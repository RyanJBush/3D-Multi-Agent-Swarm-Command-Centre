import type { Trace, TraceEvent } from "./types";

export type CallStatus = "open" | "failed" | "succeeded";

export interface CallState {
  readonly callId: string;
  readonly status: CallStatus;
  /** The applied tool_result that closed this call, or null while open. */
  readonly resultId: string | null;
}

export interface ReplayState {
  /** Number of events applied (0..total). */
  readonly count: number;
  readonly total: number;
  /** Applied events in sequence order. Future events are never present. */
  readonly applied: readonly TraceEvent[];
  readonly latestId: string | null;
  /**
   * Derived status for every applied tool_call, keyed by eventId. A Map (not an object) because
   * event IDs are arbitrary nonempty strings, including "constructor" and "__proto__".
   * The raw event outcome is never changed.
   */
  readonly calls: ReadonlyMap<string, CallState>;
  readonly openCalls: readonly string[];
  readonly failedCalls: readonly string[];
  /** id -> applied events that name it as parent or related event (Map: see `calls`). */
  readonly referencedBy: ReadonlyMap<string, readonly string[]>;
  readonly fingerprint: string;
}

/** FNV-1a 32-bit; deterministic, dependency-free, not cryptographic. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Pure replay of the first `count` events by sequence (never by timestamp).
 * No clock, randomness, or I/O; does not mutate the trace.
 */
export function replayTo(trace: Trace, count: number): ReplayState {
  const total = trace.events.length;
  const n = Math.max(0, Math.min(total, Number.isFinite(count) ? Math.trunc(count) : 0));
  const applied = [...trace.events].sort((a, b) => a.sequence - b.sequence).slice(0, n);

  const calls = new Map<string, CallState>();
  const referencedBy = new Map<string, string[]>();
  for (const e of applied) {
    if (e.eventType === "tool_call") calls.set(e.eventId, { callId: e.eventId, status: "open", resultId: null });
    for (const ref of new Set([e.parentEventId, e.relatedEventId])) {
      if (ref === null) continue;
      const list = referencedBy.get(ref);
      if (list) list.push(e.eventId);
      else referencedBy.set(ref, [e.eventId]);
    }
    if (e.eventType === "tool_result" && e.relatedEventId !== null) {
      const call = calls.get(e.relatedEventId);
      if (call && call.status === "open") {
        calls.set(e.relatedEventId, { callId: call.callId, status: e.outcome === "failure" ? "failed" : "succeeded", resultId: e.eventId });
      }
    }
  }
  const openCalls = [...calls.values()].filter((c) => c.status === "open").map((c) => c.callId);
  const failedCalls = [...calls.values()].filter((c) => c.status === "failed").map((c) => c.callId);
  const latestId = applied.length ? applied[applied.length - 1]!.eventId : null;
  // Maps do not JSON-serialize, so fingerprint their entries explicitly (insertion order is deterministic).
  const fingerprint = fnv1a(JSON.stringify({ n, ids: applied.map((e) => e.eventId), calls: [...calls], referencedBy: [...referencedBy] }));
  return { count: n, total, applied, latestId, calls, openCalls, failedCalls, referencedBy, fingerprint };
}
