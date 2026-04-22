# `/resume` Group 校验设计

**日期**：2026-04-22
**状态**：待实现
**分支**：`fix/resume-group-validation`
**PR 基线**：main（已含 `73f36fe` 跨组 session 隔离修复）

---

## 背景与现象

上一期（PR #6）解决了**新产生**的跨组 session 串车：文件名改为 `${group_id}_${peer_id}.json`，`switch_id` 加 group guard。但有一个**历史残留**漏洞没堵：

`/resume` endpoint 只按 `instance_token` 定位 peer（`broker.ts:609` 的 `selectPeerByToken`），**从不校验请求方的 group**。

### 实测现象（来自用户 deer-flow / huifu-dev 两 group 环境）

1. 升级前的旧 bug 在用户的 session 目录里留下了"毒文件"：`2c48...b7b2_manager.json`（文件名+内部 group_id 都是 deerflow），但文件里的 `instance_token` 在 broker DB 里其实属于 huifu-dev 的 manager peer（是当年 huifu-dev 会话 resume 走 deerflow 文件时 broker 轮转 token 留下的）。
2. 升级后启动 deer-flow 的 Claude Code：
   - server.ts 从 `.mcp.json` 正确读到 `GROUP_SECRET=deerflow-group`，`GROUP_ID=2c48...b7b2`。
   - `scanSessions` 按 deerflow 前缀扫到该文件（合法的 group + cwd 都对）。
   - `/resume` 带上文件里那个 token 请求 broker。
   - broker `selectPeerByToken` 命中 huifu-dev 的 manager，**跳过 group 校验**，轮转 token 返回 `{id: "manager", role: "manager"}`。
   - server.ts 更新 `myToken`，认为自己还在 deerflow，但 broker 把此次活跃计入 huifu-dev。
3. 结果：`whoami` 显示 cwd=deer-flow/id=manager；broker 端 `groups` 却显示 deerflow-group peers=0，huifu-dev peers=1；客户端/服务端对 group 归属认知分裂。

任何带着"指向外组 peer 的 token"的 session 文件（无论历史原因还是人为篡改）在升级后都会触发一次这种串车 — 上一期 fix B 管不到。

---

## 修复方案

### 核心：`/resume` 在 broker 端增加 group 校验

`/resume` 请求新增必填字段 `group_secret`（与 `/register` 对齐）。handler 派生 `group_id`，与 `selectPeerByToken` 返回的 peer 的 `group_id` 比较，不一致返回 401 `{error: "Token belongs to a different group"}`。

### Broker 改动（`broker.ts`）

`handleResume(body: ResumeRequest)`：

1. 新增 `group_secret` 存在性与类型校验，缺失/非法 → 400 `{error: "Missing or invalid group_secret"}`。
2. `selectPeerByToken` 之后、`peer.status === "active"` 之前，插入：
   ```ts
   const expectedGroupId = deriveGroupId(body.group_secret);
   if (peer.group_id !== expectedGroupId) {
     return { error: "Token belongs to a different group", status: 401 };
   }
   ```
3. 返回 401 的原因归到同一语义桶 → 客户端现有"401 即删除 session 文件 + fresh register"的处理逻辑会自动自愈。

### 类型定义（`shared/types.ts`）

```ts
export interface ResumeRequest {
  api_key: string;
  group_secret: string;   // 新增必填
  instance_token: string;
}
```

### 客户端改动（`server.ts`）

三处 `/resume` 调用都把 `group_secret: GROUP_SECRET` 加进 body；401 处理逻辑**不改**（已经正确：删除 session 文件 + `register()`）。

| 行 | 上下文 | body 原值 | body 新值 |
|----|--------|----------|-----------|
| 232 | `scheduleReconnect` — WS 失败后尝试 /resume | `{api_key, instance_token: myToken}` | `{api_key, group_secret: GROUP_SECRET, instance_token: myToken}` |
| 654 | `switch_id` — 带目标 session token 请求 | `{api_key, instance_token: targetSession.instance_token}` | `{api_key, group_secret: GROUP_SECRET, instance_token: targetSession.instance_token}` |
| 851 | `tryResumeSession` — 启动时每个 scan 到的 session 逐个 resume | `{api_key, instance_token: session.instance_token}` | `{api_key, group_secret: GROUP_SECRET, instance_token: session.instance_token}` |

`GROUP_SECRET` 已在 `server.ts:44` 以模块级 `const` 定义，三处直接引用。

### CLI

`cli.ts` 不调用 `/resume`（只用 `/register` + `/unregister`），无需改动。

### 无向后兼容负担

`/resume` 是内部端点，只由 server.ts 本身调用。所有实例在这次升级里会同步拿到新版本，旧 client + 新 broker 的组合不在支持范围（broker 返回 400 会触发 client 回退到 register，仍可工作，只是启动时多一跳）。故**不保留旧请求格式**，不加 `group_secret?` 可选字段。

---

## 历史数据自愈路径

- **带毒 session 文件**：升级后首次启动 → scan → /resume → broker 返回 401（group 不符）→ client 删除该文件 → 走 /register 正确注册到本 group → 新 session 文件干净。
- **broker DB 的错误归属 peer**：新 fix 不主动清理，但不再被任何客户端复活。等 `cleanStale` 24h 窗口自然清除，或用户手动 `/unregister`。
- 结论：用户**不需要任何手工操作**；只要升级后启动一次 Claude Code，带毒文件就会被自清。但为了尽快让 broker 端 peer 归属恢复整洁，可选手动清理参见"用户手动自救"一节。

### 用户手动自救（可选、加速恢复）

- Windows client：`del %USERPROFILE%\.claude-peers\sessions\*.json`（或具体路径 `D:\tmp\.claude-peers\sessions\*.json`），下次启动直接 fresh register，最干净。
- Broker 端：重启 broker（所有 peer 被标为 dormant/缓慢 cleanStale），或手工用 sqlite 清掉可疑 peer 行。

---

## 测试策略

### 自动化（集成测试 - 新增 `tests/broker-resume-group.test.ts`）

1. 启动临时 broker。
2. 用 secret A 注册一个 peer P_A，拿到 token T_A。
3. `/unregister` P_A（让它回到 dormant），以便 /resume 可用。
4. **用 secret B + token T_A** 调用 `/resume` → 断言 401 + error 含 "different group"。
5. **用 secret A + token T_A** 调用 `/resume` → 断言 200 + 返回 `{id: P_A.id}`（回归正常路径）。
6. 不传 `group_secret` → 400。
7. `group_secret` 非 string 或空串 → 400。

### 自动化（回归）

- 已有 66 个测试全部通过。
- 新增的测试不应影响任何既有测试。

### 手工（tester 执行）

重现用户 deer-flow / huifu-dev 场景的精简版：
1. 在临时 session 目录里预种一份"毒文件"：文件名 `${group_A_id}_manager.json`，内容的 token 属于 group B 的 peer。
2. 启动配置为 group A 的 server.ts，观察：
   - 日志显示 `/resume` 收到 401
   - 毒文件被删除
   - server.ts 回落到 /register，注册到 group A 成功
   - broker 端 group A 出现新 peer（不是 group B 的）

---

## 影响面评估

- Broker schema：**无变更**。
- SQLite 数据：**无迁移**。
- 客户端 session 文件：**无格式变更**。
- 向后兼容：旧 server.ts + 新 broker 组合不支持（会 400）；用户需同步升级 server 和 broker — 但本项目部署模式就是同源仓库同步更新，非问题。
- 性能：`/resume` 多一次 sha256 计算（`deriveGroupId`），忽略不计。

---

## 任务分配

| 任务 | 负责人 | 说明 |
|------|--------|------|
| 实现（TDD） | developer | 按 `docs/superpowers/plans/2026-04-22-resume-group-validation.md` 执行 |
| 代码审查 | manager | developer 完成后 review |
| 功能测试（自动化 + 手工复现） | tester | 重现并验证 historical-mismatch 自愈路径 |
| 合并 PR | manager | 审查+测试通过后 |

## 里程碑

| 里程碑 | 内容 | 负责 |
|--------|------|------|
| M1 | 设计+计划确认，developer 启动 | manager |
| M2 | 代码+单测完成，PR 提交，manager review | developer → manager |
| M3 | review 通过，tester 验证场景 | tester |
| M4 | tester 通过后合并主线 | manager |
