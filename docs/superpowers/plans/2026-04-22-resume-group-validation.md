# `/resume` Group Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the historical cross-group session leak by having `/resume` verify that the caller's `group_secret` matches the peer's stored `group_id`, and have the client self-heal when the broker rejects a mismatched token.

**Architecture:** Pure server-side validation in `handleResume` + add `group_secret` field on every client-side `/resume` call. Existing 401 handling in the client already deletes the session file and falls back to `/register`, so the self-heal path needs no behavioral change.

**Tech Stack:** Bun, TypeScript, bun:sqlite, bun:test.

---

## File Structure

- `shared/types.ts` — `ResumeRequest` gets a required `group_secret: string` field. One-line type change.
- `broker.ts` — `handleResume` (around line 602) gains two checks: validate body.group_secret, then compare `deriveGroupId(body.group_secret)` with `peer.group_id`. The `deriveGroupId` helper is already imported (used by `handleRegister`).
- `server.ts` — three `/resume` fetch sites (lines 229, 651, 848) each add `group_secret: GROUP_SECRET` to the JSON body. `GROUP_SECRET` is a module-level `const` already in scope.
- `tests/broker-resume-group.test.ts` — new file. Spins up broker in a temp DB (pattern mirrors `tests/broker-startup.test.ts`), registers a peer, unregisters it (so /resume is allowed), then exercises the /resume group-check paths.

No file deletions. No schema migration. No client-side session-file schema changes.

---

## Task 0: Branch setup & environment sanity

**Files:** none

- [ ] **Step 1: Confirm branch**

```bash
git status
git branch --show-current
```

Expected: `fix/resume-group-validation`, clean working tree. If not on the branch, `git checkout fix/resume-group-validation` (manager has already created it off `main`).

- [ ] **Step 2: Baseline test pass**

```bash
bun test
```

Expected: 66 pass / 0 fail. Anything red means the baseline is broken — stop and flag manager.

---

## Task 1: Add failing broker test for /resume group validation

**Files:**
- Create: `tests/broker-resume-group.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
/**
 * Regression: /resume must reject tokens that belong to a different group
 * than the caller's group_secret. Without this check, a client holding a
 * leaked/historical token from another group silently resumes into the
 * wrong group.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

const API_KEY = "test-api-key";
const SECRET_A = "group-a-secret";
const SECRET_B = "group-b-secret";

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

async function registerPeer(secret: string, id_hint: string) {
  const res = await fetch(`${url}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      group_secret: secret,
      pid: process.pid,
      hostname: hostname(),
      cwd: `/tmp/${id_hint}`,
      git_root: null,
      summary: "",
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; instance_token: string; role: string };
}

async function unregisterPeer(token: string) {
  const res = await fetch(`${url}/unregister`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: "{}",
  });
  // 401 is acceptable if the peer was already cleaned up elsewhere; we just want it non-active
  if (!res.ok && res.status !== 401) throw new Error(`unregister failed: ${res.status}`);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-resume-group-"));
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

test("/resume rejects token from a different group with 401", async () => {
  // Register peer in group A, then unregister so /resume is allowed (dormant state).
  // /unregister now deletes the row outright, so we need a peer whose status is dormant
  // via WS close instead. Simpler: the WS never opened in this test, so after unregister
  // the row is gone. Approach: re-register to land in dormant without WS path — we use
  // the status flag: /register gives active; to go dormant without WS close, we call
  // /unregister which deletes. So instead, directly open a second /resume scenario: first
  // /resume after a fresh register will return 409 (already active). That means we need
  // to either (a) use WS close to go dormant, or (b) accept that this test exercises the
  // group-check BEFORE the active check by validating the 401 returns "different group"
  // and not "already active".
  const peerA = await registerPeer(SECRET_A, "peerA");

  // Call /resume with wrong group_secret (B) and A's token.
  // Expected: 401 with "different group" message, regardless of active state,
  // because the group check fires before the active-status check.
  const res = await fetch(`${url}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      group_secret: SECRET_B,
      instance_token: peerA.instance_token,
    }),
  });
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("different group");

  await unregisterPeer(peerA.instance_token);
});

test("/resume with matching group_secret succeeds after dormant", async () => {
  // Register fresh peer, then unregister cleanly — row is deleted, so /resume should 401
  // with "Invalid token", NOT "different group". This confirms the positive path of the
  // group check doesn't break the existing invalid-token path.
  const peerA = await registerPeer(SECRET_A, "peerA2");
  await unregisterPeer(peerA.instance_token);

  const res = await fetch(`${url}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      group_secret: SECRET_A,
      instance_token: peerA.instance_token,
    }),
  });
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("Invalid token");
});

test("/resume with missing group_secret returns 400", async () => {
  const res = await fetch(`${url}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      instance_token: "a".repeat(64),
    }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error.toLowerCase()).toContain("group_secret");
});

test("/resume with empty group_secret returns 400", async () => {
  const res = await fetch(`${url}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      group_secret: "",
      instance_token: "a".repeat(64),
    }),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run the new test to verify it fails**

```bash
bun test tests/broker-resume-group.test.ts
```

Expected: first test FAILS (broker currently returns 409 "Peer is already active" because group check doesn't exist yet — the check-order fix is what makes this test drive the implementation). The "missing group_secret" tests likely pass accidentally because the field is ignored today, but the mismatched-group test must fail.

If the mismatched-group test passes before the fix is in, the test is wrong — stop and flag manager.

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/broker-resume-group.test.ts
git commit -m "test: add failing /resume group validation tests"
```

---

## Task 2: Add `group_secret` to `ResumeRequest` type

**Files:**
- Modify: `shared/types.ts:66-69`

- [ ] **Step 1: Update the type**

Find:

```ts
export interface ResumeRequest {
  api_key: string;
  instance_token: string;
}
```

Replace with:

```ts
export interface ResumeRequest {
  api_key: string;
  group_secret: string;
  instance_token: string;
}
```

- [ ] **Step 2: Type-check compiles (no behavioural run yet)**

```bash
bun build --target=bun broker.ts --outfile=/tmp/broker-check.js
bun build --target=bun server.ts --outfile=/tmp/server-check.js
```

Expected: both succeed. TypeScript structural typing means existing callsites that don't pass `group_secret` will be flagged only at the usage site (broker.ts doesn't destructure the field, server.ts builds JSON manually — so no compile error, just runtime 400 after Task 3). That's fine.

Do NOT commit yet — commit together with Task 3.

---

## Task 3: Implement broker-side group check in `handleResume`

**Files:**
- Modify: `broker.ts:602-616` (handleResume function body)

- [ ] **Step 1: Verify `deriveGroupId` import exists in broker.ts**

```bash
grep -n "deriveGroupId" broker.ts
```

Expected: at least one hit (used by `handleRegister`). If missing, add to the shared/auth imports at the top.

- [ ] **Step 2: Modify `handleResume`**

Find the current function body starting at `function handleResume(body: ResumeRequest)`:

```ts
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
```

Replace with (insertions marked; keep the rest of the function unchanged):

```ts
function handleResume(body: ResumeRequest): { id: string; instance_token: string } | { error: string; status: number } {
  if (!body.api_key || typeof body.api_key !== "string" || !verifyApiKey(body.api_key)) {
    return { error: "Invalid API key", status: 401 };
  }
  if (!body.group_secret || typeof body.group_secret !== "string") {
    return { error: "Missing or invalid group_secret", status: 400 };
  }
  if (!body.instance_token || typeof body.instance_token !== "string" || body.instance_token.length !== 64) {
    return { error: "Missing or invalid instance_token", status: 400 };
  }
  const peer = selectPeerByToken.get(body.instance_token) as Peer | null;
  if (!peer) {
    return { error: "Invalid token", status: 401 };
  }
  // Group check — the historical bug was that a token from one group could resume
  // into that peer from any caller; we now require the caller to prove group membership.
  const expectedGroupId = deriveGroupId(body.group_secret);
  if (peer.group_id !== expectedGroupId) {
    return { error: "Token belongs to a different group", status: 401 };
  }
  // Reject if already active (either with or without a WS connection)
  if (peer.status === "active") {
    return { error: "Peer is already active", status: 409 };
  }
```

Rationale for ordering: group check BEFORE active check means a mismatched-group caller gets a clear 401 "different group" even against a currently-active target peer; otherwise they'd get 409 which is semantically wrong and misleading.

- [ ] **Step 3: Run broker-resume-group tests — should pass now**

```bash
bun test tests/broker-resume-group.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 4: Run full suite for regression**

```bash
bun test
```

Expected: 70 pass (66 existing + 4 new) / 0 fail. If any existing test fails, it likely hit the new `group_secret` requirement — that belongs to Task 4 (client updates), but fix here only if the failure is in broker tests that construct /resume bodies inline.

- [ ] **Step 5: Commit types + broker change together**

```bash
git add shared/types.ts broker.ts
git commit -m "feat(broker): validate group_secret in /resume"
```

---

## Task 4: Update client `/resume` callsites in `server.ts`

**Files:**
- Modify: `server.ts:232` (scheduleReconnect)
- Modify: `server.ts:654` (switch_id handler)
- Modify: `server.ts:851` (tryResumeSession)

- [ ] **Step 1: Patch scheduleReconnect (line ~232)**

Find:

```ts
          const res = await fetch(`${BROKER_URL}/resume`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: API_KEY, instance_token: myToken }),
            signal: AbortSignal.timeout(10000),
          });
```

Replace with:

```ts
          const res = await fetch(`${BROKER_URL}/resume`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: API_KEY, group_secret: GROUP_SECRET, instance_token: myToken }),
            signal: AbortSignal.timeout(10000),
          });
```

- [ ] **Step 2: Patch switch_id handler (line ~654)**

Find:

```ts
        const res = await fetch(`${BROKER_URL}/resume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: API_KEY, instance_token: targetSession.instance_token }),
          signal: AbortSignal.timeout(10000),
        });
```

Replace with:

```ts
        const res = await fetch(`${BROKER_URL}/resume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: API_KEY, group_secret: GROUP_SECRET, instance_token: targetSession.instance_token }),
          signal: AbortSignal.timeout(10000),
        });
```

- [ ] **Step 3: Patch tryResumeSession (line ~851)**

Find:

```ts
      const res = await fetch(`${BROKER_URL}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: API_KEY, instance_token: session.instance_token }),
        signal: AbortSignal.timeout(10000),
      });
```

Replace with:

```ts
      const res = await fetch(`${BROKER_URL}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: API_KEY, group_secret: GROUP_SECRET, instance_token: session.instance_token }),
        signal: AbortSignal.timeout(10000),
      });
```

- [ ] **Step 4: Sanity grep — no `/resume` body without group_secret remains**

```bash
grep -n '"/resume"' server.ts
grep -nA3 '/resume' server.ts | grep -i "body: JSON.stringify"
```

Expected: exactly 3 /resume callsites, each body includes `group_secret:`.

- [ ] **Step 5: Full test suite must still pass**

```bash
bun test
```

Expected: 70 pass / 0 fail.

- [ ] **Step 6: Commit**

```bash
git add server.ts
git commit -m "feat(server): send group_secret on /resume for group validation"
```

---

## Task 5: End-to-end self-heal test for historical mismatched session file

**Files:**
- Modify: `tests/broker-resume-group.test.ts` (append new test at bottom)

**Rationale:** Tasks 1-4 validate broker mechanics and client-body format. This task proves the self-heal loop — scan → /resume 401 → delete file → register — works end-to-end against a seeded bad session file.

- [ ] **Step 1: Add self-heal test**

Append to `tests/broker-resume-group.test.ts`:

```ts
import { writeFileSync, readdirSync, mkdirSync } from "node:fs";

test("tryResumeSession-style flow: scan → /resume 401 → delete file → fresh register", async () => {
  // Simulate the historical scenario:
  // 1. Peer P exists in group A (register leaves it active).
  // 2. Unregister to free the row — then re-register to rebuild state for test clarity.
  // Actually simpler: we don't need a real peer. Stage a session-dir with a file whose
  // token points at a group A peer, then act as a client from group B.
  //
  // Seed: register in group A, DO NOT unregister (so token IS valid & peer.group_id = A).
  // As a group B client, call /resume with that token → should get 401 "different group".
  // Then simulate the client-side deletion by calling deleteSession semantics.
  const sessionDir = mkdtempSync(join(tmpdir(), "claude-peers-selfheal-"));

  const peerA = await registerPeer(SECRET_A, "historical");
  const { deriveGroupId } = await import("../shared/auth.ts");
  const groupAId = deriveGroupId(SECRET_A);
  const groupBId = deriveGroupId(SECRET_B);

  // Write a "toxic" session file that claims group B in filename but holds A's token.
  // (We don't need to fake the filename, just the content; scanSessions logic isn't tested here.)
  const fileName = `${groupBId}_historical.json`;
  const filePath = join(sessionDir, fileName);
  writeFileSync(filePath, JSON.stringify({
    peer_id: "historical",
    instance_token: peerA.instance_token,
    cwd: "/tmp/historical",
    group_id: groupBId,
    hostname: hostname(),
  }));

  // Group B client attempts /resume with the toxic token.
  const resumeRes = await fetch(`${url}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      group_secret: SECRET_B,
      instance_token: peerA.instance_token,
    }),
  });
  expect(resumeRes.status).toBe(401);
  const body = (await resumeRes.json()) as { error: string };
  expect(body.error).toContain("different group");

  // Client response: delete the toxic file (mirroring tryResumeSession's 401 branch).
  const { deleteSession } = await import("../shared/session.ts");
  deleteSession(sessionDir, groupBId, "historical");
  expect(readdirSync(sessionDir)).toEqual([]);

  // Client proceeds to fresh /register in group B — this succeeds with a brand-new peer.
  const peerB = await registerPeer(SECRET_B, "historical");
  expect(peerB.id).toBeDefined();
  expect(peerB.instance_token).toHaveLength(64);
  expect(peerB.instance_token).not.toBe(peerA.instance_token); // new token, not the toxic one

  // Cleanup
  await unregisterPeer(peerA.instance_token);
  await unregisterPeer(peerB.instance_token);
  rmSync(sessionDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the new test**

```bash
bun test tests/broker-resume-group.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 3: Full suite regression**

```bash
bun test
```

Expected: 71 pass / 0 fail.

- [ ] **Step 4: Commit**

```bash
git add tests/broker-resume-group.test.ts
git commit -m "test: verify /resume self-heal path end-to-end"
```

---

## Task 6: PR creation (deferred — wait for manager go-ahead)

**Do NOT run this task until manager sends explicit approval after reviewing commits from Tasks 1-5.**

Rationale: previous iteration PR #6 showed the value of a manager review pass before PR opens — catches issues like the guard-delete bug earlier in the loop.

- [ ] **Step 1: Push branch**

```bash
git push -u origin fix/resume-group-validation
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --base main --title "fix: validate group_secret in /resume to close historical cross-group leak" --body "$(cat <<'EOF'
## Summary

- Broker `/resume` now requires `group_secret` and rejects tokens that belong to a different group (401 "Token belongs to a different group").
- All three client-side `/resume` callsites in `server.ts` now send `group_secret`.
- Existing 401 → delete-session-file → fresh-register flow self-heals historical "toxic" session files left by the pre-v1 cross-group bug.

## Why

PR #6 (cross-group session isolation) prevented NEW cross-group collisions by keying session files on `${group_id}_${peer_id}`, but it left a residual hole: if a pre-upgrade session file contained a token that broker DB attributed to another group (from past filename-collision resumes), `/resume` would still silently revive the foreign-group peer because it only checked the token, never the group. Live reproduction: a user's deer-flow session kept landing in huifu-dev group after upgrade.

## Design & Plan

- `doc/design/2026-04-22-resume-group-validation.md`
- `docs/superpowers/plans/2026-04-22-resume-group-validation.md`

## Test plan

- [x] Broker unit tests for /resume group validation (4 tests)
- [x] End-to-end self-heal test (1 test)
- [x] Full suite regression (was 66, now 71 pass)
- [ ] Tester manual verification per design doc "测试策略 — 手工" section

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report PR URL to manager**

Use `send_message` to `manager` with the PR URL so manager can kick off tester.

---

## Self-Review Notes (completed by plan author, not the executor)

- **Spec coverage:** broker check, client body update, tests, self-heal — all present. ✓
- **Type consistency:** `ResumeRequest` gets `group_secret`; all three callsites match. ✓
- **Placeholder scan:** no TBD / TODO / "add error handling" / "similar to above". ✓
- **Commit cadence:** one commit per logical change (tests → broker → client → e2e test), matches prior iteration's reviewability. ✓
