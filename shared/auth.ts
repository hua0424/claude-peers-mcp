import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

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
  return hashSecret(secret).slice(0, 16);
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
