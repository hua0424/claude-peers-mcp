import { mkdirSync, readdirSync, unlinkSync, existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { isValidPeerId } from "./auth.ts";

export interface SessionData {
  peer_id: string;
  instance_token: string;
  cwd: string;
  group_id: string;
  hostname: string;
  summary?: string;
  created_at?: string;
  last_used?: string;
}

/** Reject peer IDs that could escape the sessions directory. Delegates to shared validation. */
const isSafePeerId = isValidPeerId;

export function saveSession(dir: string, data: SessionData): void {
  if (!isSafePeerId(data.peer_id)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const record = {
    ...data,
    created_at: data.created_at ?? now,
    last_used: now,
  };
  const filePath = join(dir, `${data.peer_id}.json`);
  writeFileSync(filePath, JSON.stringify(record, null, 2));
  chmodSync(filePath, 0o600);
}

export function loadSession(dir: string, peerId: string): SessionData | null {
  if (!isSafePeerId(peerId)) return null;
  const file = join(dir, `${peerId}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SessionData;
  } catch {
    return null;
  }
}

export function scanSessions(dir: string, cwd: string, groupId: string, hostname: string): SessionData[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const sessions: SessionData[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as SessionData;
      // Skip entries with invalid peer_id — saves/deletes would silently no-op on them
      if (!isSafePeerId(data.peer_id)) continue;
      if (data.cwd === cwd && data.group_id === groupId && data.hostname === hostname) {
        sessions.push(data);
      }
    } catch {
      // Skip corrupt files
    }
  }
  // ISO 8601 strings are lexicographically sortable, so string comparison works correctly here.
  sessions.sort((a, b) => {
    const ta = a.last_used ?? a.created_at ?? "";
    const tb = b.last_used ?? b.created_at ?? "";
    return tb.localeCompare(ta);
  });
  return sessions;
}

export function deleteSession(dir: string, peerId: string): void {
  if (!isSafePeerId(peerId)) return;
  const file = join(dir, `${peerId}.json`);
  if (existsSync(file)) unlinkSync(file);
}

export function cleanupStaleSessions(dir: string, maxAgeDays: number): void {
  if (!existsSync(dir)) return;
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as SessionData;
      const lastUsed = data.last_used ?? data.created_at ?? "";
      // ISO 8601 strings are lexicographically sortable, string comparison is correct.
      // If both fields are absent (e.g. a very old session file), lastUsed defaults to ""
      // which is always < any ISO cutoff, so the file is deleted. This is intentional:
      // files without timestamps cannot be determined to be recent and are treated as stale.
      if (lastUsed < cutoff) {
        unlinkSync(join(dir, file));
      }
    } catch {
      // Skip corrupt files
    }
  }
}
