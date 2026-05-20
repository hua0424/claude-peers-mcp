# Stale Cleanup Wrongly Deletes Active Peer — Design Document

> Date: 2026-05-18
> Issue: 用户报告周末 idle 两天后 CLI `peers` 返回空；mcp reconnect 之后拿到一个随机 ID，而不是之前 `set_id` 设的 `manager`。
> Related (prior): `doc/design/2026-04-30-ws-heartbeat.md`, `doc/design/2026-05-08-session-persistence-fix.md`
> Author: manager

## Background

`broker.ts` 已经经过多次相关修复：

- `7176c46` 把 WS `idleTimeout` 从 120s 放宽到 600s
- `aa5f74b` 客户端加了 30s ping 心跳
- `ee428b3` 在 WS auth 成功时更新 `last_seen`，并新增 `/disconnect`
- `9bdb8fb` 客户端 cleanup 改用 `/disconnect` 而不是 `/unregister`

但**"WS 持续保活但 idle 超过 24h"**这条路径仍然会触发 broker 误删 active peer。本文档定位根因并修复。

## Root Cause

`broker.ts:296-301, 389` 的 stale-cleanup：

```ts
const STALE_PEER_TTL_MS = 24 * 60 * 60 * 1000;
const selectStalePeers = db.prepare(`
  SELECT instance_token FROM peers WHERE last_seen < ?
`);
const deleteStalePeers = db.prepare(`
  DELETE FROM peers WHERE last_seen < ?
`);
setInterval(cleanStale, 60 * 60 * 1000);
```

`cleanStale()` 删除所有 `last_seen` 早于 24h 的 peer **而不区分 `status`**。

而 `last_seen` 只在以下时刻被刷新：

| 触发点 | 文件:行 |
|--------|---------|
| 注册 (`handleRegister`) | broker.ts:486 |
| HTTP 请求认证 | broker.ts:842 |
| WS auth 成功 | broker.ts:1059 |
| WS close 转 dormant | broker.ts:1087 |

**WS 正常连接 + 客户端不调用任何 MCP 工具时，没有任何路径会刷新 `last_seen`。**

Bun 的 `sendPings: true` (broker.ts:1094) 让 broker 主动发 ping、客户端 WebSocket 自动 pong，连接持续活着，但 ping/pong 走的是 WS 协议帧、不进 `message` 回调，也不触碰 DB。

### 完整故障序列

1. T0：客户端注册并 `set_id manager`，broker `peers.last_seen = T0`，`status = active`，WS 入 `wsPool`
2. T0+ε～T0+24h：WS 经由 sendPings 持续保活；客户端未调用工具；`last_seen` 始终 = T0
3. T0+24h+：`cleanStale()` 触发 → 选中 manager → `ws.close(4000, "Peer cleaned up as stale")` → `DELETE FROM peers WHERE instance_token = ...`
4. 客户端 `socket.onclose` → `scheduleReconnect` → 1s/2s/4s 三次失败后调 `/resume`
5. broker `selectPeerByToken` 找不到 (peer 已删) → 返回 **401**
6. server.ts:248-252 401 分支 → `register(...)` → 拿到**随机 8 字符 ID**；`deleteSession(SESSION_DIR, GROUP_ID, oldId)` 删掉 `manager` 的 session 文件
7. `~/.claude-peers/sessions/` 中只剩随机 ID 的 session
8. 用户 mcp reconnect / 重启 Claude Code → 新进程扫描 session → 只找到随机 ID → `/resume` 成功 → CLI 看到随机 ID

## Design Decisions

### 决策 1：建立 "active 必有 WS" 的语义

修复的核心是让 status 字段表达**真实的活性**：

- `active` ⇔ broker 当前持有该 peer 的已认证 WS（即 `wsPool` 中有键）
- `dormant` ⇔ peer 暂无 WS 连接，但身份与 instance_token 保留，等待 `/resume`

在此语义下：

- 死掉的 active peer（进程被 kill -9、网络永久断）由 WS `idleTimeout: 600` 兜底——broker 在 10 分钟内会 close 该 WS，触发 `close` 回调把 peer 转成 `dormant`（broker.ts:1087），同时刷新 `last_seen`
- `cleanStale` 只清理 dormant peer（且 `last_seen` 超过 TTL）即可

这种语义比"每个 pong 都 updateLastSeen"更简洁，避免无意义的 DB 写。

### 决策 2：broker 启动时把所有 active 重置为 dormant

broker 重启后 `wsPool` 是空的。DB 中的 `status = 'active'` 全部是幻影，必须复位：

```ts
db.run("UPDATE peers SET status = 'dormant' WHERE status = 'active'");
```

否则决策 1 会让幻影 active peer 永远不被清理（永远满足"active 不删"的条件）。

### 决策 3：客户端 401/409 后尝试夺回原 ID

即使 broker 修好，仍有一条剩余路径会丢身份：客户端笔记本休眠 30h（dormant 24h+），dormant peer 被回收后再连，必然走 register 拿随机 ID。

server.ts 401/409 分支已经有 `oldId401` 变量但只用于 `deleteSession`——可以多走一步，注册后立即调 `/set-id` 把原 ID 抢回来：

```ts
// 注册后
if (oldId401 && oldId401 !== myId) {
  try {
    const r = await brokerFetch<{ id: string }>("/set-id", { new_id: oldId401 });
    if (r.id === oldId401) {
      myId = oldId401;
      saveCurrentSession();
      log(`Reclaimed original ID: ${oldId401}`);
    }
  } catch {
    // ID 被占用，放弃恢复，保留随机 ID
  }
}
if (oldId401 && oldId401 !== myId) deleteSession(SESSION_DIR, GROUP_ID, oldId401);
```

这是兜底，对决策 1+2 而言是 nice-to-have，但能显著提升健壮性。

### 不做：每次 ping/pong 更新 last_seen

代价：每个 peer 每 30 秒一次 DB 写，纯浪费 IO，且语义混乱（`last_seen` 究竟意味着"上次活动"还是"上次握手"？）。决策 1 之后 `last_seen` 只对 dormant peer 有意义——表示它多久没回来——语义干净。

### 不做：改 `STALE_PEER_TTL_MS`

dormant 24h 回收是合理 GC，避免离线机器永久占用 ID。无需修改。

## Changes

### A. broker.ts — `cleanStale` 只清理 dormant peer

```ts
const selectStalePeers = db.prepare(`
  SELECT instance_token FROM peers WHERE last_seen < ? AND status = 'dormant'
`);
const deleteStalePeers = db.prepare(`
  DELETE FROM peers WHERE last_seen < ? AND status = 'dormant'
`);
```

### B. broker.ts — 启动时复位所有 active 为 dormant

紧跟所有 migration 之后、`cleanStale()` 首次调用之前插入：

```ts
// Reset stale active rows: on startup wsPool is empty, so any active peer in
// DB is a phantom from the previous process. Mark them dormant so they can be
// resumed via /resume rather than blocking new connections with 409.
{
  const reset = db.run("UPDATE peers SET status = 'dormant' WHERE status = 'active'");
  if (reset.changes > 0) {
    console.error(`[claude-peers broker] Reset ${reset.changes} phantom active peer(s) to dormant on startup`);
  }
}
```

### C. server.ts — 401/409 重注册后夺回原 ID

修改 `scheduleReconnect` 内的两个分支（401 和 409），在 `await register(...)` 之后插入 set-id 恢复尝试。

```ts
// server.ts scheduleReconnect 内
} else if (res.status === 401) {
  log("Token invalid, re-registering...");
  const oldId = myId;
  await register(currentSummary || initialSummary);
  await tryReclaimId(oldId);
  wsFailCount = 0;
} else if (res.status === 409) {
  log("Session taken by another connection, re-registering...");
  const oldId = myId;
  await register(currentSummary || initialSummary);
  await tryReclaimId(oldId);
  wsFailCount = 0;
}

// 新增辅助函数
async function tryReclaimId(oldId: string | null): Promise<void> {
  if (!oldId || oldId === myId) return;
  try {
    const r = await brokerFetch<{ id: string }>("/set-id", { new_id: oldId });
    if (r.id === oldId) {
      myId = oldId;
      saveCurrentSession();
      log(`Reclaimed original ID: ${oldId}`);
      return;
    }
  } catch (e) {
    log(`Could not reclaim original ID ${oldId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 没夺回，清掉旧 session 文件，避免下次启动还试旧 ID
  deleteSession(SESSION_DIR, GROUP_ID, oldId);
}
```

注意：`tryReclaimId` 内成功夺回时不再调 `deleteSession(oldId)`——因为 `saveCurrentSession` 写入的就是 `oldId` 文件名（new myId === oldId），不需要也不能删它。失败路径才走 `deleteSession`。

### D. 文档备注（不改代码）

在 server.ts 的 `socket.ping()` 附近加注释：

```ts
heartbeatTimer = setInterval(() => {
  // Bun's WebSocket client exposes .ping(); standard Web WebSocket does not.
  // Even if this throws (e.g. under Node), keepalive is still maintained by
  // the broker's sendPings: true (server pings, browser/Bun auto-pongs).
  try { socket.ping(); } catch { /* onclose will fire */ }
}, 30_000);
```

避免未来误改 `sendPings: true` 配置。

## Testing

### 自动化测试（developer 负责）

新增 `broker.test.ts` 用例：

1. **`cleanStale does not delete active peers`**
   - 注册一个 peer
   - 把 `last_seen` 直接 UPDATE 到 25h 前（绕过时间）
   - 手动调 `cleanStale()` (export 出来或通过反射)
   - 断言：active peer 仍在 DB
2. **`cleanStale deletes dormant peers past TTL`**
   - 同上，但状态先转 dormant
   - 断言：被删除
3. **`startup resets active to dormant`**
   - 直接 INSERT 一行 `status = 'active'` 的 peer
   - 重启 broker 进程（或通过测试入口重跑启动逻辑）
   - 断言：状态变 dormant
4. **`client reclaims original id after 401`** (server.ts 集成)
   - mock broker 第一次 /resume 返回 401
   - 验证 client 注册后立即调用 /set-id 试图夺回 oldId

### 手工集成测试（tester 负责）

| 场景 | 操作 | 期望 |
|------|------|------|
| 长 idle 不被清理 | 临时改 `STALE_PEER_TTL_MS = 60_000` 与 `cleanupInterval = 10_000`，启动 broker + claude code，等 2 分钟 | CLI peers 仍能看到该 peer，ID 不变 |
| broker 重启不抢身份 | 注册 peer A → 杀 broker → 重启 broker → 在 claude code 中调任意 MCP 工具 | 工具调用先 401 → 客户端 /resume 又遇 401 → register 后 tryReclaimId 成功 → whoami 显示原 ID |
| dormant 过期回收 | 临时小 TTL，关闭 claude code，等过 TTL，再启动 claude code | server.ts 启动时 tryResumeSession 401 → register → tryReclaimId（旧 ID 已删除可夺回）→ whoami 显示原 ID |
| ID 已被他人占用时不抢 | 在 group 内手动让另一个 peer 占用 oldId，触发本 peer 401 重注册 | tryReclaimId 失败 → whoami 显示新随机 ID（不报错）|

### 回归

`bun test` 必须全部通过；现有 73 个用例不能因这次改动断。

## Files Changed

- `broker.ts` — cleanStale SQL 加 status 过滤；启动时 active → dormant 复位
- `server.ts` — 新增 `tryReclaimId`；401/409 分支调用之；ping 注释
- `broker.test.ts` — 新增 4 个用例
- `doc/track/2026-05-18-stale-cleanup-active-peer-bug-tracking.md` — 任务跟踪文档
- `doc/test/2026-05-XX-stale-cleanup-test-report.md` — 测试报告（tester 填）

## Risks & Mitigations

| 风险 | 缓解 |
|------|------|
| broker 启动复位 active → dormant 后，正在运行的客户端 token 还能用 | 是的，dormant peer 仍能 /resume；/resume 会转回 active。重启后的第一次客户端调用就会触发 |
| `tryReclaimId` 与同 group 其他 peer 的 `set_id` 并发抢同一 ID | broker `handleSetId` 已有 UNIQUE 约束保护，竞速失败方收到 409，安全 |
| 测试用例直接修改 STALE_PEER_TTL_MS 会影响并行测试 | 用环境变量 override 或测试内重新 import；不要全局 mutate |

## Phases

阶段拆分见 `doc/track/2026-05-18-stale-cleanup-active-peer-bug-tracking.md`。
