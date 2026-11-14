import { serve } from "@hono/node-server";
import type { HttpBindings, Http2Bindings } from "@hono/node-server";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { systemClock } from "./clock.js";
import { startHousekeeping } from "./housekeeping.js";
import { startOrExit } from "./start.js";

const { config, db } = startOrExit(process.env, (line) => {
  console.error(line);
  process.exit(1);
});
const log = (line: string) => console.log(line);
const app = createApp({ config, db, clock: systemClock, log });

const housekeeping = startHousekeeping({ log }, app.stores);

const server = serve(
  {
    fetch: (req: Request, env: HttpBindings | Http2Bindings) =>
      app.fetch(req, env.incoming.socket.remoteAddress),
    port: config.port,
  },
  (info) => log(`moony-sync ${config.version} listening on port ${info.port}`),
);

// A 100 MiB snapshot may take a slow connection a long time (the app allows 10 minutes per
// snapshot); the 300 s default requestTimeout would cut it off. Headers must still arrive fast.
const httpServer = server as Server;
httpServer.requestTimeout = 15 * 60 * 1000;
httpServer.headersTimeout = 30 * 1000;

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  housekeeping.stop();
  // `docker stop` kills after 10 s anyway; leave first, on our own terms.
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(() => {
    app.close();
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      log("shutdown: WAL checkpoint failed");
    }
    try {
      db.close();
    } catch {
      /* exiting anyway */
    }
    process.exit(0);
  });
  httpServer.closeIdleConnections();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
