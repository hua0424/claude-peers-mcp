import { test, expect, beforeEach, afterEach } from "bun:test";
import { saveSession, loadSession, scanSessions, deleteSession, cleanupStaleSessions } from "./session.ts";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = `/tmp/claude-peers-session-test-${Date.now()}`;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("saveSession creates a session file", () => {
  saveSession(TEST_DIR, {
    peer_id: "abc12345",
    instance_token: "tok123",
    cwd: "/project",
    group_id: "grp1",
    hostname: "host1",
  });
  expect(existsSync(join(TEST_DIR, "abc12345.json"))).toBe(true);
});

test("loadSession reads a session file", () => {
  saveSession(TEST_DIR, {
    peer_id: "abc12345",
    instance_token: "tok123",
    cwd: "/project",
    group_id: "grp1",
    hostname: "host1",
  });
  const session = loadSession(TEST_DIR, "abc12345");
  expect(session).not.toBeNull();
  expect(session!.peer_id).toBe("abc12345");
  expect(session!.instance_token).toBe("tok123");
});

test("loadSession returns null for missing file", () => {
  const session = loadSession(TEST_DIR, "nonexistent");
  expect(session).toBeNull();
});

test("scanSessions filters by cwd and group_id", () => {
  saveSession(TEST_DIR, { peer_id: "a", instance_token: "t1", cwd: "/proj", group_id: "g1", hostname: "h" });
  saveSession(TEST_DIR, { peer_id: "b", instance_token: "t2", cwd: "/proj", group_id: "g1", hostname: "h" });
  saveSession(TEST_DIR, { peer_id: "c", instance_token: "t3", cwd: "/other", group_id: "g1", hostname: "h" });
  saveSession(TEST_DIR, { peer_id: "d", instance_token: "t4", cwd: "/proj", group_id: "g2", hostname: "h" });

  const matches = scanSessions(TEST_DIR, "/proj", "g1", "h");
  const ids = matches.map((s) => s.peer_id);
  expect(ids).toContain("a");
  expect(ids).toContain("b");
  expect(ids).not.toContain("c");
  expect(ids).not.toContain("d");
});

test("scanSessions returns newest last_used first", () => {
  saveSession(TEST_DIR, { peer_id: "old", instance_token: "t1", cwd: "/p", group_id: "g", hostname: "h" });
  const oldFile = join(TEST_DIR, "old.json");
  const oldData = JSON.parse(readFileSync(oldFile, "utf8"));
  oldData.last_used = "2020-01-01T00:00:00Z";
  writeFileSync(oldFile, JSON.stringify(oldData));

  saveSession(TEST_DIR, { peer_id: "new", instance_token: "t2", cwd: "/p", group_id: "g", hostname: "h" });

  const matches = scanSessions(TEST_DIR, "/p", "g", "h");
  expect(matches[0]!.peer_id).toBe("new");
  expect(matches[1]!.peer_id).toBe("old");
});

test("deleteSession removes a session file", () => {
  saveSession(TEST_DIR, { peer_id: "abc", instance_token: "t", cwd: "/p", group_id: "g", hostname: "h" });
  deleteSession(TEST_DIR, "abc");
  expect(existsSync(join(TEST_DIR, "abc.json"))).toBe(false);
});

test("cleanupStaleSessions removes old files", () => {
  saveSession(TEST_DIR, { peer_id: "stale", instance_token: "t", cwd: "/p", group_id: "g", hostname: "h" });
  const file = join(TEST_DIR, "stale.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.last_used = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(file, JSON.stringify(data));

  saveSession(TEST_DIR, { peer_id: "fresh", instance_token: "t2", cwd: "/p", group_id: "g", hostname: "h" });

  cleanupStaleSessions(TEST_DIR, 7);
  expect(existsSync(join(TEST_DIR, "stale.json"))).toBe(false);
  expect(existsSync(join(TEST_DIR, "fresh.json"))).toBe(true);
});
