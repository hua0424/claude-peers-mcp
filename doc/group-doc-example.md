# 团队说明文档示例

> **说明**：本文件是 `group_doc` 的填写示例，供参考。实际团队文档由 `generate_group_doc` 生成骨架后，由 manager 补充完善并通过 `set_group_doc` 提交。

---

# claude-peers-mcp 开发团队

> 由 generate_group_doc 生成于 2026-04-20 10:00，由 manager 补充完善。

## 成员列表

| Peer ID | 角色 | 职责说明 |
|---------|------|---------|
| `manager` | manager | 项目规划、设计评审、PR 合并；协调开发与测试工作，分配任务并跟踪进度 |
| `developer` | developer | 功能开发与 bug 修复；接受 manager 任务分配，响应 tester 反馈 |
| `tester` | tester | 功能测试与回归测试；输出测试报告，将故障反馈给 developer |

## 职责详情

### manager

- 主导需求分析，撰写设计文档（`doc/design/`）
- 通过 `send_message` 向 developer 分配开发任务，附文档路径
- 对 PR 进行 code review，合并后通知 tester 开始测试
- 对 developer 与 tester 的分歧进行裁决
- 维护本团队说明文档（`set_group_doc`）

### developer

- 按 manager 分配的设计文档实现功能，遵循 TDD 原则（先写测试）
- 每个功能点完成后提交 PR，通过 `send_message` 通知 manager review
- 修复 tester 反馈的 bug，完成后通知 tester 重新验证
- 及时更新 `set_summary`，反映当前工作状态

### tester

- 收到 manager 的测试通知后，拉取最新代码执行测试
- 将测试结果写入 `doc/test/` 并通过 `send_message` 发送路径给 developer
- 若 bug 无法复现或有争议，上报 manager 裁决
- 回归测试通过后通知 manager，由 manager 决定是否合并

## 工作流程

```
manager 撰写设计文档
       │
       ▼
manager ──send_message──▶ developer（附设计文档路径）
                                │
                          开发 + 写测试
                                │
                          提交 PR + send_message ──▶ manager
                                                        │
                                                    code review
                                                        │
                                              ┌─────────┴─────────┐
                                           通过                   有问题
                                              │                    │
                                       合并 PR              send_message ──▶ developer
                                              │
                                    send_message ──▶ tester（附 PR 说明）
                                              │
                                         执行测试
                                              │
                                   ┌──────────┴──────────┐
                                通过                    有 bug
                                   │                      │
                          send_message ──▶ manager  send_message ──▶ developer
                                   │
                              迭代结束
```

## 沟通规范

- **短消息**：直接用 `send_message` 发送，适合通知、确认、简短问题。
- **大段内容**（设计方案、PRD、review 意见、测试报告）：写入 `doc/` 对应子目录，再通过 `send_message` 发送文件路径，例如：
  ```
  已完成开发，PR 已提交，请 review doc/review/2026-04-20-feature-x.md
  ```
- **文件命名**：`YYYY-MM-DD-<简短标题>.md`
- **同步状态**：每次开始新任务时用 `set_summary` 更新自己的摘要，方便其他成员通过 `list_peers` 了解进度。
- **查看身份**：不确定自己当前 peer ID 时，用 `whoami` 工具确认。
