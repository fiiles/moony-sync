// The daily sweep (and the minute sweep of pairing mailboxes). Every time rule is also
// enforced at request time, so this only reclaims space and finishes interrupted deletions.

import type { Deps, Stores } from "./app.js";
import { HOUSEKEEPING_INTERVAL_SECONDS, MAILBOX_SWEEP_INTERVAL_SECONDS } from "./limits.js";

export function startHousekeeping(
  deps: Pick<Deps, "log">,
  stores: Pick<Stores, "vaults" | "mailboxes" | "blobs">,
  intervalSeconds: number = HOUSEKEEPING_INTERVAL_SECONDS,
): { runOnce(): void; stop(): void } {
  // One failing step must not stop the others; log lines carry no IDs.
  const attempt = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch {
      deps.log(`housekeeping: ${what} failed`);
    }
  };

  function runOnce(): void {
    let ids: string[] = [];
    attempt("listing vaults", () => {
      ids = stores.vaults.listIds();
    });
    for (const id of ids) {
      attempt("vault", () => stores.vaults.housekeep(id));
      attempt("blobs", () => stores.blobs.housekeep(id));
    }
    attempt("mailboxes", () => stores.mailboxes.housekeep());
    attempt("sweep", () => stores.vaults.sweep());
    attempt("blob sweep", () => stores.blobs.sweep());
  }

  runOnce();
  const timer = setInterval(runOnce, intervalSeconds * 1000);
  timer.unref();
  // Expired pairing mailboxes must not keep their contents until the daily run.
  const mailboxTimer = setInterval(
    () => attempt("mailboxes", () => stores.mailboxes.housekeep()),
    MAILBOX_SWEEP_INTERVAL_SECONDS * 1000,
  );
  mailboxTimer.unref();
  return {
    runOnce,
    stop: () => {
      clearInterval(timer);
      clearInterval(mailboxTimer);
    },
  };
}
