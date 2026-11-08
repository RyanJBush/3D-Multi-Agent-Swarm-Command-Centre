import type { ReplayState } from "./replay";
import { ROLES, type AgentRole, type TraceEvent } from "./types";

/**
 * Pure projection of ReplayState for the 3D view (and its text equivalent). It holds no state of
 * its own: every value is derived from events that have already been applied, so nothing about
 * unrevealed events can appear here.
 */
export interface GraphNode {
  readonly role: AgentRole;
  /** Latest applied event authored by this role, or null ("No events yet"). */
  readonly latestEventId: string | null;
}
export interface GraphEdge {
  readonly eventId: string;
  readonly from: AgentRole;
  readonly to: AgentRole;
  readonly sequence: number;
}
export interface FailureMarker {
  /** The failed tool_call. */
  readonly callId: string;
  /** The applied failed tool_result that explains it. */
  readonly resultId: string;
  /** Role that made the call. */
  readonly role: AgentRole;
  readonly toolName: string;
  readonly path: string;
  readonly errorCode: string;
}
export interface GraphModel {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly failures: readonly FailureMarker[];
}

const isRole = (v: unknown): v is AgentRole => typeof v === "string" && (ROLES as readonly string[]).includes(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function latestEventForRole(state: ReplayState, role: AgentRole): TraceEvent | null {
  for (let i = state.applied.length - 1; i >= 0; i--) {
    const e = state.applied[i]!;
    if (e.agentRole === role) return e;
  }
  return null;
}

export function buildGraph(state: ReplayState): GraphModel {
  const nodes = ROLES.map((role) => ({ role, latestEventId: latestEventForRole(state, role)?.eventId ?? null }));

  const edges: GraphEdge[] = [];
  for (const e of state.applied) {
    const to = e.details["toAgentRole"];
    if (e.eventType === "handoff" && isRole(to)) edges.push({ eventId: e.eventId, from: e.agentRole, to, sequence: e.sequence });
  }

  const byId = new Map(state.applied.map((e) => [e.eventId, e]));
  const failures: FailureMarker[] = [];
  for (const call of state.calls.values()) {
    if (call.status !== "failed" || call.resultId === null) continue;
    const callEvent = byId.get(call.callId);
    const result = byId.get(call.resultId);
    if (!callEvent || !result) continue;
    failures.push({
      callId: call.callId,
      resultId: call.resultId,
      role: callEvent.agentRole,
      toolName: str(callEvent.details["toolName"]),
      path: str(callEvent.details["path"]),
      errorCode: str(result.details["errorCode"]),
    });
  }
  return { nodes, edges, failures };
}

/** The 3D view's contract with the app. Kept free of Three.js so the app can load the renderer lazily. */
export interface View3DHandlers {
  onPickNode(role: AgentRole): void;
  onPickEdge(eventId: string): void;
  onPickFailure(callId: string): void;
  /** The WebGL context was lost; the app falls back to the 2D table. */
  onContextLost(): void;
}
export interface View3D {
  update(graph: GraphModel, selectedEventId: string | null): void;
  dispose(): void;
}
/** Resolves with a ready view, or rejects (WebGL unavailable, module load failure, ...). */
export type View3DFactory = (container: HTMLElement, handlers: View3DHandlers) => Promise<View3D>;
