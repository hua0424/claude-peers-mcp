import { test, expect, beforeAll, afterAll } from "bun:test";
import { type Subprocess } from "bun";
import { unlinkSync } from "node:fs";
import { Database } from "bun:sqlite";

const TEST_PORT = 17899;
const TEST_DB = `/tmp/claude-peers-test-${Date.now()}.db`;
const TEST_API_KEY = "test-api-key-12345";
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let broker: Subprocess;

beforeAll(async () => {
  broker = Bun.spawn(["bun", "broker.ts"], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(TEST_PORT),
      CLAUDE_PEERS_DB: TEST_DB,
      CLAUDE_PEERS_API_KEY: TEST_API_KEY,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  // Wait for broker to start
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`, {
        headers: { "Authorization": `Bearer ${TEST_API_KEY}` },
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) break;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
});

afterAll(async () => {
  if (broker) {
    broker.kill();
    await broker.exited;
  }
  try { unlinkSync(TEST_DB); } catch {}
});

// Helper: spawn a broker against a prepared DB, wait for /health, then kill it.
async function spawnBrokerWithDb(dbPath: string, port: number): Promise<{ stderr: string }> {
  const proc = Bun.spawn(["bun", "broker.ts"], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(port),
      CLAUDE_PEERS_DB: dbPath,
      CLAUDE_PEERS_API_KEY: TEST_API_KEY,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { "Authorization": `Bearer ${TEST_API_KEY}` },
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) { ready = true; break; }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  await proc.exited;
  const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
  if (!ready) throw new Error(`Broker failed to start. stderr:\n${stderr}`);
  return { stderr };
}

test("migrates pre-v2 peers table (id PK, no instance_token) without crashing", async () => {
  // Reproduces the real-world upgrade failure: a peers table from a very old
  // broker version where `id` was the primary key and `instance_token` did not
  // yet exist. The migration must recreate the table instead of crashing.
  const dbPath = `/tmp/claude-peers-migration-ancient-${Date.now()}.db`;
  const port = TEST_PORT + 1;
  try {
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE peers (
        id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        hostname TEXT NOT NULL,
        cwd TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      )
    `);
    db.run(`INSERT INTO peers (id, pid, hostname, cwd, summary, registered_at, last_seen)
            VALUES ('old', 1, 'h', '/tmp', '', datetime('now'), datetime('now'))`);
    db.close();

    const { stderr } = await spawnBrokerWithDb(dbPath, port);
    expect(stderr).toContain("predates v2 schema");

    // Verify the new schema is in place: instance_token is the PK, id is not.
    const verify = new Database(dbPath);
    const cols = verify.query("PRAGMA table_info(peers)").all() as Array<{ name: string; pk: number }>;
    const tokCol = cols.find((c) => c.name === "instance_token");
    const idCol = cols.find((c) => c.name === "id");
    verify.close();
    expect(tokCol?.pk).toBe(1);
    expect(idCol?.pk).toBe(0);
  } finally {
    try { unlinkSync(dbPath); } catch {}
  }
});

test("migrates v1 peers table (has instance_token + group_id) and carries rows over", async () => {
  // Intermediate schema: `id` is PK, but `instance_token` and `group_id`
  // already exist. Data should be carried over into the v2 table.
  const dbPath = `/tmp/claude-peers-migration-v1-${Date.now()}.db`;
  const port = TEST_PORT + 2;
  try {
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE groups (
        group_id TEXT PRIMARY KEY,
        group_secret_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    // 32-char group_id to avoid triggering the v3-format cleanup migration.
    const gid = "g".repeat(32);
    db.run(`INSERT INTO groups VALUES (?, 'hash1', datetime('now'))`, [gid]);
    db.run(`
      CREATE TABLE peers (
        id TEXT PRIMARY KEY,
        instance_token TEXT NOT NULL,
        pid INTEGER NOT NULL,
        hostname TEXT NOT NULL,
        cwd TEXT NOT NULL,
        git_root TEXT,
        group_id TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      )
    `);
    const token = "a".repeat(64);
    db.run(
      `INSERT INTO peers (id, instance_token, pid, hostname, cwd, git_root, group_id, summary, registered_at, last_seen)
       VALUES ('peer1', ?, 42, 'h1', '/tmp', NULL, ?, 's', datetime('now'), datetime('now'))`,
      [token, gid],
    );
    db.close();

    await spawnBrokerWithDb(dbPath, port);

    const verify = new Database(dbPath);
    const row = verify.query("SELECT id, instance_token, status FROM peers WHERE id = 'peer1'").get() as
      | { id: string; instance_token: string; status: string } | null;
    verify.close();
    expect(row).not.toBeNull();
    expect(row?.instance_token.length).toBe(64);
    expect(row?.status).toBe("active");
  } finally {
    try { unlinkSync(dbPath); } catch {}
  }
});

test("health endpoint returns ok", async () => {
  const res = await fetch(`${BASE_URL}/health`, {
    headers: { "Authorization": `Bearer ${TEST_API_KEY}` },
  });
  expect(res.ok).toBe(true);
  const data = await res.json() as { status: string; peers: number };
  expect(data.status).toBe("ok");
});

test("health endpoint rejects bad api_key", async () => {
  const res = await fetch(`${BASE_URL}/health`, {
    headers: { "Authorization": "Bearer wrong-key" },
  });
  expect(res.status).toBe(401);
});

test("health endpoint rejects missing auth", async () => {
  const res = await fetch(`${BASE_URL}/health`);
  expect(res.status).toBe(401);
});

test("register succeeds with valid api_key + group_secret", async () => {
  const res = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "team-alpha",
      pid: 99999,
      hostname: "test-host",
      cwd: "/tmp/test",
      git_root: null,
      summary: "test peer",
    }),
  });
  expect(res.ok).toBe(true);
  const data = await res.json() as { id: string; instance_token: string };
  expect(data.id).toHaveLength(8);
  expect(data.instance_token).toHaveLength(64);
});

test("register rejects bad api_key", async () => {
  const res = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: "wrong-key",
      group_secret: "team-alpha",
      pid: 99998,
      hostname: "test-host",
      cwd: "/tmp/test",
      git_root: null,
      summary: "bad peer",
    }),
  });
  expect(res.status).toBe(401);
});

test("register rejects invalid input fields", async () => {
  const base = { api_key: TEST_API_KEY, group_secret: "val-group", pid: 11001, hostname: "h", cwd: "/v", git_root: null, summary: "" };

  // Hostname too long
  const r1 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...base, hostname: "h".repeat(300) }),
  });
  expect(r1.status).toBe(400);

  // pid out of range
  const r2 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...base, pid: -1 }),
  });
  expect(r2.status).toBe(400);

  const r3 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...base, pid: 99_999_999 }),
  });
  expect(r3.status).toBe(400);

  // cwd too long
  const r4 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...base, cwd: "/".repeat(5000) }),
  });
  expect(r4.status).toBe(400);
});

test("set-id rejects IDs that fail isValidPeerId format", async () => {
  const reg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "format-group",
      pid: 11010, hostname: "h", cwd: "/f", git_root: null, summary: "",
    }),
  });
  const peer = await reg.json() as { id: string; instance_token: string };

  for (const badId of ["UPPERCASE", "-leading-hyphen", "trailing-hyphen-", "has space", ""]) {
    const res = await fetch(`${BASE_URL}/set-id`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${peer.instance_token}` },
      body: JSON.stringify({ new_id: badId }),
    });
    expect(res.status).toBe(400);
  }
});

test("list-peers directory scope returns same-cwd peers only", async () => {
  const secret = "dir-scope-group";
  const regA = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: TEST_API_KEY, group_secret: secret, pid: 11020, hostname: "dh", cwd: "/shared", git_root: null, summary: "A" }),
  });
  const peerA = await regA.json() as { id: string; instance_token: string };

  const regB = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: TEST_API_KEY, group_secret: secret, pid: 11021, hostname: "dh", cwd: "/shared", git_root: null, summary: "B" }),
  });
  const peerB = await regB.json() as { id: string; instance_token: string };

  // peerC is in a different directory
  const regC = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: TEST_API_KEY, group_secret: secret, pid: 11022, hostname: "dh", cwd: "/other", git_root: null, summary: "C" }),
  });
  const peerC = await regC.json() as { id: string; instance_token: string };

  const listRes = await fetch(`${BASE_URL}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${peerA.instance_token}` },
    body: JSON.stringify({ scope: "directory", cwd: "/shared", hostname: "dh", git_root: null }),
  });
  expect(listRes.ok).toBe(true);
  const peers = await listRes.json() as Array<{ id: string }>;
  const ids = peers.map((p) => p.id);
  expect(ids).toContain(peerB.id);
  expect(ids).not.toContain(peerA.id); // self excluded
  expect(ids).not.toContain(peerC.id); // different directory
});

test("list-peers repo scope returns same-git-root peers only", async () => {
  const secret = "repo-scope-group";
  const regA = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: TEST_API_KEY, group_secret: secret, pid: 11030, hostname: "rh", cwd: "/repo/a", git_root: "/repo", summary: "A" }),
  });
  const peerA = await regA.json() as { id: string; instance_token: string };

  const regB = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: TEST_API_KEY, group_secret: secret, pid: 11031, hostname: "rh2", cwd: "/repo/b", git_root: "/repo", summary: "B" }),
  });
  const peerB = await regB.json() as { id: string; instance_token: string };

  const regC = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: TEST_API_KEY, group_secret: secret, pid: 11032, hostname: "rh3", cwd: "/other-repo", git_root: "/other-repo", summary: "C" }),
  });
  const peerC = await regC.json() as { id: string; instance_token: string };

  const listRes = await fetch(`${BASE_URL}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${peerA.instance_token}` },
    body: JSON.stringify({ scope: "repo", cwd: "/repo/a", hostname: "rh", git_root: "/repo" }),
  });
  expect(listRes.ok).toBe(true);
  const peers = await listRes.json() as Array<{ id: string }>;
  const ids = peers.map((p) => p.id);
  expect(ids).toContain(peerB.id);
  expect(ids).not.toContain(peerA.id);
  expect(ids).not.toContain(peerC.id);
});

test("register creates group on first use, reuses on second", async () => {
  const reg1 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "new-group-secret",
      pid: 88881,
      hostname: "host-a",
      cwd: "/a",
      git_root: null,
      summary: "peer a",
    }),
  });
  const data1 = await reg1.json() as { id: string; instance_token: string };

  const reg2 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "new-group-secret",
      pid: 88882,
      hostname: "host-b",
      cwd: "/b",
      git_root: null,
      summary: "peer b",
    }),
  });
  const data2 = await reg2.json() as { id: string; instance_token: string };

  expect(data1.id).not.toBe(data2.id);
  expect(data1.instance_token).not.toBe(data2.instance_token);
});

test("authenticated endpoints reject missing token", async () => {
  const res = await fetch(`${BASE_URL}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "group", cwd: "/", hostname: "h", git_root: null }),
  });
  expect(res.status).toBe(401);
});

test("list-peers returns only same-group peers", async () => {
  const reg1 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "group-alpha",
      pid: 70001,
      hostname: "host-1",
      cwd: "/project-a",
      git_root: "/project-a",
      summary: "peer alpha-1",
    }),
  });
  const peer1 = await reg1.json() as { id: string; instance_token: string };

  const reg2 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "group-alpha",
      pid: 70002,
      hostname: "host-2",
      cwd: "/project-b",
      git_root: "/project-b",
      summary: "peer alpha-2",
    }),
  });
  const peer2 = await reg2.json() as { id: string; instance_token: string };

  const reg3 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "group-beta",
      pid: 70003,
      hostname: "host-3",
      cwd: "/other",
      git_root: null,
      summary: "peer beta-1",
    }),
  });
  const peer3 = await reg3.json() as { id: string; instance_token: string };

  const listRes = await fetch(`${BASE_URL}/list-peers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${peer1.instance_token}`,
    },
    body: JSON.stringify({
      scope: "group",
      cwd: "/project-a",
      hostname: "host-1",
      git_root: "/project-a",
    }),
  });
  expect(listRes.ok).toBe(true);
  const peers = await listRes.json() as Array<{ id: string; summary: string }>;
  const peerIds = peers.map((p) => p.id);
  expect(peerIds).toContain(peer2.id);
  expect(peerIds).not.toContain(peer1.id);
  expect(peerIds).not.toContain(peer3.id);
});

test("send-message and WebSocket push", async () => {
  const senderReg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "ws-test-group",
      pid: 60001,
      hostname: "sender-host",
      cwd: "/sender",
      git_root: null,
      summary: "sender",
    }),
  });
  const sender = await senderReg.json() as { id: string; instance_token: string };

  const receiverReg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "ws-test-group",
      pid: 60002,
      hostname: "receiver-host",
      cwd: "/receiver",
      git_root: null,
      summary: "receiver",
    }),
  });
  const receiver = await receiverReg.json() as { id: string; instance_token: string };

  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);

  // Connect and authenticate
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token: receiver.instance_token }));
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : "") as { type: string };
      if (msg.type === "auth_ok") resolve();
    };
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("WS auth timeout")), 3000);
  });

  const messagePromise = new Promise<string>((resolve) => {
    ws.onmessage = (event) => {
      resolve(typeof event.data === "string" ? event.data : "");
    };
  });

  const sendRes = await fetch(`${BASE_URL}/send-message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${sender.instance_token}`,
    },
    body: JSON.stringify({
      to_id: receiver.id,
      text: "hello from sender",
    }),
  });
  expect(sendRes.ok).toBe(true);
  const sendData = await sendRes.json() as { ok: boolean };
  expect(sendData.ok).toBe(true);

  const rawMsg = await Promise.race([
    messagePromise,
    new Promise<string>((_, rej) => setTimeout(() => rej(new Error("WS message timeout")), 3000)),
  ]);

  const msg = JSON.parse(rawMsg) as { type: string; from_id: string; text: string };
  expect(msg.type).toBe("message");
  expect(msg.from_id).toBe(sender.id);
  expect(msg.text).toBe("hello from sender");

  ws.close();
});

test("send-message fails across groups", async () => {
  const reg1 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "cross-group-a",
      pid: 50001,
      hostname: "h",
      cwd: "/a",
      git_root: null,
      summary: "",
    }),
  });
  const peer1 = await reg1.json() as { id: string; instance_token: string };

  const reg2 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "cross-group-b",
      pid: 50002,
      hostname: "h",
      cwd: "/b",
      git_root: null,
      summary: "",
    }),
  });
  const peer2 = await reg2.json() as { id: string; instance_token: string };

  const sendRes = await fetch(`${BASE_URL}/send-message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${peer1.instance_token}`,
    },
    body: JSON.stringify({ to_id: peer2.id, text: "should fail" }),
  });
  const data = await sendRes.json() as { ok: boolean; error: string };
  expect(data.ok).toBe(false);
  expect(data.error).toContain("not found");
});

test("set-summary updates peer summary", async () => {
  const reg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "summary-group",
      pid: 40001,
      hostname: "h",
      cwd: "/c",
      git_root: null,
      summary: "old summary",
    }),
  });
  const peer = await reg.json() as { id: string; instance_token: string };

  const setRes = await fetch(`${BASE_URL}/set-summary`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${peer.instance_token}`,
    },
    body: JSON.stringify({ summary: "new summary" }),
  });
  expect(setRes.ok).toBe(true);
});

test("unregister sets peer dormant and rotates token (dormant peer excluded from list)", async () => {
  // Register two peers so the lister can see results
  const reg1 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "unreg-group",
      pid: 30001,
      hostname: "h",
      cwd: "/d",
      git_root: null,
      summary: "will go dormant",
    }),
  });
  const peer1 = await reg1.json() as { id: string; instance_token: string };

  const reg2 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY,
      group_secret: "unreg-group",
      pid: 30002,
      hostname: "h",
      cwd: "/d2",
      git_root: null,
      summary: "lister",
    }),
  });
  const peer2 = await reg2.json() as { id: string; instance_token: string };

  // Unregister peer1 (sets dormant)
  const unregRes = await fetch(`${BASE_URL}/unregister`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${peer1.instance_token}`,
    },
    body: JSON.stringify({}),
  });
  expect(unregRes.ok).toBe(true);

  // Token is rotated on unregister — the old token is now invalid.
  // Use peer2 (still active) to verify peer1 no longer appears in list.
  const listRes = await fetch(`${BASE_URL}/list-peers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${peer2.instance_token}`,
    },
    body: JSON.stringify({ scope: "group", cwd: "/d2", hostname: "h", git_root: null }),
  });
  expect(listRes.ok).toBe(true);
  // Dormant peer1 should NOT appear in list
  const peers = await listRes.json() as Array<{ id: string }>;
  const ids = peers.map((p) => p.id);
  expect(ids).not.toContain(peer1.id);
});

test("resume succeeds for dormant peer (WS disconnect)", async () => {
  // Register a peer
  const reg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "resume-group",
      pid: 20001, hostname: "h", cwd: "/r", git_root: null, summary: "",
    }),
  });
  const peer = await reg.json() as { id: string; instance_token: string };

  // Connect WS and authenticate (peer is active)
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => { ws.send(JSON.stringify({ type: "auth", token: peer.instance_token })); };
    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : "") as { type: string };
      if (msg.type === "auth_ok") resolve();
    };
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("WS auth timeout")), 3000);
  });

  // Close WS from client — broker marks peer dormant but does NOT rotate token
  ws.close();
  await new Promise((r) => setTimeout(r, 200));

  // Resume with original token — should succeed and return a rotated token
  const resumeRes = await fetch(`${BASE_URL}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: TEST_API_KEY, group_secret: "resume-group", instance_token: peer.instance_token }),
  });
  expect(resumeRes.ok).toBe(true);
  const resumed = await resumeRes.json() as { id: string; instance_token: string };
  expect(resumed.id).toBe(peer.id);
  expect(resumed.instance_token).not.toBe(peer.instance_token); // token was rotated
});

test("resume fails after explicit unregister (token rotated)", async () => {
  const reg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "resume-unregister-group",
      pid: 20011, hostname: "h", cwd: "/ru", git_root: null, summary: "",
    }),
  });
  const peer = await reg.json() as { id: string; instance_token: string };

  // Explicit unregister — sets dormant AND rotates token
  await fetch(`${BASE_URL}/unregister`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${peer.instance_token}` },
    body: JSON.stringify({}),
  });

  // Resume with old token — should fail because token was rotated on unregister
  const resumeRes = await fetch(`${BASE_URL}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: TEST_API_KEY, group_secret: "resume-unregister-group", instance_token: peer.instance_token }),
  });
  expect(resumeRes.status).toBe(401);
});

test("resume fails with active WS connection", async () => {
  const reg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "resume-ws-group",
      pid: 20002, hostname: "h", cwd: "/r2", git_root: null, summary: "",
    }),
  });
  const peer = await reg.json() as { id: string; instance_token: string };

  // Connect WS and authenticate
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => { ws.send(JSON.stringify({ type: "auth", token: peer.instance_token })); };
    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : "") as { type: string };
      if (msg.type === "auth_ok") resolve();
    };
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("WS auth timeout")), 3000);
  });

  // Try resume — should get 409 because WS is active
  const resumeRes = await fetch(`${BASE_URL}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: TEST_API_KEY, group_secret: "resume-ws-group", instance_token: peer.instance_token }),
  });
  expect(resumeRes.status).toBe(409);

  ws.close();
});

test("set-id changes peer ID", async () => {
  const reg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "setid-group",
      pid: 20003, hostname: "h", cwd: "/s", git_root: null, summary: "",
    }),
  });
  const peer = await reg.json() as { id: string; instance_token: string };

  const setRes = await fetch(`${BASE_URL}/set-id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${peer.instance_token}` },
    body: JSON.stringify({ new_id: "my-custom-id" }),
  });
  expect(setRes.ok).toBe(true);
  const data = await setRes.json() as { id: string };
  expect(data.id).toBe("my-custom-id");
});

test("set-id updates from_id on queued messages", async () => {
  const senderReg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "setid-msg-group",
      pid: 9001, hostname: "h", cwd: "/sm", git_root: null, summary: "",
    }),
  });
  const sender = await senderReg.json() as { id: string; instance_token: string };

  const receiverReg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "setid-msg-group",
      pid: 9002, hostname: "h", cwd: "/rm", git_root: null, summary: "",
    }),
  });
  const receiver = await receiverReg.json() as { id: string; instance_token: string };

  // Send message while receiver has no WS (queued)
  await fetch(`${BASE_URL}/send-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sender.instance_token}` },
    body: JSON.stringify({ to_id: receiver.id, text: "before rename" }),
  });

  // Rename sender
  await fetch(`${BASE_URL}/set-id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sender.instance_token}` },
    body: JSON.stringify({ new_id: "renamed-sender" }),
  });

  // Poll messages as receiver — from_id should reflect the rename
  const checkRes = await fetch(`${BASE_URL}/check-messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${receiver.instance_token}` },
    body: JSON.stringify({}),
  });
  const data = await checkRes.json() as { messages: Array<{ from_id: string; text: string }> };
  expect(data.messages).toHaveLength(1);
  expect(data.messages[0].from_id).toBe("renamed-sender");
  expect(data.messages[0].text).toBe("before rename");
});

test("set-id rejects duplicate ID within the same group", async () => {
  const reg1 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "dup-group",
      pid: 20004, hostname: "h", cwd: "/d1", git_root: null, summary: "",
    }),
  });
  const peer1 = await reg1.json() as { id: string; instance_token: string };

  // Set custom ID
  await fetch(`${BASE_URL}/set-id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${peer1.instance_token}` },
    body: JSON.stringify({ new_id: "taken-id" }),
  });

  // Register second peer in same group
  const reg2 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "dup-group",
      pid: 20005, hostname: "h", cwd: "/d2", git_root: null, summary: "",
    }),
  });
  const peer2 = await reg2.json() as { id: string; instance_token: string };

  // Try same ID — should fail
  const setRes = await fetch(`${BASE_URL}/set-id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${peer2.instance_token}` },
    body: JSON.stringify({ new_id: "taken-id" }),
  });
  expect(setRes.status).toBe(409);
});

test("check-messages returns queued messages and marks them delivered", async () => {
  const senderReg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "checkmsg-group",
      pid: 10001, hostname: "h", cwd: "/cs", git_root: null, summary: "sender",
    }),
  });
  const sender = await senderReg.json() as { id: string; instance_token: string };

  const receiverReg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "checkmsg-group",
      pid: 10002, hostname: "h", cwd: "/cr", git_root: null, summary: "receiver",
    }),
  });
  const receiver = await receiverReg.json() as { id: string; instance_token: string };

  // Send message while receiver has no WS (queued)
  await fetch(`${BASE_URL}/send-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sender.instance_token}` },
    body: JSON.stringify({ to_id: receiver.id, text: "queued hello" }),
  });

  // Poll — should return the queued message
  const checkRes = await fetch(`${BASE_URL}/check-messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${receiver.instance_token}` },
    body: JSON.stringify({}),
  });
  expect(checkRes.ok).toBe(true);
  const data = await checkRes.json() as { messages: Array<{ type: string; from_id: string; text: string }> };
  expect(data.messages).toHaveLength(1);
  expect(data.messages[0].from_id).toBe(sender.id);
  expect(data.messages[0].text).toBe("queued hello");

  // Second poll — already delivered, should be empty
  const checkRes2 = await fetch(`${BASE_URL}/check-messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${receiver.instance_token}` },
    body: JSON.stringify({}),
  });
  const data2 = await checkRes2.json() as { messages: Array<unknown> };
  expect(data2.messages).toHaveLength(0);
});

test("WebSocket auth timeout closes connection with code 4001", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
  const closeCode = await new Promise<number>((resolve, reject) => {
    ws.onopen = () => {
      // Do not send auth — wait for broker timeout
    };
    ws.onclose = (event) => resolve((event as CloseEvent).code);
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("test timed out waiting for auth timeout")), 8000);
  });
  expect(closeCode).toBe(4001);
}, 10000);

test("pushUndeliveredMessages delivers queued messages on WS auth", async () => {
  const senderReg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "push-group",
      pid: 10011, hostname: "h", cwd: "/ps", git_root: null, summary: "sender",
    }),
  });
  const sender = await senderReg.json() as { id: string; instance_token: string };

  const receiverReg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "push-group",
      pid: 10012, hostname: "h", cwd: "/pr", git_root: null, summary: "receiver",
    }),
  });
  const receiver = await receiverReg.json() as { id: string; instance_token: string };

  // Send message while receiver has no WS (queued)
  await fetch(`${BASE_URL}/send-message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sender.instance_token}` },
    body: JSON.stringify({ to_id: receiver.id, text: "pushed-offline" }),
  });

  // Connect WS — queued message should be pushed immediately after auth
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
  const pushedMessages: string[] = [];

  await new Promise<void>((resolve, reject) => {
    let authOk = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token: receiver.instance_token }));
    };
    ws.onmessage = (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      const msg = JSON.parse(data) as { type: string; text?: string };
      if (msg.type === "auth_ok") { authOk = true; return; }
      if (msg.type === "message" && authOk) {
        pushedMessages.push(msg.text ?? "");
        resolve();
      }
    };
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("push timeout")), 3000);
  });

  expect(pushedMessages).toHaveLength(1);
  expect(pushedMessages[0]).toBe("pushed-offline");
  ws.close();
});

test("dormant peers are excluded from list-peers", async () => {
  const reg = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "dormant-group",
      pid: 20006, hostname: "h", cwd: "/dorm", git_root: null, summary: "will go dormant",
    }),
  });
  const peer = await reg.json() as { id: string; instance_token: string };

  // Register a second peer to do the listing
  const reg2 = await fetch(`${BASE_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TEST_API_KEY, group_secret: "dormant-group",
      pid: 20007, hostname: "h", cwd: "/dorm2", git_root: null, summary: "lister",
    }),
  });
  const lister = await reg2.json() as { id: string; instance_token: string };

  // Unregister first peer (dormant)
  await fetch(`${BASE_URL}/unregister`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${peer.instance_token}` },
    body: JSON.stringify({}),
  });

  // List peers — dormant peer should NOT appear
  const listRes = await fetch(`${BASE_URL}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${lister.instance_token}` },
    body: JSON.stringify({ scope: "group", cwd: "/dorm2", hostname: "h", git_root: null }),
  });
  const peers = await listRes.json() as Array<{ id: string }>;
  const ids = peers.map((p) => p.id);
  expect(ids).not.toContain(peer.id);
});
