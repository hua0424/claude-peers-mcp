# Group Config & Role System 设计文档

**日期**：2026-04-19  
**状态**：待实现  
**分支**：`feat/group-config`（计划）

---

## 背景与目标

当前 claude-peers 已支持 peer ID 固定身份，但缺少：
- 组级别的说明文档（成员职责、工作流程等）
- Peer 的角色属性（区分 manager / developer / tester）
- 查看自身 ID 与角色的工具（whoami）
- Broker 侧的管理命令

本期分两个阶段交付，数据模型一次到位，权限管控在第二阶段加固。

---

## 数据模型变更（一次到位）

### `peers` 表新增字段

```sql
ALTER TABLE peers ADD COLUMN role TEXT NOT NULL DEFAULT 'unknown';
```

- 默认值 `'unknown'`，表示尚未分配角色
- 角色由 peer 自行首次设置，或由 manager 修改（第二阶段执行权限校验）
- 常见值：`manager` / `developer` / `tester`，可扩展

### `groups` 表新增字段

```sql
ALTER TABLE groups ADD COLUMN doc TEXT NOT NULL DEFAULT '';
```

- 存储 Markdown 格式的组说明文档
- 由 `set_group_doc` 写入，`get_group_doc` 读取
- 第一阶段无权限校验，第二阶段限 manager 写入

---

## 阶段一：核心工具（无权限拦截）

**目标**：提供完整的数据读写能力，所有角色均可使用全部工具。  
**验收**：developer / tester 可使用 whoami、set_role、get/set_group_doc；manager 可生成并提交模板。

### 1.1 新增 Broker 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/set-role` | POST | 设置 caller 自身角色（body: `{role: string}`） |
| `/get-group-doc` | POST | 获取 caller 所在 group 的说明文档 |
| `/set-group-doc` | POST | 写入 group 说明文档（body: `{doc: string}`） |
| `/admin/groups` | GET | 列出所有 groups（API Key 鉴权，无需 group secret） |

### 1.2 修改现有端点

- `/register` 响应追加 `role` 字段（方便 MCP server 初始化 `myRole`）
- `/resume` 响应追加 `role` 字段
- `/list-peers` 响应每条 peer 追加 `role` 字段

### 1.3 新增 MCP 工具（server.ts）

#### `whoami`
返回当前会话的完整身份信息。

```
输出：peer ID、role、summary、cwd、hostname
```

#### `set_role`
设置当前 peer 的角色。

```
输入：role (string)
规则（阶段一）：无限制，任意调用均可设置
```

#### `get_group_doc`
获取当前 group 的说明文档（Markdown 文本）。

```
输出：Markdown 字符串（为空时提示"尚未设置，可用 generate_group_doc 生成模板"）
```

#### `set_group_doc`
写入 group 说明文档。

```
输入：doc (string, Markdown)
规则（阶段一）：无限制
```

#### `generate_group_doc`
根据当前在线成员自动生成 Markdown 模板，**不自动提交**，返回文本供 manager 确认后手动调用 `set_group_doc`。

生成逻辑：
1. 调用 `/list-peers` 获取全部在线成员（含 role、summary）
2. 加入自身（whoami）
3. 填充模板（见下方模板格式）

**模板格式**：

```markdown
# 团队说明文档

> 由 generate_group_doc 生成于 {datetime}，请 manager 补充完善后调用 set_group_doc 提交。

## 成员列表

| Peer ID | 角色 | 职责说明 |
|---------|------|---------|
| {id} | {role} | {summary} |

## 职责详情

### {role: manager}
<!-- 填写 manager 的详细职责 -->

### {role: developer}
<!-- 填写 developer 的详细职责 -->

### {role: tester}
<!-- 填写 tester 的详细职责 -->

## 工作流程

<!-- 描述团队协作流程，例如：
1. manager 在 doc/ 目录创建需求文档，send_message 通知 developer
2. developer 完成开发后 send_message 通知 tester
3. tester 完成测试后 send_message 汇报 manager
-->

## 沟通规范

<!-- 大段内容（PRD、设计方案、review 报告）放 doc/ 目录，通过 send_message 发送路径引用 -->
```

### 1.4 CLI 增强（cli.ts）

| 命令 | 说明 | 鉴权 |
|------|------|------|
| `bun cli.ts groups` | 列出 broker 上所有 groups（group_id、成员数、创建时间） | API Key |
| `bun cli.ts peers` | 现有命令，输出中追加 role 列 | Group Secret |
| `bun cli.ts group-doc` | 显示当前 group 的说明文档 | Group Secret |

### 1.5 类型更新（shared/types.ts）

新增：
- `Peer.role: string`
- `SetRoleRequest`、`GetGroupDocResponse`、`SetGroupDocRequest`

### 1.6 README 更新

- 新增 CLI 命令说明章节
- 说明 role 字段用途与设置方式

---

## 阶段二：权限管控

**目标**：role 字段的设置施加约束，group doc 的写入限制为 manager 专属。  
**验收**：non-manager peer 无法修改他人 role；non-manager 调用 set_group_doc 返回 403。

### 2.1 `set_role` 权限规则（broker 侧执行）

```
IF caller.role == 'unknown':
    允许设置任意 role（首次设置）
ELSE IF caller.role == 'manager':
    允许通过附加参数 peer_id 修改他人 role
    省略 peer_id 时修改自身
ELSE:
    拒绝，返回 403（"Role already set, only manager can change it"）
```

#### `set_role` 请求体变更

```ts
// 阶段一
{ role: string }

// 阶段二（manager 可附加 peer_id）
{ role: string; peer_id?: string }
```

### 2.2 `set_group_doc` 权限规则

```
IF caller.role != 'manager':
    返回 403（"Only manager can update group doc"）
```

### 2.3 MCP 工具描述更新

- `set_role` description 注明限制条件
- `set_group_doc` description 注明仅 manager 可调用
- `generate_group_doc` 描述保持不变（所有人可生成模板，但提交需 manager）

### 2.4 测试用例（新增）

| 场景 | 预期 |
|------|------|
| unknown peer 设置 role | 200 成功 |
| 已有 role 的 non-manager peer 修改自身 role | 403 |
| manager 修改他人 role | 200 成功 |
| non-manager 调用 set_group_doc | 403 |
| manager 调用 set_group_doc | 200 成功 |

---

## 任务分配

### 阶段一

| 任务 | 负责人 | 说明 |
|------|--------|------|
| DB schema 迁移（role + doc 字段） | developer | `broker.ts` 迁移段，含 ALTER TABLE |
| 新增 Broker 端点（4 个） | developer | `/set-role` `/get-group-doc` `/set-group-doc` `/admin/groups` |
| 修改现有端点响应（register/resume/list-peers） | developer | 追加 role 字段 |
| 新增 MCP 工具（5 个） | developer | server.ts + types.ts |
| CLI 增强（3 命令） | developer | cli.ts |
| README 更新 | developer | CLI 章节 + role 说明 |
| 阶段一功能测试 | tester | 覆盖所有新工具的正常路径 |

### 阶段二

| 任务 | 负责人 | 说明 |
|------|--------|------|
| set_role 权限校验（broker 侧） | developer | 含 peer_id 参数支持 |
| set_group_doc 权限校验（broker 侧） | developer | role != manager → 403 |
| MCP 工具描述更新 | developer | server.ts |
| 权限拒绝场景测试 | tester | 见 2.4 测试矩阵 |

---

## 里程碑

| 里程碑 | 内容 | 负责 |
|--------|------|------|
| M1 | 设计文档确认，建立 feat/group-config 分支 | manager |
| M2 | 阶段一开发完成，tester 开始测试 | developer |
| M3 | 阶段一测试通过，PR 提交 review | tester → manager |
| M4 | 阶段一合并主线，阶段二开发启动 | manager |
| M5 | 阶段二开发+测试完成，PR 合并 | developer + tester |
