#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for inspecting broker state and sending messages.
 *
 * Required env vars:
 *   CLAUDE_PEERS_BROKER_URL    — e.g. http://10.0.0.5:7899
 *   CLAUDE_PEERS_API_KEY       — must match broker's configured key
 *   CLAUDE_PEERS_GROUP_SECRET  — required for peers/send commands
 *
 * Usage:
 *   bun cli.ts status              — Show broker status
 *   bun cli.ts peers               — List all peers in your group
 *   bun cli.ts send <id> <msg>     — Send a message to a peer
 *   bun cli.ts kill-broker          — Stop the broker daemon
 */

import { hostname } from "node:os";

const BROKER_URL = process.env.CLAUDE_PEERS_BROKER_URL;
const API_KEY = process.env.CLAUDE_PEERS_API_KEY;
const GROUP_SECRET = process.env.CLAUDE_PEERS_GROUP_SECRET;

if (!BROKER_URL || !API_KEY) {
  console.error("Required: CLAUDE_PEERS_BROKER_URL and CLAUDE_PEERS_API_KEY env vars");
  process.exit(1);
}

// CLI registers as a temporary peer for authenticated operations
let cliToken: string | null = null;
let cliPeerId: string | null = null;

async function brokerFetch<T>(path: string, body?: unknown, useToken = true): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (useToken && cliToken) {
    headers["Authorization"] = `Bearer ${cliToken}`;
  }
  const opts: RequestInit = body
    ? { method: "POST", headers, body: JSON.stringify(body) }
    : { headers };
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function registerCli(): Promise<void> {
  if (!GROUP_SECRET) {
    console.error("Required: CLAUDE_PEERS_GROUP_SECRET env var for this command");
    process.exit(1);
  }
  const reg = await brokerFetch<{ id: string; instance_token: string }>(
    "/register",
    {
      api_key: API_KEY,
      group_secret: GROUP_SECRET,
      pid: process.pid,
      hostname: hostname(),
      cwd: process.cwd(),
      git_root: null,
      summary: "[CLI]",
    },
    false // don't use Bearer token for /register
  );
  cliToken = reg.instance_token;
  cliPeerId = reg.id;
}

async function unregisterCli(): Promise<void> {
  if (cliToken) {
    try {
      await brokerFetch("/unregister", {});
    } catch { /* best effort */ }
  }
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const res = await fetch(`${BROKER_URL}/health`, {
        headers: { "Authorization": `Bearer ${API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const health = await res.json() as { status: string; peers: number };
      console.log(`Broker: ${health.status} (${health.peers} peer(s) registered)`);
      console.log(`URL: ${BROKER_URL}`);
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "peers": {
    try {
      await registerCli();
      const peers = await brokerFetch<
        Array<{
          id: string;
          pid: number;
          hostname: string;
          cwd: string;
          git_root: string | null;
          summary: string;
          last_seen: string;
        }>
      >("/list-peers", {
        scope: "group",
        cwd: process.cwd(),
        hostname: hostname(),
        git_root: null,
      });

      if (peers.length === 0) {
        console.log("No other peers in this group.");
      } else {
        for (const p of peers) {
          console.log(`  ${p.id}  ${p.hostname}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await unregisterCli();
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <peer-id> <message>");
      process.exit(1);
    }
    try {
      await registerCli();
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await unregisterCli();
    }
    break;
  }

  case "kill-broker": {
    try {
      const res = await fetch(`${BROKER_URL}/kill`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`claude-peers CLI

Required env vars:
  CLAUDE_PEERS_BROKER_URL     Broker address (e.g. http://10.0.0.5:7899)
  CLAUDE_PEERS_API_KEY        Broker access key
  CLAUDE_PEERS_GROUP_SECRET   Group secret (for peers/send commands)

Usage:
  bun cli.ts status              Show broker status
  bun cli.ts peers               List all peers in your group
  bun cli.ts send <id> <msg>     Send a message to a peer
  bun cli.ts kill-broker         Stop the broker daemon (local only)`);
}
