// The directory fsync after the rename fails: the renamed file must not stay behind.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { newVaultId, testApp } from "./helpers.js";

const failing = vi.hoisted(() => ({ on: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      if (failing.on) throw Object.assign(new Error("disk"), { code: "EIO" });
      actual.fsyncSync(fd);
    },
  };
});

describe("snapshot write", () => {
  it("removes the renamed file when the directory fsync throws, and rethrows", async () => {
    const t = testApp();
    const vaultId = newVaultId();
    const body = new Blob(["hello"]).stream() as ReadableStream<Uint8Array>;
    failing.on = true;
    try {
      await expect(t.stores.snapshots.write(vaultId, 0, body, 100)).rejects.toThrow("disk");
    } finally {
      failing.on = false;
    }
    const dir = join(t.dataDir, "snapshots", vaultId);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});
