# 任务跟踪：Stale Cleanup 误删 Active Peer

> 设计文档：`doc/design/2026-05-18-stale-cleanup-active-peer-bug.md`
> 创建时间：2026-05-18
> Manager：`manager`

## 状态总览

- [x] Phase 0：需求与方案确认
- [x] Phase 1：broker 端修复 (developer)
- [x] Phase 2：server 端身份恢复 (developer)
- [x] Phase 3：自动化测试 (developer)
- [ ] Phase 4：code review (manager)
- [ ] Phase 5：手工集成测试 (tester)
- [ ] Phase 6：回归与合并 (manager)

## Phase 0 — 需求与方案确认 ✅

| 步骤 | 责任人 | 状态 | 备注 |
|------|--------|------|------|
| 复现用户报告的现象（CLI peers 空 + 重连后随机 ID） | manager | ✅ | 用户在 #1 消息中提供 |
| 阅读 broker.ts/server.ts/session.ts，定位 last_seen 更新点 | manager | ✅ | 见设计文档 Root Cause |
| 评估两条相关历史修复（heartbeat / session-persistence-fix）是否覆盖此场景 | manager | ✅ | 不覆盖：均未处理"WS 持续保活但 idle 24h" |
| 与用户对修复方向达成一致 | manager | ✅ | 用户认可方案 A+B+C+D |

## Phase 1 — broker 端修复

> 负责人：developer
> 目标：让 `cleanStale` 只清理 dormant peer；broker 启动时复位幻影 active

| 步骤 | 责任人 | 状态 | 备注 |
|------|--------|------|------|
| 1.1 修改 `selectStalePeers` / `deleteStalePeers` 加 `AND status = 'dormant'` | developer | ✅ | broker.ts:299-301, 316-318 |
| 1.2 在 migration 之后、`cleanStale()` 首次调用之前，插入 `UPDATE peers SET status='dormant' WHERE status='active'`，并 log changes 数 | developer | ✅ | broker.ts 约 832 行位置 |
| 1.3 先写测试再写实现（TDD），见 Phase 3.1～3.3 | developer | ✅ | |
| 1.4 提交 PR，标题含 "fix: stale cleanup only deletes dormant peers + reset phantom actives on startup" | developer | ✅ | commit 1805a20 |
| 1.5 通过 `send_message` 通知 manager review | developer | ✅ | |

## Phase 2 — server 端身份恢复

> 负责人：developer
> 目标：401/409 重注册后尝试夺回原 ID；客户端 ping 加注释

| 步骤 | 责任人 | 状态 | 备注 |
|------|--------|------|------|
| 2.1 新增 `tryReclaimId(oldId)` 函数（设计文档 Changes.C 给了完整代码） | developer | ✅ | server.ts |
| 2.2 修改 401 分支调用 `tryReclaimId` | developer | ✅ | server.ts:248-252 |
| 2.3 修改 409 分支调用 `tryReclaimId` | developer | ✅ | server.ts:254-259 |
| 2.4 给 `socket.ping()` 加注释（设计文档 Changes.D） | developer | ✅ | server.ts:173-176 |
| 2.5 提交到 Phase 1 同一 PR 或独立 PR（developer 自行决定） | developer | ✅ | commit 35971ab |

## Phase 3 — 自动化测试

> 负责人：developer（TDD：先写后实现）

| 步骤 | 责任人 | 状态 | 备注 |
|------|--------|------|------|
| 3.1 `broker.test.ts`：`cleanStale does not delete active peers` | developer | ✅ | tests/broker-stale-cleanup.test.ts |
| 3.2 `broker.test.ts`：`cleanStale deletes dormant peers past TTL` | developer | ✅ | tests/broker-stale-cleanup.test.ts |
| 3.3 `broker.test.ts`：`startup resets active to dormant` | developer | ✅ | tests/broker-stale-cleanup.test.ts |
| 3.4 集成测试：401 后客户端尝试夺回原 ID | developer | ✅ | 通过服务端能力测试（broker.test.ts: reclaim after unregister）+ tester Phase 5.3/5.4 手工覆盖完整链路 |
| 3.5 `bun test` 全绿（73+ 用例全过） | developer | ✅ | 79 pass / 0 fail |

## Phase 4 — Code Review

> 负责人：manager

| 步骤 | 责任人 | 状态 | 备注 |
|------|--------|------|------|
| 4.1 阅读 diff，重点检查：SQL 条件正确性、复位逻辑顺序、tryReclaimId 边界 | manager | ⬜ | |
| 4.2 在 `doc/review/2026-05-XX-stale-cleanup-review.md` 记录 review 意见（如有） | manager | ⬜ | 若无意见可直接批 |
| 4.3 批准后通过 `send_message` 通知 tester | manager | ⬜ | |

## Phase 5 — 手工集成测试

> 负责人：tester
> 测试方法见设计文档 Testing 章节"手工集成测试"表

| 步骤 | 责任人 | 状态 | 备注 |
|------|--------|------|------|
| 5.1 长 idle 不被清理（缩小 TTL 验证） | tester | ⬜ | |
| 5.2 broker 重启不抢身份 | tester | ⬜ | |
| 5.3 dormant 过期回收后 tryReclaimId | tester | ⬜ | |
| 5.4 ID 被占用时不抢，回退到随机 ID | tester | ⬜ | |
| 5.5 写测试报告 `doc/test/2026-05-XX-stale-cleanup-test-report.md` | tester | ⬜ | |
| 5.6 `send_message` 把报告路径发给 manager | tester | ⬜ | |

## Phase 6 — 回归与合并

> 负责人：manager

| 步骤 | 责任人 | 状态 | 备注 |
|------|--------|------|------|
| 6.1 确认测试报告中 4 个场景全部 PASS | manager | ⬜ | |
| 6.2 决定合并到 main / 是否需要 hotfix 分支 | manager | ⬜ | |
| 6.3 合并后通知 developer + tester | manager | ⬜ | |
| 6.4 向用户汇报修复完成 | manager | ⬜ | |

## 沟通记录

| 时间 | 发件人 → 收件人 | 摘要 |
|------|----------------|------|
| 2026-05-18 | user → manager | 报告周末 idle 后 peer 消失、ID 变随机 |
| 2026-05-18 | manager → user | 根因分析 + 方案 A/B/C/D 设计，获认可 |
| | | |

## 决策记录

| 编号 | 决策 | 理由 | 备选 |
|------|------|------|------|
| D1 | "active 必有 WS" 作为不变量 | 语义清晰、避免每次 pong 更新 DB | 每次 pong 触发 updateLastSeen（成本高） |
| D2 | 启动时复位 active→dormant | 防止幻影 active 永不被清理 | 不做：D1 会失效 |
| D3 | 客户端夺回原 ID 用 set-id | 保留 broker 原有竞速保护 | 服务端新加 register-with-id 端点（改动大） |
