import { describe, expect, it } from "vitest";
import { fnv1a, replayTo } from "../src/replay";
import { PROTO_IDS, QUOTE_IDS, dump, ev, fixtureJson, loadTrace, mutated, trace5 } from "./helpers";

const trace = loadTrace();
const byId = (id: string) => trace.events.find((e) => e.eventId === id)!;

describe("replayTo basics", () => {
  it("applies the first N events by sequence", () => {
    expect(replayTo(trace, 0).applied).toEqual([]);
    expect(replayTo(trace, 0).latestId).toBeNull();
    expect(replayTo(trace, 3).applied.map((e) => e.eventId)).toEqual(["e01", "e02", "e03"]);
    expect(replayTo(trace, 6).latestId).toBe("e06");
  });
  it("clamps out-of-range, fractional, and non-finite counts", () => {
    expect(replayTo(trace, -4).count).toBe(0);
    expect(replayTo(trace, 99).count).toBe(6);
    expect(replayTo(trace, 2.9).count).toBe(2);
    expect(replayTo(trace, NaN).count).toBe(0);
  });
});

describe("e03 call status is derived, never stored", () => {
  it("e03 is open after three events", () => {
    const s = replayTo(trace, 3);
    expect(s.calls.get("e03")).toEqual({ callId: "e03", status: "open", resultId: null });
    expect(s.openCalls).toEqual(["e03"]);
    expect(s.failedCalls).toEqual([]);
  });
  it("e03 is closed as failed after four events, closed by e04", () => {
    const s = replayTo(trace, 4);
    expect(s.calls.get("e03")).toEqual({ callId: "e03", status: "failed", resultId: "e04" });
    expect(s.openCalls).toEqual([]);
    expect(s.failedCalls).toEqual(["e03"]);
  });
  it("stays failed through the end of the run", () => {
    expect(replayTo(trace, 6).failedCalls).toEqual(["e03"]);
  });
  it("the raw e03 outcome stays 'started' at every position", () => {
    for (let n = 0; n <= 6; n++) replayTo(trace, n);
    expect(byId("e03").outcome).toBe("started");
    expect(replayTo(trace, 6).applied.find((e) => e.eventId === "e03")!.outcome).toBe("started");
  });
  it("a successful result closes the call as succeeded", () => {
    const t = loadTrace(mutated((x) => { ev(x, "e04").outcome = "success"; ev(x, "e04").details = { output: "ok" }; }));
    expect(replayTo(t, 4).calls.get("e03")!.status).toBe("succeeded");
    expect(replayTo(t, 4).failedCalls).toEqual([]);
  });
});

describe("no future leakage", () => {
  it("at position 3 nothing about e04 (or its error) is present", () => {
    const s = replayTo(trace, 3);
    const text = dump(s);
    expect(text).not.toContain("e04");
    expect(text).not.toContain("ENOENT");
    expect(text).not.toContain('"status":"failed"');
    expect(text).not.toContain("failure");
    expect(s.applied.some((e) => e.eventId === "e04")).toBe(false);
  });
});

describe("determinism and immutability", () => {
  it("repeated runs are deeply equal", () => {
    for (let n = 0; n <= 6; n++) expect(replayTo(trace, n)).toEqual(replayTo(trace, n));
  });
  it("each prefix has a distinct fingerprint", () => {
    expect(new Set(Array.from({ length: 7 }, (_, n) => replayTo(trace, n).fingerprint)).size).toBe(7);
  });
  it("shuffled input yields identical replay (sequence ordering)", () => {
    const shuffled = loadTrace(mutated((x) => (x.events = [...x.events].reverse())));
    for (let n = 0; n <= 6; n++) expect(replayTo(shuffled, n)).toEqual(replayTo(trace, n));
  });
  it("timestamps do not affect replay order", () => {
    const skewed = loadTrace(mutated((x) => x.events.forEach((e: any, i: number) => (e.timestamp = `2026-11-07T12:00:0${5 - i}.000Z`))));
    for (let n = 0; n <= 6; n++) expect(replayTo(skewed, n).applied.map((e) => e.eventId)).toEqual(replayTo(trace, n).applied.map((e) => e.eventId));
  });
  it("does not mutate the (frozen) trace", () => {
    const before = JSON.stringify(trace);
    for (let n = 0; n <= 6; n++) replayTo(trace, n);
    expect(JSON.stringify(trace)).toBe(before);
  });
});

describe("e02 / e03 / e04 oracle", () => {
  it("e02 is the planner -> implementer handoff that caused e03", () => {
    const e02 = byId("e02");
    expect([e02.eventType, e02.agentRole, e02.details["toAgentRole"], e02.outcome]).toEqual(["handoff", "planner", "implementer", "success"]);
    expect(e02.details["message"]).toBe("Read requirements.txt and prepare the patch.");
    expect(byId("e03").parentEventId).toBe("e02");
  });
  it("e03 is the failed call: implementer read_file('requirements.txt')", () => {
    const e03 = byId("e03");
    expect([e03.eventType, e03.agentRole, e03.details["toolName"], e03.details["path"]]).toEqual(["tool_call", "implementer", "read_file", "requirements.txt"]);
  });
  it("e04 explains the failure: ENOENT, required file missing, paired to e03", () => {
    const e04 = byId("e04");
    expect([e04.eventType, e04.outcome, e04.details["errorCode"]]).toEqual(["tool_result", "failure", "ENOENT"]);
    expect(e04.details["message"]).toContain("requirements.txt does not exist");
    expect([e04.parentEventId, e04.relatedEventId]).toEqual(["e03", "e03"]);
  });
  it("e05 hands the failure to the reviewer; e06 is a blocked review", () => {
    const e05 = byId("e05");
    expect([e05.agentRole, e05.details["toAgentRole"], e05.parentEventId, e05.relatedEventId]).toEqual(["implementer", "reviewer", "e04", "e03"]);
    const e06 = byId("e06");
    expect([e06.eventType, e06.outcome, e06.relatedEventId]).toEqual(["review_completed", "blocked", "e04"]);
  });
  it("e05 is NOT the handoff that preceded the failed call", () => {
    expect(byId("e03").parentEventId).not.toBe("e05");
    expect(byId("e05").sequence).toBeGreaterThan(byId("e03").sequence);
  });
  it("there is no retry: exactly one tool_call and one tool_result", () => {
    expect(trace.events.filter((e) => e.eventType === "tool_call").map((e) => e.eventId)).toEqual(["e03"]);
    expect(trace.events.filter((e) => e.eventType === "tool_result").map((e) => e.eventId)).toEqual(["e04"]);
    expect(replayTo(trace, 6).calls).toEqual(new Map([["e03", { callId: "e03", status: "failed", resultId: "e04" }]]));
  });
  it("reverse references among applied events", () => {
    const s = replayTo(trace, 6);
    expect(s.referencedBy.get("e03")).toEqual(["e04", "e05"]);
    expect(s.referencedBy.get("e04")).toEqual(["e05", "e06"]);
    expect(replayTo(trace, 3).referencedBy.get("e03")).toBeUndefined();
  });
});

describe("fnv1a", () => {
  it("matches published FNV-1a 32-bit vectors", () => {
    expect(fnv1a("")).toBe("811c9dc5");
    expect(fnv1a("a")).toBe("e40c292c");
    expect(fnv1a("foobar")).toBe("bf9cf968");
  });
});

it("fixture file still parses as JSON (guard for helper)", () => {
  expect(fixtureJson().events).toHaveLength(6);
});


describe("arbitrary event IDs (Object.prototype names)", () => {
  const t = loadTrace(trace5(PROTO_IDS));

  it("validates a trace whose IDs are constructor, toString, __proto__, hasOwnProperty, valueOf", () => {
    expect(t.events.map((e) => e.eventId)).toEqual(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]);
  });

  it("replays every prefix without throwing", () => {
    for (let n = 0; n <= 5; n++) expect(() => replayTo(t, n)).not.toThrow();
  });

  it("(constructor) is a normal key in the reverse-reference index and does not pollute other IDs", () => {
    const s = replayTo(t, 2);
    expect(s.referencedBy.get("constructor")).toEqual(["toString"]);
    expect(s.referencedBy.get("toString")).toBeUndefined();
    expect(s.referencedBy.get("valueOf")).toBeUndefined();
    expect(s.referencedBy.get("__proto__")).toBeUndefined();
    expect(Object.getPrototypeOf(s.referencedBy)).toBe(Map.prototype);
  });

  it("(toString) as a parent is indexed independently", () => {
    expect(replayTo(t, 3).referencedBy.get("toString")).toEqual(["__proto__"]);
  });

  it("(__proto__) is an enumerable call: open at 3, failed at 4, closed by hasOwnProperty", () => {
    expect([...replayTo(t, 3).calls.keys()]).toEqual(["__proto__"]);
    expect(replayTo(t, 3).calls.get("__proto__")).toEqual({ callId: "__proto__", status: "open", resultId: null });
    expect(replayTo(t, 3).openCalls).toEqual(["__proto__"]);
    expect(replayTo(t, 4).calls.get("__proto__")).toEqual({ callId: "__proto__", status: "failed", resultId: "hasOwnProperty" });
    expect(replayTo(t, 4).failedCalls).toEqual(["__proto__"]);
    expect(replayTo(t, 4).openCalls).toEqual([]);
  });

  it("(__proto__) reverse references are recorded for the call", () => {
    expect(replayTo(t, 5).referencedBy.get("__proto__")).toEqual(["hasOwnProperty", "valueOf"]);
    expect(replayTo(t, 5).referencedBy.get("hasOwnProperty")).toEqual(["valueOf"]);
  });

  it("non-call IDs named like Object.prototype members are not calls", () => {
    const s = replayTo(t, 5);
    for (const id of ["constructor", "toString", "hasOwnProperty", "valueOf"]) expect(s.calls.has(id)).toBe(false);
    expect(s.calls.get("constructor")).toBeUndefined();
    expect(s.calls.size).toBe(1);
  });

  it("fingerprints are distinct per prefix and stable across runs", () => {
    const fps = Array.from({ length: 6 }, (_, n) => replayTo(t, n).fingerprint);
    expect(new Set(fps).size).toBe(6);
    expect(fps).toEqual(Array.from({ length: 6 }, (_, n) => replayTo(t, n).fingerprint));
  });

  it("does not leak the future for these IDs (explicit Map contents)", () => {
    const text = dump(replayTo(t, 3));
    expect(text).not.toContain("hasOwnProperty");
    expect(text).not.toContain("valueOf");
    expect(text).not.toContain("ENOENT");
  });

  it("same behavior for IDs with quotes and brackets", () => {
    const q = loadTrace(trace5(QUOTE_IDS));
    expect(replayTo(q, 4).calls.get(QUOTE_IDS.c)).toEqual({ callId: QUOTE_IDS.c, status: "failed", resultId: QUOTE_IDS.d });
    expect(replayTo(q, 5).referencedBy.get(QUOTE_IDS.c)).toEqual([QUOTE_IDS.d, QUOTE_IDS.e]);
  });
});
