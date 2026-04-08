import { createHash, randomBytes } from "node:crypto";

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
