// Fixed-window rate limits and the client key.

import { createHash } from "node:crypto";
import type { Clock } from "./clock.js";
import { KIT_CLIENT_FAILURES_PER_MINUTE, KIT_READS_PER_MINUTE, KIT_VAULT_FAILURES_PER_HOUR } from "./limits.js";

/** `hit` counts one request for `key`; true means the caller is over the limit. */
export interface Limiter {
  hit(key: string): boolean;
  /** True when `key` has already used up its hits in this window; counts nothing. Lets a caller
   *  count only failures (hit after the fact) and refuse early once the quota is gone. */
  over(key: string): boolean;
  /** Counts one hit for `key` unless its quota is already used up (then nothing is counted and
   *  null comes back). The returned function gives the hit back, in the same window only. For
   *  work that must be counted before it starts (a slow check), refunded when it succeeds. */
  reserve(key: string): (() => void) | null;
  /** Forgets every count of the current window (an operator's unlock). */
  clear(): void;
}

/** At most `limit` hits per key in each window of `periodSeconds`. Entries of finished windows
 *  are dropped, so the map holds only keys seen in the current window. */
export function fixedWindow(limit: number, periodSeconds: number, clock: Clock): Limiter {
  let window = -1;
  let counts = new Map<string, number>();
  const roll = (): void => {
    const current = Math.floor(clock() / periodSeconds);
    if (current !== window) {
      window = current;
      counts = new Map();
    }
  };
  return {
    clear() {
      counts = new Map();
    },
    hit(key) {
      roll();
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n > limit;
    },
    over(key) {
      roll();
      return (counts.get(key) ?? 0) >= limit;
    },
    reserve(key) {
      roll();
      const n = counts.get(key) ?? 0;
      if (n >= limit) return null;
      counts.set(key, n + 1);
      const reserved = window;
      return () => {
        const now = counts.get(key) ?? 0;
        if (reserved === window && now > 0) counts.set(key, now - 1);
      };
    },
  };
}

/** The last entry of a comma-separated forwarding header: the one a (single, trusted) proxy
 *  appended itself. Earlier entries are whatever the client sent. */
export function lastForwarded(value: string | null | undefined): string | undefined {
  return value?.split(",").pop()?.trim() || undefined;
}

/** The key an address is limited under: IPv4 as is; IPv4-mapped IPv6 as the IPv4; any other
 *  IPv6 by its /64 (one subscriber holds a whole /64, so per-address keys would be free to
 *  rotate). Anything that does not parse is used as it is. */
export function addressKey(address: string): string {
  const a = address.split("%")[0]!.toLowerCase();
  if (!a.includes(":")) return address;
  const mapped = /^(?:0{0,4}:){2,5}ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(a);
  if (mapped) return mapped[1]!;
  const halves = a.split("::");
  if (halves.length > 2) return address;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return address;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return address;
  const hexMapped = /^0+$/.test(groups.slice(0, 5).join("")) && groups[5] === "ffff";
  if (hexMapped) {
    const hi = parseInt(groups[6]!, 16);
    const lo = parseInt(groups[7]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}

/** The caller's address: the socket's, or the last X-Forwarded-For entry (the peer the proxy
 *  saw) only behind a proxy the operator declared trusted (otherwise any client could pick its
 *  own key, and behind a proxy the leftmost entry is client-chosen). */
export function clientKey(req: Request, clientAddress: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const last = lastForwarded(req.headers.get("x-forwarded-for"));
    if (last) return addressKey(last);
  }
  return clientAddress ? addressKey(clientAddress) : "local";
}

/** Per-minute limits. */
export interface Limiters {
  /** Account lookups (and vault creation, which can probe account numbers), per client. */
  accountLookup: Limiter;
  /** Per vault + token prefix, so junk tokens cannot use up a real vault's quota. */
  vault: Limiter;
  /** All vault routes, per client. */
  vaultIp: Limiter;
  pairing: Limiter;
  /** Every GET /kit per client, before the token is looked at: a generous backstop. */
  kitRead: Limiter;
  /** Failed GET /kit attempts (401, 404) per client, per minute. Counted after the fact, so the
   *  right Kit token is never refused by it. */
  kitClientFailures: Limiter;
  /** Failed GET /kit attempts (401) per vault, per hour. Counted after the fact, so the right Kit
   *  token is never refused by it. */
  kitVaultFailures: Limiter;
}

export function createLimiters(clock: Clock): Limiters {
  return {
    accountLookup: fixedWindow(60, 60, clock),
    vault: fixedWindow(600, 60, clock),
    vaultIp: fixedWindow(1200, 60, clock),
    pairing: fixedWindow(120, 60, clock),
    kitRead: fixedWindow(KIT_READS_PER_MINUTE, 60, clock),
    kitClientFailures: fixedWindow(KIT_CLIENT_FAILURES_PER_MINUTE, 60, clock),
    kitVaultFailures: fixedWindow(KIT_VAULT_FAILURES_PER_HOUR, 60 * 60, clock),
  };
}

export const tokenKey = (vaultId: string, token: string): string =>
  `${vaultId}:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
