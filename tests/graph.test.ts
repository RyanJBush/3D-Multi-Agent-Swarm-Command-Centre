import { describe, expect, it } from "vitest";
import { buildGraph, latestEventForRole } from "../src/graph";
import { replayTo } from "../src/replay";
import { PROTO_IDS, ev, loadTrace, mutated, trace5 } from "./helpers";

const trace = loadTrace();
const g = (n: number) => buildGraph(replayTo(trace, n));
const latest = (n: number) => Object.fromEntries(g(n).nodes.map((x) => [x.role, x.latestEventId]));

describe("nodes", () => {
  it("are always the three fixed roles, in a fixed order", () => {
    for (let n = 0; n <= 6; n++) expect(g(n).nodes.map((x) => x.role)).toEqual(["planner", "implementer", "reviewer"]);
  });
  it("have no latest event until one of their own is revealed (no invented events)", () => {
    expect(latest(0)).toEqual({ planner: null, implementer: null, reviewer: null });
    expect(latest(2)).toEqual({ planner: "e02", implementer: null, reviewer: null });
  });
  it("track each role's latest revealed event", () => {
    expect(latest(3)).toEqual({ planner: "e02", implementer: "e03", reviewer: null });
    expect(latest(4)).toEqual({ planner: "e02", implementer: "e04", reviewer: null });
    expect(latest(5)).toEqual({ planner: "e02", implementer: "e05", reviewer: null });
    expect(latest(6)).toEqual({ planner: "e02", implementer: "e05", reviewer: "e06" });
  });
  it("latestEventForRole returns the event, or null", () => {
    expect(latestEventForRole(replayTo(trace, 2), "planner")!.eventId).toBe("e02");
    expect(latestEventForRole(replayTo(trace, 2), "reviewer")).toBeNull();
  });
});

describe("handoff edges appear only when their events are applied", () => {
  const edges = (n: number) => g(n).edges.map((e) => `${e.eventId}:${e.from}>${e.to}`);
  it("none before e02", () => {
    expect(edges(0)).toEqual([]);
    expect(edges(1)).toEqual([]);
  });
  it("e02 planner -> implementer from position 2", () => {
    expect(edges(2)).toEqual(["e02:planner>implementer"]);
    expect(edges(4)).toEqual(["e02:planner>implementer"]); // e05 not yet revealed
  });
  it("e05 implementer -> reviewer from position 5", () => {
    expect(edges(5)).toEqual(["e02:planner>implementer", "e05:implementer>reviewer"]);
    expect(edges(6)).toEqual(edges(5));
  });
  it("non-handoff events never produce edges", () => {
    expect(g(6).edges).toHaveLength(2);
  });
});

describe("failure marker", () => {
  it("absent until e04 is applied, then links failed call e03 and explanation e04", () => {
    for (const n of [0, 1, 2, 3]) expect(g(n).failures).toEqual([]);
    expect(g(4).failures).toEqual([{ callId: "e03", resultId: "e04", role: "implementer", toolName: "read_file", path: "requirements.txt", errorCode: "ENOENT" }]);
    expect(g(6).failures).toHaveLength(1);
  });
  it("is not duplicated for a retry-free trace (exactly one failure)", () => {
    expect(g(6).failures.map((f) => f.callId)).toEqual(["e03"]);
  });
});

describe("no future leakage", () => {
  it("position 3 contains nothing about e04, e05, e06, ENOENT, or reviewer events", () => {
    const text = JSON.stringify(g(3));
    for (const s of ["e04", "e05", "e06", "ENOENT"]) expect(text).not.toContain(s);
  });
});

describe("arbitrary event IDs", () => {
  it("works for constructor / toString / __proto__ IDs", () => {
    const t = loadTrace(trace5(PROTO_IDS));
    const m = buildGraph(replayTo(t, 5));
    expect(m.edges.map((e) => e.eventId)).toEqual(["toString", "valueOf"]);
    expect(m.failures).toEqual([{ callId: "__proto__", resultId: "hasOwnProperty", role: "implementer", toolName: "read_file", path: "x.txt", errorCode: "ENOENT" }]);
  });
});

describe("only real handoffs and real failures are drawn", () => {
  it("a non-handoff event carrying a toAgentRole detail does not create an edge", () => {
    const t = loadTrace(mutated((x) => { ev(x, "e01").details.toAgentRole = "reviewer"; ev(x, "e03").details.toAgentRole = "planner"; ev(x, "e06").details.toAgentRole = "planner"; }));
    expect(buildGraph(replayTo(t, 6)).edges.map((e) => e.eventId)).toEqual(["e02", "e05"]);
  });
  it("a successful tool_result produces no failure marker", () => {
    const t = loadTrace(mutated((x) => { ev(x, "e04").outcome = "success"; ev(x, "e04").details = { output: "ok" }; }));
    expect(buildGraph(replayTo(t, 4)).failures).toEqual([]);
    expect(buildGraph(replayTo(t, 6)).failures).toEqual([]);
  });
  it("an open call (no result yet) produces no failure marker", () => {
    expect(buildGraph(replayTo(trace, 3)).failures).toEqual([]);
  });
});
