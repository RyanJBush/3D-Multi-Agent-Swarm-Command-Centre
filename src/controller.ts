import { replayTo, type ReplayState } from "./replay";
import type { Trace } from "./types";

export interface ReplaySnapshot {
  readonly count: number;
  readonly total: number;
  readonly playing: boolean;
  /** Always null or an id of an applied (revealed) event. */
  readonly selectedId: string | null;
  readonly state: ReplayState;
}

export const PLAY_INTERVAL_MS = 1000;

/**
 * Replay position, selection, and playback timer. No DOM or rendering dependency, so a
 * the 2D table and the 3D graph both share this one controller (neither keeps replay state of its own).
 *
 * Rules: Step applies exactly one event and selects it (and pauses playback). A Play tick does
 * the same. Selecting a revealed event pauses and leaves the count unchanged. Seeking pauses,
 * recomputes from the prefix, and moves a now-hidden selection to the latest applied event
 * (or clears it at position 0). At most one timer ever exists. `dispose()` is terminal: it cancels
 * the timer and drops listeners, and every later call is a no-op (no timer can be recreated).
 */
export class ReplayController {
  readonly #trace: Trace;
  readonly #intervalMs: number;
  #count = 0;
  #disposed = false;
  #selectedId: string | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #state: ReplayState;
  readonly #listeners = new Set<() => void>();

  constructor(trace: Trace, intervalMs: number = PLAY_INTERVAL_MS) {
    this.#trace = trace;
    this.#intervalMs = intervalMs;
    this.#state = replayTo(trace, 0);
  }

  get snapshot(): ReplaySnapshot {
    return { count: this.#count, total: this.#trace.events.length, playing: this.#timer !== null, selectedId: this.#selectedId, state: this.#state };
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  step(): void {
    if (this.#disposed) return;
    this.#stopTimer();
    this.#advance();
    this.#emit();
  }

  play(): void {
    if (this.#disposed) return;
    if (this.#timer !== null || this.#count >= this.#trace.events.length) return;
    this.#timer = setInterval(() => {
      this.#advance();
      if (this.#count >= this.#trace.events.length) this.#stopTimer();
      this.#emit();
    }, this.#intervalMs);
    this.#emit();
  }

  pause(): void {
    if (this.#disposed) return;
    if (this.#timer === null) return;
    this.#stopTimer();
    this.#emit();
  }

  reset(): void {
    if (this.#disposed) return;
    this.#stopTimer();
    this.#setCount(0);
    this.#selectedId = null;
    this.#emit();
  }

  /** Select an already-revealed event. Ignored for unrevealed or unknown ids. */
  select(eventId: string): void {
    if (this.#disposed) return;
    if (!this.#state.applied.some((e) => e.eventId === eventId)) return;
    this.#stopTimer();
    this.#selectedId = eventId;
    this.#emit();
  }

  seek(position: number): void {
    if (this.#disposed) return;
    this.#stopTimer();
    this.#setCount(position);
    if (this.#selectedId !== null && !this.#state.applied.some((e) => e.eventId === this.#selectedId)) {
      this.#selectedId = this.#state.latestId;
    }
    this.#emit();
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopTimer();
    this.#listeners.clear();
  }

  #advance(): void {
    if (this.#count >= this.#trace.events.length) return;
    this.#setCount(this.#count + 1);
    this.#selectedId = this.#state.latestId;
  }

  #setCount(n: number): void {
    this.#state = replayTo(this.#trace, n);
    this.#count = this.#state.count;
  }

  #stopTimer(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #emit(): void {
    for (const fn of [...this.#listeners]) fn();
  }
}
