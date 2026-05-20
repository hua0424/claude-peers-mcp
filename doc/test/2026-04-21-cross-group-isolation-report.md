# 跨组会话隔离 Bug 修复 + Broker TDZ 修复验证报告

**日期**：2026-04-21
**测试人**：tester
**分支**：`fix/cross-group-session-isolation`
**PR**: https://github.com/hua0424/claude-peers-mcp/pull/6

---

## 测试结果总览

| # | 测试项 | 结果 | 备注 |
|---|--------|------|------|
| 1 | Broker TDZ 崩溃修复回归 | **PASS** | 启动含过期 peer 的 DB 无错误 |
| 2 | 跨组 session 隔离（Broker 侧） | **PASS** | 两组 manager peer 独立共存 |
| 3 | 跨组 session 隔离（Client 文件侧） | **PASS** | 文件名按 `group_id_peer_id` 隔离 |
| 4 | switch_id group 防御 | **PASS with issue** | 错误提示正确，但删除逻辑有缺陷 |
| 5 | 旧格式迁移（C1: 正常重命名） | **PASS** | 内容完整保留 |
| 6 | 旧格式迁移（C2: 损坏文件删除） | **PASS** | 自动清理 |
| 7 | 旧格式迁移（C3: 幂等性） | **PASS** | 已迁移文件不被改动 |
| 8 | 旧格式迁移（C4: 缺 group_id 删除） | **PASS** | 无法识别的文件被清理 |
| 9 | CLI 跨组查询验证 | **PASS** | 两组看到各自的 manager |
| — | 自动化测试回归 | **66 pass, 0 fail** | 基线确认 |

---

## 1. Broker TDZ 崩溃修复回归

### 测试目的
验证修复后 broker 启动时不会因 `wsPool` TDZ 错误崩溃。

### 测试步骤
1. 启动 broker，注册一个 peer
2. 关闭 broker，将 peer 的 `last_seen` 修改为 2 天前（过期）
3. 重新启动 broker

### 预期结果
Broker 正常启动，自动清理过期 peer，不报错。

### 实际结果
```
[claude-peers broker] Cleaned 1 stale peer(s)
[claude-peers broker] listening on 0.0.0.0:18999 (db: ...)
```

**状态：PASS** — 无 `ReferenceError: Cannot access 'wsPool' before initialization` 错误。

---

## 2. 跨组 Session 隔离主修复

### 2.1 Broker 侧隔离

#### 测试步骤
1. 启动 broker
2. 用 `group1-secret` 注册两个 peer，其中一个 set_id("manager")
3. 用 `group2-secret` 注册两个 peer，其中一个 set_id("manager")
4. 从每组非-manager peer 视角查询 list-peers
5. CLI 分别用两组 secret 查询 peers

#### 预期结果
- 两组各自有自己的 manager peer
- list-peers 只返回同组成员
- CLI `peers` 命令分别显示两组的 manager（通过 summary 区分）

#### 实际结果
**Broker DB 验证：**
```
manager | group=201960a7... | status=active | summary=group1-secret peer
manager | group=2cb68aaa... | status=active | summary=group2-secret peer
```

**CLI Group1：**
```
  manager  [unknown]  host1  /tmp/g1a
         G1 manager
  9abbew3o [unknown]  host1  /tmp/g1b
         G1 dev
```

**CLI Group2：**
```
  manager  [unknown]  host1  /tmp/g2a
         G2 manager
  0b4hhdgv [unknown]  host1  /tmp/g2b
         G2 dev
```

**状态：PASS** — 两组完全隔离，互不干扰。

### 2.2 Client 侧 Session 文件隔离

#### 测试步骤
直接调用 `shared/session.ts` 的函数：
1. `saveSession` 两次：同 peer_id="manager"，不同 group_id
2. `loadSession` 验证只返回目标组
3. `deleteSession` 验证只删目标组
4. `scanSessions` 验证只返回目标组

#### 实际结果
- 文件系统创建两个独立文件：`aaaaaaaa..._manager.json`、`bbbbbbbb..._manager.json`
- `loadSession(GROUP_A, "manager")` → 返回 GroupA 数据
- `loadSession(GROUP_B, "manager")` → 返回 GroupB 数据
- `deleteSession(GROUP_A, "manager")` → 只删除 GroupA 文件
- `scanSessions(GROUP_A)` → 只返回 GroupA 的 peers

**状态：PASS** — 文件系统层完全隔离。

---

## 3. switch_id Group 防御验证

### 测试步骤
1. 手工创建伪造 session 文件：文件名用 `GROUP_A_manager.json`，但内部 `group_id` 字段为 `GROUP_B`
2. 调用 `loadSession(GROUP_A, "manager")` 加载
3. 模拟 switch_id 的 group 校验逻辑

### 预期结果
- 加载成功（文件名匹配 GROUP_A）
- group_id 校验失败（内容声称 GROUP_B ≠ GROUP_A）
- 返回错误提示并删除伪造文件

### 实际结果
```
Loaded session: { peer_id: "manager", group_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", summary: "Fake session" }
Group mismatch: file claims group bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, expected aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
deleteSession called with targetSession.group_id and targetSession.peer_id
```

**文件状态：**
- 删除前：`aaaaaaaa..._manager.json`（伪造文件）存在
- 删除后：`aaaaaaaa..._manager.json` 仍存在！

### ⚠️ 发现的问题
`switch_id` 防御代码中（`server.ts:641`）：
```typescript
deleteSession(SESSION_DIR, targetSession.group_id, targetSession.peer_id);
```

这里 `targetSession.group_id` 是文件**内容中**的 group_id（GROUP_B），而伪造文件的实际文件名是 `GROUP_A_manager.json`。因此 `deleteSession` 尝试删除的是 `GROUP_B_manager.json`（不存在），而伪造文件 `GROUP_A_manager.json` **未被删除**。

**建议修复：** 应改为用当前会话的 `GROUP_ID` 删除：
```typescript
deleteSession(SESSION_DIR, GROUP_ID, targetSession.peer_id);
```

或直接用文件路径删除。由于 Fix B（文件名隔离）已使正常情况下不可能触发此防御，这是一个低概率的边缘场景，但仍建议修复以确保纵深防御的有效性。

**状态：PASS with issue** — 错误提示正确，但删除逻辑有缺陷。

---

## 4. 旧格式 Session 文件迁移（Fix C）

### C1: 正常旧格式文件重命名

#### 测试步骤
创建旧格式文件 `manager.json`（含有效 group_id），调用 `migrateSessionFiles`。

#### 实际结果
- `manager.json` → `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_manager.json`
- 内容完整保留，token、summary 等字段未丢失

**状态：PASS**

### C2: 损坏 JSON 文件自动删除

#### 测试步骤
创建旧格式文件 `corrupt.json`（非法 JSON），调用 `migrateSessionFiles`。

#### 实际结果
- `corrupt.json` 被自动删除
- 已迁移的正常文件不受影响

**状态：PASS**

### C3: 幂等性（已迁移文件不被改动）

#### 测试步骤
对已包含新格式文件的目录再次调用 `migrateSessionFiles`。

#### 实际结果
- 文件列表前后一致
- 无重复、无删除、无修改

**状态：PASS**

### C4: 缺少 group_id 的旧格式文件删除

#### 测试步骤
创建旧格式文件 `nogroup.json`（只有 peer_id，无 group_id）。

#### 实际结果
- 文件被自动删除（无法识别归属）

**状态：PASS**

---

## 5. 自动化测试回归

运行命令：`bun test`

结果：
```
66 pass
0 fail
161 expect() calls
Ran 66 tests across 6 files. [12.72s]
```

**状态：PASS** — 无回归。

---

## 6. 环境信息

- OS: Ubuntu 24.04 (Linux 6.17.0-19-generic)
- Bun: v1.3.11
- Node.js: (Bun built-in)
- 测试方式：独立 broker 实例 + HTTP API + CLI + 直接 session.ts 函数调用
- 测试目录：全部使用临时目录（`/tmp/*-test-XXXXXX`），测试后自动清理

---

## 7. 结论

### 通过项（8/9）
1. ✅ Broker TDZ 崩溃修复 — 启动正常
2. ✅ 跨组 Broker 隔离 — 两组 manager 独立共存
3. ✅ 跨组 Session 文件隔离 — 文件名按 `group_id_peer_id` 正确隔离
4. ✅ 旧格式迁移 C1 — 正常重命名
5. ✅ 旧格式迁移 C2 — 损坏文件删除
6. ✅ 旧格式迁移 C3 — 幂等性
7. ✅ 旧格式迁移 C4 — 缺 group_id 删除
8. ✅ CLI 跨组查询 — 两组看到各自的 manager

### 发现的问题（1 项）
- ⚠️ **switch_id group 防御删除逻辑缺陷**：当检测到 session 文件 group_id 不匹配时，`deleteSession` 使用文件内容中的 group_id 而非文件名中的 group_id，导致伪造文件未被删除。建议将 `server.ts:641` 改为 `deleteSession(SESSION_DIR, GROUP_ID, targetSession.peer_id)`。

---

## 8. Re-verify: switch_id guard 修复（commit `f1bd8be`）

developer 针对 §3 发现的问题进行了修复：`server.ts:641` 的 `deleteSession` 调用从 `targetSession.group_id` 改为 `GROUP_ID`。

### R1: 伪造文件删除验证

**测试步骤**：同 §3 — 创建文件名 `GROUP_A_manager.json`、内部 `group_id=GROUP_B` 的伪造文件，模拟 switch_id guard 逻辑。

**修复前结果**：`deleteSession(dir, targetSession.group_id, targetSession.peer_id)` → 尝试删除 `GROUP_B_manager.json`（不存在），伪造文件残留。

**修复后结果**：`deleteSession(dir, GROUP_ID, id)` → 正确删除 `GROUP_A_manager.json`，伪造文件**被实际删除**。

```
Files after guard: []
✅ R1: Corrupt session file was ACTUALLY deleted
```

**状态：PASS**

### R2: 正常流程不受影响

**测试步骤**：创建有效的 `GROUP_A_manager.json`（`group_id === GROUP_A`），验证 guard 不触发，文件保留。

**结果**：
```
✅ R2: Group ID matches — guard NOT triggered, normal flow proceeds
✅ R2: Valid session file preserved
```

**状态：PASS**

---

## 9. 更新后结论

### 全部通过（9/9）
1. ✅ Broker TDZ 崩溃修复
2. ✅ 跨组 Broker 隔离
3. ✅ 跨组 Session 文件隔离
4. ✅ switch_id group 防御（含修复验证）
5. ✅ 旧格式迁移 C1 — C4
6. ✅ CLI 跨组查询
7. ✅ 自动化测试回归 — 66 pass / 0 fail

**PR #6 推荐合并。** 所有测试项均通过，发现的 switch_id guard 缺陷已在 commit `f1bd8be` 修复并验证。
