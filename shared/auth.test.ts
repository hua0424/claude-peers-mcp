import { test, expect } from "bun:test";
import { hashSecret, deriveGroupId, generateToken, generatePeerId, safeEqual } from "./auth.ts";

test("safeEqual returns true for identical strings", () => {
  expect(safeEqual("my-api-key", "my-api-key")).toBe(true);
});

test("safeEqual returns false for different strings", () => {
  expect(safeEqual("correct-key", "wrong-key")).toBe(false);
});

test("safeEqual returns false for different-length strings", () => {
  expect(safeEqual("short", "much-longer-string")).toBe(false);
});

test("hashSecret returns consistent SHA-256 hex", () => {
  const h1 = hashSecret("my-secret");
  const h2 = hashSecret("my-secret");
  expect(h1).toBe(h2);
  expect(h1).toHaveLength(64); // SHA-256 hex = 64 chars
});

test("hashSecret returns different hashes for different inputs", () => {
  const h1 = hashSecret("secret-a");
  const h2 = hashSecret("secret-b");
  expect(h1).not.toBe(h2);
});

test("deriveGroupId returns first 32 chars of SHA-256", () => {
  const groupId = deriveGroupId("my-secret");
  const fullHash = hashSecret("my-secret");
  expect(groupId).toHaveLength(32);
  expect(groupId).toBe(fullHash.slice(0, 32));
});

test("generateToken returns 64-char hex string", () => {
  const token = generateToken();
  expect(token).toHaveLength(64);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
});

test("generateToken returns unique values", () => {
  const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
  expect(tokens.size).toBe(100);
});

test("generatePeerId returns 8-char alphanumeric string", () => {
  const id = generatePeerId();
  expect(id).toHaveLength(8);
  expect(id).toMatch(/^[a-z0-9]{8}$/);
});

test("generatePeerId returns unique values", () => {
  const ids = new Set(Array.from({ length: 100 }, () => generatePeerId()));
  expect(ids.size).toBe(100);
});
