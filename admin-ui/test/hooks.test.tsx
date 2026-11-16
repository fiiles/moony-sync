// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResource } from "../src/hooks";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

describe("useResource quiet refresh", () => {
  it("does nothing by itself without options", async () => {
    const load = vi.fn(async () => 1);
    renderHook(() => useResource(load));
    await flush();
    await act(async () => void (await vi.advanceTimersByTimeAsync(120_000)));
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refreshes every interval while visible, without a loading state", async () => {
    let n = 0;
    const load = vi.fn(async () => ++n);
    const { result } = renderHook(() => useResource(load, [], { refreshEveryMs: 30_000 }));
    await flush();
    expect(result.current.data).toBe(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe(2);
    expect(result.current.loading).toBe(false);
  });

  it("makes no request while hidden", async () => {
    const load = vi.fn(async () => 1);
    renderHook(() => useResource(load, [], { refreshEveryMs: 30_000, refreshOnFocus: true }));
    await flush();
    setVisibility("hidden");
    await act(async () => void (await vi.advanceTimersByTimeAsync(90_000)));
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the tab becomes visible or the window gets focus", async () => {
    const load = vi.fn(async () => 1);
    renderHook(() => useResource(load, [], { refreshOnFocus: true }));
    await flush();
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("keeps the old data and shows no error when a background refresh fails", async () => {
    let fail = false;
    const load = vi.fn(async () => {
      if (fail) throw new Error("down");
      return "old";
    });
    const { result } = renderHook(() => useResource(load, [], { refreshEveryMs: 1000 }));
    await flush();
    fail = true;
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe("old");
    expect(result.current.error).toBeNull();
    expect(result.current.refreshing).toBe(false);
  });

  it("is refreshing while a manual refresh runs, and runs one request at a time", async () => {
    let release: (v: number) => void = () => undefined;
    let first = true;
    const load = vi.fn(() => {
      if (first) {
        first = false;
        return Promise.resolve(1);
      }
      return new Promise<number>((r) => (release = r));
    });
    const { result } = renderHook(() => useResource(load));
    await flush();
    act(() => void result.current.refresh());
    act(() => void result.current.refresh());
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.refreshing).toBe(true);
    expect(result.current.loading).toBe(false);
    await act(async () => release(7));
    expect(result.current.data).toBe(7);
    expect(result.current.refreshing).toBe(false);
  });

  it("stops the timer and listeners on unmount", async () => {
    const load = vi.fn(async () => 1);
    const { unmount } = renderHook(() => useResource(load, [], { refreshEveryMs: 1000, refreshOnFocus: true }));
    await flush();
    unmount();
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    window.dispatchEvent(new Event("focus"));
    expect(load).toHaveBeenCalledTimes(1);
  });
});
