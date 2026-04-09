#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Registers with the remote broker using API Key + Group Secret,
 * receives messages via WebSocket push.
 *
 * Required env vars:
 *   CLAUDE_PEERS_BROKER_URL — e.g. http://10.0.0.5:7899
 *   CLAUDE_PEERS_API_KEY    — must match broker's configured key
 *   CLAUDE_PEERS_GROUP_SECRET — determines group membership
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  WsPushMessage,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";
import { hostname } from "node:os";

// --- Configuration ---

const BROKER_URL = process.env.CLAUDE_PEERS_BROKER_URL;
const API_KEY = process.env.CLAUDE_PEERS_API_KEY;
const GROUP_SECRET = process.env.CLAUDE_PEERS_GROUP_SECRET;

if (!BROKER_URL || !API_KEY || !GROUP_SECRET) {
  console.error(
    "[claude-peers] Missing required env vars: CLAUDE_PEERS_BROKER_URL, CLAUDE_PEERS_API_KEY, CLAUDE_PEERS_GROUP_SECRET"
  );
  process.exit(1);
}

// Derive WS URL from HTTP URL
const WS_URL = BROKER_URL.replace(/^http/, "ws");

// --- Utility ---

function log(msg: string) {
  console.error(`[claude-peers] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) return text.trim();
  } catch { /* not a git repo */ }
  return null;
}

// --- Broker communication ---

let myId: PeerId | null = null;
let myToken: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let myHostname = hostname();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
let wsFailCount = 0;
const MAX_RECONNECT_DELAY = 30000;
const RE_REGISTER_AFTER_FAILURES = 3;

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (myToken) {
    headers["Authorization"] = `Bearer ${myToken}`;
  }
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function register(summary: string): Promise<void> {
  const reg = await brokerFetch<RegisterResponse>("/register", {
    api_key: API_KEY,
    group_secret: GROUP_SECRET,
    pid: process.pid,
    hostname: myHostname,
    cwd: myCwd,
    git_root: myGitRoot,
    summary,
  });
  myId = reg.id;
  myToken = reg.instance_token;
  log(`Registered as peer ${myId}`);
}

// --- WebSocket connection ---

let initialSummary = "";

function connectWebSocket() {
  if (!myToken) return;

  const wsUrl = `${WS_URL}/ws?token=${myToken}`;
  log(`Connecting WebSocket to ${WS_URL}/ws`);
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    log("WebSocket connected");
    reconnectDelay = 1000; // reset backoff on success
    wsFailCount = 0;
  };

  ws.onmessage = async (event) => {
    try {
      const data = typeof event.data === "string" ? event.data : await event.data.text();
      const msg = JSON.parse(data) as WsPushMessage;

      if (msg.type === "message") {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: msg.text,
            meta: {
              from_id: msg.from_id,
              from_summary: msg.from_summary,
              from_cwd: msg.from_cwd,
              from_hostname: msg.from_hostname,
              sent_at: msg.sent_at,
            },
          },
        });
        log(`Pushed message from ${msg.from_id}: ${msg.text.slice(0, 80)}`);
      }
    } catch (e) {
      log(`WS message parse error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  ws.onclose = () => {
    log(`WebSocket disconnected, reconnecting in ${reconnectDelay}ms`);
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    log(`WebSocket error: ${e}`);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  wsFailCount++;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      // After repeated failures, token may be invalid (broker restarted).
      // Re-register to get a fresh token before reconnecting.
      if (wsFailCount >= RE_REGISTER_AFTER_FAILURES) {
        log("Multiple WS failures, re-registering with broker...");
        try {
          await register(initialSummary);
          wsFailCount = 0;
        } catch (e) {
          log(`Re-register failed: ${e instanceof Error ? e.message : String(e)}`);
          // Will retry on next cycle
        }
      }
      connectWebSocket();
    } catch {
      // If connect fails, the onclose handler will schedule another retry
    }
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.2.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers network. Other Claude Code instances in your group can see you and send you messages — even across different machines.

IMPORTANT: When you receive a <channel source="claude-peers" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming peer messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, from_cwd, and from_hostname attributes to understand who sent the message. Reply by calling send_message with their from_id.

Available tools:
- list_peers: Discover other Claude Code instances (scope: group/directory/repo)
- send_message: Send a message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other peers)
- check_messages: Manually check for new messages (messages normally arrive via WebSocket push)

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances in your group. Returns their ID, hostname, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["group", "directory", "repo"],
          description:
            'Scope of peer discovery. "group" = all instances in your group (across all machines). "directory" = same working directory on same host. "repo" = same git repository (across hosts).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. The message will be pushed into their session immediately via WebSocket.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The peer ID of the target Claude Code instance (from list_peers)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually trigger a check for new messages. Messages normally arrive instantly via WebSocket, but use this if you suspect a message was missed.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "group" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          hostname: myHostname,
          git_root: myGitRoot,
        });

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `Host: ${p.hostname}`,
            `CWD: ${p.cwd}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          return parts.join("\n  ");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return {
          content: [
            {
              type: "text" as const,
              text: "WebSocket not connected. Messages will be delivered when connection is restored.",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: "WebSocket is connected. Messages are delivered automatically.",
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Startup ---

async function main() {
  // 1. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  myHostname = hostname();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`Hostname: ${myHostname}`);
  log(`Broker: ${BROKER_URL}`);

  // 2. Generate initial summary (non-blocking, best-effort)
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // 3. Register with broker
  await register(initialSummary);

  // If summary generation is still running, update it when done
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myToken) {
        try {
          await brokerFetch("/set-summary", { summary: initialSummary });
          log(`Late auto-summary applied: ${initialSummary}`);
        } catch { /* Non-critical */ }
      }
    });
  }

  // 4. Connect WebSocket for message push
  connectWebSocket();

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Clean up on exit
  const cleanup = async () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close();
    if (myToken) {
      try {
        await brokerFetch("/unregister", {});
        log("Unregistered from broker");
      } catch { /* Best effort */ }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
