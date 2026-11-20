import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, openDb } from "../src/db.js";
import { startOrExit } from "../src/start.js";

class Exit extends Error {}
const failing = (lines: string[]) => (line: string): never => {
  lines.push(line);
  throw new Exit();
};

describe("startOrExit", () => {
  it("a configuration error is one line, no stack", () => {
    const lines: string[] = [];
    expect(() => startOrExit({ TRUST_PROXY: "maybe" }, failing(lines))).toThrow(Exit);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("moony-sync: configuration error: TRUST_PROXY must be 1, 0, true or false");
    expect(lines[0]).not.toMatch(/\n|\bat /);
    expect(() => startOrExit({ PORT: "99999" }, failing([]))).toThrow(Exit);
  });

  it("a database from a newer server is one line, and the database is untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "moony-start-"));
    try {
      const db = openDb(dir);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(MIGRATIONS.length + 1);
      db.close();
      const lines: string[] = [];
      expect(() => startOrExit({ DATA_DIR: dir }, failing(lines))).toThrow(Exit);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("newer version of the server");
      expect(lines[0]).not.toMatch(/\n|\bat /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start on a database that already holds two IDs equal ignoring case", () => {
    const dir = mkdtempSync(join(tmpdir(), "moony-start-"));
    try {
      const db = openDb(dir);
      db.exec("DROP INDEX vaults_id_fold; DELETE FROM schema_version WHERE version = 9");
      const ins = db.prepare(
        "INSERT INTO vaults (vault_id, account, token_hash, created_at, last_activity) VALUES (?, '1234567890123456', 'h', 0, 0)",
      );
      ins.run("AbCdEfGhIjKlMnOpQrStUv");
      ins.run("abcdefghijklmnopqrstuv");
      db.close();
      expect(() => openDb(dir)).toThrow("vault_ids_collide_ignoring_case");
      const lines: string[] = [];
      expect(() => startOrExit({ DATA_DIR: dir }, failing(lines))).toThrow(Exit);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("letter case");
      expect(lines[0]).toContain("HAVING COUNT(*) > 1");
      expect(lines[0]).not.toMatch(/\n|\bat |abcdefghijklmnopqrstuv/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the config and an open database otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "moony-start-"));
    try {
      const r = startOrExit({ DATA_DIR: dir, PORT: "0" }, failing([]));
      expect(r.config.dataDir).toBe(dir);
      expect(r.db.open).toBe(true);
      r.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
