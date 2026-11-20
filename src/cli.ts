#!/usr/bin/env node
// `moony-sync reset-admin` (lost password or second factor) and `moony-sync unlock-admin` (clear
// the login lockout). Both work while the server runs (SQLite WAL lets a second process write);
// the server reads the new setup code and the lockout signal on its next call.

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearLockout, resetAdmin } from "./admin/auth.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";

export function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  const command = args[0];
  if (command !== "reset-admin" && command !== "unlock-admin") {
    err(
      command
        ? `unknown command: ${command} (try: moony-sync reset-admin | unlock-admin)`
        : "usage: moony-sync reset-admin | unlock-admin",
    );
    return 1;
  }
  const dataDir = loadConfig(env).dataDir;
  // Never create an empty database: a wrong DATA_DIR would just report a setup code nobody reads.
  if (!existsSync(join(dataDir, "moony-sync.db"))) {
    err(`no database in ${dataDir}; set DATA_DIR to the server's data directory`);
    return 1;
  }
  const db = openDb(dataDir);
  try {
    if (command === "unlock-admin") {
      clearLockout(db);
      out("Login attempts were reset.");
    } else {
      out(`Setup code: ${resetAdmin(db)}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

// Run only when started as the program (also through the `moony-sync` bin symlink).
const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCli(process.argv.slice(2), process.env, console.log, console.error);
  } catch (e) {
    console.error(`moony-sync: ${e instanceof Error ? e.message : "failed"}`);
    process.exitCode = 1;
  }
}
