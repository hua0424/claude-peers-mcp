import {
  mkdirSync,
  readdirSync,
  unlinkSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  renameSync,
} from "node:fs";
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

/** Reject peer IDs that could escape the sessions directory. */
const isSafePeerId = isValidPeerId;

/** 32 lowercase hex chars — matches deriveGroupId's output. */
const GROUP_ID_REGEX = /^[a-f0-9]{32}$/;

function isSafeGroupId(groupId: string): boolean {
  return GROUP_ID_REGEX.test(groupId);
}

function sessionFileName(groupId: string, peerId: string): string {
  return `${groupId}_${peerId}.json`;
}

/** Matches new-scheme filenames: `${32-hex}_${peer_id}.json`. */
const NEW_FORMAT_REGEX = /^[a-f0-9]{32}_[a-z0-9][a-z0-9-]{0,31}\.json$/;

export function saveSession(dir: string, data: SessionData): void {
  if (!isSafePeerId(data.peer_id)) return;
  if (!isSafeGroupId(data.group_id)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const record = {
    ...data,
    created_at: data.created_at ?? now,
    last_used: now,
  };
  const filePath = join(dir, sessionFileName(data.group_id, data.peer_id));
  writeFileSync(filePath, JSON.stringify(record, null, 2));
  chmodSync(filePath, 0o600);
}

export function loadSession(
  dir: string,
  groupId: string,
  peerId: string
): SessionData | null {
  if (!isSafePeerId(peerId) || !isSafeGroupId(groupId)) return null;
  const file = join(dir, sessionFileName(groupId, peerId));
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SessionData;
  } catch {
    return null;
  }
}

export function scanSessions(
  dir: string,
  cwd: string,
  groupId: string,
  hostname: string
): SessionData[] {
  if (!existsSync(dir)) return [];
  if (!isSafeGroupId(groupId)) return [];
  const prefix = `${groupId}_`;
  const files = readdirSync(dir).filter(
    (f) => f.startsWith(prefix) && f.endsWith(".json")
  );
  const sessions: SessionData[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(
        readFileSync(join(dir, file), "utf8")
      ) as SessionData;
      if (!isSafePeerId(data.peer_id)) continue;
      if (data.group_id !== groupId) continue; // defense in depth
      if (data.cwd === cwd && data.hostname === hostname) {
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

export function deleteSession(
  dir: string,
  groupId: string,
  peerId: string
): void {
  if (!isSafePeerId(peerId) || !isSafeGroupId(groupId)) return;
  const file = join(dir, sessionFileName(groupId, peerId));
  if (existsSync(file)) unlinkSync(file);
}

export function cleanupStaleSessions(dir: string, maxAgeDays: number): void {
  if (!existsSync(dir)) return;
  const cutoff = new Date(
    Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const data = JSON.parse(
        readFileSync(join(dir, file), "utf8")
      ) as SessionData;
      const lastUsed = data.last_used ?? data.created_at ?? "";
      if (lastUsed < cutoff) {
        unlinkSync(join(dir, file));
      }
    } catch {
      // Skip corrupt files
    }
  }
}

/**
 * One-shot migration from the legacy `${peer_id}.json` filename scheme
 * to `${group_id}_${peer_id}.json`. Safe to call on every startup: files
 * already in new format are skipped. Corrupt or unrecognisable legacy
 * files are removed (they cannot be resumed anyway).
 */
export function migrateSessionFiles(dir: string): void {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    if (NEW_FORMAT_REGEX.test(file)) continue; // already migrated
    const oldPath = join(dir, file);
    try {
      const data = JSON.parse(readFileSync(oldPath, "utf8")) as SessionData;
      if (
        isSafePeerId(data.peer_id) &&
        isSafeGroupId(data.group_id) &&
        data.peer_id === file.replace(/\.json$/, "")
      ) {
        const newPath = join(dir, sessionFileName(data.group_id, data.peer_id));
        if (existsSync(newPath)) {
          unlinkSync(oldPath);
        } else {
          renameSync(oldPath, newPath);
        }
        continue;
      }
      unlinkSync(oldPath);
    } catch {
      try {
        unlinkSync(oldPath);
      } catch {
        // best-effort
      }
    }
  }
}
