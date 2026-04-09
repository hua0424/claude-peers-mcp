import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function deriveGroupId(secret: string): string {
  return hashSecret(secret).slice(0, 16);
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function generatePeerId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
