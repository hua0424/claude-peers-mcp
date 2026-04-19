# doc/

团队成员之间的大量信息交流与项目文档存放地点。

当 peer 之间需要交换的信息超出 `send_message` 合适长度（PRD、设计方案、评审意见、测试报告、会议纪要等），请以文件形式放入本目录，并通过 `send_message` 发送文件路径引用。

## 目录约定

- `prd/` — 产品需求文档（PRD）
- `design/` — 技术设计 / 架构方案
- `review/` — 代码 review 记录与反馈
- `test/` — 测试计划、测试报告、缺陷清单
- `meeting/` — 讨论纪要、决策记录

## 文件命名

`YYYY-MM-DD-<简短标题>.md`，例如 `2026-04-18-peer-auth-design.md`。

## 使用流程

1. 作者创建文档并提交。
2. 通过 `send_message` 将路径（相对仓库根）发给相关 peer，例如：
   `请 review doc/design/2026-04-18-peer-auth-design.md`
3. 反馈直接追加到文档或新建 review 文件。
