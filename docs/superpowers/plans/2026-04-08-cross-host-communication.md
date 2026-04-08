# Cross-Host Communication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable claude-peers to work across machines via a self-hosted broker with group-based isolation, dual-layer auth, and WebSocket push.

**Architecture:** Central broker on `0.0.0.0:7899` with SQLite. Instances register using API Key + Group Secret, receive an instance token, then connect via WebSocket for real-time message push. HTTP is used for commands (send, list, etc). All queries scoped by group_id.

**Tech Stack:** Bun, bun:sqlite, Bun.serve() WebSocket, @modelcontextprotocol/sdk

**Spec:** `docs/superpowers/specs/2026-04-08-cross-host-communication-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `shared/types.ts` | Rewrite | All TypeScript types for broker API |
| `shared/auth.ts` | Create | Hashing, token generation, peer ID generation |
| `shared/auth.test.ts` | Create | Unit tests for auth utilities |
| `broker.ts` | Rewrite | HTTP + WebSocket server, DB, all handlers |
| `broker.test.ts` | Create | Integration tests for broker endpoints |
| `server.ts` | Rewrite | MCP server with auth, WS client, auto-reconnect |
| `cli.ts` | Rewrite | CLI with auth support |
| `shared/summarize.ts` | No change | — |
| `index.ts` | No change | — |

---

### Task 1: Update shared/types.ts

**Files:**
- Rewrite: `shared/types.ts`

- [ ] **Step 1: Write the new types file**

Replace the entire contents of `shared/types.ts`:

```ts
// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  hostname: string;
  cwd: string;
  git_root: string | null;
  group_id: string;
  instance_token: string;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API request/response types ---

export interface RegisterRequest {
  api_key: string;
  group_secret: string;
  pid: number;
  hostname: string;
  cwd: string;
  git_root: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
  instance_token: string;
}

export interface SetSummaryRequest {
  summary: string;
}

export interface ListPeersRequest {
  scope: "group" | "directory" | "repo";
  cwd: string;
  hostname: string;
  git_root: string | null;
}

export interface SendMessageRequest {
  to_id: PeerId;
  text: string;
}

export interface UnregisterRequest {
  // no body needed — peer ID derived from token
}

// --- WebSocket message types (broker → instance) ---

export interface WsPushMessage {
  type: "message";
  from_id: PeerId;
  from_summary: string;
  from_cwd: string;
  from_hostname: string;
  text: string;
  sent_at: string;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `bunx tsc --noEmit shared/types.ts`
Expected: No errors (exit code 0). Other files will have errors since they import old types — that's expected and will be fixed in later tasks.

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat: update types for cross-host communication"
```

---

### Task 2: Create shared/auth.ts with tests

**Files:**
- Create: `shared/auth.ts`
- Create: `shared/auth.test.ts`

- [ ] **Step 1: Write the test file**

Create `shared/auth.test.ts`:

```ts
import { test, expect } from "bun:test";
import { hashSecret, deriveGroupId, generateToken, generatePeerId } from "./auth.ts";

test("hashSecret returns consistent SHA-256 hex", () => {
  const h1 = hashSecret("my-secret");
  const h2 = hashSecret("my-secret");
  expect(h1).toBe(h2);
  expect(h1).toHaveLength(64); // SHA-256 hex = 64 chars
});

test("hashSecret returns different hashes for different inputs", () => {
  const h1 = hashSecret("secret-a");
  const h2 = hashSecret("secret-b");
  expect(h1).not.toBe(h2);
});

test("deriveGroupId returns first 16 chars of SHA-256", () => {
  const groupId = deriveGroupId("my-secret");
  const fullHash = hashSecret("my-secret");
  expect(groupId).toHaveLength(16);
  expect(groupId).toBe(fullHash.slice(0, 16));
});

test("generateToken returns 64-char hex string", () => {
  const token = generateToken();
  expect(token).toHaveLength(64);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
});

test("generateToken returns unique values", () => {
  const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
  expect(tokens.size).toBe(100);
});

test("generatePeerId returns 8-char alphanumeric string", () => {
  const id = generatePeerId();
  expect(id).toHaveLength(8);
  expect(id).toMatch(/^[a-z0-9]{8}$/);
});

test("generatePeerId returns unique values", () => {
  const ids = new Set(Array.from({ length: 100 }, () => generatePeerId()));
  expect(ids.size).toBe(100);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test shared/auth.test.ts`
Expected: FAIL — `shared/auth.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `shared/auth.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function deriveGroupId(secret: string): string {
  return hashSecret(secret).slice(0, 16);
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function generatePeerId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test shared/auth.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/auth.ts shared/auth.test.ts
git commit -m "feat: add auth utilities (hashing, token generation)"
```

---

### Task 3: Rewrite broker.ts — DB schema, auth, register, health

**Files:**
- Rewrite: `broker.ts`
- Create: `broker.test.ts`

This task builds the broker foundation: DB schema, API Key validation, `/register` with group auto-creation, and `/health`. Later tasks add the remaining endpoints and WebSocket.

- [ ] **Step 1: Write broker integration test for register + health**

Create `broker.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { type Subprocess } from "bun";

const TEST_PORT = 17899;
const TEST_DB = `/tmp/claude-peers-test-${Date.now()}.db`;
const TEST_API_KEY = "test-api-key-12345";
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let broker: Subprocess;

beforeAll(async () => {
  broker = Bun.spawn(["bun", "broker.ts"], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_PORT),
      CLAUDE_PEERS_DB: TEST_DB,
      CLAUDE_PEERS_API_KEY: TEST_API_KEY,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  // Wait for broker to start
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health?api_key=${TEST_API_KEY}`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) break;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
});

afterAll(() => {
  broker.kill();
  try { require("fs").unlinkSync(TEST_DB); } catch {}
});

test("health endpoint returns ok", async () => {
  const res = await fetch(`${BASE_URL}/health?api_key=${TEST_API_KEY}`);
  expect(res.ok).toBe(true);
  const data = await res.json() as { status: string; peers: number };
  expect(data.status).toBe("ok");
  expect(data.peers).toBe(0);
});

test("health endpoint rejects bad api_key", async () => {
  const res = await fetch(`${BASE_URL}/health?api_key=wrong`);
  expect(res.status).toBe(401);
});

test("register succeeds with valid api_key + group_secret", async () => {
  const res = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "team-alpha",
      pid: 99999,
      hostname: "test-host",
      cwd: "/tmp/test",
      git_root: null,
      summary: "test peer",
    }),
  });
  expect(res.ok).toBe(true);
  const data = await res.json() as { id: string; instance_token: string };
  expect(data.id).toHaveLength(8);
  expect(data.instance_token).toHaveLength(64);
});

test("register rejects bad api_key", async () => {
  const res = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: "wrong-key",
      group_secret: "team-alpha",
      pid: 99998,
      hostname: "test-host",
      cwd: "/tmp/test",
      git_root: null,
      summary: "bad peer",
    }),
  });
  expect(res.status).toBe(401);
});

test("register creates group on first use, reuses on second", async () => {
  const reg1 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "new-group-secret",
      pid: 88881,
      hostname: "host-a",
      cwd: "/a",
      git_root: null,
      summary: "peer a",
    }),
  });
  const data1 = await reg1.json() as { id: string; instance_token: string };

  const reg2 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "new-group-secret",
      pid: 88882,
      hostname: "host-b",
      cwd: "/b",
      git_root: null,
      summary: "peer b",
    }),
  });
  const data2 = await reg2.json() as { id: string; instance_token: string };

  // Both registered successfully, different IDs
  expect(data1.id).not.toBe(data2.id);
  expect(data1.instance_token).not.toBe(data2.instance_token);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test broker.test.ts`
Expected: FAIL — current broker.ts doesn't support api_key or instance_token.

- [ ] **Step 3: Write the new broker.ts (foundation)**

Rewrite `broker.ts` with DB schema, register, and health. Other endpoints will be added in Task 4.

```ts
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
    const stored = existingGroup as unknown as { group_secret_hash: string };
    // selectGroup returns all columns; access group_secret_hash
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test broker.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add broker.ts broker.test.ts
git commit -m "feat: rewrite broker with groups, auth, WebSocket support"
```

---

### Task 4: Add broker tests for authenticated endpoints

**Files:**
- Modify: `broker.test.ts`

- [ ] **Step 1: Add tests for list-peers, send-message, set-summary, unregister, and WebSocket**

Append to `broker.test.ts`:

```ts
test("authenticated endpoints reject missing token", async () => {
  const res = await fetch(`${BASE_URL}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "group", cwd: "/", hostname: "h", git_root: null }),
  });
  expect(res.status).toBe(401);
});

test("list-peers returns only same-group peers", async () => {
  // Register two peers in group-alpha
  const reg1 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "group-alpha",
      pid: 70001,
      hostname: "host-1",
      cwd: "/project-a",
      git_root: "/project-a",
      summary: "peer alpha-1",
    }),
  });
  const peer1 = await reg1.json() as { id: string; instance_token: string };

  const reg2 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "group-alpha",
      pid: 70002,
      hostname: "host-2",
      cwd: "/project-b",
      git_root: "/project-b",
      summary: "peer alpha-2",
    }),
  });
  const peer2 = await reg2.json() as { id: string; instance_token: string };

  // Register one peer in group-beta
  const reg3 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "group-beta",
      pid: 70003,
      hostname: "host-3",
      cwd: "/other",
      git_root: null,
      summary: "peer beta-1",
    }),
  });
  const peer3 = await reg3.json() as { id: string; instance_token: string };

  // Peer1 lists group scope — should see peer2 but NOT peer3
  const listRes = await fetch(`${BASE_URL}/list-peers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${peer1.instance_token}`,
    },
    body: JSON.stringify({
      scope: "group",
      cwd: "/project-a",
      hostname: "host-1",
      git_root: "/project-a",
    }),
  });
  expect(listRes.ok).toBe(true);
  const peers = await listRes.json() as Array<{ id: string; summary: string }>;
  const peerIds = peers.map((p) => p.id);
  expect(peerIds).toContain(peer2.id);
  expect(peerIds).not.toContain(peer1.id); // excludes self
  expect(peerIds).not.toContain(peer3.id); // different group
});

test("send-message and WebSocket push", async () => {
  // Register sender and receiver in same group
  const senderReg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "ws-test-group",
      pid: 60001,
      hostname: "sender-host",
      cwd: "/sender",
      git_root: null,
      summary: "sender",
    }),
  });
  const sender = await senderReg.json() as { id: string; instance_token: string };

  const receiverReg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "ws-test-group",
      pid: 60002,
      hostname: "receiver-host",
      cwd: "/receiver",
      git_root: null,
      summary: "receiver",
    }),
  });
  const receiver = await receiverReg.json() as { id: string; instance_token: string };

  // Connect receiver via WebSocket
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws?token=${receiver.instance_token}`);
  const received: string[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("WS connect timeout")), 3000);
  });

  const messagePromise = new Promise<void>((resolve) => {
    ws.onmessage = (event) => {
      received.push(typeof event.data === "string" ? event.data : "");
      resolve();
    };
  });

  // Send message from sender to receiver
  const sendRes = await fetch(`${BASE_URL}/send-message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${sender.instance_token}`,
    },
    body: JSON.stringify({
      to_id: receiver.id,
      text: "hello from sender",
    }),
  });
  expect(sendRes.ok).toBe(true);
  const sendData = await sendRes.json() as { ok: boolean };
  expect(sendData.ok).toBe(true);

  // Wait for WS push
  await Promise.race([messagePromise, new Promise((_, rej) => setTimeout(() => rej(new Error("WS message timeout")), 3000))]);

  expect(received.length).toBe(1);
  const msg = JSON.parse(received[0]!) as { type: string; from_id: string; text: string };
  expect(msg.type).toBe("message");
  expect(msg.from_id).toBe(sender.id);
  expect(msg.text).toBe("hello from sender");

  ws.close();
});

test("send-message fails across groups", async () => {
  const reg1 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "cross-group-a",
      pid: 50001,
      hostname: "h",
      cwd: "/a",
      git_root: null,
      summary: "",
    }),
  });
  const peer1 = await reg1.json() as { id: string; instance_token: string };

  const reg2 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "cross-group-b",
      pid: 50002,
      hostname: "h",
      cwd: "/b",
      git_root: null,
      summary: "",
    }),
  });
  const peer2 = await reg2.json() as { id: string; instance_token: string };

  const sendRes = await fetch(`${BASE_URL}/send-message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${peer1.instance_token}`,
    },
    body: JSON.stringify({ to_id: peer2.id, text: "should fail" }),
  });
  const data = await sendRes.json() as { ok: boolean; error: string };
  expect(data.ok).toBe(false);
  expect(data.error).toContain("not found");
});

test("set-summary updates peer summary", async () => {
  const reg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "summary-group",
      pid: 40001,
      hostname: "h",
      cwd: "/c",
      git_root: null,
      summary: "old summary",
    }),
  });
  const peer = await reg.json() as { id: string; instance_token: string };

  const setRes = await fetch(`${BASE_URL}/set-summary`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${peer.instance_token}`,
    },
    body: JSON.stringify({ summary: "new summary" }),
  });
  expect(setRes.ok).toBe(true);
});

test("unregister removes peer", async () => {
  const reg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "unreg-group",
      pid: 30001,
      hostname: "h",
      cwd: "/d",
      git_root: null,
      summary: "",
    }),
  });
  const peer = await reg.json() as { id: string; instance_token: string };

  const unregRes = await fetch(`${BASE_URL}/unregister`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${peer.instance_token}`,
    },
    body: JSON.stringify({}),
  });
  expect(unregRes.ok).toBe(true);

  // Token should no longer work
  const listRes = await fetch(`${BASE_URL}/list-peers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${peer.instance_token}`,
    },
    body: JSON.stringify({ scope: "group", cwd: "/d", hostname: "h", git_root: null }),
  });
  expect(listRes.status).toBe(401);
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test broker.test.ts`
Expected: All 11 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add broker.test.ts
git commit -m "test: add broker integration tests for all endpoints + WebSocket"
```

---

### Task 5: Rewrite server.ts — auth, WebSocket client, MCP tools

**Files:**
- Rewrite: `server.ts`

- [ ] **Step 1: Rewrite server.ts**

Replace the entire contents of `server.ts`:

```ts
#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Registers with the remote broker using API Key + Group Secret,
 * receives messages via WebSocket push.
 *
 * Required env vars:
 *   CLAUDE_PEERS_BROKER_URL — e.g. http://10.0.0.5:7899
 *   CLAUDE_PEERS_API_KEY    — must match broker's configured key
 *   CLAUDE_PEERS_GROUP_SECRET — determines group membership
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  WsPushMessage,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";
import { hostname } from "node:os";

// --- Configuration ---

const BROKER_URL = process.env.CLAUDE_PEERS_BROKER_URL;
const API_KEY = process.env.CLAUDE_PEERS_API_KEY;
const GROUP_SECRET = process.env.CLAUDE_PEERS_GROUP_SECRET;

if (!BROKER_URL || !API_KEY || !GROUP_SECRET) {
  console.error(
    "[claude-peers] Missing required env vars: CLAUDE_PEERS_BROKER_URL, CLAUDE_PEERS_API_KEY, CLAUDE_PEERS_GROUP_SECRET"
  );
  process.exit(1);
}

// Derive WS URL from HTTP URL
const WS_URL = BROKER_URL.replace(/^http/, "ws");

// --- Utility ---

function log(msg: string) {
  console.error(`[claude-peers] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) return text.trim();
  } catch { /* not a git repo */ }
  return null;
}

// --- Broker communication ---

let myId: PeerId | null = null;
let myToken: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let myHostname = hostname();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
let wsFailCount = 0;
const MAX_RECONNECT_DELAY = 30000;
const RE_REGISTER_AFTER_FAILURES = 3;

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (myToken) {
    headers["Authorization"] = `Bearer ${myToken}`;
  }
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function register(summary: string): Promise<void> {
  const reg = await brokerFetch<RegisterResponse>("/register", {
    api_key: API_KEY,
    group_secret: GROUP_SECRET,
    pid: process.pid,
    hostname: myHostname,
    cwd: myCwd,
    git_root: myGitRoot,
    summary,
  });
  myId = reg.id;
  myToken = reg.instance_token;
  log(`Registered as peer ${myId}`);
}

// --- WebSocket connection ---

let initialSummary = "";

function connectWebSocket() {
  if (!myToken) return;

  const wsUrl = `${WS_URL}/ws?token=${myToken}`;
  log(`Connecting WebSocket to ${WS_URL}/ws`);
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    log("WebSocket connected");
    reconnectDelay = 1000; // reset backoff on success
    wsFailCount = 0;
  };

  ws.onmessage = async (event) => {
    try {
      const data = typeof event.data === "string" ? event.data : await event.data.text();
      const msg = JSON.parse(data) as WsPushMessage;

      if (msg.type === "message") {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: msg.text,
            meta: {
              from_id: msg.from_id,
              from_summary: msg.from_summary,
              from_cwd: msg.from_cwd,
              from_hostname: msg.from_hostname,
              sent_at: msg.sent_at,
            },
          },
        });
        log(`Pushed message from ${msg.from_id}: ${msg.text.slice(0, 80)}`);
      }
    } catch (e) {
      log(`WS message parse error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  ws.onclose = () => {
    log(`WebSocket disconnected, reconnecting in ${reconnectDelay}ms`);
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    log(`WebSocket error: ${e}`);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  wsFailCount++;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      // After repeated failures, token may be invalid (broker restarted).
      // Re-register to get a fresh token before reconnecting.
      if (wsFailCount >= RE_REGISTER_AFTER_FAILURES) {
        log("Multiple WS failures, re-registering with broker...");
        try {
          await register(initialSummary);
          wsFailCount = 0;
        } catch (e) {
          log(`Re-register failed: ${e instanceof Error ? e.message : String(e)}`);
          // Will retry on next cycle
        }
      }
      connectWebSocket();
    } catch {
      // If connect fails, the onclose handler will schedule another retry
    }
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.2.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances in your group can see you and send you messages — even across different machines.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, from_cwd, and from_hostname attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- list_peers: Discover other Claude Code instances (scope: group/directory/repo)
- send_message: Send a message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages (messages normally arrive via WebSocket push)

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances in your group. Returns their ID, hostname, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["group", "directory", "repo"],
          description:
            'Scope of peer discovery. "group" = all instances in your group (across all machines). "directory" = same working directory on same host. "repo" = same git repository (across hosts).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via WebSocket.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually trigger a check for new messages. Messages normally arrive instantly via WebSocket, but use this if you suspect a message was missed.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "group" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          hostname: myHostname,
          git_root: myGitRoot,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `Host: ${p.hostname}`,
            `CWD: ${p.cwd}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          return parts.join("\n  ");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return {
          content: [
            {
              type: "text" as const,
              text: "WebSocket not connected. Messages will be delivered when connection is restored.",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: "WebSocket is connected. Messages are delivered automatically.",
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Startup ---

async function main() {
  // 1. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  myHostname = hostname();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`Hostname: ${myHostname}`);
  log(`Broker: ${BROKER_URL}`);

  // 2. Generate initial summary (non-blocking, best-effort)
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // 3. Register with broker
  await register(initialSummary);

  // If summary generation is still running, update it when done
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myToken) {
        try {
          await brokerFetch("/set-summary", { summary: initialSummary });
          log(`Late auto-summary applied: ${initialSummary}`);
        } catch { /* Non-critical */ }
      }
    });
  }

  // 4. Connect WebSocket for message push
  connectWebSocket();

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Clean up on exit
  const cleanup = async () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close();
    if (myToken) {
      try {
        await brokerFetch("/unregister", {});
        log("Unregistered from broker");
      } catch { /* Best effort */ }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `bunx tsc --noEmit server.ts`
Expected: No errors (exit code 0).

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "feat: rewrite MCP server with auth, WebSocket client, auto-reconnect"
```

---

### Task 6: Rewrite cli.ts

**Files:**
- Rewrite: `cli.ts`

- [ ] **Step 1: Rewrite cli.ts with auth support**

Replace the entire contents of `cli.ts`:

```ts
#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for inspecting broker state and sending messages.
 *
 * Required env vars:
 *   CLAUDE_PEERS_BROKER_URL    — e.g. http://10.0.0.5:7899
 *   CLAUDE_PEERS_API_KEY       — must match broker's configured key
 *   CLAUDE_PEERS_GROUP_SECRET  — required for peers/send commands
 *
 * Usage:
 *   bun cli.ts status              — Show broker status
 *   bun cli.ts peers               — List all peers in your group
 *   bun cli.ts send <id> <msg>     — Send a message to a peer
 *   bun cli.ts kill-broker          — Stop the broker daemon
 */

import { hostname } from "node:os";

const BROKER_URL = process.env.CLAUDE_PEERS_BROKER_URL;
const API_KEY = process.env.CLAUDE_PEERS_API_KEY;
const GROUP_SECRET = process.env.CLAUDE_PEERS_GROUP_SECRET;

if (!BROKER_URL || !API_KEY) {
  console.error("Required: CLAUDE_PEERS_BROKER_URL and CLAUDE_PEERS_API_KEY env vars");
  process.exit(1);
}

// CLI registers as a temporary peer for authenticated operations
let cliToken: string | null = null;
let cliPeerId: string | null = null;

async function brokerFetch<T>(path: string, body?: unknown, useToken = true): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (useToken && cliToken) {
    headers["Authorization"] = `Bearer ${cliToken}`;
  }
  const opts: RequestInit = body
    ? { method: "POST", headers, body: JSON.stringify(body) }
    : { headers };
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function registerCli(): Promise<void> {
  if (!GROUP_SECRET) {
    console.error("Required: CLAUDE_PEERS_GROUP_SECRET env var for this command");
    process.exit(1);
  }
  const reg = await brokerFetch<{ id: string; instance_token: string }>(
    "/register",
    {
      api_key: API_KEY,
      group_secret: GROUP_SECRET,
      pid: process.pid,
      hostname: hostname(),
      cwd: process.cwd(),
      git_root: null,
      summary: "[CLI]",
    },
    false // don't use Bearer token for /register
  );
  cliToken = reg.instance_token;
  cliPeerId = reg.id;
}

async function unregisterCli(): Promise<void> {
  if (cliToken) {
    try {
      await brokerFetch("/unregister", {});
    } catch { /* best effort */ }
  }
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>(
        `/health?api_key=${encodeURIComponent(API_KEY)}`,
        undefined,
        false
      );
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
      console.log(`URL: ${BROKER_URL}`);
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    try {
      await registerCli();
      const peers = await brokerFetch<
        Array<{
          id: string;
          pid: number;
          hostname: string;
          cwd: string;
          git_root: string | null;
          summary: string;
          last_seen: string;
        }>
      >("/list-peers", {
        scope: "group",
        cwd: process.cwd(),
        hostname: hostname(),
        git_root: null,
      });

      if (peers.length === 0) {
        console.log("No other peers in this group.");
      } else {
        for (const p of peers) {
          console.log(`  ${p.id}  ${p.hostname}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await unregisterCli();
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      await registerCli();
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await unregisterCli();
    }
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; peers: number }>(
        `/health?api_key=${encodeURIComponent(API_KEY)}`,
        undefined,
        false
      );
      console.log(`Broker has ${health.peers} peer(s). Shutting down...`);

      // Use the broker URL to find the process — works locally
      const url = new URL(BROKER_URL);
      const port = url.port;
      const proc = Bun.spawnSync(["lsof", "-ti", `:${port}`]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running (or not local).");
    }
    break;
  }

  default:
    console.log(`claude-peers CLI

Required env vars:
  CLAUDE_PEERS_BROKER_URL     Broker address (e.g. http://10.0.0.5:7899)
  CLAUDE_PEERS_API_KEY        Broker access key
  CLAUDE_PEERS_GROUP_SECRET   Group secret (for peers/send commands)

Usage:
  bun cli.ts status              Show broker status
  bun cli.ts peers               List all peers in your group
  bun cli.ts send <id> <msg>     Send a message to a peer
  bun cli.ts kill-broker         Stop the broker daemon (local only)`);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `bunx tsc --noEmit cli.ts`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add cli.ts
git commit -m "feat: rewrite CLI with auth and group support"
```

---

### Task 7: Run all tests and fix any issues

**Files:**
- Possibly fix: `broker.ts`, `broker.test.ts`, `shared/auth.ts`

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: All tests in `shared/auth.test.ts` and `broker.test.ts` PASS.

- [ ] **Step 2: Run TypeScript type check on all files**

Run: `bunx tsc --noEmit`
Expected: No errors. If there are errors in `index.ts` due to removed exports, fix them.

- [ ] **Step 3: Fix any issues found**

Address any test failures or type errors.

- [ ] **Step 4: Commit fixes if any**

```bash
git add -A
git commit -m "fix: resolve test and type check issues"
```

---

### Task 8: Update CLAUDE.md and README.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update CLAUDE.md architecture section**

Update the Architecture section to reflect the new file structure and cross-host design. Update the Running section with the new env vars.

Key changes:
- Architecture: mention `shared/auth.ts`, update descriptions for broker.ts and server.ts
- Running: show required env vars, remove localhost-only instructions
- Add `CLAUDE_PEERS_API_KEY`, `CLAUDE_PEERS_BROKER_URL`, `CLAUDE_PEERS_GROUP_SECRET` to the running examples

- [ ] **Step 2: Update README.md**

Update Quick Start, How It Works, Configuration, and Architecture sections:
- Install section: same
- Register MCP server: show env vars in `.mcp.json` config
- Running: explain broker deployment, env vars
- Architecture diagram: update to show cross-host
- Configuration table: new env vars
- Remove localhost-only references

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update docs for cross-host communication"
```
