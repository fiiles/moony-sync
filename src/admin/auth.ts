// Admin authentication: the one admin, password (Argon2id), sessions, TOTP and backup codes,
// and the attempt limits that guard every guessable input. No HTTP in here; api.ts maps it.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import type { Clock } from "../clock.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { fail, type Result } from "../http.js";
import { normalizeName } from "../people.js";
import { fixedWindow, type Limiter } from "../ratelimit.js";
import { matchTotp, newTotpSecret, otpauthUrl, randomBase32, base32Decode } from "./totp.js";

export const SESSION_IDLE_SECONDS = 12 * 3600;
const ATTEMPT_WINDOW_SECONDS = 15 * 60;
const PER_CLIENT_ATTEMPTS = 5;
const OVERALL_ATTEMPTS = 50;
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 1024;
const BACKUP_CODES = 10;
const BACKUP_CODE_LENGTH = 10;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

// ---------------------------------------------------------------------------------------------
// settings and reset (shared with the command line tool)
// ---------------------------------------------------------------------------------------------

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

/** Removes the admin, every session and the second factor (people and data stay), and leaves a
 *  fresh setup code in `settings` for a running server to pick up. Returns the code. */
export function resetAdmin(db: Db): string {
  const code = randomBase32(24);
  db.transaction(() => {
    db.exec("DELETE FROM admin; DELETE FROM admin_sessions; DELETE FROM backup_codes");
    setSetting(db, "setup_code", code);
  })();
  return code;
}

// ---------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------

export interface SessionInfo {
  /** SHA-256 of the cookie value; identifies the session without holding the secret. */
  tokenHash: string;
  name: string;
  twoFactor: boolean;
}

export interface Auth {
  setupNeeded(): boolean;
  /** The code the setup page needs right now. */
  setupCode(): string;
  /** The session behind a cookie value, refreshing its idle timer; null when none or expired. */
  session(token: string | null): SessionInfo | null;
  setup(who: string, input: { code: unknown; name: unknown; password: unknown }): Promise<Result<{ token: string }>>;
  login(
    who: string,
    input: { name: unknown; password: unknown; totp: unknown },
    presentedToken: string | null,
  ): Promise<Result<{ token: string }>>;
  logout(s: SessionInfo): void;
  logoutAll(): void;
  changePassword(s: SessionInfo, who: string, current: unknown, next: unknown): Promise<Result>;
  /** Needs the password again: a stolen session alone must not be able to plant a second factor. */
  enrol(s: SessionInfo, who: string, password: unknown): Promise<Result<{ secret: string; otpauthUrl: string }>>;
  confirm(s: SessionInfo, who: string, totp: unknown): Result<{ backupCodes: string[] }>;
  disable(s: SessionInfo, who: string, password: unknown): Promise<Result>;
  /** Re-checks the admin's password for a sensitive action (shares the login attempt limit). */
  verifyPassword(who: string, password: unknown): Promise<Result>;
}

interface AdminRow {
  name: string;
  password_hash: string;
  totp_secret: string | null;
  totp_pending: string | null;
  totp_step: number;
}

/** Attempt quotas per client address and across all clients. Slow checks (Argon2) use
 *  `reserve`: the attempt is counted before the work starts, so parallel requests cannot all
 *  pass the check, and the refund on success means only failures stay counted. Fast checks
 *  use `locked` then `failed` (nothing awaits in between). */
function attemptLimit(clock: Clock) {
  const perClient: Limiter = fixedWindow(PER_CLIENT_ATTEMPTS, ATTEMPT_WINDOW_SECONDS, clock);
  const overall: Limiter = fixedWindow(OVERALL_ATTEMPTS, ATTEMPT_WINDOW_SECONDS, clock);
  return {
    locked: (who: string): boolean => perClient.over(who) || overall.over("*"),
    failed(who: string): void {
      perClient.hit(who);
      overall.hit("*");
    },
    reserve(who: string): (() => void) | null {
      const client = perClient.reserve(who);
      if (!client) return null;
      const all = overall.reserve("*");
      if (!all) {
        client();
        return null;
      }
      return () => {
        client();
        all();
      };
    },
  };
}

/** At most this many Argon2 verifications run at once, whoever asks; the rest are refused. */
export const MAX_CONCURRENT_VERIFICATIONS = 4;

export function createAuth(deps: { config: Config; db: Db; clock: Clock }): Auth {
  const { config, db, clock } = deps;
  const setupLimit = attemptLimit(clock);
  const passwordLimit = attemptLimit(clock); // login, password change, 2fa disable
  const totpLimit = attemptLimit(clock);
  const rateLimited = () => fail(429, "rate_limited");

  const startupCode = config.setupCode ?? randomBase32(24);
  const admin = (): AdminRow | undefined => db.prepare("SELECT * FROM admin WHERE id = 1").get() as AdminRow | undefined;

  // Verifying against this when the name is wrong keeps a wrong name as slow as a wrong
  // password. Computed now, so the first wrong name is not faster than later ones.
  const dummyHash: Promise<string> = argonHash(randomBase32(32));
  dummyHash.catch(() => undefined);
  let verifying = 0;
  /** One Argon2 verification inside the global concurrency cap; null when the cap is reached. */
  async function verifyCapped(hash: string, password: string): Promise<boolean | null> {
    if (verifying >= MAX_CONCURRENT_VERIFICATIONS) return null;
    verifying++;
    try {
      return await passwordOk(hash, password);
    } finally {
      verifying--;
    }
  }
  const passwordOk = async (hash: string, password: string): Promise<boolean> => {
    try {
      return await argonVerify(hash, password);
    } catch {
      return false;
    }
  };
  const validPasswordLength = (p: unknown): p is string =>
    typeof p === "string" && p.length >= MIN_PASSWORD && p.length <= MAX_PASSWORD;

  function createSession(): string {
    const token = randomBytes(32).toString("base64url");
    const now = clock();
    db.prepare("DELETE FROM admin_sessions WHERE last_used <= ?").run(now - SESSION_IDLE_SECONDS);
    db.prepare("INSERT INTO admin_sessions (token_hash, created_at, last_used) VALUES (?, ?, ?)").run(
      sha256(token),
      now,
      now,
    );
    return token;
  }

  /** Checks the admin's current password for a signed-in admin. The attempt is reserved before
   *  the Argon2 work and refunded when the password is right. */
  async function checkPassword(who: string, password: unknown): Promise<Result> {
    const refund = passwordLimit.reserve(who);
    if (!refund) return rateLimited();
    const a = admin();
    if (a === undefined || typeof password !== "string" || password.length > MAX_PASSWORD) {
      return fail(401, "bad_credentials");
    }
    const ok = await verifyCapped(a.password_hash, password);
    if (ok === null) {
      refund();
      return rateLimited();
    }
    if (!ok) return fail(401, "bad_credentials");
    refund();
    return { ok: true };
  }

  /** A TOTP step (6 digits) or a backup code (10 characters, used up by this call). */
  function acceptSecondFactor(a: AdminRow, code: string): boolean {
    if (/^\d{6}$/.test(code)) {
      const step = matchTotp(base32Decode(a.totp_secret!), code, clock(), a.totp_step);
      if (step === null) return false;
      // the compare-and-set makes two simultaneous uses of one code succeed only once
      return db.prepare("UPDATE admin SET totp_step = ? WHERE id = 1 AND totp_step < ?").run(step, step).changes === 1;
    }
    const normalized = code.trim().toUpperCase();
    if (normalized.length !== BACKUP_CODE_LENGTH) return false;
    return db.prepare("DELETE FROM backup_codes WHERE code_hash = ?").run(sha256(normalized)).changes === 1;
  }

  const currentSetupCode = (): string => getSetting(db, "setup_code") ?? startupCode;

  return {
    setupNeeded: () => admin() === undefined,
    setupCode: currentSetupCode,

    session(token) {
      if (!token) return null;
      const tokenHash = sha256(token);
      const row = db.prepare("SELECT last_used FROM admin_sessions WHERE token_hash = ?").get(tokenHash) as
        | { last_used: number }
        | undefined;
      const a = admin();
      if (!row || !a) return null;
      const now = clock();
      if (now - row.last_used >= SESSION_IDLE_SECONDS) {
        db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(tokenHash);
        return null;
      }
      db.prepare("UPDATE admin_sessions SET last_used = ? WHERE token_hash = ?").run(now, tokenHash);
      return { tokenHash, name: a.name, twoFactor: a.totp_secret !== null };
    },

    async setup(who, input) {
      if (admin()) return fail(403, "setup_done");
      if (setupLimit.locked(who)) return rateLimited();
      if (typeof input.code !== "string" || !constantTimeEqual(input.code, currentSetupCode())) {
        setupLimit.failed(who);
        return fail(401, "bad_code");
      }
      const name = normalizeName(input.name);
      if (name === null) return fail(400, "invalid_name");
      if (!validPasswordLength(input.password)) return fail(400, "weak_password");
      const passwordHash = await argonHash(input.password);
      // The row's fixed primary key decides a race: the second of two setups finds the admin there.
      return db.transaction((): Result<{ token: string }> => {
        if (admin()) return fail(403, "setup_done");
        db.prepare("INSERT INTO admin (id, name, password_hash, created_at) VALUES (1, ?, ?, ?)").run(
          name,
          passwordHash,
          clock(),
        );
        db.prepare("DELETE FROM settings WHERE key = 'setup_code'").run();
        return { ok: true, token: createSession() };
      })();
    },

    async login(who, input, presentedToken) {
      const { name, password } = input;
      if (typeof name !== "string" || typeof password !== "string") return fail(400, "invalid_request");
      const refund = passwordLimit.reserve(who);
      if (!refund) return rateLimited();
      const a = admin();
      // Name and password are always both checked, against a dummy hash when the name is wrong.
      // The name is trimmed like setup trims it; the comparison is case-sensitive.
      const nameMatches = a !== undefined && a.name === name.trim();
      let pwMatches = false;
      if (password.length <= MAX_PASSWORD) {
        const checked = await verifyCapped(nameMatches ? a.password_hash : await dummyHash, password);
        if (checked === null) {
          refund();
          return rateLimited();
        }
        pwMatches = checked;
      }
      if (!a || !nameMatches || !pwMatches) return fail(401, "bad_credentials");
      refund(); // only failed passwords stay counted
      if (a.totp_secret !== null) {
        if (typeof input.totp !== "string" || input.totp === "") return fail(401, "totp_required");
        if (totpLimit.locked(who)) return rateLimited();
        // re-read: the step may have moved while the password was being checked
        const fresh = admin()!;
        if (!acceptSecondFactor(fresh, input.totp)) {
          totpLimit.failed(who);
          return fail(401, "bad_totp");
        }
      }
      if (presentedToken) db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(sha256(presentedToken));
      return { ok: true, token: createSession() };
    },

    logout(s) {
      db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(s.tokenHash);
    },

    logoutAll() {
      db.prepare("DELETE FROM admin_sessions").run();
    },

    async changePassword(s, who, current, next) {
      const checked = await checkPassword(who, current);
      if (!checked.ok) return checked;
      if (!validPasswordLength(next)) return fail(400, "weak_password");
      const passwordHash = await argonHash(next);
      db.transaction(() => {
        db.prepare("UPDATE admin SET password_hash = ? WHERE id = 1").run(passwordHash);
        db.prepare("DELETE FROM admin_sessions WHERE token_hash != ?").run(s.tokenHash);
      })();
      return { ok: true };
    },

    async enrol(s, who, password) {
      const checked = await checkPassword(who, password);
      if (!checked.ok) return checked;
      if (s.twoFactor) return fail(409, "already_enrolled");
      // The secret has to be readable to check codes, so it is stored as it is; only the
      // database file and its backups hold it.
      const secret = newTotpSecret();
      db.prepare("UPDATE admin SET totp_pending = ? WHERE id = 1").run(secret);
      return { ok: true, secret, otpauthUrl: otpauthUrl(secret, s.name) };
    },

    confirm(s, who, totp) {
      const a = admin();
      if (s.twoFactor || !a?.totp_pending) return fail(409, "not_enrolling");
      if (totpLimit.locked(who)) return rateLimited();
      const step =
        typeof totp === "string" && /^\d{6}$/.test(totp)
          ? matchTotp(base32Decode(a.totp_pending), totp, clock(), 0)
          : null;
      if (step === null) {
        totpLimit.failed(who);
        return fail(401, "bad_totp");
      }
      const codes = Array.from({ length: BACKUP_CODES }, () => randomBase32(BACKUP_CODE_LENGTH));
      db.transaction(() => {
        db.prepare("UPDATE admin SET totp_secret = totp_pending, totp_pending = NULL, totp_step = ? WHERE id = 1").run(step);
        db.prepare("DELETE FROM backup_codes").run();
        // whoever else holds a session has not shown the new factor
        db.prepare("DELETE FROM admin_sessions WHERE token_hash != ?").run(s.tokenHash);
        const insert = db.prepare("INSERT INTO backup_codes (code_hash) VALUES (?)");
        for (const c of codes) insert.run(sha256(c));
      })();
      return { ok: true, backupCodes: codes };
    },

    verifyPassword: checkPassword,

    async disable(_s, who, password) {
      if (config.require2fa) return fail(403, "required");
      const checked = await checkPassword(who, password);
      if (!checked.ok) return checked;
      db.transaction(() => {
        db.prepare("UPDATE admin SET totp_secret = NULL, totp_pending = NULL, totp_step = 0 WHERE id = 1").run();
        db.prepare("DELETE FROM backup_codes").run();
      })();
      return { ok: true };
    },
  };
}
