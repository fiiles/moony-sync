import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { Person } from "../src/people.js";

export const START_TIME = 1_800_000_000;

/** An in-process app on a temporary data directory and a clock the test moves by hand. */
export function testApp(overrides: Partial<Config> = {}, prepare?: (dataDir: string) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), "moony-sync-"));
  prepare?.(dataDir);
  const config: Config = {
    port: 0,
    dataDir,
    publicUrl: null,
    trustProxy: false,
    require2fa: false,
    setupCode: null,
    version: "1.0.0",
    ...overrides,
  };
  const db = openDb(dataDir);
  const clock = { now: START_TIME };
  const logs: string[] = [];
  const disk: { free: number | null } = { free: 2 ** 40 };
  const app = createApp({
    config,
    db,
    clock: () => clock.now,
    log: (l) => logs.push(l),
    freeBytes: async () => disk.free,
  });
  afterAll(() => {
    app.close();
    if (db.open) db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const call = (method: string, path: string, init: RequestInit & { clientAddress?: string } = {}) => {
    const { clientAddress, ...rest } = init;
    return app.fetch(new Request(`http://localhost${path}`, { method, ...rest }), clientAddress);
  };
  return { app, db, clock, dataDir, logs, call, stores: app.stores, disk };
}

/** A body that counts the chunks the server pulled; each chunk is 64 KiB, `chunks` in all. */
export function countingBody(chunks = 40) {
  const state = { pulled: 0 };
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= chunks) return controller.close();
        state.pulled += 1;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { state, body };
}

export type TestApp = ReturnType<typeof testApp>;

export function addPerson(t: TestApp, name = "Test Person"): Person {
  return t.stores.people.create(name);
}

// ---------------------------------------------------------------------------------------------
// Vault helpers (Task 3)
// ---------------------------------------------------------------------------------------------

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

export const newVaultId = (): string => b64url(randomBytes(16));
export const newToken = (): string => b64url(randomBytes(32));
export const b64 = (s: string): string => btoa(s);
export const unb64 = (s: string): string => atob(s);

export type Vault = { account: string; id: string; token: string };

export async function newVault(t: TestApp, account?: string): Promise<Vault> {
  const acc = account ?? addPerson(t).account;
  const id = newVaultId();
  const token = newToken();
  const res = await t.call("PUT", `/v1/vaults/${id}`, {
    headers: { authorization: `Bearer ${token}`, "moony-account": acc },
  });
  if (res.status !== 201) throw new Error(`vault create failed: ${res.status} ${await res.text()}`);
  return { account: acc, id, token };
}

export const auth = (v: Vault, extra: HeadersInit = {}): Headers => {
  const h = new Headers(extra);
  h.set("authorization", `Bearer ${v.token}`);
  return h;
};

export const push = (t: TestApp, v: Vault, ops: { id: string; ct: string }[]): Promise<Response> =>
  t.call("POST", `/v1/vaults/${v.id}/ops`, {
    headers: auth(v, { "content-type": "application/json" }),
    body: JSON.stringify({ ops }),
  });

export type PullBody = { ops: { seq: number; id: string; ct: string }[]; head: number; more: boolean };

export function pull(t: TestApp, v: Vault, after = 0, limit?: number): Promise<Response> {
  const q = new URLSearchParams({ after: String(after) });
  if (limit !== undefined) q.set("limit", String(limit));
  return t.call("GET", `/v1/vaults/${v.id}/ops?${q}`, { headers: auth(v) });
}

export function uploadSnapshot(t: TestApp, v: Vault, seq: number, content: string): Promise<Response> {
  const body = new TextEncoder().encode(content);
  return t.call("PUT", `/v1/vaults/${v.id}/snapshot?seq=${seq}`, {
    headers: auth(v, {
      "content-type": "application/octet-stream",
      "content-length": String(body.byteLength),
    }),
    body,
  });
}

/** Files of the vault's snapshot directory (real names only, no temporary ones). */
export function snapshotFiles(t: TestApp, v: { id: string }): string[] {
  const dir = join(t.dataDir, "snapshots", v.id);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

export const newBlobId = (): string => randomUUID();

/** Files of the vault's blob directory, temporary ones included. */
export function blobFiles(t: TestApp, v: { id: string }): string[] {
  const dir = join(t.dataDir, "blobs", v.id);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** A blob upload: PUT with a Content-Length of the content. */
export function uploadBlob(
  t: TestApp,
  v: Vault,
  blobId: string,
  content: Uint8Array | string,
  headers: HeadersInit = {},
): Promise<Response> {
  const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const h = auth(v, { "content-type": "application/octet-stream", ...Object.fromEntries(new Headers(headers)) });
  h.set("content-length", String(body.byteLength));
  return t.call("PUT", `/v1/vaults/${v.id}/blobs/${blobId}`, { headers: h, body: body as BodyInit });
}

/** A blob upload whose body the test finishes (or breaks) by hand: 2 bytes are sent at once. */
export function heldBlobUpload(t: TestApp, v: Vault, blobId: string, content: Uint8Array | string) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
      c.enqueue(bytes.subarray(0, 2));
    },
  });
  const response = t.call("PUT", `/v1/vaults/${v.id}/blobs/${blobId}`, {
    headers: auth(v, { "content-length": String(bytes.byteLength) }),
    body,
    duplex: "half",
  } as RequestInit);
  return {
    response,
    /** Resolves once `count` temporary files exist, i.e. that many uploads are streaming. */
    started: (count = 1) =>
      vi.waitFor(() => expect(blobFiles(t, v).filter((f) => f.endsWith(".tmp")).length).toBeGreaterThanOrEqual(count)),
    finish() {
      ctl.enqueue(bytes.subarray(2));
      ctl.close();
    },
    fail() {
      ctl.error(new Error("client went away"));
    },
  };
}

export function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Admin helpers (Task 6)
// ---------------------------------------------------------------------------------------------

export const ADMIN_NAME = "Admin";
export const ADMIN_PASSWORD = "correct horse battery";

export interface AdminSession {
  cookie: string;
  /** An authenticated call to /admin/api with the Origin header a browser would send. */
  call(method: string, path: string, body?: unknown, init?: RequestInit & { clientAddress?: string }): Promise<Response>;
}

const adminCredentials = new WeakMap<object, { name: string; password: string }>();

/** The code from the last `Setup code: …` log line. */
export function setupCodeFrom(t: TestApp): string {
  for (const line of [...t.logs].reverse()) {
    const m = /^Setup code: (\S+)$/.exec(line);
    if (m) return m[1]!;
  }
  throw new Error("no setup code in the log");
}

export function cookieFrom(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const m = /moony_admin=([^;]*)/.exec(raw);
  if (!m || !m[1]) throw new Error(`no session cookie in response (${res.status})`);
  return `moony_admin=${m[1]}`;
}

export function adminSession(t: TestApp, cookie: string): AdminSession {
  return {
    cookie,
    call(method, path, body, init = {}) {
      const headers = new Headers(init.headers);
      if (cookie) headers.set("cookie", cookie);
      if (method !== "GET") headers.set("origin", "http://localhost");
      if (body !== undefined) headers.set("content-type", "application/json");
      return t.call(method, `/admin/api/${path}`, {
        ...init,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
  };
}

/** Sets the admin up through the API (code from the log) and returns the session it opens. */
export async function setupAdmin(
  t: TestApp,
  opts: { name?: string; password?: string; code?: string } = {},
): Promise<AdminSession> {
  const name = opts.name ?? ADMIN_NAME;
  const password = opts.password ?? ADMIN_PASSWORD;
  const res = await adminSession(t, "").call("POST", "setup", {
    code: opts.code ?? setupCodeFrom(t),
    name,
    password,
  });
  if (res.status !== 204) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  adminCredentials.set(t, { name: name.trim(), password });
  return adminSession(t, cookieFrom(res));
}

/** Logs in as the admin set up by `setupAdmin` (or with the given credentials). */
export async function login(
  t: TestApp,
  opts: { name?: string; password?: string; totp?: string } = {},
): Promise<AdminSession> {
  const known = adminCredentials.get(t) ?? { name: ADMIN_NAME, password: ADMIN_PASSWORD };
  const res = await adminSession(t, "").call("POST", "login", {
    name: opts.name ?? known.name,
    password: opts.password ?? known.password,
    totp: opts.totp,
  });
  if (res.status !== 204) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return adminSession(t, cookieFrom(res));
}
