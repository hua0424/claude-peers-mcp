# Peers Skill — Design Document

> Date: 2026-04-23
> Issue: All claude-peers operations currently require natural-language prompting to the LLM, which is indirect and consumes conversation context.

## Goal

Provide a unified `/peers` slash command in Claude Code that maps directly to claude-peers MCP tools, bypassing the need for natural-language negotiation with the LLM.

## Architecture

A single Claude Code skill distributed with the claude-peers repo. The skill translates user-typed `/peers <action> [args...]` into direct MCP tool invocations.

```
User: /peers list group
    ↓
Claude loads ~/.claude/skills/peers/SKILL.md
    ↓
Skill content instructs Claude: "call list_peers with scope='group'"
    ↓
Claude invokes the MCP tool directly
    ↓
Result returned to user
```

## Skill Design

### Location

Project-level skill: `.claude/skills/peers/SKILL.md` (committed to repo)

User installs by copying to personal skills:
```bash
cp -r .claude/skills/peers ~/.claude/skills/
```

### Frontmatter

```yaml
---
name: peers
description: Quick access to claude-peers MCP tools. Invoke directly with /peers <action>.
disable-model-invocation: true
argument-hint: "<action> [args...]"
arguments: [action]
---
```

- `disable-model-invocation: true` — prevents Claude from auto-triggering; only explicit `/peers` invocations
- `arguments` — first positional arg is the action, remainder are tool-specific args

### Action Mapping

| Action | MCP Tool | Args | Example |
|--------|----------|------|---------|
| `whoami` | whoami | — | `/peers whoami` |
| `list` | list_peers | `[scope]` | `/peers list`, `/peers list repo` |
| `send` | send_message | `<to_id> <message>` | `/peers send alice "hello"` |
| `set-id` | set_id | `<id>` | `/peers set-id my-bot` |
| `set-summary` | set_summary | `<text>` | `/peers set-summary "fixing bug"` |
| `set-role` | set_role | `<role>` | `/peers set-role developer` |
| `check` | check_messages | — | `/peers check` |
| `doc-get` | get_group_doc | — | `/peers doc-get` |
| `doc-set` | set_group_doc | — | `/peers doc-set` (opens editor) |
| `doc-gen` | generate_group_doc | — | `/peers doc-gen` |
| `switch-id` | switch_id | — | `/peers switch-id` |

### Skill Content Strategy

The SKILL.md body instructs Claude to:
1. Parse `$0` as the action
2. Parse remaining args (`$ARGUMENTS` minus action) as tool parameters
3. Call the matching MCP tool with the exact parameters
4. Return the raw result without conversational fluff

## Installation

Two paths:

**Manual:**
```bash
cd ~/claude-peers-mcp
cp -r .claude/skills/peers ~/.claude/skills/
```

**CLI command (future):**
```bash
bun cli.ts install-skills
```

## Testing

1. Install skill to `~/.claude/skills/`
2. Restart Claude Code (skill discovery)
3. Verify skill appears: type `/` and see `peers` in the list
4. Run `/peers whoami` → should return peer info
5. Run `/peers list` → should return peers in group

## Files Changed

- **Create:** `.claude/skills/peers/SKILL.md` — the skill definition
- **Modify:** `README.md` — add skill installation instructions

## Non-Goals

- Not replacing MCP tools — they still work via natural language
- Not creating true zero-LLM commands — skills still load into context and tools still execute through the LLM pipeline
- Not auto-registering skills — user must manually copy/install
