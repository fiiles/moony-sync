// The blob routes of a vault: /v1/vaults/:vaultId/blobs[/:blobId]. The caller (sync-api) has
// already validated the IDs, applied the limiters and parsed the bearer token. Blob bodies stream
// to and from disk, never through the buffered-body budget.

import { hasRoom } from "./disk.js";
import { BodyIdleError, BodyStreamError } from "./files.js";
import { errorResponse, json } from "./http.js";
import {
  DEFAULT_BLOB_LIST_LIMIT,
  IDLE_BODY_SECONDS,
  MAX_BLOB_BYTES,
  MAX_BLOB_LIST_LIMIT,
  MAX_BLOB_UPLOADS_PER_VAULT,
} from "./limits.js";
import { isBlobId } from "./encoding.js";
import { intParam, type RouteDeps } from "./sync-api.js";

/** An error answer of a blob route: the usual JSON body plus the code in a header, so a client
 *  that only sees the head of a response (HEAD) can still tell what went wrong. */
export function blobError(status: number, code: string): Response {
  const res = errorResponse(status, code);
  res.headers.set("moony-error", code);
  return res;
}

/** Counts the blob uploads of each vault that are in flight. */
export interface UploadGate {
  /** A release function, or null when the vault already has its share running. */
  tryEnter(vaultId: string): (() => void) | null;
}

export function createUploadGate(perVault: number = MAX_BLOB_UPLOADS_PER_VAULT): UploadGate {
  const running = new Map<string, number>();
  return {
    tryEnter(vaultId) {
      const n = running.get(vaultId) ?? 0;
      if (n >= perVault) return null;
      running.set(vaultId, n + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (running.get(vaultId) ?? 1) - 1;
        if (left <= 0) running.delete(vaultId);
        else running.set(vaultId, left);
      };
    },
  };
}

export async function blobRoute(
  rd: RouteDeps,
  request: Request,
  url: URL,
  vaultId: string,
  blobId: string | null,
  token: string,
): Promise<Response> {
  const { blobs, blobFiles: files } = rd.stores;
  const method = request.method;

  if (blobId === null) {
    if (method !== "GET") return blobError(405, "method_not_allowed");
    const after = url.searchParams.get("after");
    if (after !== null && !isBlobId(after)) return blobError(400, "invalid_blob_id");
    const limit = Math.min(intParam(url, "limit") ?? DEFAULT_BLOB_LIST_LIMIT, MAX_BLOB_LIST_LIMIT);
    if (limit < 1) return blobError(400, "invalid_limit");
    const r = blobs.list(vaultId, token, after, limit);
    if (!r.ok) return blobError(r.status, r.error);
    // `now` is the server's clock: a device measures a blob's age (now - createdAt) on it.
    return json({ blobs: r.blobs, more: r.more, now: rd.clock() });
  }

  if (method === "PUT") {
    // The token and the entitlement are judged before a body byte is read; an existing blob
    // answers without reading the body at all.
    const known = blobs.check(vaultId, token, blobId);
    if (!known.ok) return blobError(known.status, known.error);
    if (known.exists) return created(false, 200);

    // Digits only: Number() would also take "1e3" or "0x10".
    const declared = request.headers.get("content-length") ?? "";
    const length = /^[0-9]+$/.test(declared) ? Number(declared) : NaN;
    if (!Number.isSafeInteger(length) || length <= 0) return blobError(411, "length_required");
    if (length > MAX_BLOB_BYTES) return blobError(413, "blob_too_large");
    if (!blobs.fits(vaultId, length)) return blobError(413, "quota_exceeded");
    if (!request.body) return blobError(400, "empty_body");

    if (!hasRoom(await rd.freeBytes(), length)) return blobError(507, "server_full");

    const release = rd.uploads.tryEnter(vaultId);
    if (!release) return blobError(429, "too_many_uploads");
    try {
      return await receive(rd, request, vaultId, blobId, token, length);
    } finally {
      release();
    }
  }

  // HEAD first: Hono dispatches it as GET and drops the body, so it must not open a file.
  if (method === "HEAD") {
    const found = blobs.find(vaultId, token, blobId);
    if (!found.ok) return blobError(found.status, found.error);
    const size = files.size(vaultId, blobId);
    if (size === null) return blobError(404, "blob_not_found");
    return new Response(null, { headers: contentHeaders(size) });
  }

  if (method === "GET") {
    const found = blobs.find(vaultId, token, blobId);
    if (!found.ok) return blobError(found.status, found.error);
    const file = files.open(vaultId, blobId);
    if (!file) return blobError(404, "blob_not_found");
    return new Response(file.stream, { headers: contentHeaders(file.size) });
  }

  if (method === "DELETE") {
    const r = blobs.remove(vaultId, token, blobId);
    if (!r.ok) return blobError(r.status, r.error);
    return new Response(null, { status: 204 });
  }

  return blobError(405, "method_not_allowed");
}

/** Steps 6-7 of an upload: stream the body to a temporary file, then commit it. */
async function receive(
  rd: RouteDeps,
  request: Request,
  vaultId: string,
  blobId: string,
  token: string,
  length: number,
): Promise<Response> {
  const { blobs, blobFiles: files } = rd.stores;
  let written;
  try {
    // The declared length is also the cap: a body that runs past it is refused as it streams.
    written = await files.writeTemp(vaultId, blobId, request.body!, length, IDLE_BODY_SECONDS * 1000);
  } catch (e) {
    if (e instanceof BodyStreamError) return blobError(400, "incomplete_body");
    if (e instanceof BodyIdleError) return blobError(408, "body_timeout");
    // The vault was deleted while the body was streaming: its directory is gone.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return blobError(404, "vault_not_found");
    throw e; // disk errors: 500 internal_error via the app's error handler
  }
  if (written === "too_large") return blobError(413, "blob_too_large");
  const { tmp, size } = written;
  try {
    if (size !== length) return blobError(400, "incomplete_body");
    const r = blobs.commit(vaultId, token, blobId, size, () => files.publish(vaultId, blobId, tmp));
    if (!r.ok) return blobError(r.status, r.error);
    return r.created ? created(true, 201) : created(false, 200);
  } finally {
    files.discard(vaultId, tmp); // a no-op after a publish
  }
}

const created = (value: boolean, status: number): Response => json({ created: value }, status);

function contentHeaders(size: number): Record<string, string> {
  return {
    "content-type": "application/octet-stream",
    "content-length": String(size),
    "cache-control": "no-store",
    "moony-blob-size": String(size),
  };
}
