# Server Stability & Peer Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make peer identity persistent across restarts, fix the reconnect bug, add set_id/switch_id tools, and improve error handling.

**Architecture:** Session files in `~/.claude-peers/sessions/` persist peer_id + token. Broker gets a `status` column (active/dormant), `/resume` endpoint, and `/set-id` endpoint. Server.ts tries to resume an existing session on startup before registering new. Reconnect prefers /resume over /register to preserve ID.

**Tech Stack:** Bun, bun:sqlite, @modelcontextprotocol/sdk

**Spec:** `docs/superpowers/specs/2026-04-10-server-stability-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `shared/types.ts` | Modify | Add ResumeRequest, ResumeResponse, SetIdRequest, SetIdResponse; add `status` to Peer |
| `shared/session.ts` | Create | Session file I/O: save, load, scan, delete, cleanup |
| `broker.ts` | Modify | Add `status` column, `/resume` endpoint, `/set-id` endpoint, modify `/unregister` and `/list-peers` |
| `server.ts` | Modify | Session persistence, fixed reconnect, set_id/switch_id tools, graceful errors |

---

### Task 1: Update shared/types.ts

**Files:**
- Modify: `shared/types.ts`

- [ ] **Step 1: Add new types**

Add the following after `UnregisterRequest` and before the WebSocket section in `shared/types.ts`:

```ts
export interface ResumeRequest {
  instance_token: string;
}

export interface ResumeResponse {
  id: PeerId;
  instance_token: string;
}

export interface SetIdRequest {
  new_id: string;
}

export interface SetIdResponse {
  id: PeerId;
}
```

Add `status` field to the `Peer` interface (after `last_seen`):

```ts
  status: "active" | "dormant";
```

- [ ] **Step 2: Verify types compile**

Run: `bunx tsc --noEmit shared/types.ts`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat: add resume, set-id types and peer status field"
```

---

### Task 2: Create shared/session.ts

**Files:**
- Create: `shared/session.ts`
- Create: `shared/session.test.ts`

- [ ] **Step 1: Write tests**

Create `shared/session.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { saveSession, loadSession, scanSessions, deleteSession, cleanupStaleSessions } from "./session.ts";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = `/tmp/claude-peers-session-test-${Date.now()}`;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("saveSession creates a session file", () => {
  saveSession(TEST_DIR, {
    peer_id: "abc12345",
    instance_token: "tok123",
    cwd: "/project",
    group_id: "grp1",
    hostname: "host1",
  });
  expect(existsSync(join(TEST_DIR, "abc12345.json"))).toBe(true);
});

test("loadSession reads a session file", () => {
  saveSession(TEST_DIR, {
    peer_id: "abc12345",
    instance_token: "tok123",
    cwd: "/project",
    group_id: "grp1",
    hostname: "host1",
  });
  const session = loadSession(TEST_DIR, "abc12345");
  expect(session).not.toBeNull();
  expect(session!.peer_id).toBe("abc12345");
  expect(session!.instance_token).toBe("tok123");
});

test("loadSession returns null for missing file", () => {
  const session = loadSession(TEST_DIR, "nonexistent");
  expect(session).toBeNull();
});

test("scanSessions filters by cwd and group_id", () => {
  saveSession(TEST_DIR, { peer_id: "a", instance_token: "t1", cwd: "/proj", group_id: "g1", hostname: "h" });
  saveSession(TEST_DIR, { peer_id: "b", instance_token: "t2", cwd: "/proj", group_id: "g1", hostname: "h" });
  saveSession(TEST_DIR, { peer_id: "c", instance_token: "t3", cwd: "/other", group_id: "g1", hostname: "h" });
  saveSession(TEST_DIR, { peer_id: "d", instance_token: "t4", cwd: "/proj", group_id: "g2", hostname: "h" });

  const matches = scanSessions(TEST_DIR, "/proj", "g1");
  const ids = matches.map((s) => s.peer_id);
  expect(ids).toContain("a");
  expect(ids).toContain("b");
  expect(ids).not.toContain("c");
  expect(ids).not.toContain("d");
});

test("scanSessions returns newest last_used first", () => {
  saveSession(TEST_DIR, { peer_id: "old", instance_token: "t1", cwd: "/p", group_id: "g", hostname: "h" });
  // Manually set older timestamp
  const oldFile = join(TEST_DIR, "old.json");
  const oldData = JSON.parse(Bun.file(oldFile).textSync());
  oldData.last_used = "2020-01-01T00:00:00Z";
  Bun.write(oldFile, JSON.stringify(oldData));

  saveSession(TEST_DIR, { peer_id: "new", instance_token: "t2", cwd: "/p", group_id: "g", hostname: "h" });

  const matches = scanSessions(TEST_DIR, "/p", "g");
  expect(matches[0]!.peer_id).toBe("new");
  expect(matches[1]!.peer_id).toBe("old");
});

test("deleteSession removes a session file", () => {
  saveSession(TEST_DIR, { peer_id: "abc", instance_token: "t", cwd: "/p", group_id: "g", hostname: "h" });
  deleteSession(TEST_DIR, "abc");
  expect(existsSync(join(TEST_DIR, "abc.json"))).toBe(false);
});

test("cleanupStaleSessions removes old files", () => {
  saveSession(TEST_DIR, { peer_id: "stale", instance_token: "t", cwd: "/p", group_id: "g", hostname: "h" });
  // Set last_used to 8 days ago
  const file = join(TEST_DIR, "stale.json");
  const data = JSON.parse(Bun.file(file).textSync());
  data.last_used = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  Bun.write(file, JSON.stringify(data));

  saveSession(TEST_DIR, { peer_id: "fresh", instance_token: "t2", cwd: "/p", group_id: "g", hostname: "h" });

  cleanupStaleSessions(TEST_DIR, 7);
  expect(existsSync(join(TEST_DIR, "stale.json"))).toBe(false);
  expect(existsSync(join(TEST_DIR, "fresh.json"))).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test shared/session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `shared/session.ts`:

```ts
import { mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface SessionData {
  peer_id: string;
  instance_token: string;
  cwd: string;
  group_id: string;
  hostname: string;
  created_at?: string;
  last_used?: string;
}

export function saveSession(dir: string, data: SessionData): void {
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const record = {
    ...data,
    created_at: data.created_at ?? now,
    last_used: now,
  };
  Bun.write(join(dir, `${data.peer_id}.json`), JSON.stringify(record, null, 2));
}

export function loadSession(dir: string, peerId: string): SessionData | null {
  const file = join(dir, `${peerId}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(Bun.file(file).textSync()) as SessionData;
  } catch {
    return null;
  }
}

export function scanSessions(dir: string, cwd: string, groupId: string): SessionData[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const sessions: SessionData[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(Bun.file(join(dir, file)).textSync()) as SessionData;
      if (data.cwd === cwd && data.group_id === groupId) {
        sessions.push(data);
      }
    } catch {
      // Skip corrupt files
    }
  }
  // Sort by last_used descending (newest first)
  sessions.sort((a, b) => {
    const ta = a.last_used ?? a.created_at ?? "";
    const tb = b.last_used ?? b.created_at ?? "";
    return tb.localeCompare(ta);
  });
  return sessions;
}

export function deleteSession(dir: string, peerId: string): void {
  const file = join(dir, `${peerId}.json`);
  if (existsSync(file)) unlinkSync(file);
}

export function cleanupStaleSessions(dir: string, maxAgeDays: number): void {
  if (!existsSync(dir)) return;
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const data = JSON.parse(Bun.file(join(dir, file)).textSync()) as SessionData;
      const lastUsed = data.last_used ?? data.created_at ?? "";
      if (lastUsed < cutoff) {
        unlinkSync(join(dir, file));
      }
    } catch {
      // Skip corrupt files
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test shared/session.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/session.ts shared/session.test.ts
git commit -m "feat: add session file persistence module"
```

---

### Task 3: Broker — add status column, /resume, /set-id, modify /unregister

**Files:**
- Modify: `broker.ts`

- [ ] **Step 1: Add status column to peers table**

In `broker.ts`, modify the `CREATE TABLE IF NOT EXISTS peers` statement to add the `status` column. Replace the existing peers table creation (lines 49-63) with:

```sql
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
```

Add a migration for existing DBs right after the CREATE TABLE statements:

```ts
// Migration: add status column if missing
try {
  db.run("ALTER TABLE peers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
} catch {
  // Column already exists
}
```

- [ ] **Step 2: Add new prepared statements**

Add after the existing prepared statements:

```ts
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

const selectPeerByIdAndGroup = db.prepare(`
  SELECT * FROM peers WHERE id = ? AND group_id = ?
`);
```

Modify `selectPeersByGroup` and the other list queries to filter by status = 'active':

```ts
const selectPeersByGroup = db.prepare(`
  SELECT * FROM peers WHERE group_id = ? AND status = 'active'
`);

const selectPeersByGroupAndCwdAndHost = db.prepare(`
  SELECT * FROM peers WHERE group_id = ? AND cwd = ? AND hostname = ? AND status = 'active'
`);

const selectPeersByGroupAndGitRoot = db.prepare(`
  SELECT * FROM peers WHERE group_id = ? AND git_root = ? AND status = 'active'
`);

const countPeers = db.prepare(`
  SELECT COUNT(*) as count FROM peers WHERE status = 'active'
`);
```

- [ ] **Step 3: Add handleResume function**

Add after the existing handler functions:

```ts
function handleResume(body: { instance_token: string }): { id: string; instance_token: string } | { error: string; status: number } {
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
```

- [ ] **Step 4: Add handleSetId function**

```ts
function handleSetId(body: { new_id: string }, callerPeer: Peer): { id: string } | { error: string; status: number } {
  const newId = body.new_id;
  // Validate format: 1-16 lowercase alphanumeric + hyphens
  if (!/^[a-z0-9][a-z0-9-]{0,15}$/.test(newId)) {
    return { error: "Invalid ID format. Must be 1-16 lowercase alphanumeric characters or hyphens, starting with alphanumeric.", status: 400 };
  }
  // Check uniqueness within group
  const existing = selectPeerByIdAndGroup.get(newId, callerPeer.group_id) as Peer | null;
  if (existing) {
    return { error: "ID already taken", status: 409 };
  }
  const oldId = callerPeer.id;
  // Update peer ID
  updatePeerId.run(newId, oldId);
  // Migrate messages
  updateMessageFromId.run(newId, oldId);
  updateMessageToId.run(newId, oldId);
  // Update WS pool
  const existingWs = wsPool.get(oldId);
  if (existingWs) {
    wsPool.delete(oldId);
    wsPool.set(newId, existingWs);
    existingWs.data.peerId = newId;
  }
  return { id: newId };
}
```

- [ ] **Step 5: Modify handleUnregister to set dormant**

Replace the existing `handleUnregister` function:

```ts
function handleUnregister(callerPeer: Peer): void {
  wsPool.delete(callerPeer.id);
  const now = new Date().toISOString();
  updatePeerStatus.run("dormant", now, callerPeer.id);
}
```

- [ ] **Step 6: Add /resume and /set-id routes**

In the fetch handler's POST switch, add before the default case:

```ts
        // /resume uses instance_token in body, not Bearer token
        if (path === "/resume") {
          const result = handleResume(body as { instance_token: string });
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status });
          }
          return Response.json(result);
        }
```

And inside the authenticated switch block, add:

```ts
          case "/set-id": {
            const result = handleSetId(body as { new_id: string }, callerPeer);
            if ("error" in result) {
              return Response.json({ error: result.error }, { status: result.status });
            }
            return Response.json(result);
          }
```

- [ ] **Step 7: Update stale cleanup to handle dormant peers**

Replace the existing `deleteStalePeers` prepared statement:

```ts
const deleteStalePeers = db.prepare(`
  DELETE FROM peers WHERE last_seen < ? AND (status = 'dormant' OR status = 'active')
`);
```

- [ ] **Step 8: Add ResumeRequest, SetIdRequest imports**

Update the type imports at the top of `broker.ts` to include the new types.

- [ ] **Step 9: Commit**

```bash
git add broker.ts shared/types.ts
git commit -m "feat: broker status column, /resume, /set-id, dormant unregister"
```

---

### Task 4: Server.ts — session persistence, fixed reconnect, new tools, graceful errors

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Add session imports and constants**

Add at the top of `server.ts` (after existing imports):

```ts
import { saveSession, loadSession, scanSessions, deleteSession, cleanupStaleSessions } from "./shared/session.ts";
import { deriveGroupId } from "./shared/auth.ts";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
```

Add after the env var checks:

```ts
const SESSION_DIR = join(process.env.HOME ?? "/tmp", ".claude-peers", "sessions");
const GROUP_ID = deriveGroupId(GROUP_SECRET!);
mkdirSync(SESSION_DIR, { recursive: true });
```

- [ ] **Step 2: Add session save helper**

Add after the `register()` function:

```ts
function saveCurrentSession(): void {
  if (!myId || !myToken) return;
  saveSession(SESSION_DIR, {
    peer_id: myId,
    instance_token: myToken,
    cwd: myCwd,
    group_id: GROUP_ID,
    hostname: myHostname,
  });
}
```

Update `register()` to call `saveCurrentSession()` after setting myId/myToken:

```ts
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
  saveCurrentSession();
  log(`Registered as peer ${myId}`);
}
```

- [ ] **Step 3: Add tryResumeSession function**

Add before the `main()` function:

```ts
async function tryResumeSession(): Promise<boolean> {
  cleanupStaleSessions(SESSION_DIR, 7);
  const sessions = scanSessions(SESSION_DIR, myCwd, GROUP_ID);

  for (const session of sessions) {
    try {
      const res = await fetch(`${BROKER_URL}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_token: session.instance_token }),
      });

      if (res.ok) {
        const data = await res.json() as { id: string; instance_token: string };
        myId = data.id;
        myToken = data.instance_token;
        saveCurrentSession();
        log(`Resumed session as peer ${myId}`);
        return true;
      }

      if (res.status === 409) {
        log(`Session ${session.peer_id} has active connection, skipping`);
        continue;
      }

      if (res.status === 401) {
        log(`Session ${session.peer_id} token invalid, removing stale file`);
        deleteSession(SESSION_DIR, session.peer_id);
        continue;
      }
    } catch {
      // Broker unreachable, will fail on register too
      return false;
    }
  }
  return false;
}
```

- [ ] **Step 4: Fix reconnect flow**

Replace the `scheduleReconnect` function:

```ts
function scheduleReconnect() {
  if (reconnectTimer) return;
  wsFailCount++;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      if (wsFailCount >= RE_REGISTER_AFTER_FAILURES) {
        log("Multiple WS failures, attempting /resume...");
        try {
          const res = await fetch(`${BROKER_URL}/resume`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ instance_token: myToken }),
          });
          if (res.ok) {
            log("Resume successful, reconnecting WS...");
            wsFailCount = 0;
          } else if (res.status === 401) {
            log("Token invalid, re-registering...");
            await register(initialSummary);
            wsFailCount = 0;
          }
          // 409 means someone else took it — re-register
          else if (res.status === 409) {
            log("Session taken by another connection, re-registering...");
            await register(initialSummary);
            wsFailCount = 0;
          }
        } catch (e) {
          log(`Resume/re-register failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      connectWebSocket();
    } catch {
      // onclose will schedule another retry
    }
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}
```

- [ ] **Step 5: Update main() startup to try resume first**

Replace the registration section in `main()` (the "3. Register with broker" part):

```ts
  // 3. Try to resume existing session, or register new
  const resumed = await tryResumeSession();
  if (!resumed) {
    await register(initialSummary);
  }

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
```

- [ ] **Step 6: Add set_id and switch_id tool definitions**

Add to the TOOLS array:

```ts
  {
    name: "set_id",
    description:
      "Set a custom peer ID for this session. The ID must be 1-16 lowercase alphanumeric characters or hyphens. Fails if the ID is already taken by another peer in your group.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string" as const,
          description: "The custom peer ID to set (e.g. 'my-review-session')",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "switch_id",
    description:
      "Switch to a different peer identity. Looks up a local session file for the target ID and resumes that session. Useful if the wrong session was auto-resumed on startup.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string" as const,
          description: "The peer ID to switch to (must exist as a local session file)",
        },
      },
      required: ["id"],
    },
  },
```

- [ ] **Step 7: Add set_id and switch_id tool handlers**

Add to the CallToolRequestSchema handler switch, before the `default` case:

```ts
    case "set_id": {
      const { id } = args as { id: string };
      if (!myId || !myToken) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        const result = await brokerFetch<{ id?: string; error?: string }>("/set-id", { new_id: id });
        if (result.error) {
          return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        }
        const oldId = myId;
        myId = result.id!;
        deleteSession(SESSION_DIR, oldId);
        saveCurrentSession();
        return { content: [{ type: "text" as const, text: `ID changed from ${oldId} to ${myId}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "switch_id": {
      const { id } = args as { id: string };
      const targetSession = loadSession(SESSION_DIR, id);
      if (!targetSession) {
        return { content: [{ type: "text" as const, text: `No local session found for peer ${id}` }], isError: true };
      }
      try {
        const res = await fetch(`${BROKER_URL}/resume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instance_token: targetSession.instance_token }),
        });
        if (!res.ok) {
          const data = await res.json() as { error: string };
          return { content: [{ type: "text" as const, text: `Cannot switch: ${data.error}` }], isError: true };
        }
        // Dormant current session
        if (myToken) {
          try { await brokerFetch("/unregister", {}); } catch { /* best effort */ }
        }
        // Adopt target identity
        const oldId = myId;
        myId = targetSession.peer_id;
        myToken = targetSession.instance_token;
        saveCurrentSession();
        // Reconnect WS with new token
        if (ws) ws.close();
        connectWebSocket();
        return { content: [{ type: "text" as const, text: `Switched from ${oldId} to ${myId}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
```

- [ ] **Step 8: Add graceful error handling to existing tools**

Wrap each tool handler's catch block to return user-friendly messages. Replace the catch pattern in `list_peers`, `send_message`, `set_summary`:

```ts
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const friendly = msg.includes("fetch failed") || msg.includes("ECONNREFUSED")
          ? "Broker is not reachable. Messages and peer discovery are temporarily unavailable."
          : msg.includes("401")
          ? "Authentication failed. Check your API key and group secret."
          : `Broker error: ${msg}`;
        return {
          content: [{ type: "text" as const, text: friendly }],
          isError: true,
        };
      }
```

- [ ] **Step 9: Update MCP instructions**

Update the `instructions` string in the MCP Server constructor to mention the new tools:

Add to the available tools list:
```
- set_id: Set a custom peer ID (e.g. 'my-review-bot')
- switch_id: Switch to a different peer identity if the wrong one was auto-resumed
```

- [ ] **Step 10: Commit**

```bash
git add server.ts
git commit -m "feat: session persistence, fixed reconnect, set_id/switch_id, graceful errors"
```

---

### Task 5: Run tests and type check

**Files:**
- Possibly fix: any file with issues

- [ ] **Step 1: Run session unit tests**

Run: `bun test shared/session.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 2: Run auth unit tests**

Run: `bun test shared/auth.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 3: Run broker integration tests in Docker**

Run: `docker run --rm -v $(pwd):/app -w /app oven/bun:latest bun test broker.test.ts`
Expected: All 11 tests PASS. Some may need updating if the DB schema migration causes issues — fix as needed.

- [ ] **Step 4: Run TypeScript type check**

Run: `bunx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Fix any issues found, commit**

```bash
git add -A
git commit -m "fix: resolve test and type check issues"
```

---

### Task 6: Update broker.test.ts for new features

**Files:**
- Modify: `broker.test.ts`

- [ ] **Step 1: Add tests for /resume, /set-id, and dormant unregister**

Append to `broker.test.ts`:

```ts
test("resume succeeds for dormant peer", async () => {
  // Register a peer
  const reg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "resume-group",
      pid: 20001, hostname: "h", cwd: "/r", git_root: null, summary: "",
    }),
  });
  const peer = await reg.json() as { id: string; instance_token: string };

  // Unregister (sets dormant)
  await fetch(`${BASE_URL}/unregister`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${peer.instance_token}` },
    body: JSON.stringify({}),
  });

  // Resume
  const resumeRes = await fetch(`${BASE_URL}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instance_token: peer.instance_token }),
  });
  expect(resumeRes.ok).toBe(true);
  const resumed = await resumeRes.json() as { id: string };
  expect(resumed.id).toBe(peer.id);
});

test("resume fails with active WS connection", async () => {
  const reg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "resume-ws-group",
      pid: 20002, hostname: "h", cwd: "/r2", git_root: null, summary: "",
    }),
  });
  const peer = await reg.json() as { id: string; instance_token: string };

  // Connect WS
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws?token=${peer.instance_token}`);
  await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });

  // Try resume — should get 409
  const resumeRes = await fetch(`${BASE_URL}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instance_token: peer.instance_token }),
  });
  expect(resumeRes.status).toBe(409);

  ws.close();
});

test("set-id changes peer ID", async () => {
  const reg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "setid-group",
      pid: 20003, hostname: "h", cwd: "/s", git_root: null, summary: "",
    }),
  });
  const peer = await reg.json() as { id: string; instance_token: string };

  const setRes = await fetch(`${BASE_URL}/set-id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${peer.instance_token}` },
    body: JSON.stringify({ new_id: "my-custom-id" }),
  });
  expect(setRes.ok).toBe(true);
  const data = await setRes.json() as { id: string };
  expect(data.id).toBe("my-custom-id");
});

test("set-id rejects duplicate ID in same group", async () => {
  const reg1 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "dup-group",
      pid: 20004, hostname: "h", cwd: "/d1", git_root: null, summary: "",
    }),
  });
  const peer1 = await reg1.json() as { id: string; instance_token: string };

  // Set custom ID
  await fetch(`${BASE_URL}/set-id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${peer1.instance_token}` },
    body: JSON.stringify({ new_id: "taken-id" }),
  });

  // Register second peer in same group
  const reg2 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "dup-group",
      pid: 20005, hostname: "h", cwd: "/d2", git_root: null, summary: "",
    }),
  });
  const peer2 = await reg2.json() as { id: string; instance_token: string };

  // Try same ID — should fail
  const setRes = await fetch(`${BASE_URL}/set-id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${peer2.instance_token}` },
    body: JSON.stringify({ new_id: "taken-id" }),
  });
  expect(setRes.status).toBe(409);
});

test("dormant peers are excluded from list-peers", async () => {
  const reg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "dormant-group",
      pid: 20006, hostname: "h", cwd: "/dorm", git_root: null, summary: "will go dormant",
    }),
  });
  const peer = await reg.json() as { id: string; instance_token: string };

  // Register a second peer to do the listing
  const reg2 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "dormant-group",
      pid: 20007, hostname: "h", cwd: "/dorm2", git_root: null, summary: "lister",
    }),
  });
  const lister = await reg2.json() as { id: string; instance_token: string };

  // Unregister first peer (dormant)
  await fetch(`${BASE_URL}/unregister`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${peer.instance_token}` },
    body: JSON.stringify({}),
  });

  // List peers — dormant peer should NOT appear
  const listRes = await fetch(`${BASE_URL}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${lister.instance_token}` },
    body: JSON.stringify({ scope: "group", cwd: "/dorm2", hostname: "h", git_root: null }),
  });
  const peers = await listRes.json() as Array<{ id: string }>;
  const ids = peers.map((p) => p.id);
  expect(ids).not.toContain(peer.id);
});
```

- [ ] **Step 2: Do NOT run the tests (sandbox only)**

- [ ] **Step 3: Commit**

```bash
git add broker.test.ts
git commit -m "test: add tests for resume, set-id, dormant unregister"
```
