import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Shared peer ID validation regex. Must match broker.ts set-id validation and session.ts path guard. */
const PEER_ID_REGEX = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

export function isValidPeerId(id: string): boolean {
  return PEER_ID_REGEX.test(id);
}

export function safeEqual(a: string, b: string): boolean {
  // Hash both inputs to a fixed-length digest before comparing, so the comparison
  // is truly timing-safe regardless of input length differences.
  const bufA = createHash("sha256").update(a).digest();
  const bufB = createHash("sha256").update(b).digest();
  return timingSafeEqual(bufA, bufB);
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function deriveGroupId(secret: string): string {
  return hashSecret(secret).slice(0, 32);
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function generatePeerId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[randomInt(chars.length)];
  }
  return id;
}
