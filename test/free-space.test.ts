import { describe, expect, it } from "vitest";
import { hasRoom } from "../src/disk.js";
import { FREE_SPACE_FLOOR_BYTES } from "../src/limits.js";
import { auth, countingBody, newVault, setupAdmin, snapshotFiles, testApp, uploadSnapshot } from "./helpers.js";

describe("free-space floor", () => {
  it("snapshot PUT is 507 server_full when free space minus the declared length is under 1 GiB, before the body", async () => {
    const t = testApp();
    const v = await newVault(t);
    t.disk.free = FREE_SPACE_FLOOR_BYTES + 100;
    const { state, body } = countingBody(1); // refused on the declared 101 bytes
    const r = await t.app.fetch(
      new Request(`http://localhost/v1/vaults/${v.id}/snapshot?seq=0`, {
        method: "PUT",
        headers: auth(v, { "content-length": String(101) }),
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect([r.status, await r.json()]).toEqual([507, { error: "server_full" }]);
    expect(state.pulled).toBeLessThanOrEqual(1);
    expect(snapshotFiles(t, v)).toEqual([]);
  });

  it("exactly the floor left after the upload is allowed", async () => {
    const t = testApp();
    const v = await newVault(t);
    t.disk.free = FREE_SPACE_FLOOR_BYTES + 6;
    expect((await uploadSnapshot(t, v, 0, "snap-0")).status).toBe(201);
  });

  it("an unknown free space (stat failed) does not refuse", async () => {
    const t = testApp();
    const v = await newVault(t);
    t.disk.free = null;
    expect((await uploadSnapshot(t, v, 0, "snap-0")).status).toBe(201);
  });

  it("auth comes first: a wrong token is 401, not 507", async () => {
    const t = testApp();
    const v = await newVault(t);
    t.disk.free = 0;
    const r = await uploadSnapshot(t, { ...v, token: "x".repeat(43) }, 0, "snap-0");
    expect(r.status).toBe(401);
  });

  it("the overview reports the injected free space, 0 when unknown", async () => {
    const t = testApp();
    const admin = await setupAdmin(t);
    t.disk.free = 12345;
    expect(((await (await admin.call("GET", "overview")).json()) as { bytesFree: number }).bytesFree).toBe(12345);
    t.disk.free = null;
    expect(((await (await admin.call("GET", "overview")).json()) as { bytesFree: number }).bytesFree).toBe(0);
  });

  it("hasRoom", () => {
    expect(hasRoom(null, 10)).toBe(true);
    expect(hasRoom(FREE_SPACE_FLOOR_BYTES + 10, 10)).toBe(true);
    expect(hasRoom(FREE_SPACE_FLOOR_BYTES + 10, 11)).toBe(false);
  });
});
