import { describe, expect, it } from "vitest";
import { formatIssue, isValidUtcTimestamp, validateTrace, validateTraceText } from "../src/validate";
import { ev, fixtureJson, fixtureText, mutated } from "./helpers";

const issuesOf = (v: unknown) => {
  const r = validateTrace(v);
  return r.ok ? [] : r.issues;
};

/** True if some issue has this code, event, and field. */
const has = (v: unknown, code: string, eventId?: string, field?: string) =>
  issuesOf(v).some((i) => i.code === code && (eventId === undefined || i.eventId === eventId) && (field === undefined || i.field === field));

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

describe("canonical fixture", () => {
  it("is accepted unchanged and normalized by sequence", () => {
    const r = validateTraceText(fixtureText());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trace.runId).toBe("synthetic-001");
    expect(r.trace.synthetic).toBe(true);
    expect(r.trace.events.map((e) => e.eventId)).toEqual(["e01", "e02", "e03", "e04", "e05", "e06"]);
  });

  it("is not mutated by validation, and the normalized trace is deeply frozen", () => {
    const r = validateTrace(deepFreeze(fixtureJson()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.isFrozen(r.trace)).toBe(true);
    expect(Object.isFrozen(r.trace.events[2]!.details)).toBe(true);
    expect(() => {
      (r.trace.events[2] as { outcome: string }).outcome = "failure";
    }).toThrow();
  });
});

describe("ordering", () => {
  it("normalizes shuffled input by sequence", () => {
    const t = mutated((x) => {
      const e = x.events;
      x.events = [e[4], e[1], e[5], e[0], e[3], e[2]];
    });
    const r = validateTrace(t);
    expect(r.ok && r.trace.events.map((e) => e.eventId)).toEqual(["e01", "e02", "e03", "e04", "e05", "e06"]);
    expect(r.ok && r.trace.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("orders by sequence even when timestamps are repeated or out of order", () => {
    const same = mutated((x) => x.events.forEach((e: any) => (e.timestamp = "2026-11-07T12:00:00.000Z")));
    const reversed = mutated((x) => x.events.forEach((e: any, i: number) => (e.timestamp = `2026-11-07T12:00:0${5 - i}.000Z`)));
    for (const t of [same, reversed]) {
      const r = validateTrace(t);
      expect(r.ok && r.trace.events.map((e) => e.eventId)).toEqual(["e01", "e02", "e03", "e04", "e05", "e06"]);
    }
  });
});

describe("run-level rejections", () => {
  it.each([
    ["wrong schemaVersion", (t: any) => (t.schemaVersion = "2.0"), "BAD_SCHEMA_VERSION", "schemaVersion"],
    ["numeric schemaVersion", (t: any) => (t.schemaVersion = 1), "BAD_SCHEMA_VERSION", "schemaVersion"],
    ["missing schemaVersion", (t: any) => delete t.schemaVersion, "MISSING_FIELD", "schemaVersion"],
    ["empty runId", (t: any) => (t.runId = ""), "WRONG_TYPE", "runId"],
    ["missing runId", (t: any) => delete t.runId, "MISSING_FIELD", "runId"],
    ["synthetic as string", (t: any) => (t.synthetic = "true"), "WRONG_TYPE", "synthetic"],
    ["missing synthetic", (t: any) => delete t.synthetic, "MISSING_FIELD", "synthetic"],
    ["missing events", (t: any) => delete t.events, "MISSING_FIELD", "events"],
    ["events not an array", (t: any) => (t.events = {}), "WRONG_TYPE", "events"],
    ["empty events", (t: any) => (t.events = []), "EMPTY_TRACE", "events"],
  ])("rejects %s", (_n, fn, code, field) => {
    expect(has(mutated(fn), code, undefined, field)).toBe(true);
  });

  it.each([null, 42, "x", [], undefined])("rejects non-object root %j", (v) => {
    expect(issuesOf(v).map((i) => i.code)).toEqual(["NOT_OBJECT"]);
  });

  it("reports invalid JSON text as an issue", () => {
    const r = validateTraceText("{not json");
    expect(!r.ok && r.issues[0]!.code).toBe("INVALID_JSON");
  });
});

describe("event field rejections", () => {
  const FIELDS = ["eventId", "sequence", "timestamp", "agentRole", "eventType", "parentEventId", "relatedEventId", "outcome", "details"];
  it.each(FIELDS)("rejects a missing %s and names the event and field", (f) => {
    const t = mutated((x) => delete ev(x, "e03")[f]);
    const i = issuesOf(t).find((x) => x.code === "MISSING_FIELD" && x.field === f);
    expect(i).toBeDefined();
    expect(i!.path).toBe(`events[2].${f}`);
    expect(i!.message).toContain(f);
    if (f !== "eventId") expect(i!.eventId).toBe("e03");
  });

  it.each([
    ["sequence 0", (t: any) => (ev(t, "e03").sequence = 0), "BAD_SEQUENCE"],
    ["negative sequence", (t: any) => (ev(t, "e03").sequence = -3), "BAD_SEQUENCE"],
    ["fractional sequence", (t: any) => (ev(t, "e03").sequence = 3.5), "BAD_SEQUENCE"],
    ["string sequence", (t: any) => (ev(t, "e03").sequence = "3"), "BAD_SEQUENCE"],
    ["empty eventId", (t: any) => (ev(t, "e03").eventId = ""), "WRONG_TYPE"],
    ["numeric eventId", (t: any) => (ev(t, "e03").eventId = 3), "WRONG_TYPE"],
    ["bad agentRole", (t: any) => (ev(t, "e03").agentRole = "manager"), "BAD_ENUM"],
    ["bad eventType", (t: any) => (ev(t, "e03").eventType = "retry"), "BAD_ENUM"],
    ["bad outcome value", (t: any) => (ev(t, "e03").outcome = "done"), "BAD_ENUM"],
    ["details null", (t: any) => (ev(t, "e03").details = null), "BAD_DETAILS"],
    ["details array", (t: any) => (ev(t, "e03").details = []), "BAD_DETAILS"],
    ["parentEventId empty string", (t: any) => (ev(t, "e03").parentEventId = ""), "WRONG_TYPE"],
    ["relatedEventId number", (t: any) => (ev(t, "e03").relatedEventId = 2), "WRONG_TYPE"],
  ])("rejects %s", (_n, fn, code) => {
    expect(issuesOf(mutated(fn)).some((i) => i.code === code)).toBe(true);
  });

  it("rejects a non-object event", () => {
    expect(issuesOf(mutated((t) => (t.events[0] = null))).some((i) => i.code === "NOT_OBJECT")).toBe(true);
  });
});

describe("timestamps", () => {
  it.each([
    "2026-02-30T12:00:00.000Z", // impossible date
    "2026-13-01T12:00:00.000Z", // month 13
    "2026-11-07T24:00:00.000Z", // hour 24
    "2026-11-07T12:60:00.000Z",
    "2026-11-07T12:00:60.000Z", // leap-second style
    "2026-11-07T12:00:00Z", // missing milliseconds
    "2026-11-07T12:00:00.00Z",
    "2026-11-07T12:00:00.000+00:00", // offset instead of Z
    "2026-11-07T12:00:00.000", // no zone
    "2026-11-07 12:00:00.000Z",
    "2025-02-29T00:00:00.000Z", // non-leap year
    "yesterday",
    "",
  ])("rejects %j", (ts) => {
    expect(isValidUtcTimestamp(ts)).toBe(false);
    expect(has(mutated((t) => (ev(t, "e02").timestamp = ts)), ts === "" ? "BAD_TIMESTAMP" : "BAD_TIMESTAMP", "e02", "timestamp")).toBe(true);
  });

  it.each(["2024-02-29T00:00:00.000Z", "2026-12-31T23:59:59.999Z", "2026-11-07T12:00:00.000Z"])("accepts %j", (ts) => {
    expect(isValidUtcTimestamp(ts)).toBe(true);
  });

  it("rejects a non-string timestamp", () => {
    expect(has(mutated((t) => (ev(t, "e02").timestamp = 1762516801000)), "BAD_TIMESTAMP", "e02", "timestamp")).toBe(true);
  });
});

describe("identity, sequence, and references", () => {
  it("rejects duplicate eventIds", () => {
    expect(has(mutated((t) => (ev(t, "e03").eventId = "e02")), "DUPLICATE_ID", "e02", "eventId")).toBe(true);
  });
  it("rejects duplicate sequences", () => {
    expect(has(mutated((t) => (ev(t, "e04").sequence = 3)), "DUPLICATE_SEQUENCE", "e04", "sequence")).toBe(true);
  });
  it("rejects sequence gaps", () => {
    expect(has(mutated((t) => (ev(t, "e06").sequence = 8)), "SEQUENCE_GAP", "e06", "sequence")).toBe(true);
  });
  it("rejects sequences that do not start at 1", () => {
    expect(has(mutated((t) => t.events.forEach((e: any) => e.sequence++)), "SEQUENCE_GAP", "e01", "sequence")).toBe(true);
  });
  it("rejects dangling parentEventId and relatedEventId", () => {
    expect(has(mutated((t) => (ev(t, "e05").parentEventId = "zzz")), "REF_DANGLING", "e05", "parentEventId")).toBe(true);
    expect(has(mutated((t) => (ev(t, "e05").relatedEventId = "zzz")), "REF_DANGLING", "e05", "relatedEventId")).toBe(true);
  });
  it("rejects forward and self references", () => {
    expect(has(mutated((t) => (ev(t, "e02").parentEventId = "e05")), "REF_NOT_EARLIER", "e02", "parentEventId")).toBe(true);
    expect(has(mutated((t) => (ev(t, "e05").relatedEventId = "e06")), "REF_NOT_EARLIER", "e05", "relatedEventId")).toBe(true);
    expect(has(mutated((t) => (ev(t, "e02").parentEventId = "e02")), "REF_NOT_EARLIER", "e02", "parentEventId")).toBe(true);
  });
  it("judges 'earlier' by sequence, not array position or timestamp", () => {
    const t = mutated((x) => {
      x.events.reverse(); // array order is irrelevant
      ev(x, "e01").timestamp = "2030-01-01T00:00:00.000Z"; // timestamp is irrelevant
    });
    expect(validateTrace(t).ok).toBe(true);
  });
});

describe("eventType rules", () => {
  it.each([
    ["task_started outcome", (t: any) => (ev(t, "e01").outcome = "success"), "BAD_OUTCOME", "e01", "outcome"],
    ["task_started empty message", (t: any) => (ev(t, "e01").details.message = " "), "BAD_DETAILS", "e01", "details.message"],
    ["handoff outcome", (t: any) => (ev(t, "e02").outcome = "failure"), "BAD_OUTCOME", "e02", "outcome"],
    ["handoff missing message", (t: any) => delete ev(t, "e02").details.message, "BAD_DETAILS", "e02", "details.message"],
    ["handoff to unknown role", (t: any) => (ev(t, "e02").details.toAgentRole = "ceo"), "BAD_DETAILS", "e02", "details.toAgentRole"],
    ["handoff missing toAgentRole", (t: any) => delete ev(t, "e02").details.toAgentRole, "BAD_DETAILS", "e02", "details.toAgentRole"],
    ["handoff to self", (t: any) => (ev(t, "e02").details.toAgentRole = "planner"), "BAD_DETAILS", "e02", "details.toAgentRole"],
    ["tool_call outcome", (t: any) => (ev(t, "e03").outcome = "success"), "BAD_OUTCOME", "e03", "outcome"],
    ["tool_call missing toolName", (t: any) => delete ev(t, "e03").details.toolName, "BAD_DETAILS", "e03", "details.toolName"],
    ["tool_call empty path", (t: any) => (ev(t, "e03").details.path = ""), "BAD_DETAILS", "e03", "details.path"],
    ["tool_result outcome started", (t: any) => (ev(t, "e04").outcome = "started"), "BAD_OUTCOME", "e04", "outcome"],
    ["failed result missing errorCode", (t: any) => delete ev(t, "e04").details.errorCode, "BAD_DETAILS", "e04", "details.errorCode"],
    ["failed result empty message", (t: any) => (ev(t, "e04").details.message = ""), "BAD_DETAILS", "e04", "details.message"],
    ["review outcome", (t: any) => (ev(t, "e06").outcome = "failure"), "BAD_OUTCOME", "e06", "outcome"],
    ["review missing message", (t: any) => delete ev(t, "e06").details.message, "BAD_DETAILS", "e06", "details.message"],
  ])("rejects %s", (_n, fn, code, id, field) => {
    expect(has(mutated(fn), code, id, field)).toBe(true);
  });

  describe("mismatched tool_result", () => {
    it("parentEventId and relatedEventId differ", () => {
      expect(has(mutated((t) => (ev(t, "e04").relatedEventId = "e02")), "TOOL_RESULT_MISMATCH", "e04")).toBe(true);
    });
    it("relatedEventId is null", () => {
      expect(has(mutated((t) => (ev(t, "e04").relatedEventId = null)), "TOOL_RESULT_MISMATCH", "e04")).toBe(true);
    });
    it("parentEventId is null", () => {
      expect(has(mutated((t) => (ev(t, "e04").parentEventId = null)), "TOOL_RESULT_MISMATCH", "e04")).toBe(true);
    });
    it("both point at an event that is not a tool_call", () => {
      expect(has(mutated((t) => { ev(t, "e04").parentEventId = "e02"; ev(t, "e04").relatedEventId = "e02"; }), "TOOL_RESULT_MISMATCH", "e04", "parentEventId")).toBe(true);
    });
    it("result and call have different agentRole", () => {
      expect(has(mutated((t) => (ev(t, "e04").agentRole = "reviewer")), "TOOL_RESULT_MISMATCH", "e04", "agentRole")).toBe(true);
    });
  });

  it("accepts a successful tool_result without error fields", () => {
    const t = mutated((x) => {
      const r = ev(x, "e04");
      r.outcome = "success";
      r.details = { output: "ok" };
    });
    expect(validateTrace(t).ok).toBe(true);
  });
  it("accepts review_completed with outcome success", () => {
    expect(validateTrace(mutated((t) => (ev(t, "e06").outcome = "success"))).ok).toBe(true);
  });
});

describe("error reporting", () => {
  it("collects every problem in one pass, with event and field", () => {
    const t = mutated((x) => {
      ev(x, "e02").timestamp = "2026-02-30T12:00:00.000Z";
      delete ev(x, "e04").details.errorCode;
      ev(x, "e05").parentEventId = "nope";
    });
    const issues = issuesOf(t);
    expect(issues.map((i) => `${i.eventId}:${i.field}`).sort()).toEqual(["e02:timestamp", "e04:details.errorCode", "e05:parentEventId"]);
  });
  it("formats messages naming the offending event and field", () => {
    const i = issuesOf(mutated((x) => delete ev(x, "e04").details.errorCode))[0]!;
    expect(i.message).toContain("e04");
    expect(i.message).toContain("details.errorCode");
    expect(formatIssue(i)).toContain("events[3].details.errorCode");
  });
});

describe("arbitrary IDs and keys in the validator", () => {
  it("detects duplicate eventIds that are Object.prototype names", () => {
    for (const id of ["__proto__", "constructor", "toString"]) {
      const t = mutated((x) => { const a = ev(x, "e02"), b = ev(x, "e03"); a.eventId = id; b.eventId = id; });
      expect(has(t, "DUPLICATE_ID", id, "eventId")).toBe(true);
    }
  });
  it("accepts a details object with an own '__proto__' key from JSON text and preserves it", () => {
    const text = fixtureText().replace('"path": "requirements.txt"', '"path": "requirements.txt", "__proto__": "kept", "constructor": "also kept"');
    const r = validateTraceText(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.trace.events[2]!.details;
    expect(Object.keys(d)).toEqual(["toolName", "path", "__proto__", "constructor"]);
    expect(Object.getOwnPropertyDescriptor(d, "__proto__")!.value).toBe("kept");
    expect(Object.getPrototypeOf(d)).toBe(Object.prototype); // not replaced
  });
});
