---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers

Peer discovery and messaging MCP channel for Claude Code instances.

## 团队通讯录

本项目通过 claude-peers MCP 协作，团队成员（peer ID）与职责如下：

| ID | 角色 | 职责 |
|----|------|------|
| `manager` | 开发经理 | 项目开发计划、设计、文档编写、代码审查；协调开发与测试工作，安排任务并跟踪进度。 |
| `developer` | 开发人员 | 实际代码开发；接受 manager 的任务安排，修复 manager 的 review 事项，处理 tester 反馈的测试故障。 |
| `tester` | 测试人员 | 项目测试工作；将测试结果反馈给 developer，有分歧时提交 manager 裁决；受理 manager 安排的任务。 |

协作时通过 `send_message` 按 ID 直接通讯，`list_peers` 可查看当前在线成员与各自 summary。

大段信息（PRD、设计方案、review、测试报告等）放入仓库的 `doc/` 目录，通过 `send_message` 发送文件路径引用。详见 `doc/README.md`。

## Architecture

- `broker.ts` — HTTP daemon on 0.0.0.0:7899 + SQLite. Run once per network (not auto-launched). API key auth + group-based isolation.
- `server.ts` — MCP stdio server, one per Claude Code instance. Connects to remote broker via env vars, exposes tools, pushes channel notifications via WebSocket.
- `shared/types.ts` — Shared TypeScript types for broker API.
- `shared/auth.ts` — Hashing and token utilities for API key and group secret auth.
- `shared/summarize.ts` — Auto-summary generation via gpt-4o-mini.
- `cli.ts` — CLI utility for inspecting broker state.

## Running

```bash
# On the broker host (run once):
CLAUDE_PEERS_API_KEY=secret bun broker.ts

# Start Claude Code with the channel (on any host):
CLAUDE_PEERS_BROKER_URL=http://10.0.0.5:7899 \
CLAUDE_PEERS_API_KEY=secret \
CLAUDE_PEERS_GROUP_SECRET=mygroup \
claude --dangerously-load-development-channels server:claude-peers

# Or add to .mcp.json (no channel push, but tools work):
# {
#   "claude-peers": {
#     "command": "bun",
#     "args": ["~/claude-peers-mcp/server.ts"],
#     "env": {
#       "CLAUDE_PEERS_BROKER_URL": "http://10.0.0.5:7899",
#       "CLAUDE_PEERS_API_KEY": "secret",
#       "CLAUDE_PEERS_GROUP_SECRET": "mygroup"
#     }
#   }
# }

# CLI (requires same env vars):
CLAUDE_PEERS_BROKER_URL=... CLAUDE_PEERS_API_KEY=... bun cli.ts status
bun cli.ts peers
bun cli.ts send <peer-id> <message>
```

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
