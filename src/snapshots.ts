// Snapshot files: <dataDir>/snapshots/<vaultId>/<seq>-<uuid>. An upload streams to a
// ".tmp" name, is fsynced, then renamed, so a crash never leaves a half file under a real name.

import { randomUUID } from "node:crypto";
import {
  createReadStream,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { isVaultId } from "./encoding.js";
import { listVaultDirs, openRead, syncDir, writeNewFile } from "./files.js";

export { BodyStreamError as SnapshotBodyError } from "./files.js";

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
      const size = await writeNewFile(tmp, body, maxBytes);
      if (size === "too_large") return "too_large";
      try {
        renameSync(tmp, join(dir, file));
        try {
          syncDir(dir);
        } catch (e) {
          // The rename may not survive a crash: do not leave a real file nobody has a record of.
          rmSync(join(dir, file), { force: true });
          throw e;
        }
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
      return { file, size };
    },

    open(vaultId, file) {
      if (!isVaultId(vaultId) || !FILE_RE.test(file)) return null;
      return openRead(join(dirOf(vaultId), file), "snapshot_read_failed");
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
      return listVaultDirs(root);
    },
  };
}
