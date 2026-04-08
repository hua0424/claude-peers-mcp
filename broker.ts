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
import { hashSecret, deriveGroupId, generateToken, generatePeerId } from "./shared/auth.ts";
import type {
  RegisterRequest,
  RegisterResponse,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  Peer,
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
    FOREIGN KEY (group_id) REFERENCES groups(group_id)
  )
`);

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

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const deletePeerByHostPid = db.prepare(`
  DELETE FROM peers WHERE hostname = ? AND pid = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const selectPeersByGroup = db.prepare(`
  SELECT * FROM peers WHERE group_id = ?
`);

const selectPeersByGroupAndCwdAndHost = db.prepare(`
  SELECT * FROM peers WHERE group_id = ? AND cwd = ? AND hostname = ?
`);

const selectPeersByGroupAndGitRoot = db.prepare(`
  SELECT * FROM peers WHERE group_id = ? AND git_root = ?
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

const countPeers = db.prepare(`
  SELECT COUNT(*) as count FROM peers
`);

// --- WebSocket connection pool ---

const wsPool = new Map<PeerId, any>(); // Map<PeerId, ServerWebSocket>

// --- Auth helpers ---

function verifyApiKey(key: string): boolean {
  return key === API_KEY;
}

function lookupPeerByToken(token: string): Peer | null {
  return selectPeerByToken.get(token) as Peer | null;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse | { error: string } {
  if (!verifyApiKey(body.api_key)) {
    return { error: "Invalid API key" };
  }

  const groupId = deriveGroupId(body.group_secret);
  const secretHash = hashSecret(body.group_secret);

  // Auto-create group if first use
  const existingGroup = selectGroup.get(groupId) as { group_id: string } | null;
  if (!existingGroup) {
    insertGroup.run(groupId, secretHash, new Date().toISOString());
  } else {
    // Verify secret matches (different secrets could theoretically collide on first 16 chars)
    const groupRow = db.query("SELECT group_secret_hash FROM groups WHERE group_id = ?").get(groupId) as { group_secret_hash: string } | null;
    if (groupRow && groupRow.group_secret_hash !== secretHash) {
      return { error: "Group secret mismatch" };
    }
  }

  // Remove existing registration for same hostname + pid (re-registration)
  deletePeerByHostPid.run(body.hostname, body.pid);

  const id = generatePeerId();
  const instanceToken = generateToken();
  const now = new Date().toISOString();

  insertPeer.run(
    id, body.pid, body.hostname, body.cwd, body.git_root,
    groupId, instanceToken, body.summary, now, now
  );

  return { id, instance_token: instanceToken };
}

function handleListPeers(body: ListPeersRequest, callerPeer: Peer): Peer[] {
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

  // Exclude the requesting peer
  peers = peers.filter((p) => p.id !== callerPeer.id);

  // Strip instance_token from response
  return peers.map(({ instance_token, ...rest }) => rest) as unknown as Peer[];
}

function handleSendMessage(body: SendMessageRequest, callerPeer: Peer): { ok: boolean; error?: string } {
  // Verify target exists and is in the same group
  const target = selectPeerById.get(body.to_id) as Peer | null;
  if (!target || target.group_id !== callerPeer.group_id) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  const now = new Date().toISOString();
  insertMessage.run(callerPeer.id, body.to_id, body.text, now);

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
      // Mark as delivered since we pushed it
      const lastMsg = db.query(
        "SELECT id FROM messages WHERE from_id = ? AND to_id = ? AND sent_at = ? ORDER BY id DESC LIMIT 1"
      ).get(callerPeer.id, body.to_id, now) as { id: number } | null;
      if (lastMsg) {
        markDelivered.run(lastMsg.id);
      }
    } catch {
      // WebSocket send failed, message stays undelivered for later
    }
  }

  return { ok: true };
}

function handleSetSummary(body: SetSummaryRequest, callerPeer: Peer): void {
  updateSummary.run(body.summary, callerPeer.id);
}

function handleUnregister(callerPeer: Peer): void {
  wsPool.delete(callerPeer.id);
  deletePeer.run(callerPeer.id);
}

// --- Push undelivered messages on WebSocket connect ---

function pushUndeliveredMessages(peerId: PeerId, ws: any) {
  const messages = selectUndelivered.all(peerId) as Message[];
  for (const msg of messages) {
    // Look up sender info
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
  if (peer) {
    updateLastSeen.run(new Date().toISOString(), peer.id);
  }
  return peer;
}

// --- HTTP + WebSocket Server ---

type WsData = { peerId: PeerId; groupId: string };

Bun.serve<WsData>({
  port: PORT,
  hostname: "0.0.0.0",

  fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- WebSocket upgrade ---
    if (path === "/ws") {
      const token = url.searchParams.get("token");
      if (!token) {
        return new Response("Missing token", { status: 401 });
      }
      const peer = lookupPeerByToken(token);
      if (!peer) {
        return new Response("Invalid token", { status: 401 });
      }
      const upgraded = server.upgrade(req, {
        data: { peerId: peer.id, groupId: peer.group_id },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // --- Health endpoint (GET, requires api_key query param) ---
    if (path === "/health") {
      const apiKey = url.searchParams.get("api_key");
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

        // All other endpoints require Bearer token
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
            handleSetSummary(body as SetSummaryRequest, callerPeer);
            return Response.json({ ok: true });
          case "/unregister":
            handleUnregister(callerPeer);
            return Response.json({ ok: true });
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
      const { peerId } = ws.data;
      wsPool.set(peerId, ws);
      // Push any undelivered messages
      pushUndeliveredMessages(peerId, ws);
      console.error(`[claude-peers broker] WS connected: ${peerId}`);
    },
    message(_ws, _message) {
      // Client→broker messages not used; broker pushes only
    },
    close(ws) {
      const { peerId } = ws.data;
      wsPool.delete(peerId);
      console.error(`[claude-peers broker] WS disconnected: ${peerId}`);
    },
    idleTimeout: 60,
    sendPings: true,
  },
});

console.error(`[claude-peers broker] listening on 0.0.0.0:${PORT} (db: ${DB_PATH})`);
