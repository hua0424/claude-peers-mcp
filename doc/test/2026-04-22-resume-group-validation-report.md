# `/resume` Group 校验修复验证报告

**日期**：2026-04-22
**测试人**：tester
**分支**：`fix/resume-group-validation`
**PR 基线**：main（已含 `73f36fe` 跨组 session 隔离修复）

---

## 测试结果总览

| # | 测试项 | 结果 | 备注 |
|---|--------|------|------|
| 1 | 自动化回归（71 pass / 0 fail） | **PASS** | 66 原有 + 5 新增 |
| 2 | broker-resume-group.test.ts 5 项 | **PASS** | 新增测试 |
| 3 | 原有 resume 测试 3 项 | **PASS** | broker.test.ts 回归 |
| 4 | 毒 session 文件自愈路径（手工） | **PASS** | 401 → 删文件 → fresh register |
| 5 | 客户端 3 处 callsite 401 处理 | **PASS** | 均正确 |
| 6 | 负面用例（缺 group_secret） | **PASS** | 自动化覆盖 |

---

## 1. 自动化测试回归

运行命令：`bun test`

结果：
```
71 pass
0 fail
174 expect() calls
Ran 71 tests across 7 files. [13.11s]
```

**状态：PASS**

### 1.1 新增 broker-resume-group.test.ts

| # | 测试用例 | 状态 |
|---|---------|------|
| 1 | `/resume rejects token from a different group with 401` | PASS |
| 2 | `/resume with matching group_secret succeeds after dormant` | PASS |
| 3 | `/resume with missing group_secret returns 400` | PASS |
| 4 | `/resume with empty group_secret returns 400` | PASS |
| 5 | `tryResumeSession-style flow: scan → 401 → delete → fresh register` | PASS |

### 1.2 原有 resume 测试回归

broker.test.ts 中的 resume 相关测试：
- resume succeeds for dormant peer → PASS
- resume fails after explicit unregister → PASS
- resume fails with active WS connection → PASS

---

## 2. 手工复现：毒 Session 文件自愈路径

### 场景设定

模拟用户升级前遗留的"毒 session 文件"：文件名属于 group_A，但内部 token 实际属于 group_B 的 peer。

### 测试步骤

1. 启动 broker
2. 用 `group-b-secret` 注册 peer，set_id("manager")，获取 token_B
3. 计算 group_A_id 和 group_B_id
4. 创建毒文件：`${GROUP_A_ID}_manager.json`，内容为：
   - `peer_id: "manager"`
   - `instance_token: token_B`（属于 group B）
   - `group_id: GROUP_A_ID`（与文件名一致，欺骗 scanSessions）
5. 模拟 group_A 客户端的 tryResumeSession：
   - scan 到该文件 → 调用 `/resume`（body 含 `group_secret=SECRET_A`）
   - 收到 401 → 删除文件 → 调用 `/register`

### 实际结果

**Step 5 — /resume 响应：**
```
Resume status: 401
Resume body: { error: "Token belongs to a different group" }
```

**Step 5 — 客户端自愈：**
```
401 detected — simulating client self-heal: deleteSession + fresh register
Fresh register: { id: "2qh6bac3", instance_token: "3aebb88568c0146ae1aa2f916ad1df483b53f7c0b9dd5f34c66eba23adc2fd33", role: "unknown" }
Files in session dir AFTER: (empty)
```

**Step 6 — Broker DB 验证：**
```
2qh6bac3 | group=57042691... | status=active | summary=GA fresh manager
manager  | group=bcb13cb4... | status=active | summary=GB manager
```

### 验证结论

| 检查项 | 预期 | 实际 | 状态 |
|--------|------|------|------|
| (a) 日志/返回含 401 "different group" | 是 | `error: "Token belongs to a different group"` | ✅ PASS |
| (b) 毒文件被实际删除 | 是 | session dir 为空 | ✅ PASS |
| (c) fresh register 在 group_A 成功 | 是 | 新 peer `2qh6bac3` 注册成功 | ✅ PASS |
| (d) group_B 原 peer 不被复活 | 是 | `manager` 仍在 group_B，未被移动 | ✅ PASS |

**状态：PASS**

---

## 3. 客户端 3 处 `/resume` Callsite 复查

### 3.1 scheduleReconnect（WS 断线重连）

**位置**：server.ts:229-248

```typescript
const res = await fetch(`${BROKER_URL}/resume`, {
  body: JSON.stringify({ api_key: API_KEY, group_secret: GROUP_SECRET, instance_token: myToken }),
});
// ...
} else if (res.status === 401) {
  log("Token invalid, re-registering...");
  const oldId401 = myId;
  await register(currentSummary || initialSummary);
  if (oldId401) deleteSession(SESSION_DIR, GROUP_ID, oldId401);
  wsFailCount = 0;
}
```

**行为**：401 → `register()` + `deleteSession(SESSION_DIR, GROUP_ID, oldId401)` → 自愈 ✅

### 3.2 switch_id

**位置**：server.ts:651-659

```typescript
const res = await fetch(`${BROKER_URL}/resume`, {
  body: JSON.stringify({ api_key: API_KEY, group_secret: GROUP_SECRET, instance_token: targetSession.instance_token }),
});
const resumeData = await res.json();
if (!res.ok) {
  return { content: [{ type: "text", text: `Cannot switch: ${resumeData.error}` }], isError: true };
}
```

**行为**：401 → 返回错误给用户，不删文件。注意：此处依赖前置的 groupId 预检（server.ts:640），若 group 不匹配会在 /resume 之前拦截并删除文件。/resume 401 仅发生在 token 已被 broker 侧拒绝的情况（如 token 已失效）。→ 合理 ✅

### 3.3 tryResumeSession（启动时）

**位置**：server.ts:848-877

```typescript
const res = await fetch(`${BROKER_URL}/resume`, {
  body: JSON.stringify({ api_key: API_KEY, group_secret: GROUP_SECRET, instance_token: session.instance_token }),
});
// ...
if (res.status === 401) {
  log(`Session ${session.peer_id} token invalid, removing stale file`);
  deleteSession(SESSION_DIR, GROUP_ID, session.peer_id);
  continue;
}
```

**行为**：401 → `deleteSession(SESSION_DIR, GROUP_ID, session.peer_id)` + continue（尝试下一个 session 或最终 fallback 到 register）→ 自愈 ✅

### 复查结论

| Callsite | 401 处理 | 删除文件 | 后续行为 | 状态 |
|----------|---------|---------|---------|------|
| scheduleReconnect | register() + deleteSession | ✅ GROUP_ID + oldId | 重置 wsFailCount | ✅ PASS |
| switch_id | 返回错误给用户 | ❌（前置 group 预检已处理） | 用户可见错误提示 | ✅ PASS |
| tryResumeSession | deleteSession + continue | ✅ GROUP_ID + session.peer_id | 尝试下一个或 register | ✅ PASS |

**状态：全部 PASS**

---

## 4. 负面用例

由自动化测试 `broker-resume-group.test.ts` 覆盖：

| 场景 | 预期 | 状态 |
|------|------|------|
| 缺 `group_secret` 字段 | 400 | ✅ PASS |
| `group_secret: ""` | 400 | ✅ PASS |

---

## 5. 代码审查确认

### 5.1 Broker 侧（broker.ts）

`handleResume` 新增：
1. `group_secret` 存在性/类型校验 → 缺失/非法返回 400
2. `deriveGroupId(body.group_secret)` 与 `peer.group_id` 比较 → 不一致返回 401 "Token belongs to a different group"
3. group check 放在 active check 之前 → 正确（外组 caller 应收到 401 而非 409）

### 5.2 类型（shared/types.ts）

`ResumeRequest` 新增必填字段 `group_secret: string` → 正确

### 5.3 客户端（server.ts）

3 处 `/resume` 调用均加上 `group_secret: GROUP_SECRET` → 正确

---

## 6. 环境信息

- OS: Ubuntu 24.04 (Linux 6.17.0-19-generic)
- Bun: v1.3.11
- 测试方式：独立 broker 实例 + HTTP API + 模拟 client 自愈逻辑
- 测试目录：全部使用临时目录（`/tmp/*-test-XXXXXX`），测试后自动清理

---

## 7. 结论

### 全部通过（6/6）
1. ✅ 自动化回归 — 71 pass / 0 fail
2. ✅ 新增 broker-resume-group.test.ts — 5 项全过
3. ✅ 原有 resume 测试回归 — 无影响
4. ✅ 毒 session 文件自愈路径 — 401 → 删文件 → fresh register
5. ✅ 客户端 3 处 callsite 401 处理 — 全部正确
6. ✅ 负面用例 — 400 返回正确

**PR 推荐合并。** 所有测试项均通过，`/resume` group 校验修复有效堵住了历史跨组 session 泄漏漏洞，客户端自愈路径工作正常。
