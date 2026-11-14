// Serves the built admin interface (admin-ui/dist) at "/" with a strict content security policy.
// Every GET/HEAD path that is not a file, not an asset and not under an API prefix gets index.html,
// so the interface's own paths (/people, /backup, ...) survive a reload.

import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { errorResponse } from "./http.js";

/** From src/ (tests, tsx) and from dist/ (the build) alike, the interface sits one level up. */
export const DEFAULT_UI_DIR = fileURLToPath(new URL("../admin-ui/dist", import.meta.url));

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Paths owned by the API; they never fall back to the page. */
const API_PREFIXES = ["/v1", "/admin/api", "/health"];
const isApiPath = (path: string): boolean => API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

async function fileBytes(path: string): Promise<Buffer | null> {
  try {
    if (!(await stat(path)).isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

/** The file for a URL path, or null when the path escapes `root` or names no file. */
function insideRoot(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const full = resolve(join(root, decoded));
  return full === root || full.startsWith(root + sep) ? full : null;
}

function withSecurityHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

function reply(method: string, body: Buffer, type: string, cache: string): Response {
  return new Response(method === "HEAD" ? null : new Uint8Array(body), {
    headers: { ...SECURITY_HEADERS, "content-type": type, "cache-control": cache },
  });
}

/** Null when the request is not the interface's (an API path or another method). */
export function createStaticHandler(uiDir: string): (req: Request) => Promise<Response | null> {
  const root = resolve(uiDir);
  return async (req) => {
    const method = req.method;
    const path = new URL(req.url).pathname;
    if (method !== "GET" && method !== "HEAD") return null;
    if (isApiPath(path)) return null;

    const file = path === "/" ? null : insideRoot(root, path);
    if (file !== null && file !== root) {
      const bytes = await fileBytes(file);
      if (bytes) {
        // Vite names everything under /assets after its content, so it can be kept for good.
        const cache = path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
        return reply(method, bytes, TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", cache);
      }
    }
    // A missing hashed asset must not turn into a page that the browser then fails to parse.
    if (path.startsWith("/assets/")) return withSecurityHeaders(errorResponse(404, "not_found"));
    const index = await fileBytes(join(root, "index.html"));
    if (!index) return withSecurityHeaders(errorResponse(404, "not_found"));
    return reply(method, index, TYPES[".html"]!, "no-cache");
  };
}
