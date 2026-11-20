/** The two common reverse-proxy mistakes, noticed from request headers alone. */
export type ProxyWarning = "forwarded_untrusted" | "direct_client";

export interface ProxyWatch {
  see(req: Request): void;
  warning(): ProxyWarning | null;
}

/**
 * Keeps two booleans and nothing else: no address, header value, path or ID is stored or logged.
 * `/health` is not looked at; container health checks reach the server directly by design.
 */
export function createProxyWatch(trustProxy: boolean, log: (line: string) => void): ProxyWatch {
  let forwardedUntrusted = false;
  let directClient = false;
  if (trustProxy) log("TRUST_PROXY is on: only your reverse proxy may reach this port");
  return {
    see(req) {
      if (new URL(req.url).pathname === "/health") return;
      const forwarded = req.headers.has("x-forwarded-for") || req.headers.has("forwarded");
      if (!trustProxy && forwarded && !forwardedUntrusted) {
        forwardedUntrusted = true;
        log("proxy: forwarding headers seen while TRUST_PROXY is off; all clients share one rate limit");
      } else if (trustProxy && !forwarded && !directClient) {
        directClient = true;
        log("proxy: a request arrived without forwarding headers while TRUST_PROXY is on; bind the port to the proxy only");
      }
    },
    warning: () => (forwardedUntrusted ? "forwarded_untrusted" : directClient ? "direct_client" : null),
  };
}
