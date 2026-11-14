import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_TAR_ENTRY_BYTES, tarHeader } from "../src/admin/backup.js";
import { newVault, push, setupAdmin, testApp, uploadSnapshot } from "./helpers.js";

/** A minimal ustar reader: name → bytes. Verifies each header checksum. */
function untar(buf: Buffer, dirs?: Map<string, Buffer>): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  for (;;) {
    const h = buf.subarray(off, off + 512);
    if (h.length < 512 || h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString("latin1").replace(/\0.*$/, "");
    const size = parseInt(h.subarray(124, 136).toString("latin1").replace(/\0.*$/, "").trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    expect(parseInt(h.subarray(148, 156).toString("latin1").replace(/\0.*$/, "").trim(), 8)).toBe(sum);
    expect(h.subarray(257, 262).toString()).toBe("ustar");
    off += 512;
    if (h[156] === "5".charCodeAt(0)) {
      dirs?.set(name, h);
      continue;
    }
    out.set(name, buf.subarray(off, off + size));
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

const field = (h: Buffer, from: number, to: number): number =>
  parseInt(h.subarray(from, to).toString("latin1").replace(/\0.*$/, "").trim(), 8);

describe("GET /admin/api/backup", () => {
  it("needs a session", async () => {
    const t = testApp();
    const res = await t.call("GET", "/admin/api/backup");
    expect(res.status).toBe(401);
  });

  it("is a tar with the database (people rows) and the snapshot file bytes", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    const person = t.stores.people.create("Anna");
    const v = await newVault(t, person.account);
    await push(t, v, [{ id: "a", ct: "AAAA" }]);
    const content = "snapshot-bytes-".repeat(1000); // not a multiple of 512
    expect((await uploadSnapshot(t, v, 0, content)).status).toBe(201);
    // leftovers that must not be shipped
    writeFileSync(join(t.dataDir, "snapshots", v.id, "0-00000000-0000-0000-0000-000000000000.tmp"), "half");

    t.clock.now = Date.UTC(2026, 10, 14, 9, 5, 59) / 1000;
    const res = await s.call("GET", "backup");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-tar");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="moony-sync-backup-20261114-0905.tar"');
    expect(res.headers.get("cache-control")).toBe("no-store");

    const files = untar(Buffer.from(await res.arrayBuffer()));
    const names = [...files.keys()].sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toBe("moony-sync.db");
    expect(names[1]).toMatch(new RegExp(`^snapshots/${v.id}/0-[0-9a-f-]{36}$`));
    const snapName = [...files.keys()].find((k) => k.startsWith("snapshots/"))!;
    expect(files.get(snapName)!.toString()).toBe(content);

    const dir = mkdtempSync(join(tmpdir(), "moony-backup-test-"));
    try {
      writeFileSync(join(dir, "copy.db"), files.get("moony-sync.db")!);
      const copy = new Database(join(dir, "copy.db"), { readonly: true });
      expect(copy.prepare("SELECT name, account FROM people").all()).toEqual([{ name: "Anna", account: person.account }]);
      copy.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // the temporary database copy is gone
    expect(readdirSync(t.dataDir).filter((f) => f.includes("backup"))).toEqual([]);
  });

  it("removes the temporary copy when the download is abandoned", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    const res = await s.call("GET", "backup");
    await res.body!.cancel();
    // Cleanup runs asynchronously after the cancel: poll, bounded, instead of a fixed wait.
    const left = () => readdirSync(t.dataDir).filter((f) => f.includes("backup"));
    for (let i = 0; i < 400 && left().length > 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(left()).toEqual([]);
  });

  it("a file of 8 GiB or more is refused with an explicit error, not written with a corrupt header", () => {
    expect(() => tarHeader("big", MAX_TAR_ENTRY_BYTES + 1, 0)).toThrow("tar_entry_too_large");
    expect(() => tarHeader("big", 8 * 1024 ** 3, 0)).toThrow("tar_entry_too_large");
    expect(tarHeader("ok", MAX_TAR_ENTRY_BYTES, 0).subarray(124, 136).toString("latin1")).toBe("77777777777\0");
  });

  it("the app removes leftover .backup-*.tmp copies at start", () => {
    const t = testApp({}, (dir) => {
      writeFileSync(join(dir, ".backup-1234.tmp"), "x");
      writeFileSync(join(dir, "keep.txt"), "x");
    });
    const names = readdirSync(t.dataDir);
    expect(names).not.toContain(".backup-1234.tmp");
    expect(names).toContain("keep.txt");
  });

  it("headers: uid/gid 1000, files 0600, directory entries 0700 for snapshots/ and each vault", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    const v = await newVault(t);
    await push(t, v, [{ id: "a", ct: "AAAA" }]);
    expect((await uploadSnapshot(t, v, 0, "x")).status).toBe(201);
    const buf = Buffer.from(await (await s.call("GET", "backup")).arrayBuffer());
    const dirs = new Map<string, Buffer>();
    untar(buf, dirs);
    expect([...dirs.keys()].sort()).toEqual(["snapshots/", `snapshots/${v.id}/`]);
    for (const h of dirs.values()) {
      expect(field(h, 100, 108)).toBe(0o700);
      expect(field(h, 108, 116)).toBe(1000);
      expect(field(h, 116, 124)).toBe(1000);
      expect(field(h, 124, 136)).toBe(0);
    }
    // the file headers: walk the archive again for regular entries
    let off = 0;
    let files = 0;
    while (buf.length - off >= 512 && !buf.subarray(off, off + 512).every((b) => b === 0)) {
      const h = buf.subarray(off, off + 512);
      const size = field(h, 124, 136);
      if (h[156] === "0".charCodeAt(0)) {
        files += 1;
        expect(field(h, 100, 108)).toBe(0o600);
        expect(field(h, 108, 116)).toBe(1000);
        expect(field(h, 116, 124)).toBe(1000);
      }
      off += 512 + Math.ceil(size / 512) * 512;
    }
    expect(files).toBe(2);
  });

  it("HEAD answers without building a backup copy", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    const seen: string[] = [];
    const orig = t.db.backup.bind(t.db);
    (t.db as unknown as { backup: typeof orig }).backup = (dest, ...rest) => {
      seen.push(dest);
      return orig(dest, ...rest);
    };
    const res = await s.call("HEAD", "backup");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(seen).toEqual([]);
    expect(readdirSync(t.dataDir).filter((f) => f.startsWith(".backup-"))).toEqual([]);
  });
});
