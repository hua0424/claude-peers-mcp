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
  ResumeResponse,
  WsPushMessage,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitRoot,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";
import { hostname } from "node:os";
import { saveSession, loadSession, scanSessions, deleteSession, cleanupStaleSessions } from "./shared/session.ts";
import { deriveGroupId, isValidPeerId } from "./shared/auth.ts";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

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

const SESSION_DIR = join(process.env.HOME ?? "/tmp", ".claude-peers", "sessions");
const GROUP_ID = deriveGroupId(GROUP_SECRET!);
// Session files older than this are removed on startup. Should be >= broker's STALE_PEER_TTL (24h).
const SESSION_CLEANUP_AGE_DAYS = 7;
mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });

// Derive WS URL from HTTP URL (normalise protocol regardless of case)
let _brokerParsed: URL;
try {
  _brokerParsed = new URL(BROKER_URL!);
} catch {
  console.error("[claude-peers] CLAUDE_PEERS_BROKER_URL is not a valid URL:", BROKER_URL);
  process.exit(1);
}
const WS_URL = (_brokerParsed.protocol === "https:" ? "wss:" : "ws:") + "//" + _brokerParsed.host;

// --- Utility ---

function log(msg: string) {
  console.error(`[claude-peers] ${msg}`);
}

// --- Broker communication ---

let myId: PeerId | null = null;
let myRole: string = "unknown";
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
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "(unreadable)");
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

function friendlyError(e: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const msg = e instanceof Error ? e.message : String(e);
  const friendly = msg.includes("fetch failed") || msg.includes("ECONNREFUSED")
    ? "Broker is not reachable. Messages and peer discovery are temporarily unavailable."
    : msg.includes("401")
    ? "Authentication failed. Check your API key and group secret."
    : `Broker error: ${msg}`;
  return { content: [{ type: "text" as const, text: friendly }], isError: true };
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
  myRole = reg.role ?? "unknown";
  currentSummary = summary;
  saveCurrentSession();
  log(`Registered as peer ${myId}`);
}

function saveCurrentSession(): void {
  if (!myId || !myToken) return;
  saveSession(SESSION_DIR, {
    peer_id: myId,
    instance_token: myToken,
    cwd: myCwd,
    group_id: GROUP_ID,
    hostname: myHostname,
    summary: currentSummary || undefined,
  });
}

// --- WebSocket connection ---

let initialSummary = "";
// Tracks the most recent summary (auto-generated or user-set). Used when re-registering
// after a forced re-registration so the user's set_summary calls are not silently discarded.
let currentSummary = "";

function connectWebSocket() {
  if (!myToken) return;

  log(`Connecting WebSocket to ${WS_URL}/ws`);
  // Capture token at call time so the onopen closure uses the token that was current when
  // connectWebSocket() was called, not whatever myToken happens to be when the socket opens.
  const tokenForAuth = myToken;
  // Capture in a local variable so closures don't race with the module-level `ws`
  const socket = new WebSocket(`${WS_URL}/ws`);
  ws = socket;

  socket.onopen = () => {
    // Send token as first message (keeps token out of URL / proxy logs)
    socket.send(JSON.stringify({ type: "auth", token: tokenForAuth }));
    log("WebSocket connected, auth sent");
    reconnectDelay = 1000; // reset backoff on success
    wsFailCount = 0;
  };

  socket.onmessage = async (event) => {
    try {
      const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      const msg = JSON.parse(data) as WsPushMessage & { type: string };

      if (msg.type === "auth_ok") {
        log(`WebSocket authenticated as ${(msg as { id?: string }).id ?? myId}`);
        return;
      }

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

  socket.onclose = (event) => {
    if (ws === socket) ws = null;
    if ((event as CloseEvent).code === 1000) {
      // Intentional close (cleanup, switch_id) — caller manages reconnect
      return;
    }
    log(`WebSocket disconnected (code ${(event as CloseEvent).code}), reconnecting in ${reconnectDelay}ms`);
    scheduleReconnect();
  };

  socket.onerror = (e) => {
    log(`WebSocket error: ${e}`);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  wsFailCount = Math.min(wsFailCount + 1, RE_REGISTER_AFTER_FAILURES + 1);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      if (wsFailCount >= RE_REGISTER_AFTER_FAILURES) {
        log("Multiple WS failures, attempting /resume...");
        try {
          const res = await fetch(`${BROKER_URL}/resume`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: API_KEY, instance_token: myToken }),
            signal: AbortSignal.timeout(10000),
          });
          if (res.ok) {
            const data = await res.json() as { id: string; instance_token: string; role?: string };
            myId = data.id;
            myToken = data.instance_token;
            myRole = data.role ?? myRole;
            saveCurrentSession();
            log("Resume successful, reconnecting WS...");
            wsFailCount = 0;
          } else if (res.status === 401) {
            log("Token invalid, re-registering...");
            const oldId401 = myId;
            await register(currentSummary || initialSummary);
            if (oldId401) deleteSession(SESSION_DIR, oldId401);
            wsFailCount = 0;
          } else if (res.status === 409) {
            log("Session taken by another connection, re-registering...");
            const oldId409 = myId;
            await register(currentSummary || initialSummary);
            if (oldId409) deleteSession(SESSION_DIR, oldId409);
            wsFailCount = 0;
          } else {
            log(`Resume returned unexpected status ${res.status}, will retry later`);
            scheduleReconnect();
            return; // don't attempt WS with unknown token state
          }
        } catch (e) {
          log(`Resume/re-register failed: ${e instanceof Error ? e.message : String(e)}`);
          // Don't attempt WS connection with a potentially stale token
          scheduleReconnect();
          return;
        }
      }
      connectWebSocket();
    } catch {
      scheduleReconnect();
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
- set_id: Set a custom peer ID (e.g. 'my-review-bot')
- switch_id: Switch to a different peer identity if the wrong one was auto-resumed
- whoami: Show your current peer ID, role, and summary
- set_role: Set your role in the group (first time only after Phase 2)
- get_group_doc: Fetch the group's shared Markdown documentation
- set_group_doc: Publish group documentation (manager only after Phase 2)
- generate_group_doc: Generate a team-doc template from current online members

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
  {
    name: "set_id",
    description:
      "Set a custom peer ID for this session. The ID must be 1-32 lowercase alphanumeric characters or hyphens. Fails if the ID is already taken by another peer in your group.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string" as const,
          description: "The custom peer ID to set (e.g. 'my-review-session')",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "switch_id",
    description:
      "Switch to a different peer identity. Looks up a local session file for the target ID and resumes that session. Useful if the wrong session was auto-resumed on startup.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string" as const,
          description: "The peer ID to switch to (must exist as a local session file)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "whoami",
    description: "Return your current peer ID, role, and summary. Use this to confirm your identity in the group.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "set_role",
    description:
      "Set your role. Phase 2 will restrict re-assignment to manager only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        role: { type: "string" as const, description: "Your role name (e.g. 'developer')" },
      },
      required: ["role"],
    },
  },
  {
    name: "get_group_doc",
    description:
      "Fetch the group's shared documentation (Markdown). " +
      "Contains team roster, role responsibilities, and workflow. " +
      "Copy into your CLAUDE.md to keep your system prompt in sync.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "set_group_doc",
    description:
      "Publish a Markdown document as the group's shared documentation. " +
      "Only peers with role 'manager' can call this (Phase 2 enforcement). " +
      "Use generate_group_doc to create a template first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        doc: { type: "string" as const, description: "Markdown content for the group doc" },
      },
      required: ["doc"],
    },
  },
  {
    name: "generate_group_doc",
    description:
      "Generate a Markdown team-doc template from current online members. " +
      "Returns the template text — review it, then call set_group_doc to publish. " +
      "Manager should fill in responsibilities and workflow sections.",
    inputSchema: { type: "object" as const, properties: {} },
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
        return friendlyError(e);
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
        const result = await brokerFetch<{ ok: boolean; error?: string; queued?: boolean }>("/send-message", {
          to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        if (result.queued) {
          return {
            content: [{ type: "text" as const, text: `Peer ${to_id} is offline. Message queued and will be delivered when they reconnect.` }],
          };
        }
        return {
          content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }],
        };
      } catch (e) {
        return friendlyError(e);
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
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/set-summary", { summary });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed: ${result.error}` }],
            isError: true,
          };
        }
        currentSummary = summary; // keep in sync so re-registration uses the latest summary
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return friendlyError(e);
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet." }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ messages: WsPushMessage[] }>("/check-messages", {});
        if (result.messages.length === 0) {
          const wsStatus = ws && ws.readyState === WebSocket.OPEN
            ? "WebSocket is connected."
            : "WebSocket is reconnecting.";
          return {
            content: [{ type: "text" as const, text: `No queued messages. ${wsStatus}` }],
          };
        }
        for (const msg of result.messages) {
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
        }
        return {
          content: [{ type: "text" as const, text: `Delivered ${result.messages.length} queued message(s).` }],
        };
      } catch (e) {
        return friendlyError(e);
      }
    }

    case "set_id": {
      const { id } = args as { id: string };
      if (!myId || !myToken) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      if (!isValidPeerId(id)) {
        return { content: [{ type: "text" as const, text: `Invalid peer ID format: "${id}"` }], isError: true };
      }
      try {
        const result = await brokerFetch<{ id: string }>("/set-id", { new_id: id });
        if (!result.id) {
          return { content: [{ type: "text" as const, text: "Broker returned invalid response" }], isError: true };
        }
        const oldId = myId;
        myId = result.id;
        deleteSession(SESSION_DIR, oldId);
        saveCurrentSession();
        return { content: [{ type: "text" as const, text: `ID changed from ${oldId} to ${myId}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "switch_id": {
      const { id } = args as { id: string };
      if (!isValidPeerId(id)) {
        return { content: [{ type: "text" as const, text: `Invalid peer ID format: "${id}"` }], isError: true };
      }
      const targetSession = loadSession(SESSION_DIR, id);
      if (!targetSession) {
        return { content: [{ type: "text" as const, text: `No local session found for peer ${id}` }], isError: true };
      }
      try {
        const res = await fetch(`${BROKER_URL}/resume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: API_KEY, instance_token: targetSession.instance_token }),
          signal: AbortSignal.timeout(10000),
        });
        const resumeData = await res.json() as { id?: string; instance_token?: string; role?: string; error?: string };
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Cannot switch: ${resumeData.error}` }], isError: true };
        }
        // Validate before mutating any state — if we unregister the old identity first
        // and then discover the response is malformed, myToken becomes a rotated/stale token
        // and the server is stuck until restart.
        if (!resumeData.id || !resumeData.instance_token) {
          return { content: [{ type: "text" as const, text: "Broker returned invalid resume response" }], isError: true };
        }
        // Dormant current session using the OLD identity token (myToken not yet updated).
        // If /unregister fails, the old peer remains active on the broker until either
        // the WS idle timeout (120s) or the 24-hour stale cleanup evicts it.
        if (myToken) {
          try { await brokerFetch("/unregister", {}); } catch (e) { log(`Failed to unregister current session: ${e instanceof Error ? e.message : String(e)}`); }
          if (myId) deleteSession(SESSION_DIR, myId);
        }
        // Cancel any in-flight reconnect before switching identity
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        wsFailCount = 0;
        reconnectDelay = 1000; // reset backoff for new identity
        const oldId = myId;
        myId = resumeData.id;
        myToken = resumeData.instance_token;
        myRole = resumeData.role ?? "unknown";
        // Restore summary from target session so forced re-registration uses
        // the correct summary, mirroring the pattern in tryResumeSession.
        currentSummary = targetSession.summary || "";
        // Remove the old session file for the target identity before writing the new one,
        // so scanSessions never sees two files for the same peer on next startup.
        deleteSession(SESSION_DIR, targetSession.peer_id);
        saveCurrentSession();
        // Reconnect WS with new token
        if (ws) ws.close(1000, "Switching identity");
        connectWebSocket();
        return { content: [{ type: "text" as const, text: `Switched from ${oldId} to ${myId}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "whoami": {
      return {
        content: [{
          type: "text" as const,
          text: [
            `Peer ID: ${myId ?? "(not registered)"}`,
            `Role:    ${myRole}`,
            `Summary: ${currentSummary || "(none)"}`,
            `CWD:     ${myCwd}`,
            `Host:    ${myHostname}`,
          ].join("\n"),
        }],
      };
    }

    case "set_role": {
      const { role } = args as { role: string };
      if (!myId || !myToken) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/set-role", { role });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        }
        myRole = role;
        return { content: [{ type: "text" as const, text: `Role set to: ${role}` }] };
      } catch (e) {
        return friendlyError(e);
      }
    }

    case "get_group_doc": {
      if (!myId || !myToken) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        const result = await brokerFetch<{ doc: string }>("/get-group-doc", {});
        if (!result.doc) {
          return {
            content: [{ type: "text" as const, text: "No group doc set yet. Call generate_group_doc to create a template, then set_group_doc to publish it." }],
          };
        }
        return { content: [{ type: "text" as const, text: result.doc }] };
      } catch (e) {
        return friendlyError(e);
      }
    }

    case "set_group_doc": {
      const { doc } = args as { doc: string };
      if (!myId || !myToken) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/set-group-doc", { doc });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Failed: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: "Group doc updated successfully." }] };
      } catch (e) {
        return friendlyError(e);
      }
    }

    case "generate_group_doc": {
      if (!myId || !myToken) {
        return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      }
      try {
        const peers = await brokerFetch<Array<{ id: string; role: string; summary: string }>>("/list-peers", {
          scope: "group",
          cwd: myCwd,
          hostname: myHostname,
          git_root: myGitRoot,
        });
        const allMembers = [
          { id: myId, role: myRole, summary: currentSummary || "(未填写)" },
          ...peers.map((p) => ({ id: p.id, role: p.role ?? "unknown", summary: p.summary || "(未填写)" })),
        ];
        const now = new Date().toISOString().slice(0, 10);
        const tableRows = allMembers
          .map((m) => `| ${m.id} | ${m.role} | ${m.summary} |`)
          .join("\n");
        const uniqueRoles = [...new Set(allMembers.map((m) => m.role))];
        const roleBlocks = uniqueRoles
          .map((r) => `### ${r}\n<!-- 填写 ${r} 的详细职责 -->`)
          .join("\n\n");
        const template = `# 团队说明文档

> 由 generate_group_doc 生成于 ${now}。请 manager 补充完善后调用 set_group_doc 提交。

## 成员列表

| Peer ID | 角色 | 职责说明 |
|---------|------|---------|
${tableRows}

## 职责详情

${roleBlocks}

## 工作流程

<!-- 描述团队协作流程，例如：
1. manager 在 doc/ 目录创建需求文档，send_message 通知 developer
2. developer 完成开发后 send_message 通知 tester
3. tester 完成测试后 send_message 汇报 manager
-->

## 沟通规范

大段内容（PRD、设计方案、review 报告）放 doc/ 目录，通过 send_message 发送路径引用。
`;
        return {
          content: [{
            type: "text" as const,
            text: `Template generated. Review below, then call set_group_doc to publish:\n\n${template}`,
          }],
        };
      } catch (e) {
        return friendlyError(e);
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Startup ---

async function tryResumeSession(): Promise<boolean> {
  cleanupStaleSessions(SESSION_DIR, SESSION_CLEANUP_AGE_DAYS);
  const sessions = scanSessions(SESSION_DIR, myCwd, GROUP_ID, myHostname);

  for (const session of sessions) {
    // Skip sessions with malformed tokens (e.g. corrupted files) before hitting the network
    if (!/^[0-9a-f]{64}$/.test(session.instance_token)) {
      log(`Session ${session.peer_id} has invalid token format, removing`);
      deleteSession(SESSION_DIR, session.peer_id);
      continue;
    }
    try {
      const res = await fetch(`${BROKER_URL}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: API_KEY, instance_token: session.instance_token }),
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const data = await res.json() as ResumeResponse;
        myId = data.id;
        myToken = data.instance_token;
        myRole = data.role ?? "unknown";
        // Restore the summary from the session file so forced re-registration
        // after WS failures uses the correct summary, not the stale startup value.
        if (session.summary) currentSummary = session.summary;
        saveCurrentSession();
        log(`Resumed session as peer ${myId}`);
        return true;
      }

      if (res.status === 409) {
        log(`Session ${session.peer_id} has active connection, skipping`);
        continue;
      }

      if (res.status === 401) {
        log(`Session ${session.peer_id} token invalid, removing stale file`);
        deleteSession(SESSION_DIR, session.peer_id);
        continue;
      }

      log(`Session ${session.peer_id} /resume returned unexpected status ${res.status}, treating as unreachable`);
      return false; // unexpected broker error — don't waste time trying remaining sessions
    } catch {
      // Broker unreachable, will fail on register too
      return false;
    }
  }
  return false;
}

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

  // 3. Try to resume existing session, or register new
  const resumed = await tryResumeSession();
  if (!resumed) {
    await register(initialSummary);
  }

  // If summary generation is still running, update it when done
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myToken) {
        try {
          await brokerFetch("/set-summary", { summary: initialSummary });
          log(`Late auto-summary applied: ${initialSummary}`);
          // Sync currentSummary only if user hasn't called set_summary yet
          if (!currentSummary) {
            currentSummary = initialSummary;
            saveCurrentSession();
          }
        } catch { /* Non-critical */ }
      }
    }).catch(() => { /* Non-critical */ });
  }

  // 4. Connect WebSocket for message push
  connectWebSocket();

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Clean up on exit
  let shuttingDown = false;
  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    // Unregister first (while peer is still active), then close WS.
    // Reversing the order would cause /unregister to fail because the WS close
    // handler sets the peer to dormant before the HTTP call completes.
    if (myToken) {
      try {
        await brokerFetch("/unregister", {});
        log("Unregistered from broker");
      } catch { /* Best effort */ }
    }
    const activeWs = ws;
    ws = null;
    if (activeWs) activeWs.close(1000);
    try { await mcp.close(); } catch { /* Best effort */ }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
