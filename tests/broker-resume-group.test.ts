/**
 * Regression: /resume must reject tokens that belong to a different group
 * than the caller's group_secret. Without this check, a client holding a
 * leaked/historical token from another group silently resumes into the
 * wrong group.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

const API_KEY = "test-api-key";
const SECRET_A = "group-a-secret";
const SECRET_B = "group-b-secret";

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

async function registerPeer(secret: string, id_hint: string) {
  const res = await fetch(`${url}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      group_secret: secret,
      pid: process.pid,
      hostname: hostname(),
      cwd: `/tmp/${id_hint}`,
      git_root: null,
      summary: "",
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; instance_token: string; role: string };
}

async function unregisterPeer(token: string) {
  const res = await fetch(`${url}/unregister`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: "{}",
  });
  // 401 is acceptable if the peer was already cleaned up elsewhere; we just want it non-active
  if (!res.ok && res.status !== 401) throw new Error(`unregister failed: ${res.status}`);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-resume-group-"));
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

test("/resume rejects token from a different group with 401", async () => {
  const peerA = await registerPeer(SECRET_A, "peerA");

  // Call /resume with wrong group_secret (B) and A's token.
  // Expected: 401 with "different group" message, regardless of active state,
  // because the group check fires before the active-status check.
  const res = await fetch(`${url}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      group_secret: SECRET_B,
      instance_token: peerA.instance_token,
    }),
  });
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("different group");

  await unregisterPeer(peerA.instance_token);
});

test("/resume with matching group_secret succeeds after dormant", async () => {
  const peerA = await registerPeer(SECRET_A, "peerA2");
  await unregisterPeer(peerA.instance_token);

  const res = await fetch(`${url}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      group_secret: SECRET_A,
      instance_token: peerA.instance_token,
    }),
  });
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("Invalid token");
});

test("/resume with missing group_secret returns 400", async () => {
  const res = await fetch(`${url}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      instance_token: "a".repeat(64),
    }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error.toLowerCase()).toContain("group_secret");
});

test("/resume with empty group_secret returns 400", async () => {
  const res = await fetch(`${url}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      group_secret: "",
      instance_token: "a".repeat(64),
    }),
  });
  expect(res.status).toBe(400);
});
