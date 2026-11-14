// File helpers shared by the snapshot and blob stores.

import { closeSync, existsSync, fsyncSync, openSync, readdirSync, statSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { isVaultId } from "./encoding.js";

/** Makes a rename durable. Not every platform can fsync a directory; that is not an error. */
export function syncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EISDIR" && code !== "EPERM" && code !== "EINVAL" && code !== "EACCES") throw e;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The request body stream failed or ended early: a client problem, not a disk problem. */
export class BodyStreamError extends Error {
  constructor(cause?: unknown) {
    super("body_stream_error", { cause });
  }
}

/** The request body delivered no bytes for too long. */
export class BodyIdleError extends Error {
  constructor() {
    super("body_idle");
  }
}

/** Writes `body` to `handle`. Returns the bytes written, or "too_large" once it passes
 *  `maxBytes` (the reader is cancelled). Does not sync, close or remove anything. */
export async function streamToFile(
  handle: FileHandle,
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  idleMs?: number,
): Promise<number | "too_large"> {
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    let timer: NodeJS.Timeout | undefined;
    try {
      const read = reader.read();
      if (idleMs === undefined) {
        chunk = await read;
      } else {
        const idle = new Promise<"idle">((resolve) => {
          timer = setTimeout(() => resolve("idle"), idleMs);
        });
        const r = await Promise.race([read, idle]);
        if (r === "idle") {
          read.catch(() => undefined);
          await reader.cancel().catch(() => undefined);
          throw new BodyIdleError();
        }
        chunk = r;
      }
    } catch (e) {
      if (e instanceof BodyIdleError) throw e;
      throw new BodyStreamError(e); // the client side of the stream failed
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (chunk.done) return size;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    await handle.write(chunk.value);
  }
}

/** Vault IDs that have a directory under `root`, with the newest mtime inside it (or of the
 *  directory itself), in unix seconds. */
export function listVaultDirs(root: string): { vaultId: string; mtime: number }[] {
  if (!existsSync(root)) return [];
  const mtimeOf = (path: string): number => Math.floor(statSync(path).mtimeMs / 1000);
  const out: { vaultId: string; mtime: number }[] = [];
  for (const vaultId of readdirSync(root)) {
    if (!isVaultId(vaultId)) continue;
    const dir = join(root, vaultId);
    let newest: number;
    let names: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      newest = mtimeOf(dir);
      names = readdirSync(dir);
    } catch {
      continue; // not a directory, or vanished meanwhile
    }
    for (const f of names) {
      try {
        newest = Math.max(newest, mtimeOf(join(dir, f)));
      } catch {
        /* vanished meanwhile */
      }
    }
    out.push({ vaultId, mtime: newest });
  }
  return out;
}
