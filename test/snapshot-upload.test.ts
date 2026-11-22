// A snapshot upload whose body stalls is aborted like a blob upload, and gives its space back.

import { describe, expect, it, vi } from "vitest";
import { FREE_SPACE_FLOOR_BYTES } from "../src/limits.js";
import { auth, newVault, snapshotFiles, testApp, uploadSnapshot, type TestApp, type Vault } from "./helpers.js";

/** A snapshot upload that sends two bytes of `size` and then nothing. */
function stalledSnapshotUpload(t: TestApp, v: Vault, seq: number, size: number) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(2).fill(7));
    },
  });
  return t.call("PUT", `/v1/vaults/${v.id}/snapshot?seq=${seq}`, {
    headers: auth(v, { "content-length": String(size) }),
    body,
    duplex: "half",
  } as RequestInit);
}

describe("snapshot upload idle timeout", () => {
  it("a body idle for 30 s is 408 body_timeout, leaves no file and releases its space", async () => {
    const t = testApp();
    const v = await newVault(t);
    t.disk.free = FREE_SPACE_FLOOR_BYTES + 150;
    vi.useFakeTimers();
    try {
      const response = stalledSnapshotUpload(t, v, 0, 100);
      await vi.waitFor(() => expect(snapshotFiles(t, v).some((f) => f.endsWith(".tmp"))).toBe(true));
      await vi.advanceTimersByTimeAsync(29_000);
      await vi.advanceTimersByTimeAsync(2_000);
      const res = await response;
      expect([res.status, await res.json()]).toEqual([408, { error: "body_timeout" }]);
    } finally {
      vi.useRealTimers();
    }
    expect(snapshotFiles(t, v)).toEqual([]);
    // The 100 bytes reserved for the stalled upload are free again.
    expect((await uploadSnapshot(t, v, 0, "x".repeat(100))).status).toBe(201);
  });
});
