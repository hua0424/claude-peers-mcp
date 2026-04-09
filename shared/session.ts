import { mkdirSync, readdirSync, unlinkSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionData {
  peer_id: string;
  instance_token: string;
  cwd: string;
  group_id: string;
  hostname: string;
  created_at?: string;
  last_used?: string;
}

export function saveSession(dir: string, data: SessionData): void {
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const record = {
    ...data,
    created_at: data.created_at ?? now,
    last_used: now,
  };
  writeFileSync(join(dir, `${data.peer_id}.json`), JSON.stringify(record, null, 2));
}

export function loadSession(dir: string, peerId: string): SessionData | null {
  const file = join(dir, `${peerId}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SessionData;
  } catch {
    return null;
  }
}

export function scanSessions(dir: string, cwd: string, groupId: string): SessionData[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const sessions: SessionData[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as SessionData;
      if (data.cwd === cwd && data.group_id === groupId) {
        sessions.push(data);
      }
    } catch {
      // Skip corrupt files
    }
  }
  sessions.sort((a, b) => {
    const ta = a.last_used ?? a.created_at ?? "";
    const tb = b.last_used ?? b.created_at ?? "";
    return tb.localeCompare(ta);
  });
  return sessions;
}

export function deleteSession(dir: string, peerId: string): void {
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
      if (lastUsed < cutoff) {
        unlinkSync(join(dir, file));
      }
    } catch {
      // Skip corrupt files
    }
  }
}
