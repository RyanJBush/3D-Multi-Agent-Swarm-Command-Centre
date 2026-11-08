import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateTrace } from "../src/validate";
import type { ReplayState } from "../src/replay";
import type { Trace } from "../src/types";

export const FIXTURE_PATH = resolve(process.cwd(), "fixtures/synthetic-trace.json");
export const fixtureText = (): string => readFileSync(FIXTURE_PATH, "utf8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fixtureJson = (): any => JSON.parse(fixtureText());

/** Clone the fixture and apply a mutation. The fixture file itself is never written. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mutated(fn: (t: any) => void): any {
  const t = fixtureJson();
  fn(t);
  return t;
}

/** Index of an event in the raw fixture JSON by eventId. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ev = (t: any, id: string): any => t.events.find((e: any) => e.eventId === id);

export function loadTrace(json: unknown = fixtureJson()): Trace {
  const r = validateTrace(json);
  if (!r.ok) throw new Error("fixture invalid: " + r.issues.map((i) => i.message).join("; "));
  return r.trace;
}

export interface SpecialIds { a: string; b: string; c: string; d: string; e: string }

/**
 * Valid five-event trace with caller-chosen event IDs:
 * a task_started (planner) -> b handoff planner->implementer -> c tool_call (implementer)
 * -> d failed tool_result for c -> e handoff implementer->reviewer (related c).
 */
export function trace5(ids: SpecialIds) {
  const { a, b, c, d, e } = ids;
  const base = (id: string, seq: number, role: string, type: string, parent: string | null, related: string | null, outcome: string, details: object) => ({
    eventId: id, sequence: seq, timestamp: `2026-11-07T12:00:0${seq}.000Z`, agentRole: role, eventType: type,
    parentEventId: parent, relatedEventId: related, outcome, details,
  });
  return {
    schemaVersion: "1.0", runId: "special-ids", synthetic: true,
    events: [
      base(a, 1, "planner", "task_started", null, null, "started", { message: "start" }),
      base(b, 2, "planner", "handoff", a, null, "success", { toAgentRole: "implementer", message: "go" }),
      base(c, 3, "implementer", "tool_call", b, null, "started", { toolName: "read_file", path: "x.txt" }),
      base(d, 4, "implementer", "tool_result", c, c, "failure", { errorCode: "ENOENT", message: "missing" }),
      base(e, 5, "implementer", "handoff", d, c, "success", { toAgentRole: "reviewer", message: "diagnose" }),
    ],
  };
}

/** Event IDs that collide with Object.prototype members. */
export const PROTO_IDS: SpecialIds = { a: "constructor", b: "toString", c: "__proto__", d: "hasOwnProperty", e: "valueOf" };
/** Event IDs containing characters that are special in CSS attribute selectors. */
export const QUOTE_IDS: SpecialIds = { a: 'e"1', b: 'e"2', c: "e\\\"3]", d: "e'4", e: 'e"5' };

/** JSON text of a ReplayState including Map contents (plain JSON.stringify renders a Map as {}). */
export const dump = (s: ReplayState): string => JSON.stringify({ ...s, calls: [...s.calls], referencedBy: [...s.referencedBy] });
