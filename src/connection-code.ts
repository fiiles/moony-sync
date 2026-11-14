// The connection code a person types or scans into the app (shared with the app, Plan 2):
//   moony-sync1:<16-digit account>:<base64url, no padding, of the UTF-8 normalised server address>

import { isAccountNumber } from "./encoding.js";

const PREFIX = "moony-sync1";
const MAX_URL_LENGTH = 256;

/** http or https, a host, no user, password, query or fragment, no path but "/"; lowercase
 *  host, default port dropped, no trailing "/"; at most 256 characters. null when invalid. */
export function normalizeServerUrl(input: string): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH || raw.includes("\\")) return null;
  // `new URL` would quietly drop an empty query/fragment and fold "/." into "/"; check the text.
  const m = /^(https?):\/\/([^/?#]*)(\/?)$/i.exec(raw);
  if (!m) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || m[2]!.includes("@")) return null;
  if (url.hostname === "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") return null;
  const out = `${url.protocol}//${url.host}`;
  return out.length <= MAX_URL_LENGTH ? out : null;
}

export function encodeConnectionCode(url: string, account: string): string {
  const normal = normalizeServerUrl(url);
  if (normal === null) throw new Error("invalid_server_url");
  if (!isAccountNumber(account)) throw new Error("invalid_account");
  return `${PREFIX}:${account}:${Buffer.from(normal, "utf8").toString("base64url")}`;
}

export function decodeConnectionCode(code: string): { url: string; account: string } | null {
  if (typeof code !== "string") return null;
  const m = /^moony-sync1:([0-9]{16}):([A-Za-z0-9_-]+)$/.exec(code);
  if (!m) return null;
  const bytes = Buffer.from(m[2]!, "base64url");
  if (bytes.toString("base64url") !== m[2]) return null; // not canonical
  const text = bytes.toString("utf8");
  const url = normalizeServerUrl(text);
  return url !== null && url === text ? { url, account: m[1]! } : null;
}
