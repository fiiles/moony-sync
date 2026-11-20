import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const verifier = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@node-rs/argon2", async (importOriginal) => {
  const real = await importOriginal<typeof import("@node-rs/argon2")>();
  return {
    ...real,
    verify: (...args: Parameters<typeof real.verify>) => {
      verifier.calls++;
      return real.verify(...args);
    },
  };
});

import { runCli } from "../src/cli.js";
import { base32Decode, totpCode } from "../src/admin/totp.js";
import { ADMIN_NAME, ADMIN_PASSWORD, adminSession, login, setupAdmin, testApp } from "./helpers.js";

const anon = (t: Parameters<typeof adminSession>[0]) => adminSession(t, "");
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("password attempts are reserved before the Argon2 work", () => {
  it("lets at most five of twenty simultaneous wrong logins reach the verifier; the rest get 429", async () => {
    const t = testApp();
    await setupAdmin(t);
    verifier.calls = 0;
    const rs = await Promise.all(
      Array.from({ length: 20 }, () =>
        anon(t).call("POST", "login", { name: ADMIN_NAME, password: "wrong password!" }, { clientAddress: "203.0.113.9" }),
      ),
    );
    const statuses = rs.map((r) => r.status);
    expect(verifier.calls).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 401).length + statuses.filter((s) => s === 429).length).toBe(20);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(15);
  });

  it("caps verifications in flight across clients (more than 4 at once -> 429)", async () => {
    const t = testApp();
    await setupAdmin(t);
    verifier.calls = 0;
    const rs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        anon(t).call("POST", "login", { name: ADMIN_NAME, password: "wrong password!" }, { clientAddress: `198.51.100.${i}` }),
      ),
    );
    expect(verifier.calls).toBeLessThanOrEqual(4);
    expect(rs.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(8);
  });

  it("still accepts the right password right after four failures, and refunds it", async () => {
    const t = testApp();
    await setupAdmin(t);
    const ip = "203.0.113.10";
    const post = (password: string) =>
      anon(t).call("POST", "login", { name: ADMIN_NAME, password }, { clientAddress: ip });
    for (let i = 0; i < 4; i++) expect((await post("wrong password!")).status).toBe(401);
    expect((await post(ADMIN_PASSWORD)).status).toBe(204);
    // the success was refunded: still one failure left before the lock
    expect((await post("wrong password!")).status).toBe(401);
    expect((await post("wrong password!")).status).toBe(429);
  });

  it("applies to password change, 2fa/disable, 2fa/enrol and the connection-code reveal", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    const person = t.stores.people.create("P");
    const paths: [string, string, object][] = [
      ["POST", "password", { current: "wrong password!", next: "a brand new password" }],
      ["POST", "2fa/disable", { password: "wrong password!" }],
      ["POST", "2fa/enrol", { password: "wrong password!" }],
      ["POST", `people/${person.id}/connection-code`, { password: "wrong password!" }],
    ];
    verifier.calls = 0;
    const rs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const [m, p, b] = paths[i % 4]!;
        return s.call(m, p, b);
      }),
    );
    expect(verifier.calls).toBeLessThanOrEqual(4);
    expect(rs.filter((r) => r.status === 401).length).toBeLessThanOrEqual(5);
    expect(rs.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(15);
  });
});

describe("login name", () => {
  it("trims the name like setup does", async () => {
    const t = testApp();
    await setupAdmin(t);
    await login(t, { name: `  ${ADMIN_NAME} \n` });
    const r = await anon(t).call("POST", "login", { name: ADMIN_NAME.toLowerCase(), password: ADMIN_PASSWORD });
    expect(r.status).toBe(401);
  });
});

describe("forced password and session rules around the second factor", () => {
  it("2fa/enrol needs the password and counts wrong ones", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    for (const b of [{}, { password: "wrong password!" }, { password: 5 }]) {
      const r = await s.call("POST", "2fa/enrol", b);
      expect([r.status, await body(r)]).toEqual([401, { error: "bad_credentials" }]);
    }
    expect((await s.call("POST", "2fa/enrol", { password: "wrong password!" })).status).toBe(401);
    expect((await s.call("POST", "2fa/enrol", { password: "wrong password!" })).status).toBe(401);
    expect((await s.call("POST", "2fa/enrol", { password: ADMIN_PASSWORD })).status).toBe(429);
  });

  it("a successful 2fa/confirm ends every other session but not this one", async () => {
    const t = testApp({ require2fa: true });
    const keep = await setupAdmin(t);
    const other = await login(t);
    const { secret } = await body(await keep.call("POST", "2fa/enrol", { password: ADMIN_PASSWORD })) as { secret: string };
    expect((await keep.call("POST", "2fa/confirm", { totp: totpCode(base32Decode(secret), t.clock.now) })).status).toBe(200);
    expect((await body(await keep.call("GET", "state"))).authenticated).toBe(true);
    expect((await body(await other.call("GET", "state"))).authenticated).toBe(false);
  });
});

describe("trusted proxy headers: the last entry counts", () => {
  it("keys attempt limits on the last X-Forwarded-For entry, not one the client chose", async () => {
    const t = testApp({ trustProxy: true });
    const attempt = (chosen: string) =>
      anon(t).call("POST", "setup", { code: "WRONG", name: "A", password: ADMIN_PASSWORD }, {
        clientAddress: "192.0.2.1",
        headers: { "x-forwarded-for": `${chosen}, 198.51.100.7` },
      });
    for (let i = 0; i < 5; i++) await attempt(`10.0.0.${i}`);
    expect((await attempt("10.0.0.99")).status).toBe(429);
  });

  it("reads Secure and the Origin host from the last X-Forwarded-Proto / -Host entry", async () => {
    const t = testApp({ trustProxy: true });
    await setupAdmin(t);
    const creds = JSON.stringify({ name: ADMIN_NAME, password: ADMIN_PASSWORD });
    const via = (proto: string) =>
      t.app.fetch(
        new Request("http://localhost/admin/api/login", {
          method: "POST",
          body: creds,
          headers: { origin: "http://localhost", "x-forwarded-proto": proto },
        }),
      );
    expect((await via("http, https")).headers.get("set-cookie")).toContain("Secure");
    expect((await via("https, http")).headers.get("set-cookie")).not.toContain("Secure");
  });
});

describe("Origin and default ports", () => {
  it("treats :80 / :443 in Host or Origin as no port", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    const send = (url: string, origin: string, host?: string) =>
      t.app.fetch(
        new Request(url, { method: "POST", headers: { cookie: s.cookie, origin, ...(host ? { host } : {}) } }),
      );
    // Host header with an explicit default port against an Origin without one
    expect((await send("http://localhost/admin/api/logout-all", "http://localhost", "localhost:80")).status).toBe(204);
    const s2 = await login(t);
    expect(
      (await t.app.fetch(new Request("http://localhost/admin/api/logout-all", {
        method: "POST",
        headers: { cookie: s2.cookie, origin: "https://localhost:443", host: "localhost" },
      }))).status,
    ).toBe(204);
    const s3 = await login(t);
    const bad = await t.app.fetch(new Request("http://localhost/admin/api/logout-all", {
      method: "POST",
      headers: { cookie: s3.cookie, origin: "http://localhost:443", host: "localhost" },
    }));
    expect(bad.status).toBe(403);
  });
});

describe("reset-admin without a database", () => {
  it("refuses with one line and creates nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "moony-cli-"));
    try {
      const dataDir = join(dir, "data");
      const out: string[] = [];
      const err: string[] = [];
      const code = runCli(["reset-admin"], { DATA_DIR: dataDir }, (l) => out.push(l), (l) => err.push(l));
      expect([code, out.length, err.length]).toEqual([1, 0, 1]);
      expect(existsSync(dataDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("unlock-admin without a database", () => {
  it("refuses with one line and creates nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "moony-cli-"));
    try {
      const dataDir = join(dir, "data");
      const out: string[] = [];
      const err: string[] = [];
      const code = runCli(["unlock-admin"], { DATA_DIR: dataDir }, (l) => out.push(l), (l) => err.push(l));
      expect([code, out.length, err.length]).toEqual([1, 0, 1]);
      expect(existsSync(dataDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
