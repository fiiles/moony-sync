import { readFileSync } from "node:fs";

export interface Config {
  port: number;
  dataDir: string;
  publicUrl: string | null;
  trustProxy: boolean;
  require2fa: boolean;
  setupCode: string | null;
  version: string;
}

/** 1/0/true/false in any case. Anything else is refused: guessing what "yes" or "on" should
 *  mean could silently leave a security setting off. */
function flag(name: string, v: string | undefined): boolean {
  if (v === undefined || v === "") return false;
  const s = v.toLowerCase();
  if (s === "1" || s === "true") return true;
  if (s === "0" || s === "false") return false;
  throw new Error(`${name} must be 1, 0, true or false`);
}
const text = (v: string | undefined): string | null => (v ? v : null);

function packageVersion(): string {
  const url = new URL("../package.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
}

/** Environment variables, all optional (spec §5.2). */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const port = env.PORT ? Number(env.PORT) : 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid_port");
  return {
    port,
    dataDir: text(env.DATA_DIR) ?? "/data",
    publicUrl: text(env.PUBLIC_URL),
    trustProxy: flag("TRUST_PROXY", env.TRUST_PROXY),
    require2fa: flag("REQUIRE_2FA", env.REQUIRE_2FA),
    setupCode: text(env.SETUP_CODE),
    version: packageVersion(),
  };
}
