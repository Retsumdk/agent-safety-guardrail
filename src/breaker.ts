import { ValidationError } from "./types.js";

export type BreakerState = "closed" | "open" | "half_open";

export type BreakerConfig = {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenMaxProbes: number;
};

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 30_000,
  halfOpenMaxProbes: 1,
};

export type BreakerSnapshot = {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  halfOpenProbes: number;
};

export type TransitionListener = (tool: string, from: BreakerState, to: BreakerState, at: number) => void;

type ToolBreaker = {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  halfOpenProbes: number;
};

export class CircuitBreaker {
  private config: BreakerConfig;
  private clock: () => number;
  private breakers: Map<string, ToolBreaker> = new Map();
  private onTransition: TransitionListener | null;

  constructor(config: Partial<BreakerConfig> = {}, clock: () => number = () => Date.now(), onTransition: TransitionListener | null = null) {
    this.config = {
      failureThreshold: config.failureThreshold ?? DEFAULT_BREAKER_CONFIG.failureThreshold,
      cooldownMs: config.cooldownMs ?? DEFAULT_BREAKER_CONFIG.cooldownMs,
      halfOpenMaxProbes: config.halfOpenMaxProbes ?? DEFAULT_BREAKER_CONFIG.halfOpenMaxProbes,
    };
    if (this.config.failureThreshold < 1) throw new ValidationError(`failureThreshold must be >= 1`);
    if (this.config.cooldownMs < 0) throw new ValidationError(`cooldownMs must be >= 0`);
    if (this.config.halfOpenMaxProbes < 1) throw new ValidationError(`halfOpenMaxProbes must be >= 1`);
    this.clock = clock;
    this.onTransition = onTransition;
  }

  private entry(tool: string): ToolBreaker {
    let entry = this.breakers.get(tool);
    if (!entry) {
      entry = { state: "closed", consecutiveFailures: 0, openedAt: null, halfOpenProbes: 0 };
      this.breakers.set(tool, entry);
    }
    return entry;
  }

  private transition(tool: string, to: BreakerState, at: number): void {
    const entry = this.entry(tool);
    const from = entry.state;
    entry.state = to;
    if (this.onTransition && from !== to) {
      this.onTransition(tool, from, to, at);
    }
  }

  canAttempt(tool: string, at?: number): boolean {
    const now = at ?? this.clock();
    const entry = this.entry(tool);
    if (entry.state === "closed") return true;
    if (entry.state === "open") {
      if (entry.openedAt !== null && now - entry.openedAt >= this.config.cooldownMs) {
        entry.halfOpenProbes = 0;
        this.transition(tool, "half_open", now);
        entry.halfOpenProbes = 1;
        return true;
      }
      return false;
    }
    if (entry.halfOpenProbes < this.config.halfOpenMaxProbes) {
      entry.halfOpenProbes += 1;
      return true;
    }
    return false;
  }

  recordSuccess(tool: string, at?: number): void {
    const now = at ?? this.clock();
    const entry = this.entry(tool);
    entry.consecutiveFailures = 0;
    entry.halfOpenProbes = 0;
    if (entry.state !== "closed") {
      entry.openedAt = null;
      this.transition(tool, "closed", now);
    }
  }

  recordFailure(tool: string, at?: number): void {
    const now = at ?? this.clock();
    const entry = this.entry(tool);
    if (entry.state === "half_open") {
      entry.openedAt = now;
      entry.halfOpenProbes = 0;
      entry.consecutiveFailures = 0;
      this.transition(tool, "open", now);
      return;
    }
    entry.consecutiveFailures += 1;
    if (entry.state === "closed" && entry.consecutiveFailures >= this.config.failureThreshold) {
      entry.openedAt = now;
      this.transition(tool, "open", now);
    }
  }

  noteProbe(tool: string): void {
    const entry = this.entry(tool);
    if (entry.halfOpenProbes < this.config.halfOpenMaxProbes) {
      entry.halfOpenProbes += 1;
    }
  }

  restore(tool: string, snap: { state: BreakerState; consecutiveFailures?: number; openedAt?: number | null; halfOpenProbes?: number }): void {
    const entry = this.entry(tool);
    entry.state = snap.state;
    entry.consecutiveFailures = snap.consecutiveFailures ?? 0;
    entry.openedAt = snap.openedAt ?? null;
    entry.halfOpenProbes = snap.halfOpenProbes ?? 0;
  }

  snapshot(tool: string): BreakerSnapshot {
    const entry = this.entry(tool);
    return { state: entry.state, consecutiveFailures: entry.consecutiveFailures, openedAt: entry.openedAt, halfOpenProbes: entry.halfOpenProbes };
  }

  reset(tool: string, at?: number): void {
    const now = at ?? this.clock();
    const entry = this.entry(tool);
    const from = entry.state;
    entry.state = "closed";
    entry.consecutiveFailures = 0;
    entry.openedAt = null;
    entry.halfOpenProbes = 0;
    if (this.onTransition && from !== "closed") {
      this.onTransition(tool, from, "closed", now);
    }
  }

  toolNames(): string[] {
    return [...this.breakers.keys()].sort();
  }

  configValue(): BreakerConfig {
    return { ...this.config };
  }
}
