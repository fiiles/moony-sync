import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";

const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

// A stand-in for the built interface, so the test does not depend on a build.
const uiDir = mkdtempSync(join(tmpdir(), "moony-ui-"));
mkdirSync(join(uiDir, "assets"));
writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>Moony</title><div id=root></div>");
writeFileSync(join(uiDir, "assets", "app-abc123.js"), "console.log(1)");
writeFileSync(join(uiDir, "theme.js"), "/* theme */");

const dataDir = mkdtempSync(join(tmpdir(), "moony-sync-"));
const db = openDb(dataDir);
const app = createApp({
  config: { port: 0, dataDir, publicUrl: null, trustProxy: false, require2fa: false, setupCode: "setup-code", version: "1.0.0" },
  db,
  clock: () => 1_800_000_000,
  log: () => undefined,
  uiDir,
});
afterAll(() => {
  app.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(uiDir, { recursive: true, force: true });
});

const get = (path: string, method = "GET") => app.fetch(new Request(`http://localhost${path}`, { method }));

describe("static admin interface", () => {
  it("serves index.html at / with the strict headers", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r.text()).toContain('<div id=root>');
  });

  it("falls back to index.html for the interface's own paths and unknown paths", async () => {
    for (const path of ["/people", "/people/some-id", "/backup", "/settings", "/nothing/here"]) {
      const r = await get(path);
      expect([path, r.status]).toEqual([path, 200]);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("content-security-policy")).toBe(CSP);
    }
  });

  it("serves files with their type; hashed assets are cached for long, the rest is revalidated", async () => {
    const asset = await get("/assets/app-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("content-security-policy")).toBe(CSP);
    const theme = await get("/theme.js");
    expect(theme.headers.get("cache-control")).toBe("no-cache");
  });

  it("a missing asset is a 404, never the page", async () => {
    const r = await get("/assets/missing.js");
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("never gives the HTML fallback to the API paths", async () => {
    const unknownAdmin = await get("/admin/api/unknown");
    expect(unknownAdmin.headers.get("content-type")).toContain("application/json");
    expect(unknownAdmin.status).toBe(401);
    const unknownV1 = await get("/v1/unknown");
    expect(unknownV1.status).toBe(404);
    expect(unknownV1.headers.get("content-type")).toContain("application/json");
    expect(await unknownV1.json()).toEqual({ error: "not_found" });
    const state = await get("/admin/api/state");
    expect((await state.json()) as unknown).toMatchObject({ setupNeeded: true });
  });

  it("a signed-in admin gets the JSON 404 for an unknown admin API path, not the page", async () => {
    const setup = await app.fetch(
      new Request("http://localhost/admin/api/setup", {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify({ code: "setup-code", name: "Admin", password: "correct horse battery" }),
      }),
    );
    expect(setup.status).toBe(204);
    const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0]!;
    const r = await app.fetch(new Request("http://localhost/admin/api/unknown", { headers: { cookie } }));
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(await r.json()).toEqual({ error: "not_found" });
  });

  it("does not escape the interface folder", async () => {
    for (const path of ["/..%2f..%2fpackage.json", "/%2e%2e/package.json", "/assets/..%2f..%2fpackage.json"]) {
      const r = await get(path);
      expect(await r.text()).not.toContain("moony-sync");
    }
  });

  it("answers only GET and HEAD", async () => {
    const r = await get("/people", "POST");
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/json");
    const head = await get("/", "HEAD");
    expect(head.status).toBe(200);
  });
});
