/**
 * Tests for stale cleanup behavior: active peers are protected,
 * dormant peers past TTL are deleted, and phantom actives are reset on startup.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";

function freshBrokerModule(dbPath: string, port: number) {
  // Set env before import so broker.ts uses our test DB
  process.env.CLAUDE_PEERS_DB = dbPath;
  process.env.CLAUDE_PEERS_PORT = String(port);
  process.env.CLAUDE_PEERS_API_KEY = "test-api-key-stale";
  // Use query param to bypass module cache — each test gets its own db connection
  return import(`../broker.ts?t=${Date.now()}`);
}

function setupSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      group_id TEXT PRIMARY KEY,
      group_secret_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      group_secret TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS peers (
      instance_token TEXT PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      pid INTEGER NOT NULL,
      hostname TEXT NOT NULL,
      cwd TEXT NOT NULL,
      git_root TEXT,
      group_id TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      role TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      text TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      group_id TEXT NOT NULL DEFAULT ''
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_undelivered ON messages (to_id, group_id, delivered)`);
}

test("cleanStale does not delete active peers", async () => {
  const dbPath = `/tmp/claude-peers-stale-active-${Date.now()}.db`;
  const broker = await freshBrokerModule(dbPath, 17990);
  setupSchema(broker.db);

  const token = "a".repeat(64);
  const groupId = "g".repeat(32);
  broker.db.run(
    `INSERT OR IGNORE INTO groups (group_id, group_secret_hash, created_at) VALUES (?, ?, ?)`,
    [groupId, "hash", new Date().toISOString()]
  );
  broker.db.run(
    `INSERT INTO peers (instance_token, id, pid, hostname, cwd, git_root, group_id, summary, registered_at, last_seen, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [token, "active-peer", 1, "h", "/tmp", null, groupId, "", new Date().toISOString(), new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), "active"]
  );

  broker.cleanStale();

  const row = broker.db.query("SELECT * FROM peers WHERE instance_token = ?").get(token);
  expect(row).not.toBeNull();

  broker.db.close();
  unlinkSync(dbPath);
});

test("cleanStale deletes dormant peers past TTL", async () => {
  const dbPath = `/tmp/claude-peers-stale-dormant-${Date.now()}.db`;
  const broker = await freshBrokerModule(dbPath, 17991);
  setupSchema(broker.db);

  const token = "b".repeat(64);
  const groupId = "g".repeat(32);
  broker.db.run(
    `INSERT OR IGNORE INTO groups (group_id, group_secret_hash, created_at) VALUES (?, ?, ?)`,
    [groupId, "hash", new Date().toISOString()]
  );
  broker.db.run(
    `INSERT INTO peers (instance_token, id, pid, hostname, cwd, git_root, group_id, summary, registered_at, last_seen, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [token, "dormant-peer", 1, "h", "/tmp", null, groupId, "", new Date().toISOString(), new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), "dormant"]
  );

  broker.cleanStale();

  const row = broker.db.query("SELECT * FROM peers WHERE instance_token = ?").get(token);
  expect(row).toBeNull();

  broker.db.close();
  unlinkSync(dbPath);
});

test("startup resets active peers to dormant", async () => {
  const dbPath = `/tmp/claude-peers-stale-reset-${Date.now()}.db`;

  // Pre-seed DB with an active peer (simulating a crashed broker)
  {
    const db = new Database(dbPath);
    setupSchema(db);
    const token = "c".repeat(64);
    const groupId = "g".repeat(32);
    db.run(
      `INSERT OR IGNORE INTO groups (group_id, group_secret_hash, created_at) VALUES (?, ?, ?)`,
      [groupId, "hash", new Date().toISOString()]
    );
    db.run(
      `INSERT INTO peers (instance_token, id, pid, hostname, cwd, git_root, group_id, summary, registered_at, last_seen, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [token, "phantom-active", 1, "h", "/tmp", null, groupId, "", new Date().toISOString(), new Date().toISOString(), "active"]
    );
    db.close();
  }

  // Spawn broker against this DB — startup should reset active → dormant
  const proc = Bun.spawn(["bun", "broker.ts"], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: "17992",
      CLAUDE_PEERS_DB: dbPath,
      CLAUDE_PEERS_API_KEY: "test-api-key-stale",
    },
    stdout: "ignore",
    stderr: "pipe",
  });

  // Wait for broker to start
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch("http://127.0.0.1:17992/health", {
        headers: { Authorization: "Bearer test-api-key-stale" },
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) break;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  proc.kill();
  await proc.exited;
  const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";

  // Verify DB state
  const verifyDb = new Database(dbPath);
  const row = verifyDb.query("SELECT status FROM peers WHERE id = ?").get("phantom-active") as { status: string } | null;
  verifyDb.close();

  expect(row).not.toBeNull();
  expect(row?.status).toBe("dormant");
  expect(stderr).toContain("phantom active");

  unlinkSync(dbPath);
});
