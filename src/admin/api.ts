// The admin API under /admin/api: the authentication routes first, then the routes for people,
// settings, overview and backup on the same router, behind the same guard.

import { Hono, type Context } from "hono";
import type { AppBindings, AppDeps, Stores } from "../app.js";
import { encodeConnectionCode, normalizeServerUrl } from "../connection-code.js";
import { errorResponse, fromResult, json, readJson, type BodyBudget } from "../http.js";
import { normalizeName, type Person } from "../people.js";
import { clientKey, lastForwarded } from "../ratelimit.js";
import { blobQuotaBytes, setBlobQuotaBytes } from "../blobs.js";
import { MAX_BLOB_QUOTA_BYTES } from "../limits.js";
import type { ProxyWatch } from "../proxy-watch.js";
import { backupFileName, createBackupStream, estimateBackupBytes } from "./backup.js";
import { getSetting, setSetting, type Auth, type SessionInfo } from "./auth.js";

export const COOKIE = "moony_admin";
const MAX_BODY = 16 * 1024;

/** The only routes that answer without a session ("METHOD path below /admin/api"). Everything
 *  else, including paths that do not exist, needs one. */
const PUBLIC_ROUTES = new Set(["GET state", "POST setup", "POST login"]);

/** With mustEnrol2fa a session may only reach these (and `state`, which is public). */
const ENROLMENT_ROUTES = new Set(["POST logout", "POST 2fa/enrol", "POST 2fa/confirm", "POST 2fa/disable"]);

type Env = { Bindings: AppBindings; Variables: { session: SessionInfo | null } };
type Ctx = Context<Env>;

function cookieValue(header: string | null): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export function adminRoutes(deps: AppDeps, stores: Stores, auth: Auth, budget: BodyBudget, proxyWatch: ProxyWatch): Hono<Env> {
  const { config, db, clock } = deps;
  const router = new Hono<Env>();

  const forwarded = (c: Ctx, name: string): string | undefined =>
    config.trustProxy ? lastForwarded(c.req.header(name)) : undefined;

  /** What the browser sees: https from the URL, or from a trusted proxy's X-Forwarded-Proto. */
  const isHttps = (c: Ctx): boolean =>
    new URL(c.req.url).protocol === "https:" || forwarded(c, "x-forwarded-proto") === "https";

  const ownOrigin = (c: Ctx): string => {
    const url = new URL(c.req.url);
    const proto = forwarded(c, "x-forwarded-proto");
    const scheme = proto === "http" || proto === "https" ? proto : url.protocol.slice(0, -1);
    return `${scheme}://${forwarded(c, "x-forwarded-host") ?? url.host}`;
  };

  /** The request's own host without a default port (an explicit :80 or :443 means none; the
   *  Origin's host went through URL parsing, which already drops the default of its scheme). */
  const bareHost = (h: string): string => h.toLowerCase().replace(/:(80|443)$/, "");

  /** The Origin's host[:port] must be the one the request was sent to; the scheme is ignored
   *  (an https reverse proxy without TRUST_PROXY still works). A missing Origin is refused. */
  const originMatches = (c: Ctx): boolean => {
    const origin = c.req.header("origin");
    if (!origin) return false;
    let host: string;
    try {
      host = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    if (!host) return false;
    const own = [c.req.header("host") ?? new URL(c.req.url).host, forwarded(c, "x-forwarded-host")];
    return own.some((h) => h !== undefined && bareHost(h) === host);
  };

  const cookie = (c: Ctx, value: string, maxAge?: number): string =>
    `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/${maxAge === undefined ? "" : `; Max-Age=${maxAge}`}${
      isHttps(c) ? "; Secure" : ""
    }`;

  const noContent = (headers?: HeadersInit): Response => {
    const h = new Headers(headers);
    h.set("cache-control", "no-store");
    return new Response(null, { status: 204, headers: h });
  };

  const who = (c: Ctx): string => clientKey(c.req.raw, c.env.clientAddress, config.trustProxy);
  const mustEnrol = (s: SessionInfo): boolean => config.require2fa && !s.twoFactor;

  /** A JSON object body, or the error response to return. */
  async function readObject(c: Ctx): Promise<Record<string, unknown> | Response> {
    const r = await readJson(c.req.raw, MAX_BODY, { budget, client: who(c) });
    if ("error" in r) return errorResponse(r.status, r.error);
    if (typeof r.value !== "object" || r.value === null || Array.isArray(r.value)) {
      return errorResponse(400, "invalid_request");
    }
    return r.value as Record<string, unknown>;
  }
  const sessionOf = (c: Ctx): SessionInfo => c.get("session")!;

  // The one guard: origin, then session, then forced enrolment. Public routes skip the session.
  router.use("*", async (c, next) => {
    const method = c.req.method === "HEAD" ? "GET" : c.req.method;
    if (method !== "GET") {
      if (!originMatches(c)) return errorResponse(403, "bad_origin");
    }
    const token = cookieValue(c.req.header("cookie") ?? null);
    const session = auth.session(token);
    c.set("session", session);
    const route = `${method} ${c.req.path.replace(/^\/admin\/api\//, "")}`;
    if (PUBLIC_ROUTES.has(route)) return next();
    if (!session) return errorResponse(401, "unauthorized");
    if (mustEnrol(session) && !ENROLMENT_ROUTES.has(route)) return errorResponse(403, "enrol_2fa");
    return next();
  });

  router.get("/state", (c) => {
    const s = sessionOf(c);
    return json({
      setupNeeded: auth.setupNeeded(),
      authenticated: s !== null,
      ...(s ? { name: s.name } : {}),
      twoFactor: s?.twoFactor ?? false,
      require2fa: config.require2fa,
      mustEnrol2fa: s !== null && mustEnrol(s),
    });
  });

  router.post("/setup", async (c) => {
    const b = await readObject(c);
    if (b instanceof Response) return b;
    const r = await auth.setup(who(c), { code: b.code, name: b.name, password: b.password });
    return r.ok ? noContent({ "set-cookie": cookie(c, r.token) }) : fromResult(r);
  });

  router.post("/login", async (c) => {
    const b = await readObject(c);
    if (b instanceof Response) return b;
    const r = await auth.login(who(c), { name: b.name, password: b.password, totp: b.totp }, cookieValue(c.req.header("cookie") ?? null));
    return r.ok ? noContent({ "set-cookie": cookie(c, r.token) }) : fromResult(r);
  });

  router.post("/logout", (c) => {
    auth.logout(sessionOf(c)!);
    return noContent({ "set-cookie": cookie(c, "", 0) });
  });

  router.post("/logout-all", (c) => {
    auth.logoutAll();
    return noContent({ "set-cookie": cookie(c, "", 0) });
  });

  router.post("/password", async (c) => {
    const b = await readObject(c);
    if (b instanceof Response) return b;
    const r = await auth.changePassword(sessionOf(c)!, who(c), b.current, b.next);
    return r.ok ? noContent() : fromResult(r);
  });

  router.post("/2fa/enrol", async (c) => {
    const b = await readObject(c);
    if (b instanceof Response) return b;
    return fromResult(await auth.enrol(sessionOf(c)!, who(c), b.password));
  });

  router.post("/2fa/confirm", async (c) => {
    const b = await readObject(c);
    if (b instanceof Response) return b;
    return fromResult(auth.confirm(sessionOf(c)!, who(c), b.totp));
  });

  router.post("/2fa/disable", async (c) => {
    const b = await readObject(c);
    if (b instanceof Response) return b;
    const r = await auth.disable(sessionOf(c)!, who(c), b.password);
    return r.ok ? noContent() : fromResult(r);
  });

  // -------------------------------------------------------------------------------------------
  // people, settings, overview, backup. Admin answers never carry an account number,
  // except inside a connection code.
  // -------------------------------------------------------------------------------------------

  const ADDRESS_KEY = "public_url";
  const savedAddress = (): string | null => getSetting(db, ADDRESS_KEY);
  /** The address people connect to: the saved one, else PUBLIC_URL, else none. */
  const address = (): string | null =>
    savedAddress() ?? (config.publicUrl !== null ? normalizeServerUrl(config.publicUrl) : null);

  const newest = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : Math.max(a, b);

  type VaultUsage = ReturnType<typeof stores.vaults.usage>[number];

  function personView(p: Person, vaults: VaultUsage[]) {
    const mine = vaults.filter((v) => v.account === p.account);
    return {
      id: p.id,
      name: p.name,
      state: p.state,
      profiles: mine.length,
      bytes: mine.reduce((n, v) => n + v.bytes, 0),
      lastActivity: mine.reduce<number | null>((m, v) => newest(m, v.lastActivity), null),
      createdAt: p.createdAt,
    };
  }

  const personNotFound = (): Response => errorResponse(404, "person_not_found");

  router.get("/overview", async (c) => {
    const vaults = stores.vaults.usage();
    const url = new URL(c.req.url);
    const host = (c.req.header("host") ?? url.host).toLowerCase();
    const hostname = host.replace(/:\d+$/, "");
    const bytesFree = (await deps.freeBytes()) ?? 0; // unknown: report 0
    return json({
      address: address(),
      addressSuggestion: ownOrigin(c),
      people: stores.people.list().length,
      profiles: vaults.length,
      bytesUsed: vaults.reduce((n, v) => n + v.bytes, 0),
      bytesFree,
      lastActivity: vaults.reduce<number | null>((m, v) => newest(m, v.lastActivity), null),
      version: config.version,
      proxyWarning: proxyWatch.warning(),
      insecure: !isHttps(c) && hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]",
    });
  });

  router.get("/people", () => {
    const vaults = stores.vaults.usage();
    return json(stores.people.list().map((p) => personView(p, vaults)));
  });

  router.post("/people", async (c) => {
    const b = await readObject(c);
    if (b instanceof Response) return b;
    const name = normalizeName(b.name);
    if (name === null) return errorResponse(400, "invalid_name");
    const url = address();
    if (url === null) return errorResponse(409, "address_not_set");
    const p = stores.people.create(name);
    return json({ person: personView(p, []), connectionCode: encodeConnectionCode(url, p.account) }, 201);
  });

  router.get("/people/:id", (c) => {
    const p = stores.people.get(c.req.param("id"));
    if (!p) return personNotFound();
    const vaults = stores.vaults.usage();
    return json({
      ...personView(p, vaults),
      vaults: vaults
        .filter((v) => v.account === p.account)
        .map((v) => ({
          id: v.vaultId,
          shortId: v.vaultId.slice(0, 6),
          bytes: v.bytes,
          files: v.files,
          lastActivity: v.lastActivity,
          kitSince: v.kitSince,
          kitLastRead: v.kitLastRead,
        })),
    });
  });

  router.patch("/people/:id", async (c) => {
    const id = c.req.param("id");
    if (!stores.people.get(id)) return personNotFound();
    const b = await readObject(c);
    if (b instanceof Response) return b;
    const keys = Object.keys(b);
    if (keys.length !== 1) return errorResponse(400, "invalid_request");
    if (keys[0] === "name") {
      const r = stores.people.rename(id, b.name as string);
      if (!r.ok) return errorResponse(r.status, r.error);
    } else if (keys[0] === "state" && (b.state === "active" || b.state === "blocked")) {
      const r = stores.people.setState(id, b.state);
      if (!r.ok) return errorResponse(r.status, r.error);
    } else {
      return errorResponse(400, "invalid_request");
    }
    return json(personView(stores.people.get(id)!, stores.vaults.usage()));
  });

  router.post("/people/:id/connection-code", async (c) => {
    const p = stores.people.get(c.req.param("id"));
    if (!p) return personNotFound();
    const b = await readObject(c);
    if (b instanceof Response) return b;
    // A password re-check by a signed-in admin: counted per client address only, not by the overall count.
    const ok = await auth.verifyPassword(who(c), b.password);
    if (!ok.ok) return errorResponse(ok.status, ok.error);
    const url = address();
    if (url === null) return errorResponse(409, "address_not_set");
    return json({ connectionCode: encodeConnectionCode(url, p.account) });
  });

  router.delete("/people/:id", (c) => {
    const p = stores.people.get(c.req.param("id"));
    if (!p) return personNotFound();
    // One transaction: from its commit on, the account is unknown and every vault row is gone, so
    // every vault call fails at once (a snapshot upload in flight is refused when it is
    // recorded, and its route removes the file). Files go afterwards; a leftover is swept.
    const ids = db.transaction(() => {
      stores.people.remove(p.id);
      return stores.vaults.dropAccount(p.account);
    })();
    stores.vaults.finishWipes(ids);
    return noContent();
  });

  router.delete("/people/:id/vaults/:vaultId", (c) => {
    const p = stores.people.get(c.req.param("id"));
    if (!p) return personNotFound();
    const vaultId = c.req.param("vaultId");
    if (!stores.vaults.listByAccount(p.account).some((v) => v.vaultId === vaultId)) {
      return errorResponse(404, "vault_not_found");
    }
    stores.vaults.wipe(vaultId);
    return noContent();
  });

  router.get("/settings", () => json({ publicUrl: savedAddress(), blobQuotaBytes: blobQuotaBytes(db) }));

  router.put("/settings", async (c) => {
    const b = await readObject(c);
    if (b instanceof Response) return b;
    const keys = Object.keys(b);
    if (keys.length !== 1) return errorResponse(400, "invalid_request");
    if (keys[0] === "blobQuotaBytes") {
      const n = b.blobQuotaBytes;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_BLOB_QUOTA_BYTES) {
        return errorResponse(400, "invalid_quota");
      }
      setBlobQuotaBytes(db, n);
      return json({ blobQuotaBytes: n });
    }
    if (keys[0] !== "publicUrl") return errorResponse(400, "invalid_request");
    if (b.publicUrl === null) {
      db.prepare("DELETE FROM settings WHERE key = ?").run(ADDRESS_KEY);
      return json({ publicUrl: null });
    }
    const url = typeof b.publicUrl === "string" ? normalizeServerUrl(b.publicUrl) : null;
    if (url === null) return errorResponse(400, "invalid_address");
    setSetting(db, ADDRESS_KEY, url);
    return json({ publicUrl: url });
  });

  router.get("/backup/size", () => json({ estimatedBytes: estimateBackupBytes(db, config.dataDir) }));

  router.get("/backup", async (c) => {
    const now = clock();
    const headers = {
      "content-type": "application/x-tar",
      "content-disposition": `attachment; filename="${backupFileName(now)}"`,
      "cache-control": "no-store",
    };
    // Hono runs this handler for HEAD too; no database copy for a request that drops the body.
    if (c.req.method !== "GET") return new Response(null, { headers });
    const body = await createBackupStream({ db, dataDir: config.dataDir, snapshots: stores.snapshots, blobFiles: stores.blobFiles, now });
    return new Response(body, { headers });
  });

  return router;
}
