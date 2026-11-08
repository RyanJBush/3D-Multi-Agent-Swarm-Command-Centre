import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAY_INTERVAL_MS, ReplayController } from "../src/controller";
import { replayTo } from "../src/replay";
import { dump, loadTrace } from "./helpers";

const trace = loadTrace();
let c: ReplayController;

beforeEach(() => {
  vi.useFakeTimers();
  c = new ReplayController(trace);
});
afterEach(() => {
  c.dispose();
  vi.useRealTimers();
});

describe("initial state", () => {
  it("is paused before e01 with nothing selected or applied", () => {
    const s = c.snapshot;
    expect([s.count, s.total, s.playing, s.selectedId, s.state.latestId]).toEqual([0, 6, false, null, null]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("step", () => {
  it("applies exactly one event and selects it", () => {
    c.step();
    expect([c.snapshot.count, c.snapshot.selectedId]).toEqual([1, "e01"]);
    c.step();
    expect([c.snapshot.count, c.snapshot.selectedId]).toEqual([2, "e02"]);
  });
  it("is a no-op after e06", () => {
    for (let i = 0; i < 10; i++) c.step();
    expect([c.snapshot.count, c.snapshot.selectedId]).toEqual([6, "e06"]);
  });
  it("pauses playback", () => {
    c.play();
    c.step();
    expect(c.snapshot.playing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("e03 is open after three steps and failed after four", () => {
    for (let i = 0; i < 3; i++) c.step();
    expect(c.snapshot.state.calls.get("e03")!.status).toBe("open");
    c.step();
    expect(c.snapshot.state.calls.get("e03")!.status).toBe("failed");
  });
});

describe("play / pause", () => {
  it("applies one event every 1,000 ms and selects the newest", () => {
    expect(PLAY_INTERVAL_MS).toBe(1000);
    c.play();
    expect(c.snapshot.playing).toBe(true);
    vi.advanceTimersByTime(999);
    expect(c.snapshot.count).toBe(0);
    vi.advanceTimersByTime(1);
    expect([c.snapshot.count, c.snapshot.selectedId]).toEqual([1, "e01"]);
    vi.advanceTimersByTime(2000);
    expect([c.snapshot.count, c.snapshot.selectedId]).toEqual([3, "e03"]);
  });
  it("pause cancels advancement", () => {
    c.play();
    vi.advanceTimersByTime(2000);
    c.pause();
    expect(c.snapshot.playing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(c.snapshot.count).toBe(2);
  });
  it("resume starts a fresh 1,000 ms interval, not the remainder of the old one", () => {
    c.play();
    vi.advanceTimersByTime(600);
    c.pause();
    vi.advanceTimersByTime(5000);
    c.play();
    vi.advanceTimersByTime(999);
    expect(c.snapshot.count).toBe(0);
    vi.advanceTimersByTime(1);
    expect(c.snapshot.count).toBe(1);
  });
  it("repeated Play calls never create more than one timer", () => {
    for (let i = 0; i < 5; i++) c.play();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(c.snapshot.count).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(c.snapshot.count).toBe(2);
  });
  it("stops after e06 and cannot be restarted from the end", () => {
    c.play();
    vi.advanceTimersByTime(6000);
    expect([c.snapshot.count, c.snapshot.playing, c.snapshot.selectedId]).toEqual([6, false, "e06"]);
    expect(vi.getTimerCount()).toBe(0);
    c.play();
    c.step();
    expect([c.snapshot.playing, c.snapshot.count]).toEqual([false, 6]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(c.snapshot.count).toBe(6);
  });
});

describe("reset", () => {
  it("cancels playback, clears selection, returns to zero events", () => {
    c.play();
    vi.advanceTimersByTime(4000);
    c.reset();
    const s = c.snapshot;
    expect([s.count, s.playing, s.selectedId, s.state.latestId]).toEqual([0, false, null, null]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(c.snapshot.count).toBe(0);
  });
  it("removes the failure state", () => {
    for (let i = 0; i < 4; i++) c.step();
    expect(c.snapshot.state.failedCalls).toEqual(["e03"]);
    c.reset();
    expect(c.snapshot.state.failedCalls).toEqual([]);
    expect(c.snapshot.state.calls.size).toBe(0);
    expect(dump(c.snapshot.state)).not.toContain("ENOENT");
  });
});

describe("select", () => {
  it("pauses playback, selects the event, and leaves the applied count unchanged", () => {
    c.play();
    vi.advanceTimersByTime(3000);
    c.select("e01");
    const s = c.snapshot;
    expect([s.count, s.selectedId, s.playing, s.state.latestId]).toEqual([3, "e01", false, "e03"]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(c.snapshot.count).toBe(3);
  });
  it("ignores unrevealed and unknown events", () => {
    c.step();
    c.step();
    c.select("e04");
    c.select("nope");
    expect(c.snapshot.selectedId).toBe("e02");
  });
});

describe("seek", () => {
  it("pauses and recomputes deterministically from the prefix", () => {
    for (let i = 0; i < 6; i++) c.step();
    c.seek(4);
    expect(c.snapshot.state).toEqual(replayTo(trace, 4));
    const fresh = new ReplayController(trace);
    fresh.seek(4);
    expect(fresh.snapshot.state).toEqual(c.snapshot.state);
  });
  it("pauses playback", () => {
    c.play();
    c.seek(2);
    expect(c.snapshot.playing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("moves a selection that points beyond the prefix to the latest applied event", () => {
    for (let i = 0; i < 6; i++) c.step();
    c.seek(2);
    expect(c.snapshot.selectedId).toBe("e02");
  });
  it("keeps a selection that is still inside the prefix", () => {
    for (let i = 0; i < 5; i++) c.step();
    c.select("e01");
    c.seek(3);
    expect(c.snapshot.selectedId).toBe("e01");
  });
  it("clears the selection at position 0, and clamps out-of-range positions", () => {
    c.step();
    c.seek(0);
    expect([c.snapshot.count, c.snapshot.selectedId]).toEqual([0, null]);
    c.seek(99);
    expect(c.snapshot.count).toBe(6);
    c.seek(-3);
    expect(c.snapshot.count).toBe(0);
  });
  it("backward seek removes the failure state", () => {
    for (let i = 0; i < 4; i++) c.step();
    c.seek(3);
    expect(c.snapshot.state.calls.get("e03")!.status).toBe("open");
  });
});

describe("subscriptions and disposal", () => {
  it("notifies subscribers and stops after unsubscribe", () => {
    const fn = vi.fn();
    const off = c.subscribe(fn);
    c.step();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    c.step();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("dispose cancels the timer", () => {
    c.play();
    c.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("dispose is terminal: later calls are no-ops and cannot recreate a timer", () => {
    c.step();
    c.dispose();
    const fn = vi.fn();
    c.subscribe(fn);
    c.play();
    c.step();
    c.select("e01");
    c.seek(5);
    c.reset();
    c.pause();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect([c.snapshot.count, c.snapshot.selectedId, c.snapshot.playing]).toEqual([1, "e01", false]);
    expect(fn).not.toHaveBeenCalled();
  });
  it("a listener is not called after the controller it belonged to is disposed", () => {
    const fn = vi.fn();
    c.subscribe(fn);
    c.dispose();
    c.step();
    expect(fn).not.toHaveBeenCalled();
  });
});
