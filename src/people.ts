// People: the account holders of this server. The 16-digit account number is the login.
// Entitlement is decided here and only here: active → never expires, blocked → ended at the block.

import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { randomAccountNumber } from "./encoding.js";
import { fail, type Result } from "./http.js";
import { SELF_HOSTED_PAID_UNTIL } from "./limits.js";

export type PersonState = "active" | "blocked";

export interface Person {
  id: string;
  name: string;
  state: PersonState;
  account: string;
  createdAt: number;
  blockedAt: number | null;
}

export interface People {
  /** Throws Error("invalid_name") when the name breaks the name rule; callers validate first. */
  create(name: string): Person;
  list(): Person[];
  get(id: string): Person | null;
  byAccount(account: string): Person | null;
  rename(id: string, name: string): Result;
  setState(id: string, state: PersonState): Result;
  remove(id: string): Result;
  /** null = unknown account; active → SELF_HOSTED_PAID_UNTIL; blocked → the time of the block. */
  paidUntil(account: string): number | null;
}

/** Trimmed, 1–80 characters; null when invalid. */
export function normalizeName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const n = name.trim();
  const length = [...n].length; // code points, not UTF-16 units
  return length >= 1 && length <= 80 ? n : null;
}

interface Row {
  id: string;
  name: string;
  state: PersonState;
  account: string;
  created_at: number;
  blocked_at: number | null;
}

const toPerson = (r: Row): Person => ({
  id: r.id,
  name: r.name,
  state: r.state,
  account: r.account,
  createdAt: r.created_at,
  blockedAt: r.blocked_at,
});

const notFound = () => fail(404, "person_not_found");

export function createPeople(db: Db, clock: Clock): People {
  const insert = db.prepare(
    "INSERT INTO people (id, name, state, account, created_at, blocked_at) VALUES (?, ?, 'active', ?, ?, NULL)",
  );
  const selectAll = db.prepare("SELECT * FROM people ORDER BY created_at, rowid");
  const selectId = db.prepare("SELECT * FROM people WHERE id = ?");
  const selectAccount = db.prepare("SELECT * FROM people WHERE account = ?");
  const updateName = db.prepare("UPDATE people SET name = ? WHERE id = ?");
  const activate = db.prepare("UPDATE people SET state = 'active', blocked_at = NULL WHERE id = ?");
  // A repeated block keeps the first block time.
  const block = db.prepare(
    "UPDATE people SET state = 'blocked', blocked_at = COALESCE(blocked_at, ?) WHERE id = ?",
  );
  const del = db.prepare("DELETE FROM people WHERE id = ?");

  return {
    create(name) {
      const clean = normalizeName(name);
      if (clean === null) throw new Error("invalid_name");
      const id = randomUUID();
      // The UNIQUE index is the real guard; a collision of two random 16-digit numbers is
      // astronomically unlikely, a few retries are plenty.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          insert.run(id, clean, randomAccountNumber(), clock());
          return toPerson(selectId.get(id) as Row);
        } catch (e) {
          if (!(e instanceof Error) || !/UNIQUE/.test(e.message)) throw e;
        }
      }
      throw new Error("account_number_exhausted");
    },
    list: () => (selectAll.all() as Row[]).map(toPerson),
    get(id) {
      const r = selectId.get(id) as Row | undefined;
      return r ? toPerson(r) : null;
    },
    byAccount(account) {
      const r = selectAccount.get(account) as Row | undefined;
      return r ? toPerson(r) : null;
    },
    rename(id, name) {
      const clean = normalizeName(name);
      if (clean === null) return fail(400, "invalid_name");
      return updateName.run(clean, id).changes > 0 ? { ok: true } : notFound();
    },
    setState(id, state) {
      const changes =
        state === "active" ? activate.run(id).changes : block.run(clock(), id).changes;
      return changes > 0 ? { ok: true } : notFound();
    },
    remove: (id) => (del.run(id).changes > 0 ? { ok: true } : notFound()),
    paidUntil(account) {
      const r = selectAccount.get(account) as Row | undefined;
      if (!r) return null;
      return r.state === "active" ? SELF_HOSTED_PAID_UNTIL : (r.blocked_at ?? 0);
    },
  };
}
