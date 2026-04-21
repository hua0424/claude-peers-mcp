/**
 * Regression test for the TDZ crash: cleanStale() runs at module load and
 * touches wsPool, which was declared AFTER cleanStale's first invocation.
 * Pre-seed the SQLite DB with a stale peer so cleanStale actually enters
 * the wsPool branch on startup. Without the fix, broker exits non-zero
 * before the /health endpoint becomes available.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_KEY = "test-api-key";
let brokerProc: Subprocess | null = null;
let tmpDir = "";

async function pickFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  return port;
}

async function waitForBroker(url: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      if (res.ok) return true;
    } catch {
      // not ready
    }
    await Bun.sleep(50);
  }
  return false;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-peers-startup-"));
});

afterAll(async () => {
  if (brokerProc) {
    brokerProc.kill();
    await brokerProc.exited;
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test("broker starts successfully when DB has stale peers awaiting cleanup", async () => {
  const dbPath = join(tmpDir, "broker.db");

  // Pre-seed a stale peer row (last_seen far in the past, status active).
  // Schema must match broker.ts initial CREATE TABLE exactly (migrations run
  // after, so role/doc columns are added automatically; group_id must be 32
  // hex chars to avoid the old-format-clear migration).
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      group_id TEXT PRIMARY KEY,
      group_secret_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS peers (
      instance_token TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      hostname TEXT NOT NULL,
      cwd TEXT NOT NULL,
      git_root TEXT,
      group_id TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      UNIQUE(id, group_id),
      FOREIGN KEY (group_id) REFERENCES groups(group_id)
    );
  `);
  const groupId = "a".repeat(32);
  const oldIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  db.exec(
    `INSERT INTO groups (group_id, group_secret_hash, created_at) VALUES ('${groupId}', 'h', '${oldIso}')`
  );
  db.exec(
    `INSERT INTO peers (instance_token, id, pid, hostname, cwd, summary, group_id, registered_at, last_seen, status)
     VALUES ('${"t".repeat(64)}', 'stale', 1, 'h', '/tmp', '', '${groupId}', '${oldIso}', '${oldIso}', 'active')`
  );
  db.close();

  const port = await pickFreePort();
  const url = `http://127.0.0.1:${port}`;
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

  const healthy = await waitForBroker(url);
  expect(healthy).toBe(true);
});
