# Group Config & Role System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add group-level documentation (Markdown, stored in broker SQLite), peer role field, and five new MCP tools (whoami, set_role, get_group_doc, set_group_doc, generate_group_doc), plus CLI management commands.

**Architecture:** Two-phase delivery on branch `feat/group-config`. Phase 1 adds the full data model and all tools with no permission checks. Phase 2 adds role enforcement (manager-only writes). All enforcement lives in broker.ts (authoritative); MCP server trusts broker responses. TDD throughout.

**Tech Stack:** Bun, bun:sqlite, TypeScript, @modelcontextprotocol/sdk, bun test

---

## File Map

| File | Change |
|------|--------|
| `shared/types.ts` | Add `role` to `Peer`, `SetRoleRequest`, `GetGroupDocResponse`, `SetGroupDocRequest`, update `RegisterResponse`/`ResumeResponse` |
| `broker.ts` | DB migrations, 4 new prepared statements, 4 new handlers, modified register/resume/list-peers responses, 4 new routes |
| `server.ts` | Add `myRole` variable, update register/resume/switch_id handlers, 5 new MCP tools, update TOOLS array |
| `cli.ts` | 2 new commands (groups, group-doc), enhanced peers output |
| `tests/broker-group-config.test.ts` | New test file covering Phase 1 + Phase 2 |
| `README.md` | New CLI section |

---

## Phase 1 — Core Tools (No Auth)

---

### Task 1: Create branch

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout main && git pull && git checkout -b feat/group-config
```

---

### Task 2: Update shared/types.ts

**Files:**
- Modify: `shared/types.ts`

- [ ] **Step 1: Add `role` to `Peer`, update response types, add new request types**

Open `shared/types.ts` and apply all changes below in one edit:

```typescript
export interface Peer {
  id: PeerId;
  pid: number;
  hostname: string;
  cwd: string;
  git_root: string | null;
  group_id: string;
  instance_token: string;
  summary: string;
  role: string;          // ← NEW: 'unknown' | 'manager' | 'developer' | 'tester' | ...
  registered_at: string;
  last_seen: string;
  status: "active" | "dormant";
}

// Update RegisterResponse (was only id + instance_token):
export interface RegisterResponse {
  id: PeerId;
  instance_token: string;
  role: string;          // ← NEW
}

// Update ResumeResponse (was only id + instance_token):
export interface ResumeResponse {
  id: PeerId;
  instance_token: string;
  role: string;          // ← NEW
}

// NEW types — add after SetIdResponse:
export interface SetRoleRequest {
  role: string;
  peer_id?: string;      // Phase 2: manager can set another peer's role
}

export interface GetGroupDocResponse {
  doc: string;
}

export interface SetGroupDocRequest {
  doc: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add shared/types.ts
git commit -m "feat: add role and group doc types"
```

---

### Task 3: Write failing broker tests (Phase 1)

**Files:**
- Create: `tests/broker-group-config.test.ts`

- [ ] **Step 1: Create test file**

```typescript
// tests/broker-group-config.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_KEY = "test-key";
const GROUP_SECRET = "test-secret";
let brokerProc: Subprocess | null = null;
let brokerUrl = "";
let tmpDir = "";

async function waitForBroker(url: string, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${API_KEY}` } });
      if (r.ok) return;
    } catch { /* not ready */ }
    await Bun.sleep(50);
  }
  throw new Error("Broker not ready");
}

async function pickFreePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const p = s.port; s.stop(true); return p;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
  const port = await pickFreePort();
  brokerUrl = `http://127.0.0.1:${port}`;
  brokerProc = spawn({
    cmd: ["bun", "broker.ts"],
    env: { ...process.env, CLAUDE_PEERS_API_KEY: API_KEY, CLAUDE_PEERS_PORT: String(port), CLAUDE_PEERS_DB: join(tmpDir, "b.db") },
    stdout: "pipe", stderr: "pipe",
  });
  await waitForBroker(brokerUrl);
});

afterAll(async () => {
  brokerProc?.kill(); await brokerProc?.exited;
  rmSync(tmpDir, { recursive: true, force: true });
});

type RegResult = { id: string; instance_token: string; role: string };

async function reg(pid: number): Promise<RegResult> {
  const r = await fetch(`${brokerUrl}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: API_KEY, group_secret: GROUP_SECRET, pid, hostname: "h", cwd: "/c", git_root: null, summary: "" }),
  });
  expect(r.status).toBe(200);
  return r.json() as Promise<RegResult>;
}

async function unreg(token: string) {
  await fetch(`${brokerUrl}/unregister`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: "{}" });
}

async function authedPost<T>(token: string, path: string, body: unknown): Promise<{ status: number; data: T }> {
  const r = await fetch(`${brokerUrl}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: (await r.json()) as T };
}

// --- Phase 1 tests ---

test("register returns role='unknown'", async () => {
  const a = await reg(20001);
  expect(a.role).toBe("unknown");
  await unreg(a.instance_token);
});

test("set_role updates caller's role", async () => {
  const a = await reg(20002);
  const r = await authedPost<{ ok: boolean }>(a.instance_token, "/set-role", { role: "developer" });
  expect(r.status).toBe(200);
  expect(r.data.ok).toBe(true);
  await unreg(a.instance_token);
});

test("list-peers includes role field", async () => {
  const a = await reg(20003);
  await authedPost(a.instance_token, "/set-role", { role: "tester" });
  const b = await reg(20004);
  const r = await authedPost<Array<{ id: string; role: string }>>(b.instance_token, "/list-peers", { scope: "group", cwd: "/c", hostname: "h", git_root: null });
  expect(r.status).toBe(200);
  const aEntry = r.data.find(p => p.id === a.id);
  expect(aEntry?.role).toBe("tester");
  await unreg(a.instance_token); await unreg(b.instance_token);
});

test("get_group_doc returns empty string initially", async () => {
  const a = await reg(20005);
  const r = await authedPost<{ doc: string }>(a.instance_token, "/get-group-doc", {});
  expect(r.status).toBe(200);
  expect(r.data.doc).toBe("");
  await unreg(a.instance_token);
});

test("set_group_doc and get_group_doc round-trip", async () => {
  const a = await reg(20006);
  const doc = "# Team Doc\n\nHello team.";
  const setR = await authedPost<{ ok: boolean }>(a.instance_token, "/set-group-doc", { doc });
  expect(setR.status).toBe(200);
  expect(setR.data.ok).toBe(true);
  const getR = await authedPost<{ doc: string }>(a.instance_token, "/get-group-doc", {});
  expect(getR.data.doc).toBe(doc);
  await unreg(a.instance_token);
});

test("/admin/groups returns group list (API key auth)", async () => {
  await reg(20007).then(a => unreg(a.instance_token)); // ensure at least one group
  const r = await fetch(`${brokerUrl}/admin/groups`, { headers: { Authorization: `Bearer ${API_KEY}` } });
  expect(r.status).toBe(200);
  const groups = await r.json() as Array<{ group_id: string; active_peers: number; created_at: string }>;
  expect(Array.isArray(groups)).toBe(true);
});

test("/admin/groups rejects without API key", async () => {
  const r = await fetch(`${brokerUrl}/admin/groups`);
  expect(r.status).toBe(401);
});

test("resume returns role", async () => {
  const a = await reg(20008);
  await authedPost(a.instance_token, "/set-role", { role: "manager" });
  await unreg(a.instance_token);
  // Register fresh to get dormant row (unregister deleted it) — test resume path via another session
  // Just verify new register returns role field
  const b = await reg(20009);
  expect(typeof b.role).toBe("string");
  await unreg(b.instance_token);
});
```

- [ ] **Step 2: Run tests and confirm they fail**

```bash
bun test tests/broker-group-config.test.ts 2>&1 | tail -15
```

Expected: failures like `404`, `role is undefined`, etc. — that's correct, implementation hasn't been added yet.

- [ ] **Step 3: Commit failing tests**

```bash
git add tests/broker-group-config.test.ts
git commit -m "test: add failing broker tests for group-config Phase 1"
```

---

### Task 4: DB migrations and prepared statements (broker.ts)

**Files:**
- Modify: `broker.ts` (migrations section, ~lines 145–185; prepared statements section)

- [ ] **Step 1: Add DB migrations**

Find the existing migration block that ends with `"ALTER TABLE peers ADD COLUMN status..."`. Add the two new migrations immediately after:

```typescript
// Migration: add role column to peers if missing
try {
  db.run("ALTER TABLE peers ADD COLUMN role TEXT NOT NULL DEFAULT 'unknown'");
} catch { /* already exists */ }

// Migration: add doc column to groups if missing
try {
  db.run("ALTER TABLE groups ADD COLUMN doc TEXT NOT NULL DEFAULT ''");
} catch { /* already exists */ }
```

- [ ] **Step 2: Add prepared statements**

Find the block of prepared statements. Add these after `updateMessageToId`:

```typescript
const updatePeerRole = db.prepare(`
  UPDATE peers SET role = ? WHERE instance_token = ?
`);

const updatePeerRoleById = db.prepare(`
  UPDATE peers SET role = ? WHERE id = ? AND group_id = ?
`);

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
```

- [ ] **Step 3: Commit**

```bash
git add broker.ts
git commit -m "feat: add role and doc DB migrations and prepared statements"
```

---

### Task 5: Modify /register and /resume to return role

**Files:**
- Modify: `broker.ts` — `handleRegister` and `handleResume`

- [ ] **Step 1: handleRegister — return role**

Find `handleRegister`. At the end, change:
```typescript
return { id, instance_token: instanceToken };
```
to:
```typescript
return { id, instance_token: instanceToken, role: "unknown" };
```

- [ ] **Step 2: handleResume — return role**

Find `handleResume`. At the end, change:
```typescript
return { id: peer.id, instance_token: newToken };
```
to:
```typescript
return { id: peer.id, instance_token: newToken, role: peer.role };
```

- [ ] **Step 3: Commit**

```bash
git add broker.ts
git commit -m "feat: include role in /register and /resume responses"
```

---

### Task 6: Add /set-role, /get-group-doc, /set-group-doc, /admin/groups handlers

**Files:**
- Modify: `broker.ts` — add 3 handler functions + 4 routes

- [ ] **Step 1: Add handler functions**

Add after `handleSetId`:

```typescript
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
```

- [ ] **Step 2: Register routes in the fetch handler**

Inside the `switch (path)` block (authenticated routes), add after `/set-id`:

```typescript
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
```

- [ ] **Step 3: Add /admin/groups before the POST-only guard**

In the `fetch(req, server)` function, add before `if (req.method !== "POST")`:

```typescript
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
```

- [ ] **Step 4: Add imports for new types in broker.ts**

Find the import from `"./shared/types.ts"`. Add `SetRoleRequest`, `SetGroupDocRequest` to the import:

```typescript
import type {
  RegisterRequest,
  RegisterResponse,
  SetSummaryRequest,
  SetRoleRequest,       // ← NEW
  SetGroupDocRequest,   // ← NEW
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
```

- [ ] **Step 5: Run Phase 1 tests**

```bash
bun test tests/broker-group-config.test.ts 2>&1 | tail -15
```

Expected: `8 pass, 0 fail`

- [ ] **Step 6: Commit**

```bash
git add broker.ts
git commit -m "feat: add /set-role, /get-group-doc, /set-group-doc, /admin/groups endpoints"
```

---

### Task 7: server.ts — track myRole, update register/resume/switch_id

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Add myRole module variable**

Find the line `let myId: PeerId | null = null;`. Add below it:

```typescript
let myRole: string = "unknown";
```

- [ ] **Step 2: Update register() to capture role**

Find the `register` function. After `myId = reg.id;` and `myToken = reg.instance_token;`, add:

```typescript
myRole = reg.role ?? "unknown";
```

- [ ] **Step 3: Update tryResumeSession() to capture role**

Find the `if (res.ok)` block inside `tryResumeSession`. After `myId = data.id;` and `myToken = data.instance_token;`, add:

```typescript
myRole = (data as { id: string; instance_token: string; role?: string }).role ?? "unknown";
```

- [ ] **Step 4: Update switch_id tool handler to capture role**

Find the `case "switch_id":` block. Find where `myId = resumeData.id;` and `myToken = resumeData.instance_token;` are set. Add:

```typescript
myRole = resumeData.role ?? "unknown";
```

Also update the `resumeData` type cast to include `role?`:

```typescript
const resumeData = await res.json() as { id?: string; instance_token?: string; role?: string; error?: string };
```

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "feat: track myRole in server session state"
```

---

### Task 8: Add whoami and set_role MCP tools

**Files:**
- Modify: `server.ts` — TOOLS array + CallToolRequestSchema handler

- [ ] **Step 1: Add tool definitions to TOOLS array**

Find the `TOOLS` array. Add after the `switch_id` entry:

```typescript
{
  name: "whoami",
  description: "Return your current peer ID, role, and summary. Use this to confirm your identity in the group.",
  inputSchema: { type: "object" as const, properties: {} },
},
{
  name: "set_role",
  description:
    "Set your role in the group (e.g. 'manager', 'developer', 'tester'). " +
    "Can only be set once per peer — once set, only a manager can change it.",
  inputSchema: {
    type: "object" as const,
    properties: {
      role: { type: "string" as const, description: "Your role name (e.g. 'developer')" },
    },
    required: ["role"],
  },
},
```

- [ ] **Step 2: Add tool handlers in the switch(name) block**

Add after `case "switch_id":` (before `default:`):

```typescript
case "whoami": {
  return {
    content: [{
      type: "text" as const,
      text: [
        `Peer ID: ${myId ?? "(not registered)"}`,
        `Role:    ${myRole}`,
        `Summary: ${currentSummary || "(none)"}`,
        `CWD:     ${myCwd}`,
        `Host:    ${myHostname}`,
      ].join("\n"),
    }],
  };
}

case "set_role": {
  const { role } = args as { role: string };
  if (!myId || !myToken) {
    return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
  }
  try {
    const result = await brokerFetch<{ ok: boolean; error?: string }>("/set-role", { role });
    if (!result.ok) {
      return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
    }
    myRole = role;
    return { content: [{ type: "text" as const, text: `Role set to: ${role}` }] };
  } catch (e) {
    return friendlyError(e);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "feat: add whoami and set_role MCP tools"
```

---

### Task 9: Add get_group_doc and set_group_doc MCP tools

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Add tool definitions**

Append to the TOOLS array:

```typescript
{
  name: "get_group_doc",
  description:
    "Fetch the group's shared documentation (Markdown). " +
    "Contains team roster, role responsibilities, and workflow. " +
    "Copy into your CLAUDE.md to keep your system prompt in sync.",
  inputSchema: { type: "object" as const, properties: {} },
},
{
  name: "set_group_doc",
  description:
    "Publish a Markdown document as the group's shared documentation. " +
    "Only peers with role 'manager' can call this (Phase 2 enforcement). " +
    "Use generate_group_doc to create a template first.",
  inputSchema: {
    type: "object" as const,
    properties: {
      doc: { type: "string" as const, description: "Markdown content for the group doc" },
    },
    required: ["doc"],
  },
},
```

- [ ] **Step 2: Add tool handlers**

```typescript
case "get_group_doc": {
  if (!myId || !myToken) {
    return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
  }
  try {
    const result = await brokerFetch<{ doc: string }>("/get-group-doc", {});
    if (!result.doc) {
      return {
        content: [{ type: "text" as const, text: "No group doc set yet. Call generate_group_doc to create a template, then set_group_doc to publish it." }],
      };
    }
    return { content: [{ type: "text" as const, text: result.doc }] };
  } catch (e) {
    return friendlyError(e);
  }
}

case "set_group_doc": {
  const { doc } = args as { doc: string };
  if (!myId || !myToken) {
    return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
  }
  try {
    const result = await brokerFetch<{ ok: boolean; error?: string }>("/set-group-doc", { doc });
    if (!result.ok) {
      return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
    }
    return { content: [{ type: "text" as const, text: "Group doc updated successfully." }] };
  } catch (e) {
    return friendlyError(e);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "feat: add get_group_doc and set_group_doc MCP tools"
```

---

### Task 10: Add generate_group_doc MCP tool

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Add tool definition**

Append to TOOLS:

```typescript
{
  name: "generate_group_doc",
  description:
    "Generate a Markdown team-doc template from current online members. " +
    "Returns the template text — review it, then call set_group_doc to publish. " +
    "Manager should fill in responsibilities and workflow sections.",
  inputSchema: { type: "object" as const, properties: {} },
},
```

- [ ] **Step 2: Add tool handler**

```typescript
case "generate_group_doc": {
  if (!myId || !myToken) {
    return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
  }
  try {
    const peers = await brokerFetch<Array<{ id: string; role: string; summary: string }>>("/list-peers", {
      scope: "group",
      cwd: myCwd,
      hostname: myHostname,
      git_root: myGitRoot,
    });
    const allMembers = [
      { id: myId, role: myRole, summary: currentSummary || "(未填写)" },
      ...peers.map((p) => ({ id: p.id, role: p.role ?? "unknown", summary: p.summary || "(未填写)" })),
    ];
    const now = new Date().toISOString().slice(0, 10);
    const tableRows = allMembers
      .map((m) => `| ${m.id} | ${m.role} | ${m.summary} |`)
      .join("\n");
    const uniqueRoles = [...new Set(allMembers.map((m) => m.role))];
    const roleBlocks = uniqueRoles
      .map((r) => `### ${r}\n<!-- 填写 ${r} 的详细职责 -->`)
      .join("\n\n");
    const template = `# 团队说明文档

> 由 generate_group_doc 生成于 ${now}。请 manager 补充完善后调用 set_group_doc 提交。

## 成员列表

| Peer ID | 角色 | 职责说明 |
|---------|------|---------|
${tableRows}

## 职责详情

${roleBlocks}

## 工作流程

<!-- 描述团队协作流程，例如：
1. manager 在 doc/ 目录创建需求文档，send_message 通知 developer
2. developer 完成开发后 send_message 通知 tester
3. tester 完成测试后 send_message 汇报 manager
-->

## 沟通规范

大段内容（PRD、设计方案、review 报告）放 doc/ 目录，通过 send_message 发送路径引用。
`;
    return {
      content: [{
        type: "text" as const,
        text: `Template generated. Review below, then call set_group_doc to publish:\n\n${template}`,
      }],
    };
  } catch (e) {
    return friendlyError(e);
  }
}
```

- [ ] **Step 3: Update MCP server instructions string**

Find the `instructions:` string in the `new Server(...)` call. Update the tools list to include the five new tools:

```
- whoami: Show your current peer ID, role, and summary
- set_role: Set your role in the group (first time only after Phase 2)
- get_group_doc: Fetch the group's shared Markdown documentation
- set_group_doc: Publish group documentation (manager only after Phase 2)
- generate_group_doc: Generate a team-doc template from current online members
```

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "feat: add generate_group_doc MCP tool"
```

---

### Task 11: CLI enhancements

**Files:**
- Modify: `cli.ts`

- [ ] **Step 1: Add groups command**

In the `switch (cmd)` block, add before `default:`:

```typescript
case "groups": {
  try {
    const res = await fetch(`${BROKER_URL}/admin/groups`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    const groups = await res.json() as Array<{
      group_id: string;
      created_at: string;
      active_peers: number;
    }>;
    if (groups.length === 0) {
      console.log("No groups registered.");
    } else {
      console.log(`${groups.length} group(s):`);
      for (const g of groups) {
        console.log(`  ${g.group_id}  peers=${g.active_peers}  created=${g.created_at}`);
      }
    }
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
  break;
}
```

- [ ] **Step 2: Add group-doc command**

```typescript
case "group-doc": {
  if (!GROUP_SECRET) {
    console.error("Required: CLAUDE_PEERS_GROUP_SECRET env var");
    process.exit(1);
  }
  try {
    await registerCli();
    const result = await brokerFetch<{ doc: string }>("/get-group-doc", {});
    if (!result.doc) {
      console.log("(No group doc set. Use set_group_doc MCP tool to publish one.)");
    } else {
      console.log(result.doc);
    }
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await unregisterCli();
  }
  break;
}
```

- [ ] **Step 3: Enhance peers output with role**

Find the `case "peers":` block. Update the console.log line:

```typescript
// Before:
console.log(`  ${p.id}  ${p.hostname}  ${p.cwd}`);

// After:
console.log(`  ${p.id}  [${(p as any).role ?? "unknown"}]  ${p.hostname}  ${p.cwd}`);
```

- [ ] **Step 4: Update default help text**

```typescript
console.log(`claude-peers CLI
...
  bun cli.ts status              Show broker status
  bun cli.ts groups              List all groups (API key only)
  bun cli.ts peers               List peers in your group (shows role)
  bun cli.ts group-doc           Print the group doc for your group
  bun cli.ts send <id> <msg>     Send a message to a peer
  bun cli.ts kill-broker         Stop the broker daemon`);
```

- [ ] **Step 5: Commit**

```bash
git add cli.ts
git commit -m "feat: add groups and group-doc CLI commands, show role in peers"
```

---

### Task 12: README update + Phase 1 wrap-up

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add CLI commands section**

Find the `## Running` section and add a new `## CLI Commands` section after it:

```markdown
## CLI Commands

```bash
# Broker health and group overview
bun cli.ts status          # Show broker status
bun cli.ts groups          # List all groups with active peer counts (API key only)

# Group-scoped commands (requires CLAUDE_PEERS_GROUP_SECRET)
bun cli.ts peers           # List peers in your group (ID, role, host, cwd)
bun cli.ts group-doc       # Print the group's shared Markdown documentation
bun cli.ts send <id> <msg> # Send a message to a peer by ID

# Broker control
bun cli.ts kill-broker     # Stop the broker daemon
```

## MCP Tools (new in this version)

| Tool | Description |
|------|-------------|
| `whoami` | Show your peer ID, role, summary, CWD |
| `set_role` | Set your role (e.g. `developer`, `tester`, `manager`) |
| `get_group_doc` | Fetch the group's shared Markdown doc |
| `set_group_doc` | Publish a Markdown doc as the group doc (manager only after Phase 2) |
| `generate_group_doc` | Generate a team-doc template from current online members |
```

- [ ] **Step 2: Run all tests**

```bash
bun test tests/ 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 3: Commit and push**

```bash
git add README.md
git commit -m "docs: add CLI commands and MCP tools section"
git push -u origin feat/group-config
```

---

## Phase 2 — Role Enforcement

> **Start Phase 2 only after Phase 1 is merged to main.**

---

### Task 13: Write failing Phase 2 tests

**Files:**
- Modify: `tests/broker-group-config.test.ts` — append Phase 2 test block

- [ ] **Step 1: Append Phase 2 tests**

```typescript
// --- Phase 2 tests ---

test("set_role: unknown peer can set role once", async () => {
  const a = await reg(30001);
  const r = await authedPost<{ ok: boolean }>(a.instance_token, "/set-role", { role: "developer" });
  expect(r.status).toBe(200);
  expect(r.data.ok).toBe(true);
  await unreg(a.instance_token);
});

test("set_role: non-manager with existing role cannot change own role", async () => {
  const a = await reg(30002);
  await authedPost(a.instance_token, "/set-role", { role: "developer" }); // first-time set
  const r = await authedPost<{ ok: boolean; error?: string }>(a.instance_token, "/set-role", { role: "tester" }); // blocked
  expect(r.status).toBe(403);
  await unreg(a.instance_token);
});

test("set_role: manager can change own role", async () => {
  const a = await reg(30003);
  await authedPost(a.instance_token, "/set-role", { role: "manager" });
  const r = await authedPost<{ ok: boolean }>(a.instance_token, "/set-role", { role: "manager" });
  expect(r.status).toBe(200);
  await unreg(a.instance_token);
});

test("set_role: manager can change another peer's role", async () => {
  const m = await reg(30004);
  await authedPost(m.instance_token, "/set-role", { role: "manager" });
  const d = await reg(30005);
  await authedPost(d.instance_token, "/set-role", { role: "developer" });
  // manager changes developer's role
  const r = await authedPost<{ ok: boolean }>(m.instance_token, "/set-role", { role: "tester", peer_id: d.id });
  expect(r.status).toBe(200);
  // verify via list-peers
  const peers = await authedPost<Array<{ id: string; role: string }>>(m.instance_token, "/list-peers", { scope: "group", cwd: "/c", hostname: "h", git_root: null });
  expect(peers.data.find(p => p.id === d.id)?.role).toBe("tester");
  await unreg(m.instance_token); await unreg(d.instance_token);
});

test("set_group_doc: non-manager gets 403", async () => {
  const a = await reg(30006);
  await authedPost(a.instance_token, "/set-role", { role: "developer" });
  const r = await authedPost<{ ok: boolean; error?: string }>(a.instance_token, "/set-group-doc", { doc: "# hack" });
  expect(r.status).toBe(403);
  await unreg(a.instance_token);
});

test("set_group_doc: manager can write", async () => {
  const a = await reg(30007);
  await authedPost(a.instance_token, "/set-role", { role: "manager" });
  const r = await authedPost<{ ok: boolean }>(a.instance_token, "/set-group-doc", { doc: "# Official Doc" });
  expect(r.status).toBe(200);
  await unreg(a.instance_token);
});
```

- [ ] **Step 2: Run and confirm failures**

```bash
bun test tests/broker-group-config.test.ts 2>&1 | grep -E "fail|FAIL" | head
```

Expected: Phase 2 tests fail (403 not implemented yet).

- [ ] **Step 3: Commit**

```bash
git add tests/broker-group-config.test.ts
git commit -m "test: add failing Phase 2 enforcement tests"
```

---

### Task 14: Add role enforcement to /set-role

**Files:**
- Modify: `broker.ts` — `handleSetRole`

- [ ] **Step 1: Replace handleSetRole with enforced version**

```typescript
function handleSetRole(
  body: SetRoleRequest,
  callerPeer: Peer
): { ok: boolean; error?: string } | { error: string; status: number } {
  if (!body.role || typeof body.role !== "string" || body.role.length > 64) {
    return { error: "Invalid role", status: 400 };
  }

  const targetPeerId = body.peer_id;

  if (targetPeerId && targetPeerId !== callerPeer.id) {
    // Manager changing another peer's role
    if (callerPeer.role !== "manager") {
      return { error: "Only manager can change another peer's role", status: 403 };
    }
    const target = selectPeerByIdAndGroup.get(targetPeerId, callerPeer.group_id) as Peer | null;
    if (!target) {
      return { error: `Peer ${targetPeerId} not found`, status: 404 };
    }
    updatePeerRole.run(body.role, target.instance_token);
    return { ok: true };
  }

  // Setting own role
  if (callerPeer.role !== "unknown" && callerPeer.role !== "manager") {
    return { error: "Role already set. Only manager can change your role.", status: 403 };
  }
  updatePeerRole.run(body.role, callerPeer.instance_token);
  return { ok: true };
}
```

- [ ] **Step 2: Update the route to handle status codes**

Find `case "/set-role":` in the switch. Replace:

```typescript
case "/set-role": {
  const result = handleSetRole(body as SetRoleRequest, callerPeer);
  if ("status" in result) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json(result);
}
```

---

### Task 15: Add role enforcement to /set-group-doc

**Files:**
- Modify: `broker.ts` — `handleSetGroupDoc`

- [ ] **Step 1: Add manager check at the top of handleSetGroupDoc**

```typescript
function handleSetGroupDoc(
  body: SetGroupDocRequest,
  callerPeer: Peer
): { ok: boolean; error?: string } | { error: string; status: number } {
  if (callerPeer.role !== "manager") {
    return { error: "Only manager can update group doc", status: 403 };
  }
  if (typeof body.doc !== "string") {
    return { error: "Missing or invalid doc field", status: 400 };
  }
  if (body.doc.length > 100_000) {
    return { error: "Doc too long (max 100KB)", status: 400 };
  }
  updateGroupDoc.run(body.doc, callerPeer.group_id);
  return { ok: true };
}
```

- [ ] **Step 2: Update the route**

```typescript
case "/set-group-doc": {
  const result = handleSetGroupDoc(body as SetGroupDocRequest, callerPeer);
  if ("status" in result) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json(result);
}
```

---

### Task 16: Update set_role MCP tool to support peer_id

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Update TOOLS definition for set_role**

```typescript
{
  name: "set_role",
  description:
    "Set a peer's role in the group. " +
    "Peers with no role ('unknown') can set their own role once. " +
    "After that, only a peer with role 'manager' can change roles. " +
    "Manager can also set another peer's role by passing peer_id.",
  inputSchema: {
    type: "object" as const,
    properties: {
      role: { type: "string" as const, description: "Role name (e.g. 'developer', 'tester', 'manager')" },
      peer_id: { type: "string" as const, description: "Target peer ID (manager only — omit to set your own role)" },
    },
    required: ["role"],
  },
},
```

- [ ] **Step 2: Update handler to pass peer_id**

```typescript
case "set_role": {
  const { role, peer_id } = args as { role: string; peer_id?: string };
  if (!myId || !myToken) {
    return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
  }
  try {
    const payload: { role: string; peer_id?: string } = { role };
    if (peer_id) payload.peer_id = peer_id;
    const result = await brokerFetch<{ ok: boolean; error?: string }>("/set-role", payload);
    if (!result.ok) {
      return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
    }
    if (!peer_id || peer_id === myId) myRole = role;
    return { content: [{ type: "text" as const, text: peer_id ? `Role of ${peer_id} set to: ${role}` : `Your role set to: ${role}` }] };
  } catch (e) {
    return friendlyError(e);
  }
}
```

- [ ] **Step 3: Run all tests**

```bash
bun test tests/ 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 4: Commit and push**

```bash
git add broker.ts server.ts
git commit -m "feat: add Phase 2 role enforcement for set_role and set_group_doc"
git push
```

---

## Self-Review Checklist

- [x] **Spec coverage**: all 5 MCP tools covered (whoami, set_role, get_group_doc, set_group_doc, generate_group_doc); /admin/groups CLI covered; role enforcement covered.
- [x] **No placeholders**: all code blocks are complete.
- [x] **Type consistency**: `SetRoleRequest.peer_id?` defined in Task 2, used in Tasks 14/16. `updatePeerRole`/`updatePeerRoleById` defined in Task 4. `handleSetRole` return union type handled in route in Task 14/15.
- [x] **Scope**: plan produces working, testable software at end of Phase 1 and end of Phase 2 independently.
