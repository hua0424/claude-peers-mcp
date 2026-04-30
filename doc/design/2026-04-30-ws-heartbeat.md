# WS Heartbeat & Status Visibility — Design Document

> Date: 2026-04-30
> Issue: WebSocket connection drops silently during idle periods. Claude shows MCP "connected" (stdio), but the broker's WS is actually dead. Peer becomes dormant/invisible, messages fail silently.

## Background

Claude Code's MCP panel shows the **stdio** connection status between Claude and server.ts, not the **WebSocket** connection between server.ts and the broker. When the WS drops (network blip, NAT timeout, broker `idleTimeout`), server.ts may fail to reconnect, but the user has no way to know — "connected" is misleading.

Additionally, the broker's default `idleTimeout: 120` (2 minutes) is aggressive. A short idle period while reading code can trigger a WS close.

## Changes

### 1. Active Heartbeat (server.ts)

Add a periodic heartbeat timer in server.ts. After WS auth succeeds, start a 30s interval that sends a `ping()` frame. If the pong doesn't return (connection broken), the WS `onclose` fires naturally → `scheduleReconnect()` triggers.

Implementation:
- `ONOPEN`: `setInterval(() => ws.ping(), 30_000)`
- `ONCLOSE`: `clearInterval(heartbeatTimer)`
- Use `bun:ws`'s built-in ping/pong support (RFC 6455). No custom protocol needed.

### 2. WS Status in whoami (server.ts)

Extend the `whoami` tool response to include `ws_connected: boolean`.

Users (and LLM) can check real WS state at any time by calling `whoami`.

### 3. Relax idleTimeout (broker.ts)

Change `idleTimeout` from 120s to 600s (10 minutes). The broker still sends `sendPings: true`, which should keep the connection alive under normal conditions. A 10-minute window accommodates reading/review pauses.

## Testing

1. Start broker + 2 peers, verify whoami shows `ws_connected: true`
2. Kill broker, verify whoami shows `ws_connected: false`
3. Restart broker, verify peer reconnects automatically (heartbeat detects)
4. Verify 10-minute idle does NOT disconnect the WS (sendPings keeps it alive)
5. Regression: `bun test` — 73 pass, 0 fail

## Files Changed

- `server.ts` — heartbeat timer + whoami ws_connected field
- `broker.ts` — idleTimeout: 120 → 600
