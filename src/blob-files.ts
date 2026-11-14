// Blob files: <dataDir>/blobs/<vaultId>/<blobId>. An upload streams to a temporary name, is
// fsynced, then renamed, so a crash never leaves a half file under a real name. Every method
// validates its IDs before it touches the file system.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
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
import { isBlobId, isVaultId } from "./encoding.js";
import { listVaultDirs, streamToFile, syncDir } from "./files.js";

export interface BlobFiles {
  /** Streams `body` to "<blobId>.<random uuid>.tmp" (mode 0600, created with "wx") in the vault's
   *  directory (created if missing), fsyncs and closes it. The temp stays for publish/discard.
   *  "too_large" past maxBytes; BodyStreamError / BodyIdleError / disk errors are rethrown.
   *  In every non-success case the temp is removed. */
  writeTemp(
    vaultId: string,
    blobId: string,
    body: ReadableStream<Uint8Array>,
    maxBytes: number,
    idleMs?: number,
  ): Promise<{ tmp: string; size: number } | "too_large">;
  /** Synchronous: renames the temp to <blobId> (replacing nothing: callers publish only when no
   *  record exists) and syncDir()s; if syncDir throws, removes <blobId> and rethrows. */
  publish(vaultId: string, blobId: string, tmp: string): void;
  /** Removes a temp from writeTemp; no-op when it is gone or the name is not a temp name. */
  discard(vaultId: string, tmp: string): void;
  /** null when an ID is malformed or the file is missing; size and stream from one descriptor. */
  open(vaultId: string, blobId: string): { stream: ReadableStream<Uint8Array>; size: number } | null;
  /** Size on disk, null when missing or an ID is malformed. */
  size(vaultId: string, blobId: string): number | null;
  remove(vaultId: string, blobId: string): void;
  removeVault(vaultId: string): void;
  /** Deletes every "*.tmp" under the root; run once at start. */
  sweepTemp(): void;
  /** Files of the vault whose name isBlobId (temps and other names are ignored); mtime unix s. */
  listFiles(vaultId: string): { blobId: string; mtime: number }[];
  listVaultDirs(): { vaultId: string; mtime: number }[];
}

const TMP_RE = /^[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp$/;
const TMP_SUFFIX = ".tmp";

export function createBlobFiles(root: string): BlobFiles {
  const dirOf = (vaultId: string): string => join(root, vaultId);

  return {
    async writeTemp(vaultId, blobId, body, maxBytes, idleMs) {
      if (!isVaultId(vaultId) || !isBlobId(blobId)) throw new Error("invalid_id");
      const dir = dirOf(vaultId);
      mkdirSync(dir, { recursive: true });
      const tmpName = `${blobId}.${randomUUID()}${TMP_SUFFIX}`;
      const tmp = join(dir, tmpName);
      let handle: FileHandle | undefined;
      try {
        handle = await open(tmp, "wx", 0o600);
        const size = await streamToFile(handle, body, maxBytes, idleMs);
        if (size === "too_large") {
          await handle.close().catch(() => undefined);
          handle = undefined;
          await rm(tmp, { force: true });
          return "too_large";
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        return { tmp: tmpName, size };
      } catch (e) {
        await handle?.close().catch(() => undefined);
        await rm(tmp, { force: true });
        throw e;
      }
    },

    publish(vaultId, blobId, tmp) {
      if (!isVaultId(vaultId) || !isBlobId(blobId) || !TMP_RE.test(tmp)) throw new Error("invalid_id");
      const dir = dirOf(vaultId);
      renameSync(join(dir, tmp), join(dir, blobId));
      try {
        syncDir(dir);
      } catch (e) {
        // The rename may not survive a crash: do not leave a real file nobody has a record of.
        rmSync(join(dir, blobId), { force: true });
        throw e;
      }
    },

    discard(vaultId, tmp) {
      if (!isVaultId(vaultId) || !TMP_RE.test(tmp)) return;
      rmSync(join(dirOf(vaultId), tmp), { force: true });
    },

    open(vaultId, blobId) {
      if (!isVaultId(vaultId) || !isBlobId(blobId)) return null;
      // One open file: the size and the bytes come from the same descriptor, so a vault deleted
      // meanwhile cannot turn the read into an error that names the path.
      let fd: number;
      let size: number;
      try {
        fd = openSync(join(dirOf(vaultId), blobId), "r");
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
      source.on("error", () => out.destroy(new Error("blob_read_failed")));
      out.on("close", () => source.destroy());
      source.pipe(out);
      return { stream: Readable.toWeb(out) as ReadableStream<Uint8Array>, size };
    },

    size(vaultId, blobId) {
      if (!isVaultId(vaultId) || !isBlobId(blobId)) return null;
      try {
        return statSync(join(dirOf(vaultId), blobId)).size;
      } catch {
        return null;
      }
    },

    remove(vaultId, blobId) {
      if (!isVaultId(vaultId) || !isBlobId(blobId)) return;
      rmSync(join(dirOf(vaultId), blobId), { force: true });
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
      if (!isVaultId(vaultId)) return [];
      let names: string[];
      try {
        names = readdirSync(dirOf(vaultId));
      } catch {
        return [];
      }
      const out: { blobId: string; mtime: number }[] = [];
      for (const blobId of names) {
        if (!isBlobId(blobId)) continue;
        try {
          out.push({ blobId, mtime: Math.floor(statSync(join(dirOf(vaultId), blobId)).mtimeMs / 1000) });
        } catch {
          /* vanished meanwhile */
        }
      }
      return out;
    },

    listVaultDirs() {
      return listVaultDirs(root);
    },
  };
}
