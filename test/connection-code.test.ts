import { describe, expect, it } from "vitest";
import { decodeConnectionCode, encodeConnectionCode, normalizeServerUrl } from "../src/connection-code.js";

const ACCOUNT = "1234567890123456";

describe("normalizeServerUrl", () => {
  it("lowercases the host, drops the default port and the trailing slash", () => {
    expect(normalizeServerUrl("HTTP://Host.Example:80/")).toBe("http://host.example");
    expect(normalizeServerUrl("https://sync.example:443")).toBe("https://sync.example");
    expect(normalizeServerUrl("https://sync.example:8443/")).toBe("https://sync.example:8443");
    expect(normalizeServerUrl("  http://192.168.1.5:8787  ")).toBe("http://192.168.1.5:8787");
    expect(normalizeServerUrl("http://[::1]:8787")).toBe("http://[::1]:8787");
  });

  it("rejects everything else", () => {
    for (const bad of [
      "ftp://sync.example",
      "sync.example",
      "",
      "https://",
      "https://sync.example/path",
      "https://sync.example/a/",
      "https://sync.example/.",
      "https://user@sync.example",
      "https://user:pw@sync.example",
      "https://sync.example?x=1",
      "https://sync.example/?",
      "https://sync.example#top",
      "https://sync.example#",
      "https://sync.example:99999",
      "https://sync.example\\",
      "https:\\\\sync.example",
      "https://sync.example\\path",
      "https://sy\\nc.example",
      `https://${"a".repeat(240)}.example.com/`,
    ]) {
      expect([bad, normalizeServerUrl(bad)]).toEqual([bad, null]);
    }
    expect(normalizeServerUrl(42 as unknown as string)).toBeNull();
  });

  it("allows exactly 256 characters, not 257", () => {
    const host = (n: number) => `http://${"a".repeat(n - 7 - 4)}.com`;
    expect(host(256)).toHaveLength(256);
    expect(normalizeServerUrl(host(256))).toBe(host(256));
    expect(normalizeServerUrl(host(257))).toBeNull();
  });
});

describe("connection code", () => {
  it("round-trips", () => {
    const code = encodeConnectionCode("https://Sync.Example:443/", ACCOUNT);
    expect(code).toBe(`moony-sync1:${ACCOUNT}:${Buffer.from("https://sync.example").toString("base64url")}`);
    expect(code).not.toContain("=");
    expect(decodeConnectionCode(code)).toEqual({ url: "https://sync.example", account: ACCOUNT });
  });

  it("round-trips a non-ASCII host through its normalised form", () => {
    const code = encodeConnectionCode("https://münchen.example", ACCOUNT);
    expect(decodeConnectionCode(code)).toEqual({ url: "https://xn--mnchen-3ya.example", account: ACCOUNT });
  });

  it("rejects malformed codes", () => {
    const b = (s: string) => Buffer.from(s).toString("base64url");
    for (const bad of [
      "",
      "nope",
      `moony-sync2:${ACCOUNT}:${b("https://a.example")}`,
      `moony-sync1:123:${b("https://a.example")}`,
      `moony-sync1:${ACCOUNT}:`,
      `moony-sync1:${ACCOUNT}:${b("ftp://a.example")}`,
      `moony-sync1:${ACCOUNT}:${b("https://a.example/path")}`,
      `moony-sync1:${ACCOUNT}:${b("HTTPS://A.example")}`, // not in normal form
      `moony-sync1:${ACCOUNT}:${b("https://a.example")}=`,
      `moony-sync1:${ACCOUNT}:${b("https://a.example")}:x`,
      ` moony-sync1:${ACCOUNT}:${b("https://a.example")}`,
    ]) {
      expect([bad, decodeConnectionCode(bad)]).toEqual([bad, null]);
    }
  });
});
