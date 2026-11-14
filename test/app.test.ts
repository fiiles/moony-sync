import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { MIGRATIONS, openDb } from "../src/db.js";
import { testApp } from "./helpers.js";

describe("app shell", () => {
  it("GET /health", async () => {
    const t = testApp();
    const res = await t.call("GET", "/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /v1/server", async () => {
    const t = testApp({ version: "9.9.9" });
    const res = await t.call("GET", "/v1/server");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "moony-sync",
      version: "9.9.9",
      protocol: 2,
      mode: "self_hosted",
      features: ["blobs"],
    });
  });

  it("unknown API paths and non-GET requests to unknown paths are 404 not_found", async () => {
    const t = testApp();
    for (const [method, path] of [["GET", "/v1/nope"], ["POST", "/nope"]] as const) {
      const res = await t.call(method, path);
      expect([method, path, res.status]).toEqual([method, path, 404]);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });
});

describe("loadConfig", () => {
  it("defaults", () => {
    const c = loadConfig({});
    expect(c.port).toBe(8787);
    expect(c.dataDir).toBe("/data");
    expect(c.trustProxy).toBe(false);
    expect(c.require2fa).toBe(false);
    expect(c.publicUrl).toBeNull();
    expect(c.setupCode).toBeNull();
  });

  it("reads the environment", () => {
    const c = loadConfig({
      PORT: "9000",
      TRUST_PROXY: "1",
      REQUIRE_2FA: "1",
      PUBLIC_URL: "https://x.example",
      SETUP_CODE: "abc",
      DATA_DIR: "/var/x",
    });
    expect(c).toMatchObject({
      port: 9000,
      dataDir: "/var/x",
      trustProxy: true,
      require2fa: true,
      publicUrl: "https://x.example",
      setupCode: "abc",
    });
  });
});

describe("loadConfig details", () => {
  it("boolean flags accept only 1/0/true/false in any case; anything else refuses to start", () => {
    for (const v of ["1", "true", "TRUE", "True"]) {
      expect(loadConfig({ TRUST_PROXY: v, REQUIRE_2FA: v })).toMatchObject({ trustProxy: true, require2fa: true });
    }
    for (const v of ["0", "false", "FALSE", "False", ""]) {
      expect(loadConfig({ TRUST_PROXY: v, REQUIRE_2FA: v })).toMatchObject({ trustProxy: false, require2fa: false });
    }
    for (const v of ["yes", "on", "2", "enabled", " 1"]) {
      expect(() => loadConfig({ TRUST_PROXY: v })).toThrow(/TRUST_PROXY/);
      expect(() => loadConfig({ REQUIRE_2FA: v })).toThrow(/REQUIRE_2FA/);
    }
  });

  it("invalid_port: not an integer, negative or above 65535", () => {
    for (const p of ["abc", "-1", "65536", "80.5", "1e9"]) {
      expect([p, () => loadConfig({ PORT: p })]).toEqual([p, expect.any(Function)]);
      expect(() => loadConfig({ PORT: p })).toThrow("invalid_port");
    }
    expect(loadConfig({ PORT: "65535" }).port).toBe(65535);
    expect(loadConfig({ PORT: "0" }).port).toBe(0);
  });
});

describe("unhandled errors", () => {
  it("answer 500 internal_error without leaking details, and log only the error name", async () => {
    const t = testApp();
    const p = t.stores.people.create("Anna");
    t.db.close(); // every storage call now throws
    const res = await t.call("GET", "/v1/accounts/me", { headers: { "moony-account": p.account } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(t.logs.at(-1)).toMatch(/^unhandled error: \w+$/);
  });
});

describe("openDb", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "moony-db-"));
    dirs.push(d);
    return d;
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("keeps data across opens and enables WAL and foreign keys", () => {
    const dir = join(tmp(), "nested");
    const a = openDb(dir);
    expect(a.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(a.pragma("foreign_keys", { simple: true })).toBe(1);
    a.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (7)");
    a.close();
    const b = openDb(dir);
    expect(b.prepare("SELECT x FROM t").get()).toEqual({ x: 7 });
    b.close();
  });

  it("refuses a database newer than the server", () => {
    const dir = tmp();
    const a = openDb(dir);
    a.prepare("INSERT INTO schema_version (version) VALUES (?)").run(MIGRATIONS.length + 1);
    a.close();
    expect(() => openDb(dir)).toThrow("database_newer_than_server");
  });
});
