/**
 * Tests for /unregister releasing the peer ID, and set_id reclaiming dormant IDs.
 *
 * Spawns a real broker subprocess on a random port with a throwaway SQLite DB.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_KEY = "test-api-key";
const GROUP_SECRET = "test-group-secret";
let brokerProc: Subprocess | null = null;
let brokerUrl = "";
let tmpDir = "";

async function waitForBroker(url: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(50);
  }
  throw new Error(`Broker did not become ready at ${url}`);
}

async function pickFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  return port;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-test-"));
  const dbPath = join(tmpDir, "broker.db");
  const port = await pickFreePort();
  brokerUrl = `http://127.0.0.1:${port}`;
  brokerProc = spawn({
    cmd: ["bun", "broker.ts"],
    env: {
      ...process.env,
      CLAUDE_PEERS_API_KEY: API_KEY,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForBroker(brokerUrl);
});

afterAll(async () => {
  if (brokerProc) {
    brokerProc.kill();
    await brokerProc.exited;
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

type RegisterResult = { id: string; instance_token: string };

async function register(pid: number): Promise<RegisterResult> {
  const res = await fetch(`${brokerUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      group_secret: GROUP_SECRET,
      pid,
      hostname: "test-host",
      cwd: "/tmp/test",
      git_root: null,
      summary: "",
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as RegisterResult;
}

async function setId(token: string, newId: string) {
  return fetch(`${brokerUrl}/set-id`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ new_id: newId }),
  });
}

async function unregister(token: string) {
  const res = await fetch(`${brokerUrl}/unregister`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: "{}",
  });
  expect(res.status).toBe(200);
}

async function disconnect(token: string) {
  const res = await fetch(`${brokerUrl}/disconnect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: "{}",
  });
  expect(res.status).toBe(200);
}

test("set_id to a just-unregistered peer's ID succeeds (clean exit path)", async () => {
  const a = await register(10001);
  const setA = await setId(a.instance_token, "alice");
  expect(setA.status).toBe(200);

  await unregister(a.instance_token);

  const b = await register(10002);
  const setB = await setId(b.instance_token, "alice");
  expect(setB.status).toBe(200);
  const bodyB = (await setB.json()) as { id: string };
  expect(bodyB.id).toBe("alice");

  await unregister(b.instance_token);
});

test("set_id to an active peer's ID fails with 409", async () => {
  const a = await register(10003);
  const setA = await setId(a.instance_token, "bob");
  expect(setA.status).toBe(200);

  const b = await register(10004);
  const setB = await setId(b.instance_token, "bob");
  expect(setB.status).toBe(409);

  await unregister(a.instance_token);
  await unregister(b.instance_token);
});

test("set_id reclaims a dormant peer's ID (crash-exit path)", async () => {
  // Register a and give it an ID, then simulate a crash: open a WS,
  // authenticate, then close it — broker marks the peer dormant without
  // the row being deleted (since /unregister was not called).
  const a = await register(10005);
  const setA = await setId(a.instance_token, "carol");
  expect(setA.status).toBe(200);

  const wsUrl = brokerUrl.replace(/^http/, "ws") + "/ws";
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token: a.instance_token }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as { type: string };
        if (msg.type === "auth_ok") resolve();
      } catch {
        reject(new Error("bad auth response"));
      }
    };
    ws.onerror = () => reject(new Error("ws error"));
  });
  ws.close();
  // Give the broker a moment to process the close and mark dormant
  await Bun.sleep(150);

  const b = await register(10006);
  const setB = await setId(b.instance_token, "carol");
  expect(setB.status).toBe(200);
  const bodyB = (await setB.json()) as { id: string };
  expect(bodyB.id).toBe("carol");

  await unregister(b.instance_token);
});

test("/disconnect sets peer to dormant and allows /resume (unlike /unregister)", async () => {
  const a = await register(20001);
  const setIdA = await setId(a.instance_token, "dave");
  expect(setIdA.status).toBe(200);

  // Disconnect (not unregister) — peer should become dormant, row preserved
  await disconnect(a.instance_token);

  // /resume should succeed because the peer row still exists
  const resumeRes = await fetch(`${brokerUrl}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      group_secret: GROUP_SECRET,
      instance_token: a.instance_token,
    }),
  });
  expect(resumeRes.status).toBe(200);
  const resumeData = await resumeRes.json() as { id: string; instance_token: string };
  expect(resumeData.id).toBe("dave");
  expect(resumeData.instance_token).not.toBe(a.instance_token); // token rotated

  // Clean up — unregister to release the ID
  const unreg = await fetch(`${brokerUrl}/unregister`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resumeData.instance_token}`,
    },
    body: "{}",
  });
  expect(unreg.status).toBe(200);
});

test("/disconnect dormant peer's ID can be reclaimed by set_id (crash-exit path)", async () => {
  const a = await register(20002);
  const setIdA = await setId(a.instance_token, "eve");
  expect(setIdA.status).toBe(200);

  await disconnect(a.instance_token);

  // Another peer tries to claim "eve" — dormant peer is reclaimed, so it succeeds
  const b = await register(20003);
  const setB = await setId(b.instance_token, "eve");
  expect(setB.status).toBe(200);

  await unregister(b.instance_token); // clean up the new "eve"
});
