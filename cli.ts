#!/usr/bin/env bun
/**
 * claude-peers CLI
 *
 * Utility commands for inspecting broker state and sending messages.
 *
 * Required flags:
 *   --broker-url <url>      Broker address, e.g. http://10.0.0.5:7899
 *   --api-key <key>         Broker access key
 *
 * Optional flags:
 *   --group-secret <secret> Group secret (required for peers/send/group-doc commands)
 *
 * Usage:
 *   bun cli.ts --broker-url http://10.0.0.5:7899 --api-key secret status
 *   bun cli.ts --broker-url http://10.0.0.5:7899 --api-key secret --group-secret mygroup peers
 *   bun cli.ts --broker-url http://10.0.0.5:7899 --api-key secret --group-secret mygroup send alice Hello!
 *   bun cli.ts --broker-url http://10.0.0.5:7899 --api-key secret kill-broker
 */

import { hostname } from "node:os";

function parseArgs(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < argv.length) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[i + 1];
        i += 2;
      } else {
        flags[key] = "true";
        i++;
      }
    } else {
      positional.push(argv[i]);
      i++;
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));

const BROKER_URL = flags["broker-url"];
const API_KEY = flags["api-key"];
const GROUP_SECRET = flags["group-secret"];

if (!BROKER_URL || !API_KEY) {
  console.error("Required: --broker-url <url> and --api-key <key>");
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
    console.error("Required: --group-secret <secret> (or CLAUDE_PEERS_GROUP_SECRET env var)");
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
      summary: "[CLI — temporary, will unregister on exit]",
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

const cmd = positional[0];

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
          role: string;
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
          console.log(`  ${p.id}  [${p.role}]  ${p.hostname}  ${p.cwd}`);
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
    const toId = positional[1];
    const msg = positional.slice(2).join(" ");
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

  case "groups": {
    try {
      const res = await fetch(`${BROKER_URL}/admin/groups`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const groups = await res.json() as Array<{
        group_id: string;
        created_at: string;
        active_peers: number;
      }>;
      if (groups.length === 0) {
        console.log("No groups registered.");
      } else {
        console.log(`${groups.length} group(s):`);
        for (const g of groups) {
          console.log(`  ${g.group_id}  peers=${g.active_peers}  created=${g.created_at}`);
        }
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "group-doc": {
    if (!GROUP_SECRET) {
      console.error("Required: --group-secret <secret> (or CLAUDE_PEERS_GROUP_SECRET env var)");
      process.exit(1);
    }
    try {
      await registerCli();
      const result = await brokerFetch<{ doc: string }>("/get-group-doc", {});
      if (!result.doc) {
        console.log("(No group doc set. Use set_group_doc MCP tool to publish one.)");
      } else {
        console.log(result.doc);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await unregisterCli();
    }
    break;
  }

  default:
    console.log(`claude-peers CLI

Required flags:
  --broker-url <url>       Broker address, e.g. http://10.0.0.5:7899
  --api-key <key>          Broker access key

Optional flags:
  --group-secret <secret>  Group secret (required for peers/send/group-doc/groups commands)

Commands:
  status                   Show broker status
  groups                   List all groups with active peer counts
  peers                    List peers in your group (shows role)
  group-doc                Print the group doc for your group
  send <id> <msg>          Send a message to a peer
  kill-broker              Stop the broker daemon

Examples:
  bun cli.ts --broker-url http://10.0.0.5:7899 --api-key secret status
  bun cli.ts --broker-url http://10.0.0.5:7899 --api-key secret --group-secret mygroup peers
  bun cli.ts --broker-url http://10.0.0.5:7899 --api-key secret --group-secret mygroup send alice Hello!`);
}
