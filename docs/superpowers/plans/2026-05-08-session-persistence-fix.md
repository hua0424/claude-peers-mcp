# Session Persistence Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix peer ID loss after long idle periods or clean shutdown by adding a `/disconnect` endpoint (dormant, no delete) and updating `last_seen` on WS auth.

**Architecture:** Three changes — new `/disconnect` HTTP endpoint in broker.ts, replace `/unregister` with `/disconnect` in server.ts cleanup handler, add `last_seen` update on WS auth in broker.ts.

**Tech Stack:** TypeScript, Bun, bun:sqlite

---

## File Map

| File | Responsibility |
|------|---------------|
| `broker.ts` | New `/disconnect` endpoint + `last_seen` update on WS auth |
| `server.ts` | Replace `/unregister` with `/disconnect` in cleanup handler |
| `tests/broker-unregister.test.ts` | Tests for `/disconnect` behavior |

---

### Task 1: Add `/disconnect` Endpoint to Broker

**Files:**
- Modify: `broker.ts:595-609` (add handleDisconnect function)
- Modify: `broker.ts:963-965` (add route case)
- Modify: `broker.ts:1045-1047` (add last_seen update on WS auth)

- [ ] **Step 1: Write the failing test**

In `tests/broker-unregister.test.ts`, add a helper and test **at the end of the file** (before the last closing line):

```ts
async function disconnect(token: string) {
  const res = await fetch(`${brokerUrl}/disconnect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: "{}",
  });
  expect(res.status).toBe(200);
}

test("/disconnect sets peer to dormant and allows /resume (unlike /unregister)", async () => {
  const a = await register(20001);
  const setIdA = await setId(a.instance_token, "dave");
  expect(setIdA.status).toBe(200);

  // Disconnect (not unregister) — peer should become dormant, row preserved
  await disconnect(a.instance_token);

  // /resume should succeed because the peer row still exists
  const resumeRes = await fetch(`${brokerUrl}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      group_secret: GROUP_SECRET,
      instance_token: a.instance_token,
    }),
  });
  expect(resumeRes.status).toBe(200);
  const resumeData = await resumeRes.json() as { id: string; instance_token: string };
  expect(resumeData.id).toBe("dave");
  expect(resumeData.instance_token).not.toBe(a.instance_token); // token rotated

  // Clean up — unregister to release the ID
  const unreg = await fetch(`${brokerUrl}/unregister`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resumeData.instance_token}`,
    },
    body: "{}",
  });
  expect(unreg.status).toBe(200);
});

test("/disconnect reserves the ID (dormant peer blocks set_id from another peer)", async () => {
  const a = await register(20002);
  const setIdA = await setId(a.instance_token, "eve");
  expect(setIdA.status).toBe(200);

  await disconnect(a.instance_token);

  // Another peer tries to claim "eve" — should fail because dormant peer holds it
  const b = await register(20003);
  const setB = await setId(b.instance_token, "eve");
  expect(setB.status).toBe(409);

  await unregister(a.instance_token); // clean up dormant "eve"
  await unregister(b.instance_token);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/broker-unregister.test.ts
```

Expected: 2 new tests FAIL — `/disconnect` endpoint returns 404.

- [ ] **Step 3: Add `handleDisconnect` function**

In `broker.ts`, after `handleUnregister` (after line 609), add:

```ts
function handleDisconnect(callerPeer: Peer): void {
  // Set peer to dormant without deleting the row — preserves identity for
  // future /resume. Unlike /unregister (which deletes the row), /disconnect
  // is for clean client shutdown where the peer intends to reconnect later.
  updatePeerStatus.run("dormant", new Date().toISOString(), callerPeer.instance_token);
  const peerWs = wsPool.get(callerPeer.instance_token);
  wsPool.delete(callerPeer.instance_token);
  if (peerWs) peerWs.close(4000, "Peer disconnected");
}
```

- [ ] **Step 4: Add route for `/disconnect`**

In `broker.ts`, after the `/unregister` case (after line 965), add:

```ts
case "/disconnect":
  handleDisconnect(callerPeer);
  return Response.json({ ok: true });
```

- [ ] **Step 5: Add `last_seen` update on WS auth**

In `broker.ts`, after `wsPool.set(peer.instance_token, ws);` (line 1045), add:

```ts
updateLastSeen.run(new Date().toISOString(), peer.instance_token);
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
bun test tests/broker-unregister.test.ts
```

Expected: All tests pass (3 existing + 2 new = 5 pass).

- [ ] **Step 7: Run full test suite**

```bash
bun test
```

Expected: 75 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add broker.ts tests/broker-unregister.test.ts
git commit -m "feat: add /disconnect endpoint + update last_seen on WS auth"
```

---

### Task 2: Replace `/unregister` with `/disconnect` in Cleanup Handler

**Files:**
- Modify: `server.ts:960-984` (cleanup handler)

- [ ] **Step 1: Update cleanup handler**

In `server.ts`, in the `cleanup` function (lines 962-979), replace the `/unregister` block:

```ts
// Before (lines 966-974):
    // Unregister first (while peer is still active), then close WS.
    // Reversing the order would cause /unregister to fail because the WS close
    // handler sets the peer to dormant before the HTTP call completes.
    if (myToken) {
      try {
        await brokerFetch("/unregister", {});
        log("Unregistered from broker");
      } catch { /* Best effort */ }
    }

// After:
    // Notify broker of clean disconnect, preserving the peer row as dormant
    // for future /resume. Uses HTTP (not WS close frame) to avoid race with
    // process.exit() killing the process before the frame reaches the broker.
    if (myToken) {
      try {
        await brokerFetch("/disconnect", {});
        log("Disconnected from broker");
      } catch { /* Best effort */ }
    }
```

Note: The `switch_id` tool at `server.ts:676` still uses `/unregister` — that is correct because `switch_id` intentionally abandons the old identity and deletes its session file.

- [ ] **Step 2: Run full test suite**

```bash
bun test
```

Expected: 75 pass, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "fix: use /disconnect instead of /unregister in cleanup handler"
```

---

## Self-Review

**1. Spec coverage:**
- [x] New `/disconnect` endpoint → Task 1
- [x] Replace `/unregister` with `/disconnect` in cleanup → Task 2
- [x] Update `last_seen` on WS auth → Task 1 Step 5

**2. Placeholder scan:** No TBD, TODO found.

**3. Type consistency:** `handleDisconnect` signature matches existing pattern (`handleUnregister`). `updateLastSeen` SQL already exists at `broker.ts:257`. `updatePeerStatus` SQL already exists at `broker.ts:303`.

**4. Switch_id preserved:** The `switch_id` tool at `server.ts:676` continues to use `/unregister` correctly — it intentionally abandons the old identity AND deletes the session file. No change needed there.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-session-persistence-fix.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
