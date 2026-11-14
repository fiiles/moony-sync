// Start-up that can be refused for a reason the operator must fix: a bad setting or a database
// written by a newer server. Each prints one line and exits; nothing here prints a stack trace.

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
    throw e;
  }
}
