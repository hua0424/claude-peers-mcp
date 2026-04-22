import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_KEY = "test-api-key";
const GROUP_SECRET = "my-test-group";

let brokerProc: Subprocess | null = null;
let tmpDir = "";
let url = "";

async function pickFreePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = s.port;
  s.stop(true);
  return port;
}

async function waitForBroker(u: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${u}/health`, { headers: { Authorization: `Bearer ${API_KEY}` } });
      if (res.ok) return true;
    } catch { /* not ready */ }
    await Bun.sleep(50);
  }
  return false;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-groups-"));
  const port = await pickFreePort();
  url = `http://127.0.0.1:${port}`;
  brokerProc = spawn({
    cmd: ["bun", "broker.ts"],
    env: {
      ...process.env,
      CLAUDE_PEERS_API_KEY: API_KEY,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: join(tmpDir, "broker.db"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const ok = await waitForBroker(url);
  if (!ok) throw new Error("broker failed to start");
});

afterAll(async () => {
  if (brokerProc) {
    brokerProc.kill();
    await brokerProc.exited;
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test("/admin/groups returns group_secret for newly registered group", async () => {
  // Register a peer to create the group
  const registerRes = await fetch(`${url}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      group_secret: GROUP_SECRET,
      pid: process.pid,
      hostname: "test-host",
      cwd: "/tmp/test",
      git_root: null,
      summary: "",
    }),
  });
  expect(registerRes.ok).toBe(true);

  // Call /admin/groups
  const res = await fetch(`${url}/admin/groups`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  expect(res.ok).toBe(true);
  const groups = (await res.json()) as Array<{
    group_id: string;
    group_secret: string;
    created_at: string;
    active_peers: number;
  }>;

  expect(groups.length).toBe(1);
  expect(groups[0].group_secret).toBe(GROUP_SECRET);
  expect(groups[0].active_peers).toBe(1);
});

test("/admin/groups returns (unknown) for historical groups without group_secret", async () => {
  // Manually insert a group without group_secret to simulate historical data
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(tmpDir, "broker.db"));
  db.run(`
    INSERT INTO groups (group_id, group_secret_hash, created_at, group_secret)
    VALUES ('legacy-group-id', 'legacy-hash', '2024-01-01T00:00:00Z', NULL)
  `);
  db.close();

  const res = await fetch(`${url}/admin/groups`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  expect(res.ok).toBe(true);
  const groups = (await res.json()) as Array<{
    group_id: string;
    group_secret: string;
    created_at: string;
    active_peers: number;
  }>;

  const legacyGroup = groups.find((g) => g.group_id === "legacy-group-id");
  expect(legacyGroup).toBeDefined();
  expect(legacyGroup!.group_secret).toBe("(unknown)");
});
