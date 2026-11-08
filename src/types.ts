/** Trace contract, schemaVersion "1.0" (canonical contract supplied by ChatGPT). */
export const SCHEMA_VERSION = "1.0" as const;
export const ROLES = ["planner", "implementer", "reviewer"] as const;
export const EVENT_TYPES = ["task_started", "handoff", "tool_call", "tool_result", "review_completed"] as const;
export const OUTCOMES = ["started", "success", "failure", "blocked"] as const;

export type AgentRole = (typeof ROLES)[number];
export type EventType = (typeof EVENT_TYPES)[number];
export type Outcome = (typeof OUTCOMES)[number];

export interface TraceEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly agentRole: AgentRole;
  readonly eventType: EventType;
  /** Immediate causal predecessor, or null. */
  readonly parentEventId: string | null;
  /** Associated evidence or paired call, or null. */
  readonly relatedEventId: string | null;
  readonly outcome: Outcome;
  readonly details: Readonly<Record<string, unknown>>;
}

/** A validated trace. `events` is normalized: sorted by sequence, deep-frozen copy of the input. */
export interface Trace {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly runId: string;
  readonly synthetic: boolean;
  readonly events: readonly TraceEvent[];
}

export type IssueCode =
  | "INVALID_JSON"
  | "NOT_OBJECT"
  | "BAD_SCHEMA_VERSION"
  | "MISSING_FIELD"
  | "WRONG_TYPE"
  | "BAD_ENUM"
  | "BAD_OUTCOME"
  | "BAD_TIMESTAMP"
  | "BAD_SEQUENCE"
  | "BAD_DETAILS"
  | "DUPLICATE_ID"
  | "DUPLICATE_SEQUENCE"
  | "SEQUENCE_GAP"
  | "REF_DANGLING"
  | "REF_NOT_EARLIER"
  | "TOOL_RESULT_MISMATCH"
  | "EMPTY_TRACE";

export interface ValidationIssue {
  readonly code: IssueCode;
  /** JSON-path style location, e.g. `events[3].details.errorCode`. */
  readonly path: string;
  /** Offending event's eventId when known, otherwise `events[i]`; absent for run-level issues. */
  readonly eventId?: string;
  /** Offending field relative to the event (e.g. `details.toolName`) or run-level field. */
  readonly field?: string;
  /** Human-readable text that already names the event and field. */
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly trace: Trace; readonly issues: readonly [] }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };
