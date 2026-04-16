import { test, expect, beforeAll, afterAll } from "bun:test";
import { type Subprocess } from "bun";

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
  try { require("fs").unlinkSync(TEST_DB); } catch {}
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

test("unregister sets peer dormant (token still valid, but excluded from list)", async () => {
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

  // Token still valid (dormant, not deleted)
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
    body: JSON.stringify({ api_key: TEST_API_KEY, instance_token: peer.instance_token }),
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
    body: JSON.stringify({ api_key: TEST_API_KEY, instance_token: peer.instance_token }),
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
    body: JSON.stringify({ api_key: TEST_API_KEY, instance_token: peer.instance_token }),
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
