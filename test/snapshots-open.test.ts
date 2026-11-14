import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newVault, testApp, uploadSnapshot } from "./helpers.js";

describe("snapshots.open", () => {
  it("a stream opened before the file is unlinked still reads it fully", async () => {
    const t = testApp();
    const v = await newVault(t);
    const content = "snapshot-".repeat(50_000);
    expect((await uploadSnapshot(t, v, 0, content)).status).toBe(201);
    const file = t.stores.snapshots.listFiles(v.id)[0]!.file;
    const opened = t.stores.snapshots.open(v.id, file)!;
    expect(opened.size).toBe(content.length);
    rmSync(join(t.dataDir, "snapshots", v.id, file));
    const text = await new Response(opened.stream).text();
    expect(text).toBe(content);
  });

  it("returns null for a file that does not exist", () => {
    const t = testApp();
    expect(t.stores.snapshots.open("A".repeat(22), `0-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`)).toBeNull();
  });
});
