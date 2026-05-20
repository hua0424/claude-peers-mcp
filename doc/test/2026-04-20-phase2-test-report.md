# Phase 2 功能测试报告

**日期**：2026-04-20
**测试人**：tester
**分支**：feat/group-config-phase2
**测试范围**：Group Config & Role System 阶段二 — 权限管控

---

## 测试结果总览

| 类别 | 通过 | 失败 | 总计 |
|------|------|------|------|
| 自动化单元测试 | 17 | 0 | 17 |
| 集成测试（权限矩阵） | 5 | 0 | 5 |
| 集成测试（边界用例） | 8 | 0 | 8 |
| 集成测试（回归验证） | 2 | 0 | 2 |
| **总计** | **32** | **0** | **32** |

**结论**：Phase 2 全部测试通过，无阻塞性缺陷。

---

## 1. 自动化单元测试

运行命令：`bun test tests/`

结果：17 pass, 0 fail, 57 expect() calls

Phase 2 新增 6 个测试用例：
- set_role: unknown peer can set role once → 200
- set_role: non-manager with existing role cannot change own role → 403
- set_role: manager can change own role → 200
- set_role: manager can change another peer's role → 200
- set_group_doc: non-manager gets 403
- set_group_doc: manager can write → 200

---

## 2. 权限矩阵测试

| # | 场景 | 预期 | 实际 | 结果 |
|---|------|------|------|------|
| M1 | unknown peer 首次 set_role | 200 | 200 | PASS |
| M2 | 已有 role 的 non-manager 修改自身 role | 403 | 403 | PASS |
| M3 | manager 通过 peer_id 修改他人 role | 200 | 200 | PASS |
| M4 | non-manager 调用 set_group_doc | 403 | 403 | PASS |
| M5 | manager 调用 set_group_doc | 200 | 200 | PASS |

---

## 3. 边界用例与扩展测试

| # | 场景 | 预期 | 结果 |
|---|------|------|------|
| E1 | unknown → tester 首次设置成功 | 200 | PASS |
| E2 | tester → developer 再次修改被拒 | 403 | PASS |
| E3 | manager 修改自身 role | 200 | PASS |
| E4 | non-manager 用 peer_id 修改他人 | 403 | PASS |
| E5 | manager 修改不存在的 peer_id | 404 | PASS |
| E6 | non-manager 可读 group doc | 200 | PASS |
| E7 | manager set_group_doc round-trip 写入 | 200 | PASS |
| E8 | manager get_group_doc round-trip 读取一致 | 内容一致 | PASS |

---

## 4. 回归验证

- M3b: manager 修改他人 role 后，list-peers 确认变更生效 → PASS
- Phase 1 测试修改审查：`set_group_doc round-trip` 测试改为先设 manager role，逻辑合理（Phase 2 权限管控下只有 manager 能写 doc）

---

## 5. 代码审查确认

### 5.1 set_role 权限规则（broker 侧）

```
IF caller.role == 'unknown' → 允许设置任意 role
IF caller.role == 'manager' → 允许设置自身或通过 peer_id 修改他人
ELSE → 拒绝，返回 403
```

实测行为与设计一致。

### 5.2 set_group_doc 权限规则（broker 侧）

```
IF caller.role != 'manager' → 返回 403
```

实测行为与设计一致。

### 5.3 Phase 1 测试修改

原 Phase 1 的 `set_group_doc round-trip` 测试（broker-group-config.test.ts:106-116）新增了 `set_role: manager` 步骤，这是 Phase 2 权限管控的必要适配，逻辑正确。

---

## 6. 测试环境

- OS: Linux 6.17.0-19-generic
- Bun: v1.3.11
- 测试方式：独立 broker 实例 + HTTP 直接调用
- 测试脚本：/tmp/test-phase2.ts

---

## 7. 结论

**Phase 2 权限管控测试全部通过**，建议合并到 main 分支。

5 个设计文档要求的权限场景全部验证通过，额外 8 个边界用例也全部正确。Phase 1 功能回归无影响。
