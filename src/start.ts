// Start-up that can be refused for a reason the operator must fix: a bad setting or a database
// written by a newer server or holding vault IDs that differ only by letter case. Each prints one
// line and exits; nothing here prints a stack trace.

import { loadConfig, type Config } from "./config.js";
import { openDb, type Db } from "./db.js";

/** `fail` prints the line to stderr and exits with status 1 (it never returns). */
export function startOrExit(env: NodeJS.ProcessEnv, fail: (line: string) => never): { config: Config; db: Db } {
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (e) {
    return fail(`moony-sync: configuration error: ${e instanceof Error ? e.message : "invalid settings"}`);
  }
  try {
    return { config, db: openDb(config.dataDir) };
  } catch (e) {
    if (e instanceof Error && e.message === "database_newer_than_server") {
      return fail("moony-sync: the database was written by a newer version of the server; update the server (do not delete the data)");
    }
    if (e instanceof Error && e.message === "vault_ids_collide_ignoring_case") {
      return fail("moony-sync: two vault IDs in the database differ only by letter case; the server cannot start until one is removed: open the database with sqlite3, find the rows with SELECT vault_id FROM vaults GROUP BY lower(vault_id) HAVING COUNT(*) > 1, and delete one (do not delete the data folder)");
    }
    throw e;
  }
}
