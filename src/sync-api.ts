// The /v1 routes of the sync protocol: accounts, vaults and pairing mailboxes.

import { Hono, type Context } from "hono";
import type { AppBindings, Deps, Stores } from "./app.js";
import {
  base64DecodedLength,
  decodeBase64,
  encodeBase64,
  isAccountNumber,
  isMailboxId,
  isOpId,
  isVaultId,
  isVaultToken,
} from "./encoding.js";
import { errorResponse, fromResult, json, readBody, readJson, type BodyBudget } from "./http.js";
import {
  DEFAULT_PULL_LIMIT,
  DEFAULT_REKEY_LIMIT,
  MAX_OP_BYTES,
  MAX_MAILBOX_SLOT_BYTES,
  MAX_OPS_PER_PUSH,
  MAX_PULL_LIMIT,
  MAX_PUSH_BODY_BYTES,
  MAX_REKEY_BYTES,
  MAX_REKEY_LIMIT,
  MAX_SNAPSHOT_BYTES,
} from "./limits.js";
import { clientKey, tokenKey, type Limiters } from "./ratelimit.js";
import { SnapshotBodyError } from "./snapshots.js";
import type { IncomingOp } from "./vaults.js";

type Env = { Bindings: AppBindings };

export function syncRoutes(deps: Deps, stores: Stores, limiters: Limiters, budget: BodyBudget): Hono<Env> {
  const r = new Hono<Env>();
  const callerOf = (c: Context<Env>): string =>
    clientKey(c.req.raw, c.env.clientAddress, deps.config.trustProxy);

  // Accounts are created by the operator (admin API), never by clients.
  // Still limited, so it cannot be hammered.
  r.post("/accounts", (c) => {
    if (limiters.accountLookup.hit(callerOf(c))) return errorResponse(429, "rate_limited");
    return errorResponse(403, "registration_closed");
  });

  r.all("/accounts/me/checkout", (c) => {
    if (!accountOf(c.req.raw)) return errorResponse(400, "missing_account");
    if (limiters.accountLookup.hit(callerOf(c))) return errorResponse(429, "rate_limited");
    if (c.req.method !== "POST") return errorResponse(405, "method_not_allowed");
    return errorResponse(409, "self_hosted");
  });

  r.all("/accounts/me", (c) => {
    const account = accountOf(c.req.raw);
    if (!account) return errorResponse(400, "missing_account");
    if (limiters.accountLookup.hit(callerOf(c))) return errorResponse(429, "rate_limited");
    if (c.req.method === "DELETE") return errorResponse(403, "managed_by_operator");
    if (c.req.method !== "GET") return errorResponse(405, "method_not_allowed");
    const paidUntil = stores.people.paidUntil(account);
    if (paidUntil === null) return errorResponse(404, "account_not_found");
    return json({
      paidUntil: paidUntil || null,
      active: paidUntil > deps.clock(),
      vaults: stores.vaults.listByAccount(account).length,
    });
  });

  r.all("/vaults/*", (c) => vaultRoute(c.req.raw, stores, limiters, budget, callerOf(c)));

  // Pairing needs no credentials: slot contents are public keys or sealed blobs and the ID is
  // random, so it is limited per client address only.
  r.all("/pairing/*", (c) => pairingRoute(c.req.raw, stores, limiters, budget, callerOf(c)));

  return r;
}

/** Token + rekey bundle: base64 of 256 KiB is ~342 KiB, plus the JSON around it. */
const MAX_ROTATE_BODY_BYTES = 512 * 1024;
const PAIRING_PATH = /^\/v1\/pairing\/([^/]+)(?:\/([^/]+))?$/;
const VAULT_PATH = /^\/v1\/vaults\/([^/]+)(\/ops|\/snapshot|\/token|\/rekey)?$/;

function bearer(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(h);
  return m && isVaultToken(m[1]) ? m[1] : null;
}

function intParam(url: URL, name: string): number | null {
  const v = url.searchParams.get(name);
  if (v === null || !/^[0-9]{1,15}$/.test(v)) return null;
  return Number(v);
}

function parseOps(value: unknown): IncomingOp[] | null {
  const ops = (value as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS_PER_PUSH) return null;
  const out: IncomingOp[] = [];
  for (const raw of ops) {
    const { id, ct } = (raw ?? {}) as { id?: unknown; ct?: unknown };
    if (!isOpId(id) || typeof ct !== "string") return null;
    if (ct.length === 0 || ct.length % 4 !== 0) return null;
    if (base64DecodedLength(ct) > MAX_OP_BYTES) return null;
    const bytes = decodeBase64(ct);
    if (!bytes || bytes.length === 0) return null;
    out.push({ id, ct: bytes });
  }
  return out;
}

async function vaultRoute(
  request: Request,
  stores: Stores,
  limiters: Limiters,
  budget: BodyBudget,
  caller: string,
): Promise<Response> {
  const url = new URL(request.url);
  const match = VAULT_PATH.exec(url.pathname);
  if (!match) return errorResponse(404, "not_found");
  const vaultId = match[1]!;
  const sub = match[2] ?? "";
  if (!isVaultId(vaultId)) return errorResponse(400, "invalid_vault_id");

  // Per client address first, so nobody can hammer random vault IDs (or guess account numbers
  // through vault creation); then per vault + token, so junk tokens cannot use up a real
  // vault's quota.
  if (limiters.vaultIp.hit(caller)) return errorResponse(429, "rate_limited");
  const token = bearer(request);
  if (!token) return errorResponse(401, "unauthorized");
  if (limiters.vault.hit(tokenKey(vaultId, token))) return errorResponse(429, "rate_limited");
  const { vaults, snapshots } = stores;
  const method = request.method;

  if (sub === "") {
    if (method === "PUT") {
      const account = request.headers.get("moony-account");
      if (!isAccountNumber(account)) return errorResponse(400, "missing_account");
      if (limiters.accountLookup.hit(caller)) return errorResponse(429, "rate_limited");
      const r = await vaults.init(vaultId, account, token);
      if (!r.ok) return errorResponse(r.status, r.error);
      return json({ created: r.created }, r.created ? 201 : 200);
    }
    if (method === "GET") return fromResult(await vaults.info(vaultId, token));
    if (method === "DELETE") {
      const r = await vaults.destroy(vaultId, token);
      return r.ok ? new Response(null, { status: 204 }) : errorResponse(r.status, r.error);
    }
  }

  if (sub === "/ops") {
    if (method === "POST") {
      // The token is judged before a single body byte is read.
      const allowed = vaults.check(vaultId, token, "write");
      if (!allowed.ok) return errorResponse(allowed.status, allowed.error);
      const body = await readJson(request, MAX_PUSH_BODY_BYTES, budget);
      if ("error" in body) return errorResponse(body.status, body.error);
      const ops = parseOps(body.value);
      if (!ops) return errorResponse(400, "invalid_ops");
      return fromResult(await vaults.push(vaultId, token, ops));
    }
    if (method === "GET") {
      const after = intParam(url, "after") ?? 0;
      const limit = Math.min(intParam(url, "limit") ?? DEFAULT_PULL_LIMIT, MAX_PULL_LIMIT);
      if (limit < 1) return errorResponse(400, "invalid_limit");
      const r = await vaults.pull(vaultId, token, after, limit);
      if (!r.ok) return errorResponse(r.status, r.error);
      return json({
        ops: r.ops.map((o) => ({ seq: o.seq, id: o.id, ct: encodeBase64(o.ct) })),
        head: r.head,
        more: r.more,
      });
    }
  }

  if (sub === "/snapshot") {
    if (method === "PUT") {
      const seq = intParam(url, "seq");
      if (seq === null) return errorResponse(400, "invalid_seq");
      const length = Number(request.headers.get("content-length") ?? "NaN");
      if (!Number.isInteger(length) || length <= 0) return errorResponse(411, "length_required");
      if (length > MAX_SNAPSHOT_BYTES) return errorResponse(413, "snapshot_too_large");
      if (!request.body) return errorResponse(400, "empty_body");

      const auth = await vaults.authorizeSnapshot(vaultId, token, seq);
      if (!auth.ok) return errorResponse(auth.status, auth.error);
      // The declared length is also the cap: a body that runs past it is refused as it streams.
      let written;
      try {
        written = await snapshots.write(vaultId, seq, request.body, length);
      } catch (e) {
        if (e instanceof SnapshotBodyError) return errorResponse(400, "incomplete_body");
        // The vault was deleted while the body was streaming: its directory is gone.
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return errorResponse(404, "vault_not_found");
        throw e; // disk errors: 500 internal_error via the app's error handler
      }
      if (written === "too_large") return errorResponse(413, "snapshot_too_large");
      if (written.size !== length) {
        snapshots.remove(vaultId, written.file);
        return errorResponse(400, "incomplete_body");
      }
      const r = await vaults.recordSnapshot(vaultId, token, {
        file: written.file,
        seq,
        size: written.size,
      });
      if (!r.ok || r.stale) snapshots.remove(vaultId, written.file);
      if (!r.ok) return errorResponse(r.status, r.error);
      if (r.stale) return errorResponse(409, "snapshot_outdated");
      return json({ seq }, 201);
    }
    if (method === "GET") {
      const ref = await vaults.latestSnapshot(vaultId, token);
      if (!ref.ok) return errorResponse(ref.status, ref.error);
      const file = snapshots.open(vaultId, ref.file);
      if (!file) return errorResponse(404, "no_snapshot");
      return new Response(file.stream, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(file.size),
          "cache-control": "no-store",
          "moony-snapshot-seq": String(ref.seq),
        },
      });
    }
  }

  if (sub === "/token" && method === "POST") {
    const allowed = vaults.check(vaultId, token, "owner");
    if (!allowed.ok) return errorResponse(allowed.status, allowed.error);
    const body = await readJson(request, MAX_ROTATE_BODY_BYTES, budget);
    if ("error" in body) return errorResponse(body.status, body.error);
    const { token: next, rekey } = (body.value ?? {}) as { token?: unknown; rekey?: unknown };
    if (!isVaultToken(next)) return errorResponse(400, "invalid_token");
    if (typeof rekey !== "string" || rekey.length === 0) return errorResponse(400, "invalid_rekey");
    // Size first, from the string alone: nothing oversized gets decoded.
    if (rekey.length % 4 !== 0) return errorResponse(400, "invalid_rekey");
    if (base64DecodedLength(rekey) > MAX_REKEY_BYTES) return errorResponse(413, "rekey_too_large");
    const bytes = decodeBase64(rekey);
    if (!bytes || bytes.length === 0) return errorResponse(400, "invalid_rekey");
    return fromResult(await vaults.rotateToken(vaultId, token, next, bytes));
  }

  if (sub === "/rekey" && method === "GET") {
    const limit = Math.min(intParam(url, "limit") ?? DEFAULT_REKEY_LIMIT, MAX_REKEY_LIMIT);
    if (limit < 1) return errorResponse(400, "invalid_limit");
    return fromResult(await vaults.rekeys(vaultId, token, intParam(url, "after") ?? 0, limit));
  }

  return errorResponse(405, "method_not_allowed");
}

function accountOf(request: Request): string | null {
  const a = request.headers.get("moony-account");
  return isAccountNumber(a) ? a : null;
}

/** Nothing is stored for an ID until a valid first PUT, and IDs are never logged. */
async function pairingRoute(
  request: Request,
  stores: Stores,
  limiters: Limiters,
  budget: BodyBudget,
  caller: string,
): Promise<Response> {
  const match = PAIRING_PATH.exec(new URL(request.url).pathname);
  if (!match) return errorResponse(404, "not_found");
  const [, mailboxId, slotText] = match as unknown as [string, string, string | undefined];
  if (!isMailboxId(mailboxId)) return errorResponse(400, "bad_mailbox");
  if (slotText !== undefined && slotText !== "1" && slotText !== "2" && slotText !== "3") {
    return errorResponse(400, "bad_slot");
  }
  // Only well-formed requests count: junk paths cost nothing to answer and cannot use up the
  // quota of the pairing a real client is in the middle of.
  if (limiters.pairing.hit(caller)) return errorResponse(429, "rate_limited");
  const { mailboxes } = stores;
  const method = request.method;

  if (slotText === undefined) {
    if (method !== "DELETE") return errorResponse(405, "method_not_allowed");
    mailboxes.burn(mailboxId);
    return new Response(null, { status: 204 });
  }
  const slot = Number(slotText) as 1 | 2 | 3;

  if (method === "PUT") {
    const read = await readBody(request, MAX_MAILBOX_SLOT_BYTES, budget);
    if ("error" in read) return errorResponse(read.status, read.error);
    const body = read.bytes;
    if (body.byteLength === 0) return errorResponse(400, "empty_body");
    const r = mailboxes.put(mailboxId, slot, body);
    return r.ok ? new Response(null, { status: 204 }) : errorResponse(r.status, r.error);
  }
  if (method === "GET") {
    const r = mailboxes.take(mailboxId, slot);
    if (!r.ok) return errorResponse(r.status, r.error);
    return new Response(new Uint8Array(r.data), {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(r.data.byteLength),
        "cache-control": "no-store",
      },
    });
  }
  return errorResponse(405, "method_not_allowed");
}
