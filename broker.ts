#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * HTTP + WebSocket server on 0.0.0.0:7899 backed by SQLite.
 * Tracks registered Claude Code peers across machines,
 * routes messages between them via WebSocket push.
 *
 * Run directly: CLAUDE_PEERS_API_KEY=<key> bun broker.ts
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { hashSecret, deriveGroupId, generateToken, generatePeerId, safeEqual } from "./shared/auth.ts";
import type {
  RegisterRequest,
  RegisterResponse,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  ResumeRequest,
  SetIdRequest,
  Peer,
  PublicPeer,
  Message,
  PeerId,
  WsPushMessage,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const API_KEY = process.env.CLAUDE_PEERS_API_KEY;

if (!API_KEY) {
  console.error("[claude-peers broker] CLAUDE_PEERS_API_KEY is required");
  process.exit(1);
}

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS groups (
    group_id TEXT PRIMARY KEY,
    group_secret_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    hostname TEXT NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    group_id TEXT NOT NULL,
    instance_token TEXT UNIQUE NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    FOREIGN KEY (group_id) REFERENCES groups(group_id)
  )
`);

// Migration: add status column if missing
try {
  db.run("ALTER TABLE peers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
} catch {
  // Column already exists
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  )
`);

// --- Prepared statements ---

const insertGroup = db.prepare(`
  INSERT OR IGNORE INTO groups (group_id, group_secret_hash, created_at)
  VALUES (?, ?, ?)
`);

const selectGroup = db.prepare(`
  SELECT * FROM groups WHERE group_id = ?
`);

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, hostname, cwd, git_root, group_id, instance_token, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectPeerByToken = db.prepare(`
  SELECT * FROM peers WHERE instance_token = ?
`);

const selectPeerById = db.prepare(`
  SELECT * FROM peers WHERE id = ?
`);

const selectPeerByHostPidGroup = db.prepare(`
  SELECT id FROM peers WHERE hostname = ? AND pid = ? AND group_id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

// Scoped by group_id to avoid deleting another group's peer if PID is reused across hosts
const deletePeerByHostPid = db.prepare(`
  DELETE FROM peers WHERE hostname = ? AND pid = ? AND group_id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const selectPeersByGroup = db.prepare(`
  SELECT * FROM peers WHERE group_id = ? AND status = 'active'
`);

const selectPeersByGroupAndCwdAndHost = db.prepare(`
  SELECT * FROM peers WHERE group_id = ? AND cwd = ? AND hostname = ? AND status = 'active'
`);

const selectPeersByGroupAndGitRoot = db.prepare(`
  SELECT * FROM peers WHERE group_id = ? AND git_root = ? AND status = 'active'
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

const deleteDeliveredMessages = db.prepare(`
  DELETE FROM messages WHERE delivered = 1 AND sent_at < ?
`);

const countPeers = db.prepare(`
  SELECT COUNT(*) as count FROM peers WHERE status = 'active'
`);

// --- Stale data cleanup ---

const STALE_PEER_TTL_MS = 24 * 60 * 60 * 1000;         // 24 hours
const MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

const deleteStalePeers = db.prepare(`
  DELETE FROM peers WHERE last_seen < ? AND (status = 'dormant' OR status = 'active')
`);

const updatePeerStatus = db.prepare(`
  UPDATE peers SET status = ?, last_seen = ? WHERE id = ?
`);

const updatePeerId = db.prepare(`
  UPDATE peers SET id = ? WHERE id = ?
`);

const updateMessageFromId = db.prepare(`
  UPDATE messages SET from_id = ? WHERE from_id = ?
`);

const updateMessageToId = db.prepare(`
  UPDATE messages SET to_id = ? WHERE to_id = ?
`);

function cleanStale() {
  const now = Date.now();

  const peerCutoff = new Date(now - STALE_PEER_TTL_MS).toISOString();
  const peerResult = deleteStalePeers.run(peerCutoff);
  if (peerResult.changes > 0) {
    console.error(`[claude-peers broker] Cleaned ${peerResult.changes} stale peer(s)`);
  }

  const msgCutoff = new Date(now - MESSAGE_RETENTION_MS).toISOString();
  const msgResult = deleteDeliveredMessages.run(msgCutoff);
  if (msgResult.changes > 0) {
    console.error(`[claude-peers broker] Cleaned ${msgResult.changes} old message(s)`);
  }
}

cleanStale();
setInterval(cleanStale, 60 * 60 * 1000); // every hour

// --- WebSocket connection pool ---

type WsData = { connId: string; peerId: PeerId | null };
const wsPool = new Map<PeerId, ServerWebSocket<WsData>>();
// Connections waiting for auth message
const pendingConnections = new Map<string, ReturnType<typeof setTimeout>>();
const WS_AUTH_TIMEOUT_MS = 5000;

// --- Input limits ---

const MAX_MESSAGE_LENGTH = 100_000; // 100KB
const MAX_SUMMARY_LENGTH = 1_000;   // 1KB
const MAX_HOSTNAME_LENGTH = 256;
const MAX_CWD_LENGTH = 4096;

// --- Auth helpers ---

function verifyApiKey(key: string): boolean {
  return safeEqual(key, API_KEY!);
}

function lookupPeerByToken(token: string): Peer | null {
  return selectPeerByToken.get(token) as Peer | null;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse | { error: string } {
  if (!verifyApiKey(body.api_key)) {
    return { error: "Invalid API key" };
  }

  // Input validation
  if (!body.hostname || body.hostname.length > MAX_HOSTNAME_LENGTH) {
    return { error: "Invalid hostname" };
  }
  if (!body.cwd || body.cwd.length > MAX_CWD_LENGTH) {
    return { error: "Invalid cwd" };
  }
  if (!Number.isInteger(body.pid) || body.pid < 1) {
    return { error: "Invalid pid" };
  }
  if (!body.group_secret || body.group_secret.length > 256) {
    return { error: "Invalid group_secret" };
  }
  if (body.summary && body.summary.length > MAX_SUMMARY_LENGTH) {
    return { error: "Summary too long" };
  }

  const groupId = deriveGroupId(body.group_secret);
  const secretHash = hashSecret(body.group_secret);

  // Auto-create group if first use
  const existingGroup = selectGroup.get(groupId) as { group_id: string; group_secret_hash: string } | null;
  if (!existingGroup) {
    insertGroup.run(groupId, secretHash, new Date().toISOString());
  } else if (!safeEqual(existingGroup.group_secret_hash, secretHash)) {
    // Different secrets could theoretically collide on first 16 chars of SHA-256
    return { error: "Group secret mismatch" };
  }

  // Clean up WS pool for the peer being replaced (same hostname + pid + group)
  const oldPeer = selectPeerByHostPidGroup.get(body.hostname, body.pid, groupId) as { id: string } | null;
  if (oldPeer) {
    const oldWs = wsPool.get(oldPeer.id);
    if (oldWs) {
      oldWs.close(4000, "Peer re-registered");
      wsPool.delete(oldPeer.id);
    }
  }
  deletePeerByHostPid.run(body.hostname, body.pid, groupId);

  const id = generatePeerId();
  const instanceToken = generateToken();
  const now = new Date().toISOString();

  insertPeer.run(
    id, body.pid, body.hostname, body.cwd, body.git_root,
    groupId, instanceToken, body.summary ?? "", now, now
  );

  return { id, instance_token: instanceToken };
}

function handleListPeers(body: ListPeersRequest, callerPeer: Peer): PublicPeer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "group":
      peers = selectPeersByGroup.all(callerPeer.group_id) as Peer[];
      break;
    case "directory":
      peers = selectPeersByGroupAndCwdAndHost.all(callerPeer.group_id, body.cwd, body.hostname) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGroupAndGitRoot.all(callerPeer.group_id, body.git_root) as Peer[];
      } else {
        peers = selectPeersByGroupAndCwdAndHost.all(callerPeer.group_id, body.cwd, body.hostname) as Peer[];
      }
      break;
    default:
      peers = selectPeersByGroup.all(callerPeer.group_id) as Peer[];
  }

  // Exclude the requesting peer; strip internal fields (token + group_id)
  return peers
    .filter((p) => p.id !== callerPeer.id)
    .map(({ instance_token: _tok, group_id: _gid, ...rest }) => rest);
}

function handleSendMessage(
  body: SendMessageRequest,
  callerPeer: Peer
): { ok: boolean; queued?: boolean; error?: string } {
  if (body.text.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` };
  }

  // Verify target exists and is in the same group
  const target = selectPeerById.get(body.to_id) as Peer | null;
  if (!target || target.group_id !== callerPeer.group_id) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  const now = new Date().toISOString();
  const result = insertMessage.run(callerPeer.id, body.to_id, body.text, now);
  const messageId = Number(result.lastInsertRowid);

  // Try to push via WebSocket if target is connected
  const targetWs = wsPool.get(body.to_id);
  if (targetWs) {
    const pushMsg: WsPushMessage = {
      type: "message",
      from_id: callerPeer.id,
      from_summary: callerPeer.summary,
      from_cwd: callerPeer.cwd,
      from_hostname: callerPeer.hostname,
      text: body.text,
      sent_at: now,
    };
    try {
      targetWs.send(JSON.stringify(pushMsg));
      markDelivered.run(messageId);
    } catch {
      // WebSocket send failed, message stays undelivered for later
    }
  }

  // Inform caller if target is offline (message is queued for delivery on reconnect)
  if (target.status === "dormant") {
    return { ok: true, queued: true };
  }
  return { ok: true };
}

function handleSetSummary(body: SetSummaryRequest, callerPeer: Peer): { ok: boolean; error?: string } {
  if (body.summary.length > MAX_SUMMARY_LENGTH) {
    return { ok: false, error: `Summary too long (max ${MAX_SUMMARY_LENGTH} chars)` };
  }
  updateSummary.run(body.summary, callerPeer.id);
  return { ok: true };
}

function handleUnregister(callerPeer: Peer): void {
  wsPool.delete(callerPeer.id);
  const now = new Date().toISOString();
  updatePeerStatus.run("dormant", now, callerPeer.id);
}

function handleResume(body: ResumeRequest & { api_key?: string }): { id: string; instance_token: string } | { error: string; status: number } {
  if (!body.api_key || !verifyApiKey(body.api_key)) {
    return { error: "Invalid API key", status: 401 };
  }
  const peer = selectPeerByToken.get(body.instance_token) as Peer | null;
  if (!peer) {
    return { error: "Invalid token", status: 401 };
  }
  // Check if there's an active WebSocket for this peer
  if (wsPool.has(peer.id)) {
    return { error: "Peer has active connection", status: 409 };
  }
  // Revive the peer
  const now = new Date().toISOString();
  updatePeerStatus.run("active", now, peer.id);
  return { id: peer.id, instance_token: peer.instance_token };
}

function handleSetId(body: SetIdRequest, callerPeer: Peer): { id: string } | { error: string; status: number } {
  const newId = body.new_id;
  // Validate format: 1-32 lowercase alphanumeric + hyphens, no trailing hyphens
  if (!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(newId)) {
    return { error: "Invalid ID format. Must be 1-32 lowercase alphanumeric characters or hyphens, starting and ending with alphanumeric.", status: 400 };
  }
  const oldId = callerPeer.id;
  // Rely on PRIMARY KEY constraint for atomically enforced uniqueness.
  // IDs are globally unique across all groups (not scoped per group).
  try {
    db.transaction(() => {
      updatePeerId.run(newId, oldId);
      updateMessageFromId.run(newId, oldId);
      updateMessageToId.run(newId, oldId);
    })();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE constraint")) {
      return { error: "ID already taken (IDs are globally unique across all groups)", status: 409 };
    }
    throw e;
  }
  // Update WS pool
  const existingWs = wsPool.get(oldId);
  if (existingWs) {
    wsPool.delete(oldId);
    wsPool.set(newId, existingWs);
    existingWs.data.peerId = newId;
  }
  return { id: newId };
}

// --- Push undelivered messages on WebSocket connect ---

function pushUndeliveredMessages(peerId: PeerId, ws: ServerWebSocket<WsData>) {
  const messages = selectUndelivered.all(peerId) as Message[];
  for (const msg of messages) {
    const sender = selectPeerById.get(msg.from_id) as Peer | null;
    const pushMsg: WsPushMessage = {
      type: "message",
      from_id: msg.from_id,
      from_summary: sender?.summary ?? "",
      from_cwd: sender?.cwd ?? "",
      from_hostname: sender?.hostname ?? "",
      text: msg.text,
      sent_at: msg.sent_at,
    };
    try {
      ws.send(JSON.stringify(pushMsg));
      markDelivered.run(msg.id);
    } catch {
      break; // Stop if WS is broken
    }
  }
}

// --- HTTP auth middleware ---

function extractToken(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

function authenticateRequest(req: Request): Peer | null {
  const token = extractToken(req);
  if (!token) return null;
  const peer = lookupPeerByToken(token);
  // Reject dormant peers — they must call /resume before using authenticated endpoints
  if (!peer || peer.status === "dormant") return null;
  updateLastSeen.run(new Date().toISOString(), peer.id);
  return peer;
}

// --- HTTP + WebSocket Server ---

Bun.serve<WsData>({
  port: PORT,
  hostname: "0.0.0.0",

  fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- WebSocket upgrade (token sent as first message after connect) ---
    if (path === "/ws") {
      const connId = randomBytes(8).toString("hex");
      const upgraded = server.upgrade(req, {
        data: { connId, peerId: null },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // --- Health endpoint (GET, requires Authorization: Bearer header) ---
    if (path === "/health") {
      const authHeader = req.headers.get("Authorization");
      const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!apiKey || !verifyApiKey(apiKey)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const { count } = countPeers.get() as { count: number };
      return Response.json({ status: "ok", peers: count });
    }

    // --- POST endpoints ---
    if (req.method !== "POST") {
      return new Response("claude-peers broker", { status: 200 });
    }

    return (async () => {
      try {
        const body = await req.json();

        // /register uses api_key in body, not Bearer token
        if (path === "/register") {
          const result = handleRegister(body as RegisterRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: 401 });
          }
          return Response.json(result);
        }

        // /resume uses instance_token in body, not Bearer token
        if (path === "/resume") {
          const result = handleResume(body as ResumeRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }

        // All other endpoints require Bearer token from an active peer
        const callerPeer = authenticateRequest(req);
        if (!callerPeer) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        switch (path) {
          case "/list-peers":
            return Response.json(handleListPeers(body as ListPeersRequest, callerPeer));
          case "/send-message":
            return Response.json(handleSendMessage(body as SendMessageRequest, callerPeer));
          case "/set-summary":
            return Response.json(handleSetSummary(body as SetSummaryRequest, callerPeer));
          case "/unregister":
            handleUnregister(callerPeer);
            return Response.json({ ok: true });
          case "/set-id": {
            const result = handleSetId(body as SetIdRequest, callerPeer);
            if ("error" in result) {
              return Response.json({ error: result.error }, { status: result.status });
            }
            return Response.json(result);
          }
          default:
            return Response.json({ error: "not found" }, { status: 404 });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ error: msg }, { status: 500 });
      }
    })();
  },

  websocket: {
    open(ws) {
      // Require auth message within timeout
      const timer = setTimeout(() => {
        pendingConnections.delete(ws.data.connId);
        if (ws.data.peerId === null) {
          ws.close(4001, "Auth timeout");
        }
      }, WS_AUTH_TIMEOUT_MS);
      pendingConnections.set(ws.data.connId, timer);
    },

    message(ws, rawData) {
      // Auth phase: first message must be {"type":"auth","token":"..."}
      if (ws.data.peerId === null) {
        const text = typeof rawData === "string" ? rawData : Buffer.from(rawData as ArrayBuffer).toString();
        try {
          const msg = JSON.parse(text) as { type: string; token?: string };
          if (msg.type !== "auth" || !msg.token) {
            ws.close(4001, "Expected auth message");
            return;
          }
          const peer = lookupPeerByToken(msg.token);
          if (!peer) {
            ws.close(4001, "Invalid token");
            return;
          }
          // Clear auth timeout
          const timer = pendingConnections.get(ws.data.connId);
          if (timer) {
            clearTimeout(timer);
            pendingConnections.delete(ws.data.connId);
          }
          ws.data.peerId = peer.id;
          // Revive dormant peer on WS reconnect (no explicit /resume needed for same-process reconnect)
          if (peer.status === "dormant") {
            updatePeerStatus.run("active", new Date().toISOString(), peer.id);
          }
          // Close any existing connection for this peer before replacing it
          const existingWs = wsPool.get(peer.id);
          if (existingWs && existingWs !== ws) {
            existingWs.close(4000, "Replaced by new connection");
          }
          wsPool.set(peer.id, ws);
          // Confirm authentication to client
          ws.send(JSON.stringify({ type: "auth_ok", id: peer.id }));
          // Deliver any queued messages
          pushUndeliveredMessages(peer.id, ws);
          console.error(`[claude-peers broker] WS authenticated: ${peer.id}`);
        } catch {
          ws.close(4001, "Invalid auth message");
        }
        return;
      }
      // Authenticated connections: no client→broker messages currently used
    },

    close(ws) {
      const { connId, peerId } = ws.data;
      // Clear pending auth timeout if still waiting
      const timer = pendingConnections.get(connId);
      if (timer) {
        clearTimeout(timer);
        pendingConnections.delete(connId);
      }
      if (peerId) {
        wsPool.delete(peerId);
        // Mark peer dormant so stale entries don't appear in list-peers
        updatePeerStatus.run("dormant", new Date().toISOString(), peerId);
      }
      console.error(`[claude-peers broker] WS disconnected: ${peerId ?? "(unauthenticated)"}`);
    },

    idleTimeout: 120,
    sendPings: true,
  },
});

console.error(`[claude-peers broker] listening on 0.0.0.0:${PORT} (db: ${DB_PATH})`);
