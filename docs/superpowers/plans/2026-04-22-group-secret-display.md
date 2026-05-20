# Group Secret Display Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the original `group_secret` in the broker database so `/admin/groups` and CLI `groups` can display human-readable group names instead of SHA-256 digests.

**Architecture:** Add a `group_secret` column to the `groups` table (nullable for backward compatibility). Update `/register` to populate it. Update `/admin/groups` to return it. Update CLI `groups` to display it. Historical groups with `NULL` show as `(unknown)`.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bun:test`

---

## File Map

| File | Responsibility |
|------|---------------|
| `broker.ts` | SQLite schema, prepared statements, `/register` handler, `/admin/groups` endpoint |
| `cli.ts` | `groups` command output formatting |
| `tests/broker-groups.test.ts` | New test verifying `group_secret` in `/admin/groups` response |
| `README.md` | Upgrade notes for clearing historical data |

---

### Task 1: Database Schema Migration

**Files:**
- Modify: `broker.ts:58-64` (CREATE TABLE groups)
- Modify: `broker.ts` (add migration after existing migrations)

- [ ] **Step 1: Add `group_secret` column to `groups` table schema**

In `broker.ts`, update the `CREATE TABLE IF NOT EXISTS groups` statement (around line 58):

```ts
db.run(`
  CREATE TABLE IF NOT EXISTS groups (
    group_id TEXT PRIMARY KEY,
    group_secret_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    group_secret TEXT
  )
`);
```

- [ ] **Step 2: Add migration for existing databases**

After the existing migration block (after the `if (oldColNames.has("instance_token")...` block, around line 200), add:

```ts
// Migration: add group_secret column to groups table if missing
{
  const groupCols = db.query("PRAGMA table_info(groups)").all() as Array<{ name: string }>;
  if (!groupCols.some((c) => c.name === "group_secret")) {
    db.run("ALTER TABLE groups ADD COLUMN group_secret TEXT");
  }
}
```

- [ ] **Step 3: Run full test suite to confirm no regressions**

```bash
bun test
```

Expected: 71 pass, 0 fail (schema change should not break existing tests since column is nullable)

- [ ] **Step 4: Commit**

```bash
git add broker.ts
git commit -m "feat: add group_secret column to groups table"
```

---

### Task 2: Update insertGroup to Store group_secret

**Files:**
- Modify: `broker.ts:205-208` (insertGroup prepared statement)
- Modify: `broker.ts:443` (insertGroup.run call in handleRegister)

- [ ] **Step 1: Update insertGroup SQL**

In `broker.ts`, change `insertGroup` (around line 205):

```ts
const insertGroup = db.prepare(`
  INSERT OR IGNORE INTO groups (group_id, group_secret_hash, created_at, group_secret)
  VALUES (?, ?, ?, ?)
`);
```

- [ ] **Step 2: Pass group_secret in handleRegister**

In `handleRegister` (around line 443), update the `insertGroup.run` call:

```ts
if (!existingGroup) {
  insertGroup.run(groupId, secretHash, new Date().toISOString(), body.group_secret);
}
```

- [ ] **Step 3: Run full test suite**

```bash
bun test
```

Expected: 71 pass, 0 fail

- [ ] **Step 4: Commit**

```bash
git add broker.ts
git commit -m "feat: store group_secret on register"
```

---

### Task 3: Update /admin/groups to Return group_secret

**Files:**
- Modify: `broker.ts:335-341` (selectAllGroupsWithCounts SQL)
- Modify: `broker.ts:881-886` (/admin/groups endpoint response)

- [ ] **Step 1: Update selectAllGroupsWithCounts SQL**

In `broker.ts`, change `selectAllGroupsWithCounts` (around line 335):

```ts
const selectAllGroupsWithCounts = db.prepare(`
  SELECT g.group_id, g.group_secret, g.created_at,
         COUNT(CASE WHEN p.status = 'active' THEN 1 END) AS active_peers
  FROM groups g
  LEFT JOIN peers p ON p.group_id = g.group_id
  GROUP BY g.group_id, g.group_secret, g.created_at
`);
```

- [ ] **Step 2: Update /admin/groups endpoint to return group_secret**

In `broker.ts`, update the `/admin/groups` handler (around line 881):

```ts
const groups = selectAllGroupsWithCounts.all() as Array<{
  group_id: string;
  group_secret: string | null;
  created_at: string;
  active_peers: number;
}>;
const result = groups.map((g) => ({
  group_id: g.group_id,
  group_secret: g.group_secret ?? "(unknown)",
  created_at: g.created_at,
  active_peers: g.active_peers,
}));
return Response.json(result);
```

- [ ] **Step 3: Run full test suite**

```bash
bun test
```

Expected: 71 pass, 0 fail

- [ ] **Step 4: Commit**

```bash
git add broker.ts
git commit -m "feat: return group_secret in /admin/groups endpoint"
```

---

### Task 4: Update CLI groups Command

**Files:**
- Modify: `cli.ts:206-230` (groups command)

- [ ] **Step 1: Update groups command to display group_secret**

In `cli.ts`, update the `groups` command handler (around line 213):

```ts
const groups = await res.json() as Array<{
  group_id: string;
  group_secret: string;
  created_at: string;
  active_peers: number;
}>;
if (groups.length === 0) {
  console.log("No groups registered.");
} else {
  console.log(`${groups.length} group(s):`);
  for (const g of groups) {
    console.log(`  ${g.group_secret}  peers=${g.active_peers}  created=${g.created_at}`);
  }
}
```

- [ ] **Step 2: Run full test suite**

```bash
bun test
```

Expected: 71 pass, 0 fail

- [ ] **Step 3: Commit**

```bash
git add cli.ts
git commit -m "feat: display group_secret in CLI groups command"
```

---

### Task 5: Add Test for group_secret in /admin/groups

**Files:**
- Create: `tests/broker-groups.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/broker-groups.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_KEY = "test-api-key";
const GROUP_SECRET = "my-test-group";

let brokerProc: Subprocess | null = null;
let tmpDir = "";
let url = "";

async function pickFreePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = s.port;
  s.stop(true);
  return port;
}

async function waitForBroker(u: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${u}/health`, { headers: { Authorization: `Bearer ${API_KEY}` } });
      if (res.ok) return true;
    } catch { /* not ready */ }
    await Bun.sleep(50);
  }
  return false;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-groups-"));
  const port = await pickFreePort();
  url = `http://127.0.0.1:${port}`;
  brokerProc = spawn({
    cmd: ["bun", "broker.ts"],
    env: {
      ...process.env,
      CLAUDE_PEERS_API_KEY: API_KEY,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: join(tmpDir, "broker.db"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const ok = await waitForBroker(url);
  if (!ok) throw new Error("broker failed to start");
});

afterAll(async () => {
  if (brokerProc) {
    brokerProc.kill();
    await brokerProc.exited;
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test("/admin/groups returns group_secret for newly registered group", async () => {
  // Register a peer to create the group
  const registerRes = await fetch(`${url}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      group_secret: GROUP_SECRET,
      pid: process.pid,
      hostname: "test-host",
      cwd: "/tmp/test",
      git_root: null,
      summary: "",
    }),
  });
  expect(registerRes.ok).toBe(true);

  // Call /admin/groups
  const res = await fetch(`${url}/admin/groups`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  expect(res.ok).toBe(true);
  const groups = (await res.json()) as Array<{
    group_id: string;
    group_secret: string;
    created_at: string;
    active_peers: number;
  }>;

  expect(groups.length).toBe(1);
  expect(groups[0].group_secret).toBe(GROUP_SECRET);
  expect(groups[0].active_peers).toBe(1);
});

test("/admin/groups returns (unknown) for historical groups without group_secret", async () => {
  // Manually insert a group without group_secret to simulate historical data
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(tmpDir, "broker.db"));
  db.run(`
    INSERT INTO groups (group_id, group_secret_hash, created_at, group_secret)
    VALUES ('legacy-group-id', 'legacy-hash', '2024-01-01T00:00:00Z', NULL)
  `);
  db.close();

  const res = await fetch(`${url}/admin/groups`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  expect(res.ok).toBe(true);
  const groups = (await res.json()) as Array<{
    group_id: string;
    group_secret: string;
    created_at: string;
    active_peers: number;
  }>;

  const legacyGroup = groups.find((g) => g.group_id === "legacy-group-id");
  expect(legacyGroup).toBeDefined();
  expect(legacyGroup!.group_secret).toBe("(unknown)");
});
```

- [ ] **Step 2: Run the new test to verify it passes**

```bash
bun test tests/broker-groups.test.ts
```

Expected: 2 pass, 0 fail

- [ ] **Step 3: Run full test suite to confirm no regressions**

```bash
bun test
```

Expected: 73 pass (71 existing + 2 new), 0 fail

- [ ] **Step 4: Commit**

```bash
git add tests/broker-groups.test.ts
git commit -m "test: add tests for group_secret in /admin/groups"
```

---

### Task 6: Update README with Upgrade Notes

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add upgrade note in Troubleshooting section**

In `README.md`, after the existing "Broker startup fails with a SQLite schema error" section (around line 443), add a new subsection:

```markdown
**Upgrading from pre-group-secret versions**

If you see `(unknown)` as the group name when running `bun cli.ts groups`, your broker database was created before the `group_secret` column was added. To fix this:

```bash
# Stop the broker
kill $(pgrep -f 'bun.*broker\.ts') 2>/dev/null

# Remove the database (peers will re-register automatically)
rm -f ~/.claude-peers.db ~/.claude-peers.db-wal ~/.claude-peers.db-shm

# Restart the broker
CLAUDE_PEERS_API_KEY=your-key bun broker.ts
```

After restart, all peers will re-register and `groups` will show the actual group secrets.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add upgrade note for group_secret column"
```

---

## Self-Review

**1. Spec coverage:**
- [x] Schema migration (`group_secret` column) → Task 1
- [x] `/register` stores `group_secret` → Task 2
- [x] `/admin/groups` returns `group_secret` → Task 3
- [x] CLI `groups` displays `group_secret` → Task 4
- [x] Historical groups show `(unknown)` → Task 5 (second test)
- [x] README upgrade notes → Task 6

**2. Placeholder scan:** No TBD, TODO, or vague requirements found.

**3. Type consistency:** `group_secret` used consistently as `string | null` in DB, `string` in API response (with `(unknown)` fallback).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-22-group-secret-display.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
