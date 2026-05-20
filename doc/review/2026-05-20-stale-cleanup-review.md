# Code Review：Stale Cleanup 修复

> 设计：`doc/design/2026-05-18-stale-cleanup-active-peer-bug.md`
> 跟踪：`doc/track/2026-05-18-stale-cleanup-active-peer-bug-tracking.md`
> 被审 commits：`1805a20` / `35971ab` / `e8423bc`
> Reviewer: manager
> 日期: 2026-05-20

## 结论

**已通过**：R1 由 commit `1cdef76` 修复完成，79 pass / 0 fail，无回归。R2/R3 不阻塞。批准进入 Phase 5。

（原始结论：条件通过，1 个 minor 问题需修复后合并。其余符合设计预期。）

## 审查范围

| 文件 | 变更内容 | 评价 |
|------|---------|------|
| `broker.ts` | cleanStale SQL 加 `AND status='dormant'`；启动 active→dormant 复位；`if (import.meta.main)` 守卫包裹副作用代码；export 测试需要的符号 | 设计意图正确 |
| `tests/broker-stale-cleanup.test.ts` | 3 个新测试（active 保护、dormant 删除、启动复位） | 覆盖核心场景；启动复位用子进程实测，靠谱 |
| `server.ts` | 新增 `tryReclaimId`；401/409 分支调用；ping 注释 | 主体正确，见 R1 |
| `broker.test.ts` | migration 测试断言从 active 改 dormant（合理）；新增 set-id 在 unregister 后可夺回的测试 | 适配新语义 |

## 发现

### R1 — tryReclaimId 成功路径漏删随机 ID 的 session 文件【请修】

**位置**：`server.ts` `tryReclaimId` 函数

**问题**：
- 触发链：401 → `register()` 写入 `${groupId}_<randomId>.json`（含 token T_new）
- `tryReclaimId(oldId)` 成功后 `myId = oldId`，再 `saveCurrentSession()` 写入 `${groupId}_<oldId>.json`（同样 token T_new）
- **`<randomId>` 的 session 文件未被清理**

**后果**：
- 下次 `tryResumeSession` 会扫到两个文件
- 因为 token 相同，broker `/resume` 实际能正确返回 `id=oldId`，所以**功能不出错**
- 但文件残留直到 7 天清理；且若用户后续再触发 401，旧的 randomId 文件可能成为优先尝试目标，产生混乱日志

**建议改动**：

```ts
async function tryReclaimId(oldId: string | null): Promise<void> {
  if (!oldId || oldId === myId) return;
  const randomId = myId; // 捕获 register() 刚分配的随机 ID
  try {
    const r = await brokerFetch<{ id: string }>("/set-id", { new_id: oldId });
    if (r.id === oldId) {
      myId = oldId;
      saveCurrentSession();
      // 删除 register() 留下的随机 ID 文件
      if (randomId && randomId !== oldId) {
        deleteSession(SESSION_DIR, GROUP_ID, randomId);
      }
      log(`Reclaimed original ID: ${oldId}`);
      return;
    }
  } catch (e) {
    log(`Could not reclaim original ID ${oldId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 没夺回：清掉旧 session 文件，避免下次启动还试旧 ID
  deleteSession(SESSION_DIR, GROUP_ID, oldId);
}
```

**测试补强**（可选）：可在 broker.test.ts 加一个用例验证两文件清理逻辑，或留给 tester 手工验证 5.3。

### R2 — broker.ts `Bun.serve(...)` 缩进未跟随新作用域【cosmetic，不阻塞】

`Bun.serve<WsData>({` 现在位于 `if (import.meta.main) { ... }` 内部，但块内的 `port:`、`hostname:`、`fetch(req, server) {...}` 等属性仍保持原缩进，没有整体 +2 缩进。

不影响功能，可在合并前顺手 `prettier`/手动调；也可以下次 broker.ts 大改动时一起整。manager 不强制要求。

### R3 — Phase 3.4 客户端 reclaim 集成测试覆盖间接【minor，接受】

跟踪文档 3.4 写的是"集成测试：401 后客户端尝试夺回原 ID"。提交内容是 broker.test.ts 中的 `set-id allows reclaiming ID after peer is fully deleted` —— 它**验证了服务端的能力**（unregister 后可重用 ID），但**没有直接验证 server.ts 的 tryReclaimId 调用序列**。

直接测 server.ts 路径需要 mock fetch / 注入测试入口，工作量大。考虑到：

- 服务端能力已被严格测试覆盖
- tester 在 Phase 5.3 / 5.4 会手工跑完整链路
- `tryReclaimId` 本身逻辑简单（3 个 if，10 行代码）

我接受当前测试覆盖，不强求补 unit test。但跟踪文档 3.4 的备注应该改为说明这是"通过服务端能力测试 + 手工集成测试覆盖"，避免误导后续 reader。

## 其他正面观察

- ✅ `if (import.meta.main)` 守卫是优雅的可测性改造，比我建议的"重构成 initBroker(db)"更轻量
- ✅ 启动复位日志 `Reset N phantom active peer(s)` 便于运维观察
- ✅ migration 测试的断言更新 + 注释解释，体现了对副作用的清晰认知
- ✅ `bun test`：79 pass / 0 fail，无回归
- ✅ `tryReclaimId` 失败路径 `deleteSession(oldId)` 处理得当——避免下次启动还试已被占用的旧 ID

## 下一步

1. developer 修 R1（5 分钟工作量），通过 `send_message` 通知 manager 复审 → 通过即合并到 main
2. manager 通知 tester 启动 Phase 5
