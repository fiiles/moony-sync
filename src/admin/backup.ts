// The backup download: a ustar archive of the SQLite database (an online-backup copy, so it is
// consistent while the server runs) and the snapshot and blob files. Built here, no shelling
// out; the files are streamed from disk, never held in memory.

import { randomUUID } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { BlobFiles } from "../blob-files.js";
import type { Db } from "../db.js";
import type { Snapshots } from "../snapshots.js";

const BLOCK = 512;
const CHUNK = 64 * 1024;
const TAR_OWNER = 1000;

/** 11 octal digits: the largest size a ustar header can hold. */
export const MAX_TAR_ENTRY_BYTES = 8 * 1024 ** 3 - 1;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

/** One ustar header block. Names are short ASCII (checked), so no prefix field is needed. */
export function tarHeader(name: string, size: number, mtime: number, kind: "file" | "dir" = "file"): Buffer {
  if (name.length > 100 || !/^[\x20-\x7e]+$/.test(name)) throw new Error("tar_name");
  if (size > MAX_TAR_ENTRY_BYTES) throw new Error("tar_entry_too_large"); // never a corrupt header
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, "latin1");
  // Owned by uid/gid 1000 (the container's `node` user), so extracting as root still yields
  // files the server can use.
  h.write(octal(kind === "dir" ? 0o700 : 0o600, 8), 100, "latin1");
  h.write(octal(TAR_OWNER, 8), 108, "latin1");
  h.write(octal(TAR_OWNER, 8), 116, "latin1");
  h.write(octal(size, 12), 124, "latin1");
  h.write(octal(mtime, 12), 136, "latin1");
  h.write("        ", 148, "latin1"); // the checksum counts these as spaces
  h.write(kind === "dir" ? "5" : "0", 156, "latin1");
  h.write("ustar\0", 257, "latin1");
  h.write("00", 263, "latin1");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return h;
}

const padding = (size: number): Buffer => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** `files` are read lazily; a file that vanished since the listing (housekeeping) is skipped. */
async function* entries(
  dirs: string[],
  files: { name: string; path: string }[],
  mtime: number,
): AsyncGenerator<Buffer> {
  for (const d of dirs) yield tarHeader(d, 0, mtime, "dir");
  for (const f of files) {
    let handle;
    try {
      handle = await open(f.path, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("backup_read_failed"); // the original error names a path
    }
    try {
      const size = (await handle.stat()).size;
      yield tarHeader(f.name, size, mtime);
      // Files are immutable once named, but never write past the size the header promised.
      let left = size;
      while (left > 0) {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, left));
        const { bytesRead } = await handle.read(buf, 0, buf.length, size - left);
        if (bytesRead === 0) throw new Error("file_shrank");
        yield buf.subarray(0, bytesRead);
        left -= bytesRead;
      }
      yield padding(size);
    } finally {
      await handle.close();
    }
  }
  yield Buffer.alloc(2 * BLOCK);
}

/** Takes the database copy, then streams the archive. The temporary copy (inside `dataDir`) is
 *  removed when the stream ends, fails or is cancelled, and at once if the copy itself fails. */
export async function createBackupStream(opts: {
  db: Db;
  dataDir: string;
  snapshots: Snapshots;
  blobFiles: BlobFiles;
  now: number;
}): Promise<ReadableStream<Uint8Array>> {
  const tmp = join(opts.dataDir, `.backup-${randomUUID()}.tmp`);
  try {
    await opts.db.backup(tmp);
    // Listed after the copy: every snapshot the copied database refers to still exists, unless
    // housekeeping removed it in the meantime.
    const files = [{ name: "moony-sync.db", path: tmp }];
    const dirs = ["snapshots/"];
    for (const { vaultId } of opts.snapshots.listVaultDirs()) {
      dirs.push(`snapshots/${vaultId}/`);
      for (const { file } of opts.snapshots.listFiles(vaultId)) {
        files.push({ name: `snapshots/${vaultId}/${file}`, path: join(opts.dataDir, "snapshots", vaultId, file) });
      }
    }
    dirs.push("blobs/");
    for (const { vaultId } of opts.blobFiles.listVaultDirs()) {
      dirs.push(`blobs/${vaultId}/`);
      for (const { blobId } of opts.blobFiles.listFiles(vaultId)) {
        files.push({ name: `blobs/${vaultId}/${blobId}`, path: join(opts.dataDir, "blobs", vaultId, blobId) });
      }
    }
    const gen = entries(dirs, files, opts.now);
    const readable = Readable.from(
      (async function* () {
        try {
          yield* gen;
        } finally {
          await rm(tmp, { force: true });
        }
      })(),
      { objectMode: false },
    );
    // A stream cancelled before its first read never enters the generator's `finally`.
    readable.once("close", () => void rm(tmp, { force: true }).catch(() => undefined));
    return Readable.toWeb(readable) as ReadableStream<Uint8Array>;
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** What the archive will roughly weigh: the database files, a header and padded content per
 *  snapshot and blob record, a header per directory, the end blocks. An estimate: the database
 *  copy differs from the files on disk. */
export function estimateBackupBytes(db: Db, dataDir: string): number {
  const onDisk = (name: string): number => {
    try {
      return statSync(join(dataDir, name)).size;
    } catch {
      return 0;
    }
  };
  const entry = (size: number): number => BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  let total = onDisk("moony-sync.db") + onDisk("moony-sync.db-wal") + BLOCK;
  const vaultDirs = new Set<string>();
  for (const table of ["snapshots", "blobs"]) {
    const rows = db.prepare(`SELECT vault_id, size FROM ${table}`).all() as { vault_id: string; size: number }[];
    for (const r of rows) {
      total += entry(r.size);
      vaultDirs.add(`${table}/${r.vault_id}`);
    }
  }
  return total + BLOCK * (2 + vaultDirs.size) + 2 * BLOCK;
}

/** Removes database copies a crash left behind (a download that never finished); run at start,
 *  when no download can be in flight. */
export function sweepBackupTemp(dataDir: string): void {
  for (const name of readdirSync(dataDir)) {
    if (/^\.backup-.*\.tmp$/.test(name)) rmSync(join(dataDir, name), { force: true });
  }
}

/** moony-sync-backup-<YYYYMMDD-HHmm>.tar, UTC. */
export function backupFileName(nowSeconds: number): string {
  const d = new Date(nowSeconds * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `moony-sync-backup-${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}.tar`;
}
