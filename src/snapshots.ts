// Snapshot files: <dataDir>/snapshots/<vaultId>/<seq>-<uuid>. An upload streams to a
// ".tmp" name, is fsynced, then renamed, so a crash never leaves a half file under a real name.

import { randomUUID } from "node:crypto";
import {
  createReadStream,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { isVaultId } from "./encoding.js";

export interface Snapshots {
  /** Streams `body` to a new file of the vault. "too_large" when it passes `maxBytes` (nothing
   *  is left behind); a body that errors out throws, also leaving nothing behind. */
  write(
    vaultId: string,
    seq: number,
    body: ReadableStream<Uint8Array>,
    maxBytes: number,
  ): Promise<{ file: string; size: number } | "too_large">;
  /** null when the vault ID or file name is malformed or the file does not exist. */
  open(vaultId: string, file: string): { stream: ReadableStream<Uint8Array>; size: number } | null;
  remove(vaultId: string, file: string): void;
  removeVault(vaultId: string): void;
  /** Deletes every unfinished upload (".tmp"); run once at start. */
  sweepTemp(): void;
  /** Real (non-temporary) files of the vault; mtime in unix seconds. */
  listFiles(vaultId: string): { file: string; mtime: number }[];
  /** Vault IDs that have a directory, with the newest mtime inside it (or of the directory). */
  listVaultDirs(): { vaultId: string; mtime: number }[];
}

/** The request body stream failed or ended early: a client problem, not a disk problem. */
export class SnapshotBodyError extends Error {
  constructor(cause?: unknown) {
    super("snapshot_body_error", { cause });
  }
}

/** Makes a rename durable. Not every platform can fsync a directory; that is not an error. */
function syncDir(dir: string): void {
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

const FILE_RE = /^[0-9]{1,15}-[0-9a-f-]{36}$/;
const TMP_SUFFIX = ".tmp";

export function createSnapshots(root: string): Snapshots {
  const dirOf = (vaultId: string): string => join(root, vaultId);
  const mtimeOf = (path: string): number => Math.floor(statSync(path).mtimeMs / 1000);

  function realFiles(vaultId: string): string[] {
    if (!isVaultId(vaultId)) return [];
    try {
      return readdirSync(dirOf(vaultId)).filter((f) => FILE_RE.test(f));
    } catch {
      return [];
    }
  }

  return {
    async write(vaultId, seq, body, maxBytes) {
      if (!isVaultId(vaultId)) throw new Error("invalid_vault_id");
      const dir = dirOf(vaultId);
      mkdirSync(dir, { recursive: true });
      const file = `${seq}-${randomUUID()}`;
      const tmp = join(dir, file + TMP_SUFFIX);
      let handle: FileHandle | undefined;
      try {
        handle = await open(tmp, "wx", 0o600);
        let size = 0;
        const reader = body.getReader();
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch (e) {
            throw new SnapshotBodyError(e); // the client side of the stream failed
          }
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBytes) {
            await reader.cancel().catch(() => undefined);
            await handle.close().catch(() => undefined);
            handle = undefined;
            await rm(tmp, { force: true });
            return "too_large";
          }
          await handle.write(chunk.value);
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        renameSync(tmp, join(dir, file));
        try {
          syncDir(dir);
        } catch (e) {
          // The rename may not survive a crash: do not leave a real file nobody has a record of.
          rmSync(join(dir, file), { force: true });
          throw e;
        }
        return { file, size };
      } catch (e) {
        await handle?.close().catch(() => undefined);
        await rm(tmp, { force: true });
        throw e;
      }
    },

    open(vaultId, file) {
      if (!isVaultId(vaultId) || !FILE_RE.test(file)) return null;
      // One open file: the size and the bytes come from the same descriptor, so a vault deleted
      // meanwhile cannot turn the read into an error that names the path.
      let fd: number;
      let size: number;
      try {
        fd = openSync(join(dirOf(vaultId), file), "r");
      } catch {
        return null;
      }
      try {
        size = fstatSync(fd).size;
      } catch {
        closeSync(fd);
        return null;
      }
      const source = createReadStream("", { fd, autoClose: true });
      const out = new PassThrough();
      source.on("error", () => out.destroy(new Error("snapshot_read_failed")));
      out.on("close", () => source.destroy());
      source.pipe(out);
      return { stream: Readable.toWeb(out) as ReadableStream<Uint8Array>, size };
    },

    remove(vaultId, file) {
      if (!isVaultId(vaultId) || !FILE_RE.test(file)) return;
      rmSync(join(dirOf(vaultId), file), { force: true });
    },

    removeVault(vaultId) {
      if (!isVaultId(vaultId)) return;
      rmSync(dirOf(vaultId), { recursive: true, force: true });
    },

    sweepTemp() {
      if (!existsSync(root)) return;
      for (const vaultId of readdirSync(root)) {
        let names: string[];
        try {
          names = readdirSync(join(root, vaultId));
        } catch {
          continue;
        }
        for (const name of names) {
          if (name.endsWith(TMP_SUFFIX)) rmSync(join(root, vaultId, name), { force: true });
        }
      }
    },

    listFiles(vaultId) {
      return realFiles(vaultId).map((file) => ({ file, mtime: mtimeOf(join(dirOf(vaultId), file)) }));
    },

    listVaultDirs() {
      if (!existsSync(root)) return [];
      const out: { vaultId: string; mtime: number }[] = [];
      for (const vaultId of readdirSync(root)) {
        if (!isVaultId(vaultId)) continue;
        let newest: number;
        let names: string[];
        try {
          if (!statSync(dirOf(vaultId)).isDirectory()) continue;
          newest = mtimeOf(dirOf(vaultId));
          names = readdirSync(dirOf(vaultId));
        } catch {
          continue; // not a directory, or vanished meanwhile
        }
        for (const f of names) {
          try {
            newest = Math.max(newest, mtimeOf(join(dirOf(vaultId), f)));
          } catch {
            /* vanished meanwhile */
          }
        }
        out.push({ vaultId, mtime: newest });
      }
      return out;
    },
  };
}
