# 跨组会话隔离 Bug 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复相同 peer_id 跨 group 无隔离的 bug：会话文件按 (group_id, peer_id) 命名，`switch_id` 增加 group 校验，兼容迁移旧格式文件。

**Architecture:** 纯客户端修复（broker 不改）。`shared/session.ts` 重构：文件名引入 `group_id` 前缀；`loadSession`/`deleteSession` 签名加 `groupId` 参数；新增 `migrateSessionFiles` 迁移旧文件。`server.ts` 所有调用点显式传 `GROUP_ID`，`switch_id` 增加断言。

**Tech Stack:** Bun + TypeScript + `bun:test`。

**Design spec:** `doc/design/2026-04-21-cross-group-session-isolation.md`

**附加 bug**：broker 启动时 `cleanStale` 访问未初始化的 `wsPool`（TDZ）。见 Task 0。

---

## File Structure

**Modify:**
- `broker.ts` — `wsPool` 声明前移（Task 0）
- `shared/session.ts` — 文件名方案、新签名、迁移函数
- `server.ts` — 所有 session 函数调用点

**Create:**
- `tests/session.test.ts` — session 模块单元测试（跨组隔离 + 迁移）
- `tests/broker-startup.test.ts` — broker 在存在过期 peers 的 DB 上能正常启动

---

## Task 0: 修复 broker 启动 TDZ 崩溃

**Files:**
- Create: `tests/broker-startup.test.ts`
- Modify: `broker.ts`

- [ ] **Step 1: 写失败测试**

写入 `tests/broker-startup.test.ts`：

```ts
/**
 * Regression test for the TDZ crash: cleanStale() runs at module load and
 * touches wsPool, which was declared AFTER cleanStale's first invocation.
 * Pre-seed the SQLite DB with a stale peer so cleanStale actually enters
 * the wsPool branch on startup. Without the fix, broker exits non-zero
 * before the /health endpoint becomes available.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_KEY = "test-api-key";
let brokerProc: Subprocess | null = null;
let tmpDir = "";

async function pickFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  return port;
}

async function waitForBroker(url: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      if (res.ok) return true;
    } catch {
      // not ready
    }
    await Bun.sleep(50);
  }
  return false;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-startup-"));
});

afterAll(async () => {
  if (brokerProc) {
    brokerProc.kill();
    await brokerProc.exited;
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test("broker starts successfully when DB has stale peers awaiting cleanup", async () => {
  const dbPath = join(tmpDir, "broker.db");

  // Pre-seed a stale peer row (last_seen far in the past, status active)
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      group_id TEXT PRIMARY KEY,
      group_secret_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      doc TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS peers (
      instance_token TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      hostname TEXT NOT NULL,
      cwd TEXT NOT NULL,
      git_root TEXT,
      summary TEXT NOT NULL DEFAULT '',
      group_id TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      role TEXT NOT NULL DEFAULT 'unknown',
      UNIQUE(id, group_id),
      FOREIGN KEY (group_id) REFERENCES groups(group_id)
    );
  `);
  const oldIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  db.exec(
    `INSERT INTO groups (group_id, group_secret_hash, created_at) VALUES ('g1', 'h', '${oldIso}')`
  );
  db.exec(
    `INSERT INTO peers (instance_token, id, pid, hostname, cwd, summary, group_id, last_seen, status, role)
     VALUES ('${"t".repeat(64)}', 'stale', 1, 'h', '/tmp', '', 'g1', '${oldIso}', 'active', 'unknown')`
  );
  db.close();

  const port = await pickFreePort();
  const url = `http://127.0.0.1:${port}`;
  brokerProc = spawn({
    cmd: ["bun", "broker.ts"],
    env: {
      ...process.env,
      CLAUDE_PEERS_API_KEY: API_KEY,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const healthy = await waitForBroker(url);
  expect(healthy).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/broker-startup.test.ts`
Expected: FAIL（broker 子进程崩溃退出，`/health` 永远不响应，`waitForBroker` 超时返回 false）。

- [ ] **Step 3: 修复 broker.ts — 把 wsPool 声明块前移**

在 `broker.ts` 中查找 wsPool 声明位置（约 line 385-391）：

```ts
// --- WebSocket connection pool (keyed by instance_token) ---

type WsData = { connId: string; instanceToken: string | null };
const wsPool = new Map<string, ServerWebSocket<WsData>>();
// Connections waiting for auth message
const pendingConnections = new Map<string, ReturnType<typeof setTimeout>>();
const WS_AUTH_TIMEOUT_MS = 5000;
```

把这整块（包括上方的注释分隔线）**移到 `function cleanStale()` 定义之前**（约 line 342 位置，紧挨 `selectAllGroupsWithCounts` 声明之后）。原位置仅保留注释 `// wsPool declared above` 或直接删除该分隔线。

推荐实现：用一次 Edit 删除原位置的那一块，再用另一次 Edit 在新位置插入。代码语义完全不变，只是声明顺序上移。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/broker-startup.test.ts`
Expected: PASS。

- [ ] **Step 5: 跑全量测试确认无回归**

Run: `bun test`
Expected: 所有既有测试通过。

- [ ] **Step 6: Commit**

```bash
git add broker.ts tests/broker-startup.test.ts
git commit -m "fix(broker): hoist wsPool declaration above cleanStale call

cleanStale() runs at module load and reads wsPool, but wsPool was
declared later in the module. When the SQLite DB contained stale peers
on startup, cleanStale entered the wsPool branch and hit a TDZ
ReferenceError, preventing the broker from starting.

Fix: move the wsPool/pendingConnections/WS_AUTH_TIMEOUT_MS block above
the first cleanStale() invocation. No behavioural change otherwise."
```

---

## Task 1: 跨组文件名隔离 — 写失败测试

**Files:**
- Create: `tests/session.test.ts`

- [ ] **Step 1: 写 "跨组同名 peer 可共存" 的测试**

写入 `tests/session.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveSession,
  loadSession,
  deleteSession,
  scanSessions,
  migrateSessionFiles,
} from "../shared/session.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-test-"));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const groupA = "a".repeat(32);
const groupB = "b".repeat(32);

test("saveSession writes distinct files for same peer_id across groups", () => {
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp/a",
    group_id: groupA,
    hostname: "host1",
    summary: "A",
  });
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "u".repeat(64),
    cwd: "/tmp/b",
    group_id: groupB,
    hostname: "host1",
    summary: "B",
  });

  const files = readdirSync(dir).sort();
  expect(files).toEqual([
    `${groupA}_manager.json`,
    `${groupB}_manager.json`,
  ]);
});

test("loadSession returns only the matching group's session", () => {
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp",
    group_id: groupA,
    hostname: "host1",
    summary: "A",
  });
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "u".repeat(64),
    cwd: "/tmp",
    group_id: groupB,
    hostname: "host1",
    summary: "B",
  });

  const a = loadSession(dir, groupA, "manager");
  const b = loadSession(dir, groupB, "manager");
  expect(a?.summary).toBe("A");
  expect(a?.group_id).toBe(groupA);
  expect(b?.summary).toBe("B");
  expect(b?.group_id).toBe(groupB);
});

test("loadSession returns null for missing (group, peer) combination", () => {
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp",
    group_id: groupA,
    hostname: "host1",
  });
  expect(loadSession(dir, groupB, "manager")).toBeNull();
});

test("deleteSession removes only the targeted (group, peer) file", () => {
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp",
    group_id: groupA,
    hostname: "host1",
  });
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "u".repeat(64),
    cwd: "/tmp",
    group_id: groupB,
    hostname: "host1",
  });

  deleteSession(dir, groupA, "manager");
  expect(existsSync(join(dir, `${groupA}_manager.json`))).toBe(false);
  expect(existsSync(join(dir, `${groupB}_manager.json`))).toBe(true);
});

test("scanSessions returns only sessions for the given group", () => {
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp",
    group_id: groupA,
    hostname: "host1",
  });
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "u".repeat(64),
    cwd: "/tmp",
    group_id: groupB,
    hostname: "host1",
  });

  const a = scanSessions(dir, "/tmp", groupA, "host1");
  const b = scanSessions(dir, "/tmp", groupB, "host1");
  expect(a.length).toBe(1);
  expect(a[0].group_id).toBe(groupA);
  expect(b.length).toBe(1);
  expect(b[0].group_id).toBe(groupB);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/session.test.ts`
Expected: 编译失败 — `loadSession` / `deleteSession` 当前签名只接两个参数，测试调用形式与当前实现不一致。`migrateSessionFiles` 也未导出。

- [ ] **Step 3: Commit 仅测试文件（红灯 commit）**

```bash
git add tests/session.test.ts
git commit -m "test: add failing cross-group session isolation tests"
```

---

## Task 2: 修改 `shared/session.ts` 文件名方案

**Files:**
- Modify: `shared/session.ts`

- [ ] **Step 1: 重写 `shared/session.ts`**

完整替换文件内容为：

```ts
import {
  mkdirSync,
  readdirSync,
  unlinkSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { isValidPeerId } from "./auth.ts";

export interface SessionData {
  peer_id: string;
  instance_token: string;
  cwd: string;
  group_id: string;
  hostname: string;
  summary?: string;
  created_at?: string;
  last_used?: string;
}

/** Reject peer IDs that could escape the sessions directory. */
const isSafePeerId = isValidPeerId;

/** 32 lowercase hex chars — matches deriveGroupId's output. */
const GROUP_ID_REGEX = /^[a-f0-9]{32}$/;

function isSafeGroupId(groupId: string): boolean {
  return GROUP_ID_REGEX.test(groupId);
}

function sessionFileName(groupId: string, peerId: string): string {
  return `${groupId}_${peerId}.json`;
}

/** Matches new-scheme filenames: `${32-hex}_${peer_id}.json`. */
const NEW_FORMAT_REGEX = /^[a-f0-9]{32}_[a-z0-9][a-z0-9-]{0,31}\.json$/;

export function saveSession(dir: string, data: SessionData): void {
  if (!isSafePeerId(data.peer_id)) return;
  if (!isSafeGroupId(data.group_id)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const record = {
    ...data,
    created_at: data.created_at ?? now,
    last_used: now,
  };
  const filePath = join(dir, sessionFileName(data.group_id, data.peer_id));
  writeFileSync(filePath, JSON.stringify(record, null, 2));
  chmodSync(filePath, 0o600);
}

export function loadSession(
  dir: string,
  groupId: string,
  peerId: string
): SessionData | null {
  if (!isSafePeerId(peerId) || !isSafeGroupId(groupId)) return null;
  const file = join(dir, sessionFileName(groupId, peerId));
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SessionData;
  } catch {
    return null;
  }
}

export function scanSessions(
  dir: string,
  cwd: string,
  groupId: string,
  hostname: string
): SessionData[] {
  if (!existsSync(dir)) return [];
  if (!isSafeGroupId(groupId)) return [];
  const prefix = `${groupId}_`;
  const files = readdirSync(dir).filter(
    (f) => f.startsWith(prefix) && f.endsWith(".json")
  );
  const sessions: SessionData[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(
        readFileSync(join(dir, file), "utf8")
      ) as SessionData;
      if (!isSafePeerId(data.peer_id)) continue;
      if (data.group_id !== groupId) continue; // defense in depth
      if (data.cwd === cwd && data.hostname === hostname) {
        sessions.push(data);
      }
    } catch {
      // Skip corrupt files
    }
  }
  sessions.sort((a, b) => {
    const ta = a.last_used ?? a.created_at ?? "";
    const tb = b.last_used ?? b.created_at ?? "";
    return tb.localeCompare(ta);
  });
  return sessions;
}

export function deleteSession(
  dir: string,
  groupId: string,
  peerId: string
): void {
  if (!isSafePeerId(peerId) || !isSafeGroupId(groupId)) return;
  const file = join(dir, sessionFileName(groupId, peerId));
  if (existsSync(file)) unlinkSync(file);
}

export function cleanupStaleSessions(dir: string, maxAgeDays: number): void {
  if (!existsSync(dir)) return;
  const cutoff = new Date(
    Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const data = JSON.parse(
        readFileSync(join(dir, file), "utf8")
      ) as SessionData;
      const lastUsed = data.last_used ?? data.created_at ?? "";
      if (lastUsed < cutoff) {
        unlinkSync(join(dir, file));
      }
    } catch {
      // Skip corrupt files
    }
  }
}

/**
 * One-shot migration from the legacy `${peer_id}.json` filename scheme
 * to `${group_id}_${peer_id}.json`. Safe to call on every startup: files
 * already in new format are skipped. Corrupt or unrecognisable legacy
 * files are removed (they cannot be resumed anyway).
 */
export function migrateSessionFiles(dir: string): void {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    if (NEW_FORMAT_REGEX.test(file)) continue; // already migrated
    const oldPath = join(dir, file);
    try {
      const data = JSON.parse(readFileSync(oldPath, "utf8")) as SessionData;
      if (
        isSafePeerId(data.peer_id) &&
        isSafeGroupId(data.group_id) &&
        data.peer_id === file.replace(/\.json$/, "")
      ) {
        const newPath = join(dir, sessionFileName(data.group_id, data.peer_id));
        if (existsSync(newPath)) {
          unlinkSync(oldPath);
        } else {
          renameSync(oldPath, newPath);
        }
        continue;
      }
      unlinkSync(oldPath);
    } catch {
      try {
        unlinkSync(oldPath);
      } catch {
        // best-effort
      }
    }
  }
}
```

- [ ] **Step 2: 跑 session 测试确认通过**

Run: `bun test tests/session.test.ts`
Expected: 5 个已写的测试全部 PASS。

- [ ] **Step 3: 跑全量编译确认 server.ts 还没改（会编译失败）**

Run: `bun run --silent tsc --noEmit 2>&1 || true`（或 `bun build server.ts --target=bun --outdir=/tmp/check 2>&1 | head -20`）

Expected: 看到 server.ts 里 `loadSession(SESSION_DIR, id)` / `deleteSession(SESSION_DIR, xxx)` 参数不匹配的类型错误（证明 Task 3 还需要做）。这一步只是确认破损范围，不阻塞。

- [ ] **Step 4: Commit**

```bash
git add shared/session.ts
git commit -m "refactor(session): key session files by (group_id, peer_id)"
```

---

## Task 3: 更新 `server.ts` 所有调用点

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: 改 deleteSession 的 8 处调用**

按下表在 `server.ts` 中查找并替换（行号以改动前为准，可能随上下文浮动）：

```
Line 247: deleteSession(SESSION_DIR, oldId401)
       → deleteSession(SESSION_DIR, GROUP_ID, oldId401)

Line 253: deleteSession(SESSION_DIR, oldId409)
       → deleteSession(SESSION_DIR, GROUP_ID, oldId409)

Line 620: deleteSession(SESSION_DIR, oldId)
       → deleteSession(SESSION_DIR, GROUP_ID, oldId)

Line 659: deleteSession(SESSION_DIR, myId)
       → deleteSession(SESSION_DIR, GROUP_ID, myId)

Line 677: deleteSession(SESSION_DIR, targetSession.peer_id)
       → deleteSession(SESSION_DIR, targetSession.group_id, targetSession.peer_id)

Line 830: deleteSession(SESSION_DIR, session.peer_id)
       → deleteSession(SESSION_DIR, GROUP_ID, session.peer_id)

Line 861: deleteSession(SESSION_DIR, session.peer_id)
       → deleteSession(SESSION_DIR, GROUP_ID, session.peer_id)
```

用精确 grep 定位后 Edit 一行一行改，避免误伤。例如：

```bash
grep -n 'deleteSession(SESSION_DIR,' server.ts
```

- [ ] **Step 2: 改 loadSession 调用（line 633）**

```
loadSession(SESSION_DIR, id)
  → loadSession(SESSION_DIR, GROUP_ID, id)
```

- [ ] **Step 3: 编译通过确认**

Run: `bun build server.ts --target=bun --outdir=/tmp/check 2>&1 | tail -20`
Expected: 无类型错误。如仍有，按错误提示把遗漏的调用点补齐。

- [ ] **Step 4: 跑全量测试（不包括本次新加的跨组集成）**

Run: `bun test`
Expected: 既有 broker 测试全绿，新加的 session 单元测试全绿。

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "refactor(server): pass GROUP_ID to all session API calls"
```

---

## Task 4: `switch_id` 增加 group 校验（Fix A）

**Files:**
- Modify: `server.ts`（switch_id handler, 约 line 628-686）

- [ ] **Step 1: 定位 switch_id handler**

```bash
grep -n '"switch_id"' server.ts
```

- [ ] **Step 2: 在 loadSession 之后加断言**

找到：

```ts
const targetSession = loadSession(SESSION_DIR, GROUP_ID, id);
if (!targetSession) {
  return { content: [{ type: "text" as const, text: `No local session found for peer ${id}` }], isError: true };
}
```

在其后（`try {` 之前）插入：

```ts
// Defense in depth: after the file-name scheme change loadSession cannot
// return a foreign-group session, but keep an explicit check in case a
// legacy/corrupt file leaks through migration.
if (targetSession.group_id !== GROUP_ID) {
  deleteSession(SESSION_DIR, targetSession.group_id, targetSession.peer_id);
  return {
    content: [{
      type: "text" as const,
      text: `Session file for peer ${id} belongs to a different group; removed. Re-register if needed.`,
    }],
    isError: true,
  };
}
```

- [ ] **Step 3: 跑测试**

Run: `bun test`
Expected: 全部通过。

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "fix(server): guard switch_id against cross-group session files"
```

---

## Task 5: 旧格式文件迁移（Fix C）

**Files:**
- Modify: `server.ts`（main() 中 tryResumeSession 调用前）
- Modify: `tests/session.test.ts`（加迁移测试）

- [ ] **Step 1: 写迁移失败测试**

在 `tests/session.test.ts` 末尾追加：

```ts
import { writeFileSync } from "node:fs";

test("migrateSessionFiles renames legacy peer_id.json → group_id_peer_id.json", () => {
  const data = {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp",
    group_id: groupA,
    hostname: "host1",
    created_at: "2026-04-20T00:00:00Z",
    last_used: "2026-04-20T00:00:00Z",
  };
  writeFileSync(join(dir, "manager.json"), JSON.stringify(data));

  migrateSessionFiles(dir);

  const files = readdirSync(dir).sort();
  expect(files).toEqual([`${groupA}_manager.json`]);
  const loaded = loadSession(dir, groupA, "manager");
  expect(loaded?.instance_token).toBe("t".repeat(64));
});

test("migrateSessionFiles deletes corrupt or unidentifiable legacy files", () => {
  writeFileSync(join(dir, "foo.json"), "{not valid json");
  writeFileSync(join(dir, "bar.json"), JSON.stringify({ peer_id: "bar" })); // no group_id

  migrateSessionFiles(dir);

  expect(readdirSync(dir)).toEqual([]);
});

test("migrateSessionFiles is idempotent on already-migrated files", () => {
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp",
    group_id: groupA,
    hostname: "host1",
  });
  const before = readdirSync(dir);
  migrateSessionFiles(dir);
  const after = readdirSync(dir);
  expect(after).toEqual(before);
});

test("migrateSessionFiles drops legacy file when new-format target already exists", () => {
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp",
    group_id: groupA,
    hostname: "host1",
  });
  // legacy file referring to the same (group, peer)
  writeFileSync(
    join(dir, "manager.json"),
    JSON.stringify({
      peer_id: "manager",
      instance_token: "u".repeat(64),
      cwd: "/tmp",
      group_id: groupA,
      hostname: "host1",
    })
  );

  migrateSessionFiles(dir);

  const files = readdirSync(dir);
  expect(files).toEqual([`${groupA}_manager.json`]);
  // New-format wins
  expect(loadSession(dir, groupA, "manager")?.instance_token).toBe("t".repeat(64));
});
```

- [ ] **Step 2: 跑测试确认通过**

Run: `bun test tests/session.test.ts`
Expected: 全部 9 个测试 PASS（5 个原有 + 4 个新加）。`migrateSessionFiles` 已在 Task 2 实现。

- [ ] **Step 3: 在 server.ts 启动流程中调用 migrateSessionFiles**

定位 `async function main()`，在 `cleanupStaleSessions` 附近（tryResumeSession 之前）调用。

查找：

```bash
grep -n 'cleanupStaleSessions\|tryResumeSession' server.ts
```

在 `server.ts` 顶部 import 处追加 `migrateSessionFiles`：

```ts
import {
  saveSession,
  loadSession,
  scanSessions,
  deleteSession,
  cleanupStaleSessions,
  migrateSessionFiles,
} from "./shared/session.ts";
```

在 `tryResumeSession` 函数内、`cleanupStaleSessions` 调用之后追加一行：

```ts
async function tryResumeSession(): Promise<boolean> {
  cleanupStaleSessions(SESSION_DIR, SESSION_CLEANUP_AGE_DAYS);
  migrateSessionFiles(SESSION_DIR);
  const sessions = scanSessions(SESSION_DIR, myCwd, GROUP_ID, myHostname);
  ...
}
```

- [ ] **Step 4: 跑全量测试**

Run: `bun test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add tests/session.test.ts server.ts
git commit -m "feat(session): migrate legacy session files to new naming scheme"
```

---

## Task 6: 端到端冒烟验证 + 文档更新 + PR

**Files:**
- Modify: `CLAUDE.md` 或 `README.md`（如果提到 session 目录约定）

- [ ] **Step 1: 确认文档无需改动**

Run: `grep -rn "\.claude-peers/sessions\|session.*peer_id\.json" README.md CLAUDE.md doc/`
Expected: 若只有实现注释提到，保持原状；若 README 明确描述旧文件名格式，更新成新格式。当前 README 未外部化这个细节，多半无需动。

- [ ] **Step 2: 手动复现冒烟（tester 交付）**

tester 按 `doc/design/2026-04-21-cross-group-session-isolation.md` "问题现象" 章节的步骤复现一次：

1. 启动本地 broker
2. 起两个 Claude Code 会话，分别用不同 `--group-secret`
3. 两边都 `set_id("manager")`
4. `cli peers` 分别查两个组
5. 预期：两个组各自看到一个 `manager` peer，互不干扰

将测试过程与结论写入 `doc/test/2026-04-21-cross-group-isolation-report.md`。

- [ ] **Step 3: 创建 PR**

```bash
git push -u origin fix/cross-group-session-isolation
gh pr create --title "fix: isolate peer sessions across groups + broker startup crash" --body "$(cat <<'EOF'
## Summary
- `broker.ts` 启动 TDZ 修复：`wsPool` 声明前移至 `cleanStale` 调用前，避免 DB 中存在过期 peer 时启动崩溃
- `shared/session.ts` 文件名改为 `\${group_id}_\${peer_id}.json`，彻底避免跨组同名覆盖
- `switch_id` 显式校验 session.group_id，防御性拦住篡改/残留
- `migrateSessionFiles` 一次性把旧格式文件按内部 group_id 迁移到新方案
- 新增 `tests/session.test.ts`（9 个单元测试）、`tests/broker-startup.test.ts`（1 个回归测试）

## Test plan
- [x] `bun test` 全绿（session 单元测试 + broker 启动回归测试 + 既有 broker 集成测试）
- [ ] tester 手动跑跨组 set_id 复现场景，结果记录于 `doc/test/2026-04-21-cross-group-isolation-report.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: manager 代码审查**

manager 沿用既有做法：通读 diff，重点关注：
1. 所有 `deleteSession` / `loadSession` 调用点是否都迁移
2. 迁移函数的文件名正则是否严谨（group_id 固定 32 hex，peer_id 合规）
3. `scanSessions` 是否仍保留 `data.group_id !== groupId` 的防御检查

必要时用 `code-reviewer` subagent 独立审查一轮。

- [ ] **Step 5: tester 验证通过 → manager 合并 PR**

```bash
gh pr merge --squash
```

---

## Self-Review 结果

**Spec 覆盖率**：
- 附加 bug（broker TDZ 启动崩溃）→ Task 0 ✓
- Fix B（文件名方案）→ Task 2（session.ts 重写）+ Task 3（server.ts 调用点）✓
- Fix A（switch_id 校验）→ Task 4 ✓
- Fix C（迁移）→ Task 5 ✓
- 测试覆盖 → Task 0（启动回归 1 个）+ Task 1（跨组隔离 5 个）+ Task 5（迁移 4 个）✓
- 手动复现 → Task 6 Step 2 ✓

**Placeholder 扫描**：无 TBD/TODO；所有代码块都有完整内容。

**类型一致性**：
- `saveSession(dir, data)` 签名不变
- `loadSession(dir, groupId, peerId)` / `deleteSession(dir, groupId, peerId)` 所有位置签名一致
- `migrateSessionFiles(dir)` 签名在 Task 2 定义、Task 5 使用，一致
- `NEW_FORMAT_REGEX` 与 `sessionFileName` 输出匹配：`${32-hex}_${peer_id}.json`，一致
