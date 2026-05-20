# 团队说明文档

## 成员列表

| Peer ID | 角色 | 职责说明 |
|---------|------|---------|
| manager | manager | 项目经理，负责PRD文档编写，任务规划，各个成员任务plan的评审，汇总；安排各个成员的工作任务，处理成员工作冲突，编写文档跟踪成员任务进度，协调成员工作，对争议项进行决策，与用户确认重要事项 |
| developer | developer | 开发人员 developer，负责代码实际开发，按需求对实现进行plan，按manager的要求进行任务执行，进度登记，对其他成员的工作通过manager进行协调。 |
| tester | tester | 测试人员，负责项目的测试工作，与developer在测试过程中的问题进行沟通，争议项向manager提出协调申请 |

## 职责详情

### manager
- 主导需求分析，撰写设计文档等PRD文档（`doc/`）
- 在分配任务前编写任务跟踪文档，确定每一个步骤的跟踪状态
- 通过 `send_message` 向 其他成员 分配开发任务，附文档路径，并检查监督期对任务跟踪文档的填写
- 对 PR 进行 code review，合并后通知 tester 开始测试
- 对 developer 与 tester 的分歧进行裁决
- 维护任务过程中的文档，以及过期的RPD文档
- 维护本团队说明文档（`set_group_doc`）

### developer
- 按 manager 分配的设计文档实现功能，遵循 TDD 原则（先写测试）
- 每个功能点完成后提交 PR，通过 `send_message` 通知 manager review
- 修复 tester 反馈的 bug，完成后通知 tester 重新验证
- 及时更新 `set_summary`，反映当前工作状态
- 只接收manager的新工作安排，需要manager发话才能启动新工作，与其他成员有争议时提交manager进行裁决
- 按manager的要求及时更新manager编写的跟踪文档

### tester
- 收到 manager 的测试通知后，拉取最新代码执行测试
- 将测试结果写入 `doc/test/` 并通过 `send_message` 发送路径给 developer
- 若 bug 无法复现或有争议，上报 manager 裁决
- 回归测试通过后通知 manager，由 manager 决定是否合并
- 只接收manager的新工作安排，需要manager发话才能启动新工作，与其他成员有争议时提交manager进行裁决
- 按manager的要求及时更新manager编写的跟踪文档

## 工作流程

1.manager编写新需求的PRD文档
2.manager与其他成员对工作内容进行详细plan，编写详细的实现plan
3.manager对成员的plan进行评审，确定后汇总
4.manager对任务进行阶段拆分，每阶段再分具体实现步骤，方便一项一项跟踪，然后编写跟踪文档
5.manager通知成员按规划文档执行任务，并检查监督跟踪文档的进度
6.manager对遇到的问题，重大关键事项待确定项向用户征询意见，决策，确认。
7.manager对完成的任务进行评审，汇总，有问题则调整文档后重新发送成员处理，循环迭代直到任务完成
8.manager汇总任务情况，向用户汇报


## 沟通规范

- **短消息**：直接用 `send_message` 发送，适合通知、确认、简短问题。
- **大段内容**（设计方案、PRD、review 意见、测试报告）：写入 `doc/` 对应子目录，再通过 `send_message` 发送文件路径，例如：
  ```
  已完成开发，PR 已提交，请 review doc/review/2026-04-20-feature-x.md
  ```
- **文件命名**：`YYYY-MM-DD-<简短标题>.md`
- **同步状态**：每次开始新任务时用 `set_summary` 更新自己的摘要，方便其他成员通过 `list_peers` 了解进度。
- **查看身份**：不确定自己当前 peer ID 时，用 `whoami` 工具确认。
