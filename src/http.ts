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

/** Reads a request body, stopping as soon as it passes `maxBytes` (a missing or lying
 *  Content-Length must not let a client make the server buffer an unbounded body). */
export async function readBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Reads a JSON body with a hard size cap. */
export async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ value: unknown } | { error: string; status: number }> {
  const bytes = await readBody(request, maxBytes);
  if (!bytes) return { error: "body_too_large", status: 413 };
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { error: "invalid_json", status: 400 };
  }
}

/** How many request bytes may be buffered in memory at once across the sync and admin APIs.
 *  Each body reserves what it may still grow to (its declared length, capped by the route's
 *  limit) until it has been read. Snapshot uploads stream to disk and do not use it. */
export interface BodyBudget {
  /** The release function, or null when the budget is used up. */
  acquire(bytes: number): (() => void) | null;
}

export function createBodyBudget(limit: number): BodyBudget {
  let used = 0;
  return {
    acquire(bytes) {
      if (used + bytes > limit) return null;
      used += bytes;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          used -= bytes;
        }
      };
    },
  };
}

/** Runs `read` with the budget reserved for this request's body; null when the budget is full
 *  (the result is wrapped so a read that itself yields null stays distinguishable). */
export async function withBodyBudget<T>(
  budget: BodyBudget,
  request: Request,
  maxBytes: number,
  read: () => Promise<T>,
): Promise<{ value: T } | null> {
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  const reserve = Number.isFinite(declared) && declared >= 0 ? Math.min(declared, maxBytes) : maxBytes;
  const release = budget.acquire(reserve);
  if (!release) return null;
  try {
    return { value: await read() };
  } finally {
    release();
  }
}

export const busy = (): Response => errorResponse(503, "busy");
