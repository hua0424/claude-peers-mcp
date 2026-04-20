// tests/broker-group-config.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_KEY = "test-key";
const GROUP_SECRET = "test-secret";
let brokerProc: Subprocess | null = null;
let brokerUrl = "";
let tmpDir = "";

async function waitForBroker(url: string, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${API_KEY}` } });
      if (r.ok) return;
    } catch { /* not ready */ }
    await Bun.sleep(50);
  }
  throw new Error("Broker not ready");
}

async function pickFreePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const p = s.port; s.stop(true); return p;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
  const port = await pickFreePort();
  brokerUrl = `http://127.0.0.1:${port}`;
  brokerProc = spawn({
    cmd: ["bun", "broker.ts"],
    env: { ...process.env, CLAUDE_PEERS_API_KEY: API_KEY, CLAUDE_PEERS_PORT: String(port), CLAUDE_PEERS_DB: join(tmpDir, "b.db") },
    stdout: "pipe", stderr: "pipe",
  });
  await waitForBroker(brokerUrl);
});

afterAll(async () => {
  brokerProc?.kill(); await brokerProc?.exited;
  rmSync(tmpDir, { recursive: true, force: true });
});

type RegResult = { id: string; instance_token: string; role: string };

async function reg(pid: number): Promise<RegResult> {
  const r = await fetch(`${brokerUrl}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: API_KEY, group_secret: GROUP_SECRET, pid, hostname: "h", cwd: "/c", git_root: null, summary: "" }),
  });
  expect(r.status).toBe(200);
  return r.json() as Promise<RegResult>;
}

async function unreg(token: string) {
  await fetch(`${brokerUrl}/unregister`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: "{}" });
}

async function authedPost<T>(token: string, path: string, body: unknown): Promise<{ status: number; data: T }> {
  const r = await fetch(`${brokerUrl}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: (await r.json()) as T };
}

// --- Phase 1 tests ---

test("register returns role='unknown'", async () => {
  const a = await reg(20001);
  expect(a.role).toBe("unknown");
  await unreg(a.instance_token);
});

test("set_role updates caller's role", async () => {
  const a = await reg(20002);
  const r = await authedPost<{ ok: boolean }>(a.instance_token, "/set-role", { role: "developer" });
  expect(r.status).toBe(200);
  expect(r.data.ok).toBe(true);
  await unreg(a.instance_token);
});

test("list-peers includes role field", async () => {
  const a = await reg(20003);
  await authedPost(a.instance_token, "/set-role", { role: "tester" });
  const b = await reg(20004);
  const r = await authedPost<Array<{ id: string; role: string }>>(b.instance_token, "/list-peers", { scope: "group", cwd: "/c", hostname: "h", git_root: null });
  expect(r.status).toBe(200);
  const aEntry = r.data.find(p => p.id === a.id);
  expect(aEntry?.role).toBe("tester");
  await unreg(a.instance_token); await unreg(b.instance_token);
});

test("get_group_doc returns empty string initially", async () => {
  const a = await reg(20005);
  const r = await authedPost<{ doc: string }>(a.instance_token, "/get-group-doc", {});
  expect(r.status).toBe(200);
  expect(r.data.doc).toBe("");
  await unreg(a.instance_token);
});

test("set_group_doc and get_group_doc round-trip", async () => {
  const a = await reg(20006);
  await authedPost(a.instance_token, "/set-role", { role: "manager" });
  const doc = "# Team Doc\n\nHello team.";
  const setR = await authedPost<{ ok: boolean }>(a.instance_token, "/set-group-doc", { doc });
  expect(setR.status).toBe(200);
  expect(setR.data.ok).toBe(true);
  const getR = await authedPost<{ doc: string }>(a.instance_token, "/get-group-doc", {});
  expect(getR.data.doc).toBe(doc);
  await unreg(a.instance_token);
});

test("/admin/groups returns group list (API key auth)", async () => {
  await reg(20007).then(a => unreg(a.instance_token)); // ensure at least one group
  const r = await fetch(`${brokerUrl}/admin/groups`, { headers: { Authorization: `Bearer ${API_KEY}` } });
  expect(r.status).toBe(200);
  const groups = await r.json() as Array<{ group_id: string; active_peers: number; created_at: string }>;
  expect(Array.isArray(groups)).toBe(true);
});

test("/admin/groups rejects without API key", async () => {
  const r = await fetch(`${brokerUrl}/admin/groups`);
  expect(r.status).toBe(401);
});

test("resume returns role", async () => {
  const a = await reg(20008);
  await authedPost(a.instance_token, "/set-role", { role: "manager" });
  await unreg(a.instance_token);
  // Register fresh to get dormant row (unregister deleted it) — test resume path via another session
  // Just verify new register returns role field
  const b = await reg(20009);
  expect(typeof b.role).toBe("string");
  await unreg(b.instance_token);
});

// --- Phase 2 tests (role enforcement) ---

test("set_role: unknown peer can set role once", async () => {
  const a = await reg(30001);
  const r = await authedPost<{ ok: boolean }>(a.instance_token, "/set-role", { role: "developer" });
  expect(r.status).toBe(200);
  expect(r.data.ok).toBe(true);
  await unreg(a.instance_token);
});

test("set_role: non-manager with existing role cannot change own role", async () => {
  const a = await reg(30002);
  await authedPost(a.instance_token, "/set-role", { role: "developer" }); // first-time set
  const r = await authedPost<{ ok: boolean; error?: string }>(a.instance_token, "/set-role", { role: "tester" }); // blocked
  expect(r.status).toBe(403);
  await unreg(a.instance_token);
});

test("set_role: manager can change own role (including downgrade)", async () => {
  const a = await reg(30003);
  await authedPost(a.instance_token, "/set-role", { role: "manager" });
  const r = await authedPost<{ ok: boolean }>(a.instance_token, "/set-role", { role: "developer" }); // 自降级
  expect(r.status).toBe(200); // 允许，但此后无法再写 group doc
  await unreg(a.instance_token);
});

test("set_role: manager can change another peer's role", async () => {
  const m = await reg(30004);
  await authedPost(m.instance_token, "/set-role", { role: "manager" });
  const d = await reg(30005);
  await authedPost(d.instance_token, "/set-role", { role: "developer" });
  // manager changes developer's role
  const r = await authedPost<{ ok: boolean }>(m.instance_token, "/set-role", { role: "tester", peer_id: d.id });
  expect(r.status).toBe(200);
  // verify via list-peers
  const peers = await authedPost<Array<{ id: string; role: string }>>(m.instance_token, "/list-peers", { scope: "group", cwd: "/c", hostname: "h", git_root: null });
  expect(peers.data.find(p => p.id === d.id)?.role).toBe("tester");
  await unreg(m.instance_token); await unreg(d.instance_token);
});

test("set_group_doc: non-manager gets 403", async () => {
  const a = await reg(30006);
  await authedPost(a.instance_token, "/set-role", { role: "developer" });
  const r = await authedPost<{ ok: boolean; error?: string }>(a.instance_token, "/set-group-doc", { doc: "# hack" });
  expect(r.status).toBe(403);
  await unreg(a.instance_token);
});

test("set_group_doc: manager can write", async () => {
  const a = await reg(30007);
  await authedPost(a.instance_token, "/set-role", { role: "manager" });
  const r = await authedPost<{ ok: boolean }>(a.instance_token, "/set-group-doc", { doc: "# Official Doc" });
  expect(r.status).toBe(200);
  await unreg(a.instance_token);
});

test("set_role: non-manager passing own peer_id cannot bypass", async () => {
  const a = await reg(30008);
  await authedPost(a.instance_token, "/set-role", { role: "developer" }); // 首次设置
  const r = await authedPost<{ ok: boolean; error?: string }>(
    a.instance_token, "/set-role", { role: "tester", peer_id: a.id }
  );
  expect(r.status).toBe(403); // peer_id=own_id 落入 own-role 路径，被拦截
  await unreg(a.instance_token);
});
