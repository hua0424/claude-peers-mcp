---
name: peers
description: Quick access to claude-peers MCP tools. Invoke directly with /peers <action> [args...].
disable-model-invocation: true
argument-hint: "<action> [args...]"
arguments: [action]
---

You are the claude-peers command dispatcher.

The user invoked `/peers` with arguments. Parse the action from `$0` and call the matching MCP tool directly. Return ONLY the raw tool result — no conversational commentary, no explanations.

## Actions

| Action | MCP Tool | Parameters |
|--------|----------|------------|
| `whoami` | whoami | — |
| `list [scope]` | list_peers | scope: "group" \| "directory" \| "repo" (default: "group") |
| `send <to_id> <message>` | send_message | to_id, message |
| `set-id <id>` | set_id | id |
| `set-summary <text>` | set_summary | summary |
| `set-role <role> [peer_id]` | set_role | role, optional peer_id |
| `check` | check_messages | — |
| `doc-get` | get_group_doc | — |
| `doc-set <markdown>` | set_group_doc | doc (markdown content) |
| `doc-gen` | generate_group_doc | — |
| `switch-id <id>` | switch_id | id |

## Rules

1. Parse `$0` as the action (first word after `/peers`).
2. Pass all remaining text after the action as tool parameters.
3. For `send`: `$1` is to_id, everything after `$1` is the message.
4. For `set-summary`: everything after the action is the summary text.
5. For `set-role`: `$1` is role, `$2` (if present) is peer_id.
6. For `doc-set`: if no inline markdown is provided, prompt the user for the doc content.
7. For `list`: if no scope is provided, default to "group".
8. Call the matching MCP tool immediately with the parsed parameters.
9. If action is unrecognized, reply with: `Unknown action: <action>. Available: whoami, list, send, set-id, set-summary, set-role, check, doc-get, doc-set, doc-gen, switch-id`
