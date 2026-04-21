import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveSession,
  loadSession,
  deleteSession,
  scanSessions,
  migrateSessionFiles,
} from "../shared/session.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-test-"));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const groupA = "a".repeat(32);
const groupB = "b".repeat(32);

test("saveSession writes distinct files for same peer_id across groups", () => {
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp/a",
    group_id: groupA,
    hostname: "host1",
    summary: "A",
  });
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "u".repeat(64),
    cwd: "/tmp/b",
    group_id: groupB,
    hostname: "host1",
    summary: "B",
  });

  const files = readdirSync(dir).sort();
  expect(files).toEqual([
    `${groupA}_manager.json`,
    `${groupB}_manager.json`,
  ]);
});

test("loadSession returns only the matching group's session", () => {
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp",
    group_id: groupA,
    hostname: "host1",
    summary: "A",
  });
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "u".repeat(64),
    cwd: "/tmp",
    group_id: groupB,
    hostname: "host1",
    summary: "B",
  });

  const a = loadSession(dir, groupA, "manager");
  const b = loadSession(dir, groupB, "manager");
  expect(a?.summary).toBe("A");
  expect(a?.group_id).toBe(groupA);
  expect(b?.summary).toBe("B");
  expect(b?.group_id).toBe(groupB);
});

test("loadSession returns null for missing (group, peer) combination", () => {
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp",
    group_id: groupA,
    hostname: "host1",
  });
  expect(loadSession(dir, groupB, "manager")).toBeNull();
});

test("deleteSession removes only the targeted (group, peer) file", () => {
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp",
    group_id: groupA,
    hostname: "host1",
  });
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "u".repeat(64),
    cwd: "/tmp",
    group_id: groupB,
    hostname: "host1",
  });

  deleteSession(dir, groupA, "manager");
  expect(existsSync(join(dir, `${groupA}_manager.json`))).toBe(false);
  expect(existsSync(join(dir, `${groupB}_manager.json`))).toBe(true);
});

test("scanSessions returns only sessions for the given group", () => {
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp",
    group_id: groupA,
    hostname: "host1",
  });
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "u".repeat(64),
    cwd: "/tmp",
    group_id: groupB,
    hostname: "host1",
  });

  const a = scanSessions(dir, "/tmp", groupA, "host1");
  const b = scanSessions(dir, "/tmp", groupB, "host1");
  expect(a.length).toBe(1);
  expect(a[0].group_id).toBe(groupA);
  expect(b.length).toBe(1);
  expect(b[0].group_id).toBe(groupB);
});


test("migrateSessionFiles renames legacy peer_id.json → group_id_peer_id.json", () => {
  const data = {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp",
    group_id: groupA,
    hostname: "host1",
    created_at: "2026-04-20T00:00:00Z",
    last_used: "2026-04-20T00:00:00Z",
  };
  writeFileSync(join(dir, "manager.json"), JSON.stringify(data));

  migrateSessionFiles(dir);

  const files = readdirSync(dir).sort();
  expect(files).toEqual([`${groupA}_manager.json`]);
  const loaded = loadSession(dir, groupA, "manager");
  expect(loaded?.instance_token).toBe("t".repeat(64));
});

test("migrateSessionFiles deletes corrupt or unidentifiable legacy files", () => {
  writeFileSync(join(dir, "foo.json"), "{not valid json");
  writeFileSync(join(dir, "bar.json"), JSON.stringify({ peer_id: "bar" })); // no group_id

  migrateSessionFiles(dir);

  expect(readdirSync(dir)).toEqual([]);
});

test("migrateSessionFiles is idempotent on already-migrated files", () => {
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp",
    group_id: groupA,
    hostname: "host1",
  });
  const before = readdirSync(dir);
  migrateSessionFiles(dir);
  const after = readdirSync(dir);
  expect(after).toEqual(before);
});

test("migrateSessionFiles drops legacy file when new-format target already exists", () => {
  saveSession(dir, {
    peer_id: "manager",
    instance_token: "t".repeat(64),
    cwd: "/tmp",
    group_id: groupA,
    hostname: "host1",
  });
  // legacy file referring to the same (group, peer)
  writeFileSync(
    join(dir, "manager.json"),
    JSON.stringify({
      peer_id: "manager",
      instance_token: "u".repeat(64),
      cwd: "/tmp",
      group_id: groupA,
      hostname: "host1",
    })
  );

  migrateSessionFiles(dir);

  const files = readdirSync(dir);
  expect(files).toEqual([`${groupA}_manager.json`]);
  // New-format wins
  expect(loadSession(dir, groupA, "manager")?.instance_token).toBe("t".repeat(64));
});
