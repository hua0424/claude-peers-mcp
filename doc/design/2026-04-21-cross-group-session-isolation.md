# 跨组会话隔离 Bug 修复设计

**日期**：2026-04-21
**状态**：待实现
**分支**：`fix/cross-group-session-isolation`（计划，本 PR 同时附带一个无关的启动崩溃小修复）

---

## 附加 Bug：broker 启动时 TDZ 崩溃

**现象**：系统重启后启动 broker 报错：

```
ReferenceError: Cannot access 'wsPool' before initialization.
    at cleanStale (broker.ts:350:21)
    at broker.ts:371:1
```

**根因**：`cleanStale()` 在 [broker.ts:371](broker.ts) 于模块加载期立即调用，但它读取的 `wsPool` 在 [broker.ts:388](broker.ts) 才声明（`const`，受 TDZ 约束）。只有当 SQLite 中恰好存在过期 peer（`selectStalePeers` 返回非空）时才会触发——新建 DB 时此 bug 不显现，因此之前未被发现。

**修复**：把 `wsPool` 与 `pendingConnections`、`WS_AUTH_TIMEOUT_MS` 的声明块整体前移到 `cleanStale` 函数定义之前即可。无语义变更。

**为什么放进本 PR**：独立的一行顺序调整，足够小；同时 broker 起不来就无法验证主修复的端到端场景，顺手解决。

---

## 问题现象

**复现路径**（用户实测）：
1. 机器 M，Claude Code 会话 A 连接 `group1`（secret=S1 → `GROUP_ID=G1`），`set_id("manager")`
2. 同机器，另一个 Claude Code 会话 B 连接 `group2`（secret=S2 → `GROUP_ID=G2`），初始随机 ID，`set_id("manager")`
3. CLI 分别查询两组 peers：
   - `cli peers --group-secret S1` → 看到 manager（active）
   - `cli peers --group-secret S2` → 看不到 manager
4. 结果：会话 B 的 MCP token 实际绑定到了 `G1` 的 manager peer

**预期**：每个 group 独立维护自己的 manager peer，互不干扰。

---

## 根因分析

### Bug #1：会话文件按 peer_id 单键命名（`shared/session.ts`）

`saveSession(dir, data)` 写入 `${data.peer_id}.json`，不含 `group_id`。

- 会话 A 写入 `~/.claude-peers/sessions/manager.json = {token: T1, group_id: G1, ...}`
- 会话 B 调用 `set_id("manager")` 成功后，`saveCurrentSession()` 把同名文件**覆盖**为 `{token: T2, group_id: G2, ...}`
- 会话 A 的本地凭证永久丢失

### Bug #2：`switch_id` 按 peer_id 读取会话，不校验 group（`server.ts:633`）

`loadSession(SESSION_DIR, id)` 只查 `${id}.json`，从不检查 `targetSession.group_id === GROUP_ID`。

叠加场景：
1. `manager.json` 历史上存的是 G1 的 session（bug#1 覆盖问题之前的残留）
2. 新会话 B 在 G2 启动 → `tryResumeSession` 按 G2 过滤 → 跳过 `manager.json` → fresh register 拿到随机 id
3. 用户调 `switch_id("manager")` → `loadSession` 加载 G1 的 session → 带 T1 请求 `/resume`
4. broker `/resume` 按 token 查 peer，**不校验组**（`broker.ts:609` 只有 `selectPeerByToken`）→ 复活 G1 peer，轮转 token 返回
5. server.ts 本地 `GROUP_ID=G2`，但 `myToken` 绑定的是 G1 peer → "G2 会话连接到 G1 manager"

---

## 修复方案（A + B + C）

Broker 不改。问题完全在客户端。

### Fix B — 会话文件按 `(group_id, peer_id)` 命名（主修复）

文件名从 `${peer_id}.json` 改为 `${group_id}_${peer_id}.json`（32 位十六进制 group_id + `_` + peer_id）。

`peer_id` 正则 `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$` 不含 `_`，分隔符无歧义。

函数签名变更：

```ts
saveSession(dir, data: SessionData): void                          // 不变（文件名由 data 决定）
loadSession(dir, groupId, peerId): SessionData | null              // 新增 groupId 参数
deleteSession(dir, groupId, peerId): void                          // 新增 groupId 参数
scanSessions(dir, cwd, groupId, hostname): SessionData[]           // 不变（但内部用前缀过滤提效）
```

此变更使得跨组 peer_id 冲突在文件系统层就不可能发生，**Bug #1 自动消除**，**Bug #2 的根源路径也被掐断**（`loadSession` 拿不到外组 session）。

### Fix A — `switch_id` 显式 group 校验（纵深防御）

即便 Fix B 已保证 `loadSession` 不会跨组返回，`switch_id` 仍在 `loadSession` 之后加一道断言：

```ts
if (targetSession.group_id !== GROUP_ID) {
  return { error: "Session file is corrupt (group mismatch)" };
}
```

防止手工篡改或未来 bug 导致的文件错位。

### Fix C — 旧格式文件迁移

升级后首次启动时一次性迁移：

```
for each ${peer_id}.json (old format):
  read content → extract group_id
  if group_id 存在且 peer_id 有效:
    rename to ${group_id}_${peer_id}.json（若目标已存在则删除老文件）
  else:
    删除（无法识别归属）
```

迁移函数 `migrateSessionFiles(dir)` 在 `tryResumeSession` 之前运行。

---

## 影响面与回归测试

### server.ts 调用点改动

| 行 | 函数 | 原调用 | 新调用 |
|----|------|-------|-------|
| 247 | deleteSession | `(SESSION_DIR, oldId401)` | `(SESSION_DIR, GROUP_ID, oldId401)` |
| 253 | deleteSession | `(SESSION_DIR, oldId409)` | `(SESSION_DIR, GROUP_ID, oldId409)` |
| 620 | deleteSession | `(SESSION_DIR, oldId)` | `(SESSION_DIR, GROUP_ID, oldId)` |
| 633 | loadSession | `(SESSION_DIR, id)` | `(SESSION_DIR, GROUP_ID, id)` |
| 659 | deleteSession | `(SESSION_DIR, myId)` | `(SESSION_DIR, GROUP_ID, myId)` |
| 677 | deleteSession | `(SESSION_DIR, targetSession.peer_id)` | `(SESSION_DIR, targetSession.group_id, targetSession.peer_id)` |
| 830 | deleteSession | `(SESSION_DIR, session.peer_id)` | `(SESSION_DIR, GROUP_ID, session.peer_id)` |
| 861 | deleteSession | `(SESSION_DIR, session.peer_id)` | `(SESSION_DIR, GROUP_ID, session.peer_id)` |

### 测试覆盖

- `tests/session.test.ts`（新建，单元测试）
  - 同 peer_id 跨组共存
  - `loadSession` 只返回目标组
  - `deleteSession` 只删目标组
  - `scanSessions` 按 group_id 过滤
  - `migrateSessionFiles` 正确重命名 / 处理损坏文件 / 幂等
- 现有 `tests/broker-*.test.ts` 全绿（无回归）

---

## 任务分配

| 任务 | 负责人 | 说明 |
|------|--------|------|
| 实现 Fix B+A+C，包括测试 | developer | 按 `docs/superpowers/plans/2026-04-21-cross-group-session-isolation.md` TDD 执行 |
| 代码审查 | manager | developer 完成后 review PR |
| 功能测试（真实 broker + 两组场景） | tester | 按设计的复现路径验证 |
| 合并 PR | manager | 审查+测试通过后 |

---

## 里程碑

| 里程碑 | 内容 | 负责 |
|--------|------|------|
| M1 | 设计+计划确认，developer 启动开发 | manager |
| M2 | developer 完成代码+单测，提交 PR，manager review | developer → manager |
| M3 | review 通过，tester 验证两组复现场景 | tester |
| M4 | tester 通过后 PR 合并主线 | manager |
