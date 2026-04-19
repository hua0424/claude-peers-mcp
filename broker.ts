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
import { hashSecret, deriveGroupId, generateToken, generatePeerId, safeEqual, isValidPeerId } from "./shared/auth.ts";
import type {
  RegisterRequest,
  RegisterResponse,
  SetSummaryRequest,
  SetRoleRequest,
  SetGroupDocRequest,
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
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error("[claude-peers broker] CLAUDE_PEERS_PORT must be a port number between 1 and 65535");
  process.exit(1);
}
const DB_PATH = process.env.CLAUDE_PEERS_DB
  ?? (process.env.HOME ? `${process.env.HOME}/.claude-peers.db` : null);
if (!DB_PATH) {
  console.error("[claude-peers broker] Cannot determine DB path: set CLAUDE_PEERS_DB or HOME");
  process.exit(1);
}
const API_KEY = process.env.CLAUDE_PEERS_API_KEY;

if (!API_KEY) {
  console.error("[claude-peers broker] CLAUDE_PEERS_API_KEY is required");
  process.exit(1);
}

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");
db.run("PRAGMA foreign_keys = ON");

db.run(`
  CREATE TABLE IF NOT EXISTS groups (
    group_id TEXT PRIMARY KEY,
    group_secret_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

// Peers table v2: instance_token is the globally unique primary key.
// Peer IDs are unique only within a group (UNIQUE(id, group_id)).
db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    instance_token TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    hostname TEXT NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    group_id TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    UNIQUE(id, group_id),
    FOREIGN KEY (group_id) REFERENCES groups(group_id)
  )
`);

// Migration: if old schema has id as PRIMARY KEY, recreate with new schema.
// Peers re-register automatically on startup, so it is safe to carry over only
// the columns that exist in the old table — missing ones fall back to safe
// defaults and the next registration will refresh everything anyway.
{
  const cols = db.query("PRAGMA table_info(peers)").all() as Array<{ name: string; pk: number }>;
  if (cols.some((c) => c.name === "id" && c.pk === 1)) {
    const oldColNames = new Set(cols.map((c) => c.name));
    const pick = (name: string, fallback: string) =>
      oldColNames.has(name) ? name : `${fallback} AS ${name}`;

    db.transaction(() => {
      db.run("ALTER TABLE peers RENAME TO _peers_old");
      db.run(`
        CREATE TABLE peers (
          instance_token TEXT PRIMARY KEY,
          id TEXT NOT NULL,
          pid INTEGER NOT NULL,
          hostname TEXT NOT NULL,
          cwd TEXT NOT NULL,
          git_root TEXT,
          group_id TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          registered_at TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          UNIQUE(id, group_id),
          FOREIGN KEY (group_id) REFERENCES groups(group_id)
        )
      `);

      // If the old table predates instance_token entirely, skip data copy —
      // there is no way to synthesize a valid token, and peers will re-register.
      if (oldColNames.has("instance_token") && oldColNames.has("group_id")) {
        const selectExprs = [
          "instance_token",
          "id",
          pick("pid", "0"),
          pick("hostname", "''"),
          pick("cwd", "''"),
          pick("git_root", "NULL"),
          "group_id",
          pick("summary", "''"),
          pick("registered_at", "datetime('now')"),
          pick("last_seen", "datetime('now')"),
          oldColNames.has("status") ? "COALESCE(status, 'active') AS status" : "'active' AS status",
        ].join(", ");
        db.run(`
          INSERT INTO peers (instance_token, id, pid, hostname, cwd, git_root, group_id, summary, registered_at, last_seen, status)
          SELECT ${selectExprs} FROM _peers_old
        `);
      } else {
        console.error("[claude-peers broker] Old peers table predates v2 schema — dropping stale rows (peers will re-register)");
      }

      db.run("DROP TABLE _peers_old");
    })();
    console.error("[claude-peers broker] Migrated peers table to v2 (group-scoped peer IDs)");
  }
}

// Migration: add status column if missing (pre-v2 schema)
try {
  db.run("ALTER TABLE peers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
} catch {
  // Column already exists
}

// Migration: add role column to peers if missing
try {
  db.run("ALTER TABLE peers ADD COLUMN role TEXT NOT NULL DEFAULT 'unknown'");
} catch {
  // Column already exists
}

// Migration: add doc column to groups if missing
try {
  db.run("ALTER TABLE groups ADD COLUMN doc TEXT NOT NULL DEFAULT ''");
} catch {
  // Column already exists
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL DEFAULT '',
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  )
`);

// Index for efficient undelivered-message lookups (used by /check-messages and pushUndeliveredMessages)
db.run("CREATE INDEX IF NOT EXISTS idx_messages_undelivered ON messages (to_id, group_id, delivered)");

// Migration: add group_id to messages if missing
try {
  db.run("ALTER TABLE messages ADD COLUMN group_id TEXT NOT NULL DEFAULT ''");
} catch {
  // Column already exists
}

// Migration: detect old-format group_ids (pre-v3 used 16-char IDs, now 32-char)
// Peers will simply re-register with the new group_id format.
{
  const firstGroup = db.query("SELECT group_id FROM groups LIMIT 1").get() as { group_id: string } | null;
  if (firstGroup && firstGroup.group_id.length < 32) {
    console.error("[claude-peers broker] Detected old group ID format (pre-v3). Clearing groups and peers to upgrade...");
    // Delete peers first: FK from peers.group_id → groups.group_id would block otherwise.
    db.run("DELETE FROM peers");
    db.run("DELETE FROM groups");
    console.error("[claude-peers broker] Cleared. All peers will re-register automatically.");
  }
}

// --- Prepared statements ---

const insertGroup = db.prepare(`
  INSERT OR IGNORE INTO groups (group_id, group_secret_hash, created_at)
  VALUES (?, ?, ?)
`);

const selectGroup = db.prepare(`
  SELECT * FROM groups WHERE group_id = ?
`);

const insertPeer = db.prepare(`
  INSERT INTO peers (instance_token, id, pid, hostname, cwd, git_root, group_id, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectPeerByToken = db.prepare(`
  SELECT * FROM peers WHERE instance_token = ?
`);

// Peer IDs are group-scoped — always look up with group context
const selectPeerByIdAndGroup = db.prepare(`
  SELECT * FROM peers WHERE id = ? AND group_id = ?
`);

const selectPeerByHostPidGroup = db.prepare(`
  SELECT * FROM peers WHERE hostname = ? AND pid = ? AND group_id = ?
`);

const deletePeerByHostPid = db.prepare(`
  DELETE FROM peers WHERE hostname = ? AND pid = ? AND group_id = ?
`);

const deletePeerByToken = db.prepare(`
  DELETE FROM peers WHERE instance_token = ?
`);

const deleteDormantPeerByIdAndGroup = db.prepare(`
  DELETE FROM peers WHERE id = ? AND group_id = ? AND status = 'dormant'
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE instance_token = ?
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE instance_token = ?
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
  INSERT INTO messages (group_id, from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND group_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

const deleteStaleMessages = db.prepare(`
  DELETE FROM messages WHERE sent_at < ?
`);

const countPeers = db.prepare(`
  SELECT COUNT(*) as count FROM peers WHERE status = 'active'
`);

// --- Stale data cleanup ---

const STALE_PEER_TTL_MS = 24 * 60 * 60 * 1000;         // 24 hours
const MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

const deleteStalePeers = db.prepare(`
  DELETE FROM peers WHERE last_seen < ?
`);

const updatePeerStatus = db.prepare(`
  UPDATE peers SET status = ?, last_seen = ? WHERE instance_token = ?
`);

// Rename peer ID (group-scoped — only touches this group's messages)
const updatePeerId = db.prepare(`
  UPDATE peers SET id = ? WHERE instance_token = ?
`);

const updateInstanceToken = db.prepare(`
  UPDATE peers SET instance_token = ? WHERE instance_token = ?
`);

const selectStalePeers = db.prepare(`
  SELECT instance_token FROM peers WHERE last_seen < ?
`);

const updateMessageFromId = db.prepare(`
  UPDATE messages SET from_id = ? WHERE from_id = ? AND group_id = ?
`);

const updateMessageToId = db.prepare(`
  UPDATE messages SET to_id = ? WHERE to_id = ? AND group_id = ?
`);

const updatePeerRole = db.prepare(`
  UPDATE peers SET role = ? WHERE instance_token = ?
`);

const updatePeerRoleById = db.prepare(`
  UPDATE peers SET role = ? WHERE id = ? AND group_id = ?
`); // Used in Phase 2 set_role (peer_id path)

const selectGroupDoc = db.prepare(`
  SELECT doc FROM groups WHERE group_id = ?
`);

const updateGroupDoc = db.prepare(`
  UPDATE groups SET doc = ? WHERE group_id = ?
`);

const selectAllGroupsWithCounts = db.prepare(`
  SELECT g.group_id, g.created_at,
         COUNT(CASE WHEN p.status = 'active' THEN 1 END) AS active_peers
  FROM groups g
  LEFT JOIN peers p ON p.group_id = g.group_id
  GROUP BY g.group_id, g.created_at
`);

function cleanStale() {
  const now = Date.now();

  const peerCutoff = new Date(now - STALE_PEER_TTL_MS).toISOString();
  // Close WebSocket connections for stale peers before deleting them
  const stale = selectStalePeers.all(peerCutoff) as Array<{ instance_token: string }>;
  for (const p of stale) {
    const staleWs = wsPool.get(p.instance_token);
    if (staleWs) {
      staleWs.close(4000, "Peer cleaned up as stale");
      wsPool.delete(p.instance_token);
    }
  }
  const peerResult = deleteStalePeers.run(peerCutoff);
  if (peerResult.changes > 0) {
    console.error(`[claude-peers broker] Cleaned ${peerResult.changes} stale peer(s)`);
  }

  const msgCutoff = new Date(now - MESSAGE_RETENTION_MS).toISOString();
  const msgResult = deleteStaleMessages.run(msgCutoff);
  if (msgResult.changes > 0) {
    console.error(`[claude-peers broker] Cleaned ${msgResult.changes} old message(s) (delivered and undelivered)`);
  }

  // Remove groups that have no remaining peers
  db.run("DELETE FROM groups WHERE group_id NOT IN (SELECT DISTINCT group_id FROM peers)");
}

cleanStale();
const cleanupInterval = setInterval(cleanStale, 60 * 60 * 1000);

// Graceful shutdown
function shutdown() {
  clearInterval(cleanupInterval);
  for (const ws of wsPool.values()) ws.close(1001, "Broker shutting down");
  wsPool.clear();
  db.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// --- WebSocket connection pool (keyed by instance_token) ---

type WsData = { connId: string; instanceToken: string | null };
const wsPool = new Map<string, ServerWebSocket<WsData>>();
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

function handleRegister(body: RegisterRequest): RegisterResponse | { error: string; status: number } {
  if (!body.api_key || typeof body.api_key !== "string" || !verifyApiKey(body.api_key)) {
    return { error: "Invalid API key", status: 401 };
  }

  // Input validation
  if (!body.hostname || typeof body.hostname !== "string" || body.hostname.length > MAX_HOSTNAME_LENGTH) {
    return { error: "Invalid hostname", status: 400 };
  }
  if (!body.cwd || typeof body.cwd !== "string" || body.cwd.length > MAX_CWD_LENGTH) {
    return { error: "Invalid cwd", status: 400 };
  }
  if (body.git_root !== null && body.git_root !== undefined && (typeof body.git_root !== "string" || body.git_root.length > MAX_CWD_LENGTH)) {
    return { error: "Invalid git_root", status: 400 };
  }
  if (!Number.isInteger(body.pid) || body.pid < 1 || body.pid > 4_194_304) {
    return { error: "Invalid pid", status: 400 };
  }
  if (!body.group_secret || typeof body.group_secret !== "string" || body.group_secret.length > 256) {
    return { error: "Invalid group_secret", status: 400 };
  }
  if (body.summary && (typeof body.summary !== "string" || body.summary.length > MAX_SUMMARY_LENGTH)) {
    return { error: "Summary too long", status: 400 };
  }

  const groupId = deriveGroupId(body.group_secret);
  const secretHash = hashSecret(body.group_secret);

  // Auto-create group if first use
  const existingGroup = selectGroup.get(groupId) as { group_id: string; group_secret_hash: string } | null;
  if (!existingGroup) {
    insertGroup.run(groupId, secretHash, new Date().toISOString());
  } else if (!safeEqual(existingGroup.group_secret_hash, secretHash)) {
    // Defends against the astronomically unlikely case where two different secrets share
    // the same 32-char SHA-256 prefix (i.e., a group_id collision). This is not an
    // authentication check — any caller who derived the correct group_id already knows
    // the secret. It is purely a collision guard.
    return { error: "Group secret mismatch", status: 401 };
  }

  // Close WS for any existing peer with same hostname + pid + group
  const oldPeer = selectPeerByHostPidGroup.get(body.hostname, body.pid, groupId) as Peer | null;
  if (oldPeer) {
    const oldWs = wsPool.get(oldPeer.instance_token);
    if (oldWs) {
      oldWs.close(4000, "Peer re-registered");
      wsPool.delete(oldPeer.instance_token);
    }
  }

  // Wrap delete-old + insert-new in a transaction so a crash between them
  // doesn't leave the old peer deleted without a replacement.
  const instanceToken = generateToken();
  const now = new Date().toISOString();
  const gitRoot = body.git_root || null; // normalize "" to null
  let id = "";
  let inserted = false;
  db.transaction(() => {
    deletePeerByHostPid.run(body.hostname, body.pid, groupId);

    for (let attempt = 0; attempt < 5; attempt++) {
      id = generatePeerId();
      try {
        insertPeer.run(
          instanceToken, id, body.pid, body.hostname, body.cwd, gitRoot,
          groupId, body.summary ?? "", now, now
        );
        inserted = true;
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("UNIQUE constraint")) continue;
        throw e;
      }
    }
  })();
  if (!inserted) {
    return { error: "Failed to generate unique peer ID, please retry", status: 500 };
  }

  return { id, instance_token: instanceToken, role: "unknown" };
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
    .filter((p) => p.instance_token !== callerPeer.instance_token)
    .map(({ instance_token: _tok, group_id: _gid, ...rest }) => rest);
}

function handleSendMessage(
  body: SendMessageRequest,
  callerPeer: Peer
): { ok: boolean; queued?: boolean; error?: string } {
  if (!body.to_id || typeof body.to_id !== "string" || !isValidPeerId(body.to_id)) {
    return { ok: false, error: "Missing or invalid to_id field" };
  }
  if (!body.text || typeof body.text !== "string") {
    return { ok: false, error: "Missing or invalid text field" };
  }
  if (body.text.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` };
  }

  // Peer IDs are group-scoped — look up within caller's group
  const target = selectPeerByIdAndGroup.get(body.to_id, callerPeer.group_id) as Peer | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  const now = new Date().toISOString();
  const result = insertMessage.run(callerPeer.group_id, callerPeer.id, body.to_id, body.text, now);
  const messageId = Number(result.lastInsertRowid);

  // Try to push via WebSocket if target is connected
  // Note: send() is fire-and-forget; delivery is not confirmed at the protocol level.
  // Messages stay undelivered in DB until the client reconnects if the WS send fails.
  const targetWs = wsPool.get(target.instance_token);
  let pushed = false;
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
      pushed = true;
    } catch {
      // WebSocket send failed, message stays undelivered for later
    }
  }

  // Inform caller if message was queued rather than pushed live
  if (!pushed) {
    return { ok: true, queued: true };
  }
  return { ok: true };
}

function handleSetSummary(body: SetSummaryRequest, callerPeer: Peer): { ok: boolean; error?: string } {
  if (typeof body.summary !== "string") {
    return { ok: false, error: "Missing or invalid summary field" };
  }
  if (body.summary.length > MAX_SUMMARY_LENGTH) {
    return { ok: false, error: `Summary too long (max ${MAX_SUMMARY_LENGTH} chars)` };
  }
  updateSummary.run(body.summary, callerPeer.instance_token);
  return { ok: true };
}

function handleUnregister(callerPeer: Peer): void {
  // Fully remove the peer row so its ID is released for reuse by another peer
  // in the same group. Keeping a dormant row here served no purpose: the token
  // was rotated and discarded, so no future /resume could reactivate it, yet
  // UNIQUE(id, group_id) kept the ID reserved until stale cleanup (24h).
  // WS close handler also sets dormant, but that path is for unintentional
  // disconnects where the peer still wants to /resume later. Explicit
  // /unregister is a clean exit, so we drop the row entirely.
  deletePeerByToken.run(callerPeer.instance_token);
  const peerWs = wsPool.get(callerPeer.instance_token);
  wsPool.delete(callerPeer.instance_token);
  if (peerWs) peerWs.close(4000, "Peer unregistered");
}

function handleResume(body: ResumeRequest): { id: string; instance_token: string } | { error: string; status: number } {
  if (!body.api_key || typeof body.api_key !== "string" || !verifyApiKey(body.api_key)) {
    return { error: "Invalid API key", status: 401 };
  }
  if (!body.instance_token || typeof body.instance_token !== "string" || body.instance_token.length !== 64) {
    return { error: "Missing or invalid instance_token", status: 400 };
  }
  const peer = selectPeerByToken.get(body.instance_token) as Peer | null;
  if (!peer) {
    return { error: "Invalid token", status: 401 };
  }
  // Reject if already active (either with or without a WS connection)
  if (peer.status === "active") {
    return { error: "Peer is already active", status: 409 };
  }
  // Rotate token on every resume to prevent replay of stolen tokens.
  // Use conditional UPDATE inside a transaction: if the old token was already rotated
  // by a concurrent /resume request, updateInstanceToken matches 0 rows and we return 409.
  const newToken = generateToken();
  const now = new Date().toISOString();
  const activated = db.transaction(() => {
    const result = updateInstanceToken.run(newToken, peer.instance_token);
    if (result.changes === 0) return false; // concurrent request already rotated this token
    updatePeerStatus.run("active", now, newToken);
    return true;
  })();
  if (!activated) {
    return { error: "Peer is already active", status: 409 };
  }
  // Migrate wsPool key (defensive — peer should be dormant with no active WS)
  const oldWs = wsPool.get(peer.instance_token);
  if (oldWs) {
    wsPool.delete(peer.instance_token);
    wsPool.set(newToken, oldWs);
    oldWs.data.instanceToken = newToken;
  }
  return { id: peer.id, instance_token: newToken, role: peer.role };
}

function handleSetId(body: SetIdRequest, callerPeer: Peer): { id: string } | { error: string; status: number } {
  const newId = body.new_id;
  if (!newId || typeof newId !== "string") {
    return { error: "Missing or invalid new_id field", status: 400 };
  }
  // Validate format: 1-32 lowercase alphanumeric + hyphens, no trailing hyphens
  if (!isValidPeerId(newId)) {
    return { error: "Invalid ID format. Must be 1-32 lowercase alphanumeric characters or hyphens, starting and ending with alphanumeric.", status: 400 };
  }
  // IDs are unique within the group (UNIQUE(id, group_id) constraint).
  // Rely on the constraint for atomically enforced uniqueness — no pre-check needed.
  // If the conflict is with a *dormant* peer (clean /unregister now deletes outright,
  // so this covers crash-exited peers whose WS close left them dormant without a
  // /unregister), evict that peer and retry once. An active peer still blocks.
  const applyRename = () =>
    db.transaction(() => {
      updatePeerId.run(newId, callerPeer.instance_token);
      updateMessageFromId.run(newId, callerPeer.id, callerPeer.group_id);
      updateMessageToId.run(newId, callerPeer.id, callerPeer.group_id);
    })();
  try {
    applyRename();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("UNIQUE constraint")) throw e;
    const evicted = deleteDormantPeerByIdAndGroup.run(newId, callerPeer.group_id);
    if (evicted.changes === 0) {
      return { error: "ID already taken in this group", status: 409 };
    }
    try {
      applyRename();
    } catch (e2) {
      const msg2 = e2 instanceof Error ? e2.message : String(e2);
      if (msg2.includes("UNIQUE constraint")) {
        return { error: "ID already taken in this group", status: 409 };
      }
      throw e2;
    }
  }
  // wsPool is keyed by instance_token — no key update needed on ID rename
  return { id: newId };
}

function handleSetRole(
  body: SetRoleRequest,
  callerPeer: Peer
): { ok: boolean; error?: string } {
  if (!body.role || typeof body.role !== "string" || body.role.length > 64) {
    return { ok: false, error: "Invalid role" };
  }
  // Phase 1: no restrictions — any peer can set their own role
  updatePeerRole.run(body.role, callerPeer.instance_token);
  return { ok: true };
}

function handleGetGroupDoc(callerPeer: Peer): { doc: string } {
  const row = selectGroupDoc.get(callerPeer.group_id) as { doc: string } | null;
  return { doc: row?.doc ?? "" };
}

function handleSetGroupDoc(
  body: SetGroupDocRequest,
  callerPeer: Peer
): { ok: boolean; error?: string } {
  if (typeof body.doc !== "string") {
    return { ok: false, error: "Missing or invalid doc field" };
  }
  if (body.doc.length > 100_000) {
    return { ok: false, error: "Doc too long (max 100KB)" };
  }
  // Phase 1: no role check
  updateGroupDoc.run(body.doc, callerPeer.group_id);
  return { ok: true };
}

// --- HTTP poll for undelivered messages ---

function handleCheckMessages(callerPeer: Peer): { messages: WsPushMessage[] } {
  // Transaction ensures select + mark-delivered is atomic: if the process crashes
  // between the two steps, messages remain undelivered rather than being lost.
  const messages = db.transaction(() => {
    const rawMessages = selectUndelivered.all(callerPeer.id, callerPeer.group_id) as Message[];
    const result: WsPushMessage[] = [];
    for (const msg of rawMessages) {
      const sender = selectPeerByIdAndGroup.get(msg.from_id, callerPeer.group_id) as Peer | null;
      result.push({
        type: "message",
        from_id: msg.from_id,
        from_summary: sender?.summary ?? "",
        from_cwd: sender?.cwd ?? "",
        from_hostname: sender?.hostname ?? "",
        text: msg.text,
        sent_at: msg.sent_at,
      });
      markDelivered.run(msg.id);
    }
    return result;
  })();
  return { messages };
}

// --- Push undelivered messages on WebSocket connect ---

function pushUndeliveredMessages(peer: Peer, ws: ServerWebSocket<WsData>) {
  // Wrap in a transaction so concurrent /check-messages HTTP calls cannot deliver the same
  // messages simultaneously — both paths do SELECT + markDelivered, and without a transaction
  // they can interleave and deliver duplicates.
  db.transaction(() => {
    const messages = selectUndelivered.all(peer.id, peer.group_id) as Message[];
    for (const msg of messages) {
      const sender = selectPeerByIdAndGroup.get(msg.from_id, peer.group_id) as Peer | null;
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
      } catch {
        break; // WS is broken, stop attempting further pushes
      }
      try {
        markDelivered.run(msg.id);
      } catch (e) {
        console.error(`[claude-peers broker] Failed to mark message ${msg.id} delivered:`, e);
        // Continue — the message was likely received; delivery state is best-effort on WS push.
      }
    }
  })();
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
  updateLastSeen.run(new Date().toISOString(), peer.instance_token);
  return peer;
}

// --- HTTP + WebSocket Server ---

Bun.serve<WsData>({
  port: PORT,
  hostname: "0.0.0.0",
  maxRequestBodySize: 1024 * 1024, // 1MB limit on POST bodies

  fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- WebSocket upgrade (token sent as first message after connect) ---
    if (path === "/ws") {
      const connId = randomBytes(8).toString("hex");
      const upgraded = server.upgrade(req, {
        data: { connId, instanceToken: null },
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

    // --- Kill endpoint (POST, requires API key) ---
    if (path === "/kill") {
      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      const authHeader = req.headers.get("Authorization");
      const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!apiKey || !verifyApiKey(apiKey)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      setTimeout(shutdown, 100);
      return Response.json({ ok: true });
    }

    // --- POST endpoints ---
    // /admin/groups — API key auth, no group secret required
    if (path === "/admin/groups") {
      const authHeader = req.headers.get("Authorization");
      const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!apiKey || !verifyApiKey(apiKey)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const groups = selectAllGroupsWithCounts.all() as Array<{
        group_id: string;
        created_at: string;
        active_peers: number;
      }>;
      return Response.json(groups);
    }

    if (req.method !== "POST") {
      return new Response("claude-peers broker", { status: 200 });
    }

    return (async () => {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      try {

        // /register uses api_key in body, not Bearer token
        if (path === "/register") {
          const result = handleRegister(body as RegisterRequest);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
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
          case "/list-peers": {
            const listBody = body as ListPeersRequest;
            if (!listBody.scope || !["group", "directory", "repo"].includes(listBody.scope)) {
              return Response.json({ error: "Invalid scope (must be group, directory, or repo)" }, { status: 400 });
            }
            if (!listBody.cwd || typeof listBody.cwd !== "string" || listBody.cwd.length > MAX_CWD_LENGTH) {
              return Response.json({ error: "Invalid cwd" }, { status: 400 });
            }
            if (!listBody.hostname || typeof listBody.hostname !== "string" || listBody.hostname.length > MAX_HOSTNAME_LENGTH) {
              return Response.json({ error: "Invalid hostname" }, { status: 400 });
            }
            if (listBody.git_root && (typeof listBody.git_root !== "string" || listBody.git_root.length > MAX_CWD_LENGTH)) {
              return Response.json({ error: "Invalid git_root" }, { status: 400 });
            }
            return Response.json(handleListPeers(listBody, callerPeer));
          }
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
          case "/set-role": {
            const result = handleSetRole(body as SetRoleRequest, callerPeer);
            return Response.json(result);
          }
          case "/get-group-doc":
            return Response.json(handleGetGroupDoc(callerPeer));
          case "/set-group-doc": {
            const result = handleSetGroupDoc(body as SetGroupDocRequest, callerPeer);
            return Response.json(result);
          }
          case "/check-messages":
            return Response.json(handleCheckMessages(callerPeer));
          default:
            return Response.json({ error: "not found" }, { status: 404 });
        }
      } catch (e) {
        console.error("[claude-peers broker] Request error:", e);
        return Response.json({ error: "Internal server error" }, { status: 500 });
      }
    })();
  },

  websocket: {
    open(ws) {
      // Require auth message within timeout
      const timer = setTimeout(() => {
        pendingConnections.delete(ws.data.connId);
        if (ws.data.instanceToken === null) {
          ws.close(4001, "Auth timeout");
        }
      }, WS_AUTH_TIMEOUT_MS);
      pendingConnections.set(ws.data.connId, timer);
    },

    message(ws, rawData) {
      // Auth phase: first message must be {"type":"auth","token":"..."}
      if (ws.data.instanceToken === null) {
        const text = typeof rawData === "string" ? rawData : Buffer.from(rawData as ArrayBuffer).toString();
        try {
          const msg = JSON.parse(text) as { type: string; token?: string };
          if (msg.type !== "auth" || typeof msg.token !== "string" || !msg.token) {
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
          // Dormant peers must go through /resume (which rotates the token) first
          if (peer.status === "dormant") {
            ws.close(4001, "Peer is dormant, call /resume to reactivate");
            return;
          }
          ws.data.instanceToken = peer.instance_token;
          // Close any existing connection for this peer before replacing it
          const existingWs = wsPool.get(peer.instance_token);
          if (existingWs && existingWs !== ws) {
            existingWs.close(4000, "Replaced by new connection");
          }
          wsPool.set(peer.instance_token, ws);
          // Confirm authentication to client
          ws.send(JSON.stringify({ type: "auth_ok", id: peer.id }));
          // Deliver any queued messages
          pushUndeliveredMessages(peer, ws);
          console.error(`[claude-peers broker] WS authenticated: ${peer.id} (${peer.instance_token.slice(0, 8)}...)`);
        } catch {
          ws.close(4001, "Invalid auth message");
        }
        return;
      }
      // Authenticated connections: no client→broker messages currently used
    },

    close(ws) {
      const { connId, instanceToken } = ws.data;
      // Clear pending auth timeout if still waiting
      const timer = pendingConnections.get(connId);
      if (timer) {
        clearTimeout(timer);
        pendingConnections.delete(connId);
      }
      if (instanceToken) {
        // Only clean up if this WS is still the active connection for this peer.
        // Guard against the case where a new WS authenticated and replaced this one —
        // in that case the close handler for the old WS must not evict the new connection.
        if (wsPool.get(instanceToken) === ws) {
          wsPool.delete(instanceToken);
          updatePeerStatus.run("dormant", new Date().toISOString(), instanceToken);
        }
      }
      console.error(`[claude-peers broker] WS disconnected: ${instanceToken?.slice(0, 8) ?? "(unauthenticated)"}...`);
    },

    idleTimeout: 120,
    sendPings: true,
  },
});

console.error(`[claude-peers broker] listening on 0.0.0.0:${PORT} (db: ${DB_PATH})`);
