// The database holds the admin's second-factor secret in clear: only the server's user may read
// it, its -wal and -shm files, and the temporary copy a backup takes.

import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackupStream } from "../src/admin/backup.js";
import { openDb } from "../src/db.js";
import { testApp } from "./helpers.js";

const mode = (path: string): number => statSync(path).mode & 0o777;
const posix = process.platform !== "win32";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "moony-perm-"));
  dirs.push(d);
  return d;
};

describe.runIf(posix)("data folder permissions", () => {
  it("a new data folder is 0700 and the database, -wal and -shm files are 0600", () => {
    const dataDir = join(tempDir(), "data");
    const db = openDb(dataDir);
    db.prepare("INSERT INTO settings (key, value) VALUES ('probe', 'x')").run();
    expect(mode(dataDir)).toBe(0o700);
    for (const name of ["moony-sync.db", "moony-sync.db-wal", "moony-sync.db-shm"]) {
      expect([name, mode(join(dataDir, name))]).toEqual([name, 0o600]);
    }
    db.close();
  });

  it("an existing world-readable database is made 0600 at start", () => {
    const dataDir = tempDir();
    openDb(dataDir).close();
    const file = join(dataDir, "moony-sync.db");
    chmodSync(file, 0o644);
    openDb(dataDir).close();
    expect(mode(file)).toBe(0o600);
  });

  it("the backup's temporary database copy is 0600", async () => {
    const t = testApp();
    const stream = await createBackupStream({
      db: t.db,
      dataDir: t.dataDir,
      snapshots: t.stores.snapshots,
      blobFiles: t.stores.blobFiles,
      now: t.clock.now,
    });
    const tmp = readdirSync(t.dataDir).filter((n) => n.startsWith(".backup-"));
    expect(tmp).toHaveLength(1);
    expect(mode(join(t.dataDir, tmp[0]!))).toBe(0o600);
    await stream.cancel();
  });

  it("leaves an existing data folder's own mode alone", () => {
    const dataDir = tempDir();
    chmodSync(dataDir, 0o750);
    writeFileSync(join(dataDir, "unrelated"), "");
    openDb(dataDir).close();
    expect(mode(dataDir)).toBe(0o750);
  });
});
