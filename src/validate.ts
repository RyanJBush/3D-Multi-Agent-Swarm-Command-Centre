import {
  EVENT_TYPES,
  OUTCOMES,
  ROLES,
  SCHEMA_VERSION,
  type IssueCode,
  type Trace,
  type TraceEvent,
  type ValidationIssue,
  type ValidationResult,
} from "./types";

type Rec = Record<string, unknown>;

const EVENT_FIELDS = [
  "eventId",
  "sequence",
  "timestamp",
  "agentRole",
  "eventType",
  "parentEventId",
  "relatedEventId",
  "outcome",
  "details",
] as const;

const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const has = (o: Rec, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const oneOf = (list: readonly string[], v: unknown) => typeof v === "string" && list.includes(v);

/** Exact `YYYY-MM-DDTHH:mm:ss.sssZ` and a real calendar instant (rejects 2026-02-30, 24:00, 60 s). */
export function isValidUtcTimestamp(s: string): boolean {
  if (!TIMESTAMP_SHAPE.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString() === s;
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const child of Object.values(v)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

/**
 * Validate an entire untrusted trace before replay. Collects every issue (never throws,
 * never mutates input). Input array order is irrelevant: the result is sorted by sequence.
 */
export function validateTrace(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const runIssue = (code: IssueCode, field: string, message: string) =>
    issues.push({ code, path: field, field, message: `${field}: ${message}` });

  if (!isRec(input)) {
    issues.push({ code: "NOT_OBJECT", path: "$", message: "Trace must be a JSON object." });
    return { ok: false, issues };
  }
  if (!has(input, "schemaVersion")) runIssue("MISSING_FIELD", "schemaVersion", 'required; must be "1.0".');
  else if (input.schemaVersion !== SCHEMA_VERSION) runIssue("BAD_SCHEMA_VERSION", "schemaVersion", `must be "1.0", found ${JSON.stringify(input.schemaVersion)}.`);
  if (!has(input, "runId")) runIssue("MISSING_FIELD", "runId", "required; must be a nonempty string.");
  else if (!isNonEmptyString(input.runId)) runIssue("WRONG_TYPE", "runId", "must be a nonempty string.");
  if (!has(input, "synthetic")) runIssue("MISSING_FIELD", "synthetic", "required; must be a boolean.");
  else if (typeof input.synthetic !== "boolean") runIssue("WRONG_TYPE", "synthetic", "must be a boolean.");
  if (!has(input, "events")) {
    runIssue("MISSING_FIELD", "events", "required; must be a nonempty array.");
    return { ok: false, issues };
  }
  if (!Array.isArray(input.events)) {
    runIssue("WRONG_TYPE", "events", "must be an array.");
    return { ok: false, issues };
  }
  if (input.events.length === 0) {
    runIssue("EMPTY_TRACE", "events", "must contain at least one event.");
    return { ok: false, issues };
  }

  const raw: unknown[] = input.events;
  const label = (i: number): string => {
    const e = raw[i];
    return isRec(e) && isNonEmptyString(e.eventId) ? e.eventId : `events[${i}]`;
  };
  const evIssue = (code: IssueCode, i: number, field: string, message: string) =>
    issues.push({ code, path: `events[${i}]${field ? "." + field : ""}`, eventId: label(i), field, message: `${label(i)} · ${field || "event"}: ${message}` });

  // ---- Phase 1: per-event shape ----
  raw.forEach((e, i) => {
    if (!isRec(e)) {
      evIssue("NOT_OBJECT", i, "", "event must be an object.");
      return;
    }
    for (const f of EVENT_FIELDS) if (!has(e, f)) evIssue("MISSING_FIELD", i, f, "required field is missing.");
    if (has(e, "eventId") && !isNonEmptyString(e.eventId)) evIssue("WRONG_TYPE", i, "eventId", "must be a nonempty string.");
    if (has(e, "sequence") && !(Number.isSafeInteger(e.sequence) && (e.sequence as number) > 0))
      evIssue("BAD_SEQUENCE", i, "sequence", `must be a positive integer, found ${JSON.stringify(e.sequence)}.`);
    if (has(e, "timestamp") && !(typeof e.timestamp === "string" && isValidUtcTimestamp(e.timestamp)))
      evIssue("BAD_TIMESTAMP", i, "timestamp", `must be a real UTC time formatted YYYY-MM-DDTHH:mm:ss.sssZ, found ${JSON.stringify(e.timestamp)}.`);
    if (has(e, "agentRole") && !oneOf(ROLES, e.agentRole)) evIssue("BAD_ENUM", i, "agentRole", `must be one of ${ROLES.join(", ")}.`);
    if (has(e, "eventType") && !oneOf(EVENT_TYPES, e.eventType)) evIssue("BAD_ENUM", i, "eventType", `must be one of ${EVENT_TYPES.join(", ")}.`);
    if (has(e, "outcome") && !oneOf(OUTCOMES, e.outcome)) evIssue("BAD_ENUM", i, "outcome", `must be one of ${OUTCOMES.join(", ")}.`);
    for (const f of ["parentEventId", "relatedEventId"] as const)
      if (has(e, f) && e[f] !== null && !isNonEmptyString(e[f])) evIssue("WRONG_TYPE", i, f, "must be null or a nonempty event id string.");
    if (has(e, "details") && !isRec(e.details)) evIssue("BAD_DETAILS", i, "details", "must be an object.");
  });

  // ---- Phase 2: cross-event identity, ordering, references ----
  const firstById = new Map<string, number>();
  const firstBySeq = new Map<number, number>();
  raw.forEach((e, i) => {
    if (!isRec(e)) return;
    if (isNonEmptyString(e.eventId)) {
      const prior = firstById.get(e.eventId);
      if (prior === undefined) firstById.set(e.eventId, i);
      else evIssue("DUPLICATE_ID", i, "eventId", `duplicate eventId (first used at events[${prior}]).`);
    }
    if (typeof e.sequence === "number" && Number.isSafeInteger(e.sequence) && e.sequence > 0) {
      const prior = firstBySeq.get(e.sequence);
      if (prior === undefined) firstBySeq.set(e.sequence, i);
      else evIssue("DUPLICATE_SEQUENCE", i, "sequence", `duplicate sequence ${e.sequence} (first used by ${label(prior)}).`);
    }
  });
  let expected = 1;
  for (const seq of [...firstBySeq.keys()].sort((a, b) => a - b)) {
    if (seq !== expected) {
      evIssue("SEQUENCE_GAP", firstBySeq.get(seq)!, "sequence", `sequences must be contiguous from 1: expected ${expected}, found ${seq}.`);
    }
    expected = seq + 1;
  }
  const recAt = (i: number) => raw[i] as Rec;
  const lookup = (id: string): Rec | undefined => {
    const i = firstById.get(id);
    return i === undefined ? undefined : recAt(i);
  };
  raw.forEach((e, i) => {
    if (!isRec(e)) return;
    for (const f of ["parentEventId", "relatedEventId"] as const) {
      const ref = e[f];
      if (!isNonEmptyString(ref)) continue;
      const target = lookup(ref);
      if (!target) evIssue("REF_DANGLING", i, f, `references "${ref}", which is not an event in this run.`);
      else if (typeof target.sequence === "number" && typeof e.sequence === "number" && target.sequence >= e.sequence)
        evIssue("REF_NOT_EARLIER", i, f, `references ${ref} (sequence ${target.sequence}), which is not earlier than this event (sequence ${e.sequence}).`);
    }
  });

  // ---- Phase 3: per-eventType rules ----
  raw.forEach((e, i) => {
    if (!isRec(e) || !isRec(e.details)) return;
    const d = e.details;
    const need = (key: string) => {
      if (!isNonEmptyString(d[key])) evIssue("BAD_DETAILS", i, `details.${key}`, "must be a nonempty string.");
    };
    const outcomeIn = (...allowed: string[]) => {
      if (oneOf(OUTCOMES, e.outcome) && !allowed.includes(e.outcome as string))
        evIssue("BAD_OUTCOME", i, "outcome", `${String(e.eventType)} requires outcome ${allowed.join(" or ")}, found "${String(e.outcome)}".`);
    };
    switch (e.eventType) {
      case "task_started":
        outcomeIn("started");
        need("message");
        break;
      case "handoff":
        outcomeIn("success");
        need("message");
        if (!oneOf(ROLES, d.toAgentRole)) evIssue("BAD_DETAILS", i, "details.toAgentRole", `must be one of ${ROLES.join(", ")}.`);
        else if (d.toAgentRole === e.agentRole) evIssue("BAD_DETAILS", i, "details.toAgentRole", `must differ from the sender's agentRole "${String(e.agentRole)}".`);
        break;
      case "tool_call":
        outcomeIn("started");
        need("toolName");
        need("path");
        break;
      case "tool_result": {
        outcomeIn("success", "failure");
        const { parentEventId: p, relatedEventId: r } = e;
        if (p === null || r === null || p === undefined || r === undefined) {
          evIssue("TOOL_RESULT_MISMATCH", i, p == null ? "parentEventId" : "relatedEventId", "tool_result requires both parentEventId and relatedEventId to identify the paired tool_call.");
        } else if (p !== r) {
          evIssue("TOOL_RESULT_MISMATCH", i, "relatedEventId", `must equal parentEventId (${String(p)}), found ${String(r)}.`);
        } else if (isNonEmptyString(p)) {
          const call = lookup(p);
          if (call) {
            if (call.eventType !== "tool_call") evIssue("TOOL_RESULT_MISMATCH", i, "parentEventId", `${p} is a ${String(call.eventType)}, not a tool_call.`);
            else if (call.agentRole !== e.agentRole)
              evIssue("TOOL_RESULT_MISMATCH", i, "agentRole", `must match the paired call ${p}'s agentRole "${String(call.agentRole)}", found "${String(e.agentRole)}".`);
          }
        }
        if (e.outcome === "failure") {
          need("errorCode");
          need("message");
        }
        break;
      }
      case "review_completed":
        outcomeIn("success", "blocked");
        need("message");
        break;
      default:
        break;
    }
  });

  if (issues.length > 0) return { ok: false, issues };

  const events = (raw as TraceEvent[])
    .map((e) => ({ ...e, details: JSON.parse(JSON.stringify(e.details)) as Record<string, unknown> }))
    .sort((a, b) => a.sequence - b.sequence);
  const trace: Trace = deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId as string,
    synthetic: input.synthetic as boolean,
    events,
  });
  return { ok: true, trace, issues: [] };
}

/** Parse JSON text, then validate. Parse failures become issues. */
export function validateTraceText(text: string): ValidationResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, issues: [{ code: "INVALID_JSON", path: "$", message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  return validateTrace(data);
}

export function formatIssue(i: ValidationIssue): string {
  return `${i.code} — ${i.message} (at ${i.path})`;
}
