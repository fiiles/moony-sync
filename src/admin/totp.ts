// TOTP (RFC 6238: HMAC-SHA-1, 6 digits, 30 s steps) and the base32 text it travels in.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

/** RFC 4648 base32 without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("invalid_base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** `chars` random base32 characters (uniform: 32 symbols divide 256 evenly). */
export function randomBase32(chars: number): string {
  return Array.from(randomBytes(chars), (b) => ALPHABET[b & 31]).join("");
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

/** The six-digit code of the 30-second step holding `unixSeconds`. */
export function totpCode(secret: Uint8Array, unixSeconds: number): string {
  return hotp(secret, Math.floor(unixSeconds / STEP_SECONDS));
}

function hotp(secret: Uint8Array, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const offset = h[h.length - 1]! & 15;
  const bin = h.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 1_000_000).padStart(6, "0");
}

/** The step number whose code (previous, current or next step) equals `code` and that is newer
 *  than `lastStep`, or null. Every candidate is compared, whatever matched first. */
export function matchTotp(
  secret: Uint8Array,
  code: string,
  unixSeconds: number,
  lastStep: number,
): number | null {
  const current = Math.floor(unixSeconds / STEP_SECONDS);
  const given = Buffer.from(code);
  let found: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const expected = Buffer.from(hotp(secret, step));
    if (given.length === expected.length && timingSafeEqual(given, expected) && step > lastStep) {
      found = step;
    }
  }
  return found;
}

export function otpauthUrl(secret: string, accountName: string): string {
  return (
    `otpauth://totp/Moony%20Sync:${encodeURIComponent(accountName)}` +
    `?secret=${secret}&issuer=Moony%20Sync&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`
  );
}
