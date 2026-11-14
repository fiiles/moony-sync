import { Hono } from "hono";
import { join } from "node:path";
import { adminRoutes } from "./admin/api.js";
import { createAuth } from "./admin/auth.js";
import { sweepBackupTemp } from "./admin/backup.js";
import type { Clock } from "./clock.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { createBodyBudget, errorResponse, json, type BodyBudget } from "./http.js";
import { diskFreeBytes, type FreeBytes } from "./disk.js";
import { MAX_INFLIGHT_BODY_BYTES } from "./limits.js";
import { createMailboxes, type Mailboxes } from "./mailboxes.js";
import { createPeople, type People } from "./people.js";
import { clientKey, createLimiters } from "./ratelimit.js";
import { createBlobFiles, type BlobFiles } from "./blob-files.js";
import { createBlobs, type Blobs } from "./blobs.js";
import { createSnapshots, type Snapshots } from "./snapshots.js";
import { createVaults, type Vaults } from "./vaults.js";
import { syncRoutes } from "./sync-api.js";
import { createStaticHandler, DEFAULT_UI_DIR } from "./static.js";

export const PROTOCOL = 2;
/** Optional capabilities of this server; a server without the field has none. */
export const FEATURES = ["blobs"] as const;

/** Hono env: the peer socket address, for routes that rate-limit or log by client. */
export interface AppBindings {
  clientAddress: string | undefined;
}

export interface Deps {
  config: Config;
  db: Db;
  clock: Clock;
  log: (line: string) => void;
  /** The built admin interface; defaults to admin-ui/dist next to the sources. */
  uiDir?: string;
  /** Free bytes on the data volume; defaults to a statfs of the data directory. */
  freeBytes?: FreeBytes;
}

/** Deps after createApp resolved the defaults. */
export type AppDeps = Deps & { freeBytes: FreeBytes };

/** The storage-backed services, built once and handed to the routers. Later tasks extend it. */
export interface Stores {
  people: People;
  vaults: Vaults;
  blobs: Blobs;
  snapshots: Snapshots;
  blobFiles: BlobFiles;
  mailboxes: Mailboxes;
}

export function createApp(given: Deps): {
  fetch(req: Request, clientAddress?: string): Promise<Response>;
  close(): void;
  stores: Stores;
} {
  const freeBytes = given.freeBytes ?? (() => diskFreeBytes(given.config.dataDir));
  const deps: AppDeps = { ...given, freeBytes };
  const people = createPeople(deps.db, deps.clock);
  const snapshots = createSnapshots(join(deps.config.dataDir, "snapshots"));
  // An upload that was cut by a crash leaves a ".tmp" file; none of them can still be in flight.
  snapshots.sweepTemp();
  const blobFiles = createBlobFiles(join(deps.config.dataDir, "blobs"));
  blobFiles.sweepTemp();
  sweepBackupTemp(deps.config.dataDir);
  const vaults = createVaults(deps.db, deps.clock, people, snapshots, blobFiles);
  const stores: Stores = {
    people,
    snapshots,
    blobFiles,
    mailboxes: createMailboxes(deps.db, deps.clock),
    vaults,
    blobs: createBlobs(deps.db, deps.clock, vaults, blobFiles),
  };
  const app = new Hono<{ Bindings: AppBindings }>();

  app.get("/health", () => json({ ok: true }));
  const limiters = createLimiters(deps.clock);
  const budget = createBodyBudget(MAX_INFLIGHT_BODY_BYTES);
  app.get("/v1/server", (c) => {
    if (limiters.accountLookup.hit(clientKey(c.req.raw, c.env.clientAddress, deps.config.trustProxy))) {
      return errorResponse(429, "rate_limited");
    }
    return json({
      name: "moony-sync",
      version: deps.config.version,
      protocol: PROTOCOL,
      features: FEATURES,
      mode: "self_hosted",
    });
  });

  app.route("/v1", syncRoutes(deps, stores, limiters, budget));
  const auth = createAuth(deps);
  // While there is no admin, the setup code is in the log at every start (`docker logs`). It is
  // the one secret allowed there; the server never logs anything else secret.
  if (auth.setupNeeded()) deps.log(`Setup code: ${auth.setupCode()}`);
  app.route("/admin/api", adminRoutes(deps, stores, auth, budget));

  // The admin interface: files, and index.html for its own paths. API paths never get the page.
  const serveUi = createStaticHandler(deps.uiDir ?? DEFAULT_UI_DIR);
  app.notFound(async (c) => (await serveUi(c.req.raw)) ?? errorResponse(404, "not_found"));
  app.onError((err, _c) => {
    deps.log(`unhandled error: ${err instanceof Error ? err.name : "unknown"}`);
    return errorResponse(500, "internal_error");
  });

  return {
    stores,
    fetch: async (req, clientAddress) => app.fetch(req, { clientAddress }),
    close: () => {
      // Timers and other resources owned by the app are released here by later tasks.
    },
  };
}
