# Stale Cleanup 修复 — Phase 5 手工集成测试报告

**分支：** `fix/session-persistence`（stale-cleanup 修复已合并到该分支）
**测试日期：** 2026-05-20
**测试人员：** tester
**关键 commits：** `1805a20` / `35971ab` / `1cdef76`

---

## 1. 测试概览

| 场景 | 状态 | 说明 |
|------|------|------|
| 5.1 长 idle 不被清理 | ✅ PASS | active peer 经过 TTL 仍存活 |
| 5.2 broker 重启不抢身份 | ✅ PASS | phantom active→dormant，tryReclaimId 恢复 ID |
| 5.3 dormant 过期回收后 tryReclaimId | ✅ PASS | dormant→cleanStale 删除→register→reclaim 成功 |
| 5.4 ID 被占用时不抢，回退到随机 ID | ✅ PASS | 409 拒绝 reclaim，peer 保留随机 ID 不报错 |

**回归测试：** `bun test` 全量 79 pass / 0 fail（developer 已验证）

---

## 2. 测试环境

- **Broker：** 临时 sandbox 目录 `/tmp/sandbox-stale-test/`，独立 broker.ts 进程
- **DB：** 临时 SQLite 文件（每次测试独立）
- **修改：** 测试中临时缩小 `STALE_PEER_TTL_MS`（60s/30s）和 `cleanupInterval`（10s）以加速验证
- **Host：** 未直接测试，全部在隔离进程中完成

---

## 3. 场景详细记录

### 3.1 长 idle 不被清理（5.1）

**配置：** `STALE_PEER_TTL_MS = 60_000`，`cleanupInterval = 10_000`

**步骤：**
1. 启动 broker
2. 注册 peer，设置自定义 ID "alice"
3. 等待 130 秒（cleanup 运行 13 次）
4. 直接查询 DB 验证 peer 状态

**结果：**
```
Peer found: id=alice, status=active, last_seen=2026-05-20T01:14:18.529Z
PASS: alice is still active after 130s with TTL=60s
```

**结论：** active peer 不受 `cleanStale` 影响，修复生效。

---

### 3.2 broker 重启不抢身份（5.2）

**步骤：**
1. 启动 broker，注册 peer，设置 ID "bob"
2. 保存 session 文件（模拟 server.ts 行为）
3. 杀掉 broker
4. 删除 session 文件（模拟丢失）
5. 重启 broker
6. 验证 DB 中 peer 状态为 dormant（`Reset 2 phantom active peer(s) to dormant on startup`）
7. 模拟 401 恢复路径：register → tryReclaimId

**结果：**
```
Peer in DB: {"id":"bob","status":"dormant"}
New registration: randomId=8hmo3dma
Reclaim result: id=bob
PASS: broker restart + 401 recovery → tryReclaimId restores 'bob'
```

**结论：** broker 启动时正确复位 phantom active 为 dormant；session 丢失后 register + tryReclaimId 成功恢复 ID。

---

### 3.3 dormant 过期回收后 tryReclaimId（5.3）

**配置：** `STALE_PEER_TTL_MS = 30_000`，`cleanupInterval = 10_000`

**步骤：**
1. 启动 broker
2. 注册 peer，设置 ID "carol"
3. 调用 `/disconnect` 使 peer 变为 dormant
4. 验证 DB 中状态为 dormant
5. 等待 40 秒（超过 TTL）
6. 验证 DB 中 peer 已被 `cleanStale` 删除
7. 模拟客户端重启：register → tryReclaimId

**结果：**
```
Peer after disconnect: {"id":"carol","status":"dormant"}
[claude-peers broker] Cleaned 1 stale peer(s)
Peer after wait: null
New registration: randomId=66t80odi
Reclaim result: id=carol
PASS: dormant peer expired→deleted→reclaim restores 'carol'
```

**结论：** dormant peer 在 TTL 后被正确清理；删除后 register + tryReclaimId 可重新夺回原 ID。

---

### 3.4 ID 已被他人占用时不抢，回退到随机 ID（5.4）

**步骤：**
1. Peer A 注册，设置 ID "dave"
2. Peer A `/disconnect` 变为 dormant
3. Peer B 注册， reclaim "dave"（dormant ID 可被 reclaim）
4. Peer A 重新注册（获得随机 ID）
5. Peer A tryReclaimId "dave"（此时被 Peer B 占用）
6. 验证 Peer A 最终 ID 为随机 ID，不报错

**结果：**
```
Peer B set-id result: id=dave
Peer A re-registered: randomId=xoejvlqo
Reclaim response status: 409
Reclaim correctly rejected with 409 (ID occupied by Peer B)
Peer A final ID: xoejvlqo (random, not 'dave')
PASS: ID occupied → tryReclaimId fails → peer gets random ID, no error
```

**结论：** ID 被占用时 tryReclaimId 优雅失败（409），peer 保留随机 ID，无异常或报错。

---

## 4. 发现与备注

| 项目 | 说明 |
|------|------|
| R1 修复验证 | `tryReclaimId` 成功后会删除随机 ID 的 session 文件（commit `1cdef76`），已在 5.2/5.3 中间接验证 |
| cleanStale 日志 | broker 正确输出 `Cleaned N stale peer(s)` 和 `Reset N phantom active peer(s)` |
| dormant reclaim 语义 | dormant peer 的 ID 可被其他 peer reclaim，这与 crash-exit 路径行为一致 |

---

## 5. 测试结论

| 检查项 | 结果 |
|--------|------|
| active peer 不被 cleanStale 误删 | ✅ |
| broker 启动复位 phantom active→dormant | ✅ |
| tryReclaimId 成功恢复 ID | ✅ |
| tryReclaimId 失败时优雅回退随机 ID | ✅ |
| 无报错、无异常 | ✅ |
| 全量回归 79/0 | ✅ |

**结论：** 4 个手工集成测试场景全部 PASS。`fix/session-persistence` 分支（含 stale-cleanup 修复）可以合并到 main。
