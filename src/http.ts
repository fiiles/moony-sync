import { IDLE_BODY_SECONDS, MAX_INFLIGHT_BODY_CLIENT_BYTES } from "./limits.js";

// Response helpers and the `Result` type service functions return; routes map it to HTTP.

export type Failure = { ok: false; status: number; error: string };
export type Result<T = unknown> = ({ ok: true } & T) | Failure;

export const fail = (status: number, error: string): Failure => ({ ok: false, status, error });

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export const errorResponse = (status: number, error: string): Response =>
  json({ error }, status);

export function fromResult(r: Failure | ({ ok: true } & object), status = 200): Response {
  if (!r.ok) return errorResponse(r.status, r.error);
  const { ok: _ok, ...rest } = r as Record<string, unknown>;
  return json(rest, status);
}

/** How many request bytes may be buffered in memory at once across the sync and admin APIs.
 *  A body reserves bytes as they ARRIVE (never what it merely declares), so a connection that
 *  sends headers and then nothing holds nothing. Snapshot uploads stream to disk and do not use
 *  it. */
export interface BodyBudget {
  /** False when `bytes` more would pass the global limit or the client's share (nothing is
   *  reserved then). `client` is the limiters' client key. */
  tryReserve(client: string, bytes: number): boolean;
  release(client: string, bytes: number): void;
}

/** A budget and the client a body is charged to; every capped read needs one. */
export interface BodyShare {
  budget: BodyBudget;
  client: string;
}

export function createBodyBudget(limit: number, perClient: number = MAX_INFLIGHT_BODY_CLIENT_BYTES): BodyBudget {
  let used = 0;
  const byClient = new Map<string, number>();
  return {
    tryReserve(client, bytes) {
      const mine = byClient.get(client) ?? 0;
      if (used + bytes > limit || mine + bytes > perClient) return false;
      used += bytes;
      byClient.set(client, mine + bytes);
      return true;
    },
    release(client, bytes) {
      used = Math.max(0, used - bytes);
      const left = (byClient.get(client) ?? 0) - bytes;
      if (left > 0) byClient.set(client, left);
      else byClient.delete(client);
    },
  };
}

export type BodyResult = { bytes: Uint8Array } | { error: string; status: number };

/** Reads a request body, stopping as soon as it passes `maxBytes` (a missing or lying
 *  Content-Length must not let a client make the server buffer an unbounded body). Each chunk is
 *  reserved from `budget` as it arrives (503 busy when it does not fit) and everything is given
 *  back when the read ends. A body that delivers nothing for `idleMs` is aborted: 408. */
export async function readBody(
  request: Request,
  maxBytes: number,
  share: BodyShare,
  idleMs: number = IDLE_BODY_SECONDS * 1000,
): Promise<BodyResult> {
  const tooLarge = { error: "body_too_large", status: 413 };
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;
  if (!request.body) return { bytes: new Uint8Array() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reserved = 0;
  const next = (): Promise<ReadableStreamReadResult<Uint8Array> | "idle"> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve("idle"), idleMs);
      reader.read().then(
        (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  try {
    for (;;) {
      const r = await next();
      if (r === "idle") {
        void reader.cancel().catch(() => undefined);
        return { error: "body_timeout", status: 408 };
      }
      if (r.done) break;
      total += r.value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return tooLarge;
      }
      if (!share.budget.tryReserve(share.client, r.value.byteLength)) {
        void reader.cancel().catch(() => undefined);
        return { error: "busy", status: 503 };
      }
      reserved += r.value.byteLength;
      chunks.push(r.value);
    }
  } finally {
    if (reserved > 0) share.budget.release(share.client, reserved);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: out };
}

/** Reads a JSON body with a hard size cap. */
export async function readJson(
  request: Request,
  maxBytes: number,
  share: BodyShare,
  idleMs?: number,
): Promise<{ value: unknown } | { error: string; status: number }> {
  const r = await readBody(request, maxBytes, share, idleMs);
  if ("error" in r) return r;
  try {
    return { value: JSON.parse(new TextDecoder().decode(r.bytes)) };
  } catch {
    return { error: "invalid_json", status: 400 };
  }
}
