# WS Heartbeat & Status Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add active heartbeat, expose WS status in whoami, and relax broker idle timeout to prevent silent WS disconnects.

**Architecture:** Three independent changes — heartbeat timer in server.ts, ws_connected field in whoami response, idleTimeout adjustment in broker.ts.

**Tech Stack:** TypeScript, Bun, bun:ws

---

## File Map

| File | Responsibility |
|------|---------------|
| `server.ts` | Heartbeat timer, whoami ws_connected field |
| `broker.ts` | idleTimeout: 120 → 600 |

---

### Task 1: Add Active Heartbeat Timer in server.ts

**Files:**
- Modify: `server.ts:164-175` (WS onopen/onclose area)

- [ ] **Step 1: Add heartbeat variable declaration**

In `server.ts`, find the `let ws: WebSocket | null = null;` declaration (around line 83 after let variables). Add:

```ts
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
```

- [ ] **Step 2: Start heartbeat on WS open**

In `connectWebSocket()`, in the `socket.onopen` handler (around line 164-171), after `wsFailCount = 0;` add:

```ts
heartbeatTimer = setInterval(() => {
  try { socket.ping(); } catch { /* onclose will fire */ }
}, 30_000);
```

- [ ] **Step 3: Clear heartbeat on WS close**

In `socket.onclose` handler (around line 206), at the start of the handler (before status check), add:

```ts
if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
```

- [ ] **Step 4: Run tests to verify no regression**

```bash
bun test
```

Expected: 73 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "feat: add WS heartbeat timer (30s ping interval)"
```

---

### Task 2: Expose WS Status in whoami Tool

**Files:**
- Modify: `server.ts` (whoami tool handler + response)

- [ ] **Step 1: Find whoami handler**

In `server.ts`, find the whoami case in the CallToolRequestSchema handler (search for `case "whoami"`).

- [ ] **Step 2: Add ws_connected to response**

The current whoami response looks like:

```ts
case "whoami": {
  return {
    content: [{ type: "text" as const, text: `Peer ID: ${myId}\nRole:    ${myRole}\n...` }],
  };
}
```

Add a `wsConnected` check before the return statement, and include `WS:      ${wsConnected ? "connected" : "disconnected"}` line in the text output:

```ts
const wsConnected = ws !== null && ws.readyState === WebSocket.OPEN;
```

Then update the text template:

```ts
text: `Peer ID: ${myId}\nRole:    ${myRole}\nSummary: ${currentSummary || "(none)"}\nCWD:     ${myCwd}\nHost:    ${myHostname}\nWS:      ${wsConnected ? "connected" : "disconnected (stdio only)"}`,
```

- [ ] **Step 3: Run tests**

```bash
bun test
```

Expected: 73 pass, 0 fail

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "feat: add ws_connected status to whoami response"
```

---

### Task 3: Relax Broker idleTimeout

**Files:**
- Modify: `broker.ts:1079` (idleTimeout value)

- [ ] **Step 1: Change idleTimeout**

In `broker.ts`, find the websocket configuration (around line 1078-1080):

```ts
idleTimeout: 120,
sendPings: true,
```

Change to:

```ts
idleTimeout: 600,
sendPings: true,
```

- [ ] **Step 2: Run full test suite**

```bash
bun test
```

Expected: 73 pass, 0 fail

- [ ] **Step 3: Commit**

```bash
git add broker.ts
git commit -m "fix: relax WS idleTimeout from 120s to 600s"
```

---

## Self-Review

**1. Spec coverage:**
- [x] Active heartbeat timer → Task 1
- [x] WS status in whoami → Task 2
- [x] Relax idleTimeout → Task 3

**2. Placeholder scan:** No TBD, TODO found.

**3. Type consistency:** `ws: WebSocket | null` already defined; `WebSocket.OPEN` is standard.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-30-ws-heartbeat.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
