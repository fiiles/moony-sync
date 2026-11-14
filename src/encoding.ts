// Formats, validation and byte helpers. Nothing here touches storage.

import { timingSafeEqual } from "node:crypto";

const ACCOUNT_RE = /^[0-9]{16}$/;
const VAULT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const VAULT_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const OP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const isAccountNumber = (s: unknown): s is string =>
  typeof s === "string" && ACCOUNT_RE.test(s);
export const isVaultId = (s: unknown): s is string => typeof s === "string" && VAULT_ID_RE.test(s);
export const isMailboxId = (s: unknown): s is string => typeof s === "string" && VAULT_ID_RE.test(s);
export const isVaultToken = (s: unknown): s is string =>
  typeof s === "string" && VAULT_TOKEN_RE.test(s);
export const isOpId = (s: unknown): s is string => typeof s === "string" && OP_ID_RE.test(s);

/** Standard base64 (with padding) → bytes. Returns null on malformed input. */
export function decodeBase64(s: string): Uint8Array | null {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Exact decoded size of a padded base64 string, without decoding it. */
export function base64DecodedLength(s: string): number {
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Constant-time comparison of two equal-length strings (hex digests, signatures). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  return timingSafeEqual(ea, eb);
}

/** 16 random digits, first digit non-zero. Rejection sampling keeps every digit uniform. */
export function randomAccountNumber(): string {
  const digits: number[] = [];
  const buf = new Uint8Array(32);
  while (digits.length < 16) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= 250) continue; // 250 = 25 * 10, keeps b % 10 unbiased
      const d = b % 10;
      if (digits.length === 0 && d === 0) continue;
      digits.push(d);
      if (digits.length === 16) break;
    }
  }
  return digits.join("");
}
