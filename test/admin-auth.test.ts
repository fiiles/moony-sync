import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { base32Decode, totpCode } from "../src/admin/totp.js";
import {
  ADMIN_NAME,
  ADMIN_PASSWORD,
  adminSession,
  cookieFrom,
  login,
  setupAdmin,
  setupCodeFrom,
  testApp,
  type TestApp,
} from "./helpers.js";

const anon = (t: TestApp) => adminSession(t, "");
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

/** The TOTP code for the clock's current time. */
const codeNow = (t: TestApp, secret: string, offsetSteps = 0): string =>
  totpCode(base32Decode(secret), t.clock.now + offsetSteps * 30);

async function enrol(t: TestApp, s: { call: ReturnType<typeof adminSession>["call"] }) {
  const e = await body(await s.call("POST", "2fa/enrol", { password: ADMIN_PASSWORD }));
  const secret = e.secret as string;
  const c = await s.call("POST", "2fa/confirm", { totp: codeNow(t, secret) });
  expect(c.status).toBe(200);
  const backupCodes = ((await body(c)).backupCodes ?? []) as string[];
  return { secret, backupCodes };
}

describe("TOTP (RFC 6238 appendix B, SHA-1, 6 digits)", () => {
  const secret = new TextEncoder().encode("12345678901234567890");
  it("matches the published vectors", () => {
    expect(totpCode(secret, 59)).toBe("287082");
    expect(totpCode(secret, 1111111109)).toBe("081804");
    expect(totpCode(secret, 1111111111)).toBe("050471");
    expect(totpCode(secret, 1234567890)).toBe("005924");
  });
});

describe("first run and setup", () => {
  it("logs the setup code at start and shows only the setup state", async () => {
    const t = testApp();
    expect(t.logs.filter((l) => l.startsWith("Setup code: "))).toHaveLength(1);
    expect(setupCodeFrom(t)).toMatch(/^[A-Z2-7]{24}$/);
    const state = await body(await anon(t).call("GET", "state"));
    expect(state).toEqual({
      setupNeeded: true,
      authenticated: false,
      twoFactor: false,
      require2fa: false,
      mustEnrol2fa: false,
    });
  });

  it("uses SETUP_CODE from the configuration", async () => {
    const t = testApp({ setupCode: "FIXED-CODE-1" });
    expect(t.logs).toContain("Setup code: FIXED-CODE-1");
  });

  it("refuses a wrong code, a bad name and a weak password", async () => {
    const t = testApp();
    const code = setupCodeFrom(t);
    const post = (b: object) => anon(t).call("POST", "setup", b);
    const bad = await post({ code: "WRONG", name: "A", password: ADMIN_PASSWORD });
    expect(bad.status).toBe(401);
    expect(await body(bad)).toEqual({ error: "bad_code" });
    for (const name of ["   ", "", "x".repeat(81), 5]) {
      const r = await post({ code, name, password: ADMIN_PASSWORD });
      expect([r.status, (await body(r)).error]).toEqual([400, "invalid_name"]);
    }
    for (const password of ["123456789", "x".repeat(1025), 7]) {
      const r = await post({ code, name: "A", password });
      expect([r.status, (await body(r)).error]).toEqual([400, "weak_password"]);
    }
    expect((await post({ code, name: "A".repeat(80), password: "1234567890" })).status).toBe(204);
  });

  it("sets up once, trims the name, opens a session and then answers setup_done", async () => {
    const t = testApp();
    const code = setupCodeFrom(t);
    const res = await anon(t).call("POST", "setup", { code, name: "  Filip  ", password: ADMIN_PASSWORD });
    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^moony_admin=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Secure");
    const state = await body(await adminSession(t, cookieFrom(res)).call("GET", "state"));
    expect(state).toMatchObject({ setupNeeded: false, authenticated: true, name: "Filip", twoFactor: false });
    const again = await anon(t).call("POST", "setup", { code, name: "Evil", password: ADMIN_PASSWORD });
    expect([again.status, await body(again)]).toEqual([403, { error: "setup_done" }]);
  });

  it("lets only one of two simultaneous setups win", async () => {
    const t = testApp();
    const code = setupCodeFrom(t);
    const rs = await Promise.all(
      ["one", "two"].map((name) => anon(t).call("POST", "setup", { code, name, password: ADMIN_PASSWORD })),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([204, 403]);
    const { name } = (await body(
      await adminSession(t, cookieFrom(rs.find((r) => r.status === 204)!)).call("GET", "state"),
    )) as { name: string };
    expect(["one", "two"]).toContain(name);
  });

  it("answers 401 on every other admin route before setup (Review Focus 3)", async () => {
    const t = testApp();
    for (const [m, p] of [
      ["GET", "people"],
      ["GET", "anything/else"],
      ["POST", "logout"],
      ["POST", "logout-all"],
      ["POST", "password"],
      ["POST", "2fa/enrol"],
      ["POST", "2fa/confirm"],
      ["POST", "2fa/disable"],
    ] as const) {
      const r = await anon(t).call(m, p, m === "POST" ? {} : undefined);
      expect([m, p, r.status, await body(r)]).toEqual([m, p, 401, { error: "unauthorized" }]);
    }
  });

  it("locks setup attempts after five wrong codes, even for the right one, until the window ends", async () => {
    const t = testApp();
    const code = setupCodeFrom(t);
    const attempt = (c: string, ip = "203.0.113.5") =>
      anon(t).call("POST", "setup", { code: c, name: "A", password: ADMIN_PASSWORD }, { clientAddress: ip });
    for (let i = 0; i < 5; i++) expect((await attempt("WRONG")).status).toBe(401);
    const locked = await attempt(code);
    expect([locked.status, await body(locked)]).toEqual([429, { error: "rate_limited" }]);
    t.clock.now += 15 * 60;
    expect((await attempt(code)).status).toBe(204);
  });

  it("limits wrong setup codes across all addresses together (50 in 15 minutes)", async () => {
    const t = testApp();
    const code = setupCodeFrom(t);
    const attempt = (c: string, ip: string) =>
      anon(t).call("POST", "setup", { code: c, name: "A", password: ADMIN_PASSWORD }, { clientAddress: ip });
    for (let i = 0; i < 50; i++) expect((await attempt("WRONG", `198.51.100.${i}`)).status).toBe(401);
    expect((await attempt(code, "198.51.100.200")).status).toBe(429);
  });

  it("shares the five-attempt login limit within one IPv6 /64 and not across /64s", async () => {
    const t = testApp();
    await setupAdmin(t);
    const bad = (ip: string) =>
      anon(t).call("POST", "login", { name: ADMIN_NAME, password: "wrong password!" }, { clientAddress: ip });
    for (let i = 0; i < 5; i++) expect((await bad(`2001:db8:5:6:${i}::1`)).status).toBe(401);
    expect((await bad("2001:db8:5:6:ffff::9")).status).toBe(429);
    expect((await bad("2001:db8:5:7::1")).status).toBe(401);
  });

  it("reads X-Forwarded-For only with TRUST_PROXY for the attempt limits", async () => {
    const t = testApp();
    const attempt = (xff: string) =>
      anon(t).call("POST", "setup", { code: "WRONG", name: "A", password: ADMIN_PASSWORD }, {
        clientAddress: "192.0.2.1",
        headers: { "x-forwarded-for": xff },
      });
    for (let i = 0; i < 5; i++) await attempt(`10.0.0.${i}`);
    expect((await attempt("10.0.0.99")).status).toBe(429);
  });
});

describe("login", () => {
  it("accepts the right credentials and refuses wrong ones with one answer", async () => {
    const t = testApp();
    await setupAdmin(t);
    const post = (b: object) => anon(t).call("POST", "login", b);
    const outcomes = [];
    for (const b of [
      { name: ADMIN_NAME, password: "wrong password!" },
      { name: "Nobody", password: ADMIN_PASSWORD },
      { name: ADMIN_NAME.toLowerCase(), password: ADMIN_PASSWORD },
      { name: ADMIN_NAME, password: "x".repeat(5000) },
    ]) {
      const r = await post(b);
      outcomes.push([r.status, await body(r)]);
    }
    expect(outcomes).toEqual(Array(4).fill([401, { error: "bad_credentials" }]));
    const ok = await post({ name: ADMIN_NAME, password: ADMIN_PASSWORD });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("issues a fresh session each time and ignores a cookie the client brings (fixation)", async () => {
    const t = testApp();
    await setupAdmin(t);
    const planted = "moony_admin=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const r = await anon(t).call("POST", "login", { name: ADMIN_NAME, password: ADMIN_PASSWORD }, {
      headers: { cookie: planted },
    });
    expect(cookieFrom(r)).not.toBe(planted);
    const state = await body(await adminSession(t, planted).call("GET", "state"));
    expect(state.authenticated).toBe(false);
    const a = await login(t);
    const b = await login(t);
    expect(a.cookie).not.toBe(b.cookie);
  });

  it("marks the cookie Secure over https, or behind a trusted proxy that says so", async () => {
    const t = testApp();
    await setupAdmin(t);
    const creds = JSON.stringify({ name: ADMIN_NAME, password: ADMIN_PASSWORD });
    const via = (url: string, headers: Record<string, string> = {}) =>
      t.app.fetch(new Request(url, { method: "POST", body: creds, headers: { origin: new URL(url).origin, ...headers } }));
    expect((await via("https://sync.example/admin/api/login")).headers.get("set-cookie")).toContain("Secure");
    expect(
      (await via("http://localhost/admin/api/login", { "x-forwarded-proto": "https" })).headers.get("set-cookie"),
    ).not.toContain("Secure");
    const p = testApp({ trustProxy: true });
    await setupAdmin(p);
    const r = await p.app.fetch(
      new Request("http://localhost/admin/api/login", {
        method: "POST",
        body: creds,
        headers: { origin: "https://sync.example", "x-forwarded-proto": "https", "x-forwarded-host": "sync.example" },
      }),
    );
    expect(r.status).toBe(204);
    expect(r.headers.get("set-cookie")).toContain("Secure");
  });

  it("limits wrong passwords to five per address and 50 overall in 15 minutes", async () => {
    const t = testApp();
    await setupAdmin(t);
    const wrong = (ip: string) =>
      anon(t).call("POST", "login", { name: ADMIN_NAME, password: "wrong password!" }, { clientAddress: ip });
    for (let i = 0; i < 5; i++) expect((await wrong("203.0.113.1")).status).toBe(401);
    const r = await wrong("203.0.113.1");
    expect([r.status, await body(r)]).toEqual([429, { error: "rate_limited" }]);
    // the right password from a locked address is refused too
    const right = await anon(t).call("POST", "login", { name: ADMIN_NAME, password: ADMIN_PASSWORD }, {
      clientAddress: "203.0.113.1",
    });
    expect(right.status).toBe(429);
    expect((await wrong("203.0.113.2")).status).toBe(401);
    t.clock.now += 15 * 60;
    expect((await wrong("203.0.113.1")).status).toBe(401);
  });

  it("limits wrong passwords across many addresses", async () => {
    const t = testApp();
    await setupAdmin(t);
    for (let i = 0; i < 50; i++) {
      const r = await anon(t).call("POST", "login", { name: "x", password: "wrong password!" }, {
        clientAddress: `198.51.100.${i}`,
      });
      expect(r.status).toBe(401);
    }
    const r = await anon(t).call("POST", "login", { name: ADMIN_NAME, password: ADMIN_PASSWORD }, {
      clientAddress: "198.51.100.250",
    });
    expect(r.status).toBe(429);
  });

  it("does not count successful logins against the limits", async () => {
    const t = testApp();
    await setupAdmin(t);
    for (let i = 0; i < 12; i++) await login(t);
  });
});

describe("origin and sessions", () => {
  it("requires the Origin host[:port] to equal the request's Host on every non-GET route, scheme ignored", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    const send = (origin: string | null, path = "logout-all") => {
      const headers: Record<string, string> = { cookie: s.cookie };
      if (origin !== null) headers.origin = origin;
      return t.call("POST", `/admin/api/${path}`, { headers });
    };
    for (const origin of [null, "", "http://evil.example", "null", "http://localhost:81"]) {
      const r = await send(origin);
      expect([origin, r.status, await body(r)]).toEqual([origin, 403, { error: "bad_origin" }]);
    }
    // login and setup are covered as well
    const l = await t.call("POST", "/admin/api/login", { body: "{}" });
    expect(l.status).toBe(403);
    expect((await send("http://localhost")).status).toBe(204);
    // an https reverse proxy in front (no TRUST_PROXY): the scheme differs, the host does not
    const again = await login(t);
    const r = await t.call("POST", "/admin/api/logout-all", { headers: { cookie: again.cookie, origin: "https://localhost" } });
    expect(r.status).toBe(204);
  });

  it("accepts X-Forwarded-Host as the host only behind a trusted proxy", async () => {
    const via = async (trustProxy: boolean) => {
      const t = testApp({ trustProxy });
      const s = await setupAdmin(t);
      return t.call("POST", "/admin/api/logout-all", {
        headers: { cookie: s.cookie, origin: "https://sync.example", "x-forwarded-host": "other, sync.example" },
      });
    };
    expect((await via(false)).status).toBe(403);
    expect((await via(true)).status).toBe(204);
  });

  it("answers JSON 404 for unknown paths, 401 first without a session", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    const un = await anon(t).call("GET", "nope");
    expect([un.status, await body(un)]).toEqual([401, { error: "unauthorized" }]);
    const r = await s.call("GET", "nope");
    expect([r.status, r.headers.get("content-type"), await body(r)]).toEqual([
      404,
      "application/json; charset=utf-8",
      { error: "not_found" },
    ]);
  });

  it("ends the session on logout, and every session on logout-all", async () => {
    const t = testApp();
    await setupAdmin(t);
    const a = await login(t);
    const b = await login(t);
    const out = await a.call("POST", "logout");
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/moony_admin=;.*Max-Age=0/);
    expect((await body(await a.call("GET", "state"))).authenticated).toBe(false);
    expect((await body(await b.call("GET", "state"))).authenticated).toBe(true);
    const c = await login(t);
    expect((await b.call("POST", "logout-all")).status).toBe(204);
    for (const s of [b, c]) expect((await body(await s.call("GET", "state"))).authenticated).toBe(false);
  });

  it("ends a session after 12 hours without use, and use keeps it alive", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    t.clock.now += 11 * 3600;
    expect((await s.call("GET", "state")).status).toBe(200);
    expect((await body(await s.call("GET", "state"))).authenticated).toBe(true);
    t.clock.now += 11 * 3600;
    expect((await body(await s.call("GET", "state"))).authenticated).toBe(true);
    t.clock.now += 12 * 3600;
    expect((await body(await s.call("GET", "state"))).authenticated).toBe(false);
    expect((await s.call("GET", "nope")).status).toBe(401);
  });
});

describe("password change", () => {
  it("checks the current password, the new one's length, and ends the other sessions", async () => {
    const t = testApp();
    const keep = await setupAdmin(t);
    const other = await login(t);
    const bad = await keep.call("POST", "password", { current: "not the password", next: "a brand new password" });
    expect([bad.status, await body(bad)]).toEqual([401, { error: "bad_credentials" }]);
    const weak = await keep.call("POST", "password", { current: ADMIN_PASSWORD, next: "short" });
    expect([weak.status, await body(weak)]).toEqual([400, { error: "weak_password" }]);
    expect((await keep.call("POST", "password", { current: ADMIN_PASSWORD, next: "a brand new password" })).status).toBe(
      204,
    );
    expect((await body(await keep.call("GET", "state"))).authenticated).toBe(true);
    expect((await body(await other.call("GET", "state"))).authenticated).toBe(false);
    const old = await anon(t).call("POST", "login", { name: ADMIN_NAME, password: ADMIN_PASSWORD });
    expect(old.status).toBe(401);
    await login(t, { password: "a brand new password" });
  });

  it("counts wrong current passwords like wrong logins", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    for (let i = 0; i < 5; i++) {
      expect((await s.call("POST", "password", { current: "wrong password!", next: "a brand new password" })).status).toBe(401);
    }
    expect((await s.call("POST", "password", { current: ADMIN_PASSWORD, next: "a brand new password" })).status).toBe(429);
  });
});

describe("second factor", () => {
  it("enrols, confirms with ten backup codes, and then demands a code at login", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    const e = await body(await s.call("POST", "2fa/enrol", { password: ADMIN_PASSWORD }));
    const secret = e.secret as string;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(e.otpauthUrl).toBe(
      `otpauth://totp/Moony%20Sync:${encodeURIComponent(ADMIN_NAME)}?secret=${secret}&issuer=Moony%20Sync&algorithm=SHA1&digits=6&period=30`,
    );
    // pending only: login does not ask yet
    await login(t);
    expect((await body(await s.call("GET", "state"))).twoFactor).toBe(false);
    const wrong = await s.call("POST", "2fa/confirm", { totp: codeNow(t, secret) === "000000" ? "000001" : "000000" });
    expect([wrong.status, await body(wrong)]).toEqual([401, { error: "bad_totp" }]);
    const ok = await s.call("POST", "2fa/confirm", { totp: codeNow(t, secret) });
    expect(ok.status).toBe(200);
    const { backupCodes } = (await body(ok)) as { backupCodes: string[] };
    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10);
    for (const c of backupCodes) expect(c).toHaveLength(10);
    expect((await body(await s.call("GET", "state"))).twoFactor).toBe(true);

    const noCode = await anon(t).call("POST", "login", { name: ADMIN_NAME, password: ADMIN_PASSWORD });
    expect([noCode.status, await body(noCode)]).toEqual([401, { error: "totp_required" }]);
    const badCode = await anon(t).call("POST", "login", { name: ADMIN_NAME, password: ADMIN_PASSWORD, totp: "123456" });
    expect([badCode.status, await body(badCode)]).toEqual([401, { error: "bad_totp" }]);
    // a wrong password never reveals that a second factor exists
    const wrongPw = await anon(t).call("POST", "login", { name: ADMIN_NAME, password: "wrong password!" });
    expect(await body(wrongPw)).toEqual({ error: "bad_credentials" });
    t.clock.now += 30; // the enrolment code's step is used up
    await login(t, { totp: codeNow(t, secret) });
  });

  it("refuses a code twice, including the one that confirmed enrolment", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    const { secret } = await enrol(t, s);
    const confirmed = codeNow(t, secret);
    const replay = await anon(t).call("POST", "login", { name: ADMIN_NAME, password: ADMIN_PASSWORD, totp: confirmed });
    expect(await body(replay)).toEqual({ error: "bad_totp" });
    t.clock.now += 30;
    const code = codeNow(t, secret);
    await login(t, { totp: code });
    const again = await anon(t).call("POST", "login", { name: ADMIN_NAME, password: ADMIN_PASSWORD, totp: code });
    expect(await body(again)).toEqual({ error: "bad_totp" });
  });

  it("accepts the previous and the next step but not two steps away", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    const { secret } = await enrol(t, s);
    const attempt = (code: string) =>
      anon(t).call("POST", "login", { name: ADMIN_NAME, password: ADMIN_PASSWORD, totp: code });
    t.clock.now += 5 * 30;
    expect((await attempt(codeNow(t, secret, -2))).status).toBe(401);
    expect((await attempt(codeNow(t, secret, 2))).status).toBe(401);
    expect((await attempt(codeNow(t, secret, -1))).status).toBe(204);
    t.clock.now += 5 * 30;
    expect((await attempt(codeNow(t, secret, 1))).status).toBe(204);
  });

  it("takes each backup code once, in the totp field", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    const { backupCodes } = await enrol(t, s);
    const attempt = (code: string) =>
      anon(t).call("POST", "login", { name: ADMIN_NAME, password: ADMIN_PASSWORD, totp: code });
    expect((await attempt(backupCodes[0]!)).status).toBe(204);
    expect(await body(await attempt(backupCodes[0]!))).toEqual({ error: "bad_totp" });
    expect((await attempt(backupCodes[1]!)).status).toBe(204);
  });

  it("limits second-factor guesses to five per address", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    await enrol(t, s);
    const attempt = () =>
      anon(t).call("POST", "login", { name: ADMIN_NAME, password: ADMIN_PASSWORD, totp: "111111" });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    const r = await attempt();
    expect([r.status, await body(r)]).toEqual([429, { error: "rate_limited" }]);
  });

  it("disables with the password, and refuses to when REQUIRE_2FA is set", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    await enrol(t, s);
    const bad = await s.call("POST", "2fa/disable", { password: "wrong password!" });
    expect([bad.status, await body(bad)]).toEqual([401, { error: "bad_credentials" }]);
    expect((await s.call("POST", "2fa/disable", { password: ADMIN_PASSWORD })).status).toBe(204);
    expect((await body(await s.call("GET", "state"))).twoFactor).toBe(false);
    await login(t);

    const r = testApp({ require2fa: true });
    const rs = await setupAdmin(r);
    await enrol(r, rs);
    const refused = await rs.call("POST", "2fa/disable", { password: ADMIN_PASSWORD });
    expect([refused.status, await body(refused)]).toEqual([403, { error: "required" }]);
  });

  it("refuses to enrol again while enabled", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    await enrol(t, s);
    expect((await s.call("POST", "2fa/enrol", { password: ADMIN_PASSWORD })).status).toBe(409);
  });

  it("refuses confirm without a pending enrolment", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    const r = await s.call("POST", "2fa/confirm", { totp: "123456" });
    expect(r.status).toBe(409);
  });
});

describe("REQUIRE_2FA", () => {
  it("forces enrolment: only state, 2fa/* and logout answer until it is done", async () => {
    const t = testApp({ require2fa: true });
    const s = await setupAdmin(t);
    const state = await body(await s.call("GET", "state"));
    expect(state).toMatchObject({ authenticated: true, require2fa: true, twoFactor: false, mustEnrol2fa: true });
    for (const [m, p, b] of [
      ["GET", "people", undefined],
      ["POST", "password", { current: ADMIN_PASSWORD, next: "a brand new password" }],
      ["POST", "logout-all", {}],
    ] as const) {
      const r = await s.call(m, p, b);
      expect([p, r.status, await body(r)]).toEqual([p, 403, { error: "enrol_2fa" }]);
    }
    // unauthenticated is still 401 first
    expect((await anon(t).call("GET", "people")).status).toBe(401);
    await enrol(t, s);
    const after = await body(await s.call("GET", "state"));
    expect(after).toMatchObject({ twoFactor: true, mustEnrol2fa: false });
    expect((await s.call("GET", "people")).status).toBe(200);
    expect((await s.call("POST", "logout")).status).toBe(204);
  });

  it("lets a session without a second factor log out while enrolment is pending", async () => {
    const t = testApp({ require2fa: true });
    const s = await setupAdmin(t);
    expect((await s.call("POST", "logout")).status).toBe(204);
  });
});

describe("reset-admin", () => {
  const run = (t: TestApp, args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runCli(args, { DATA_DIR: t.dataDir }, (l) => out.push(l), (l) => err.push(l));
    return { code, out, err };
  };

  it("clears the admin while the server keeps running, leaves people alone and prints a new code", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    const person = t.stores.people.create("Someone");
    await enrol(t, s);
    const r = run(t, ["reset-admin"]);
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    const m = /^Setup code: ([A-Z2-7]{24})$/.exec(r.out[0]!);
    expect(m).not.toBeNull();
    expect(t.stores.people.get(person.id)).not.toBeNull();
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get()).toEqual({ n: 0 });
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM backup_codes").get()).toEqual({ n: 0 });
    const state = await body(await anon(t).call("GET", "state"));
    expect(state).toMatchObject({ setupNeeded: true, authenticated: false, twoFactor: false });
    expect((await s.call("GET", "nope")).status).toBe(401);
    // the old log line's code is not the new one, and the new code works for setup
    const old = await anon(t).call("POST", "setup", { code: setupCodeFrom(t), name: "A", password: ADMIN_PASSWORD });
    expect(old.status).toBe(401);
    const fresh = await anon(t).call("POST", "setup", { code: m![1], name: "New", password: ADMIN_PASSWORD });
    expect(fresh.status).toBe(204);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'setup_code'").get()).toEqual({ n: 0 });
    expect(t.db.prepare("SELECT totp_secret FROM admin").get()).toEqual({ totp_secret: null });
  });

  it("exits non-zero with one line on an unknown or missing command", () => {
    const t = testApp();
    for (const args of [["frobnicate"], []]) {
      const r = run(t, args);
      expect(r.code).toBe(1);
      expect(r.out).toEqual([]);
      expect(r.err).toHaveLength(1);
    }
  });
});
