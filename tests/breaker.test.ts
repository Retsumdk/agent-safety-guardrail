import { describe, test, expect } from "bun:test";
import { CircuitBreaker, DEFAULT_BREAKER_CONFIG } from "../src/breaker.js";

describe("CircuitBreaker", () => {
  test("default config", () => {
    expect(DEFAULT_BREAKER_CONFIG).toEqual({ failureThreshold: 3, cooldownMs: 30_000, halfOpenMaxProbes: 1 });
  });

  test("rejects invalid config", () => {
    expect(() => new CircuitBreaker({ failureThreshold: 0 })).toThrow("failureThreshold must be >= 1");
    expect(() => new CircuitBreaker({ cooldownMs: -1 })).toThrow("cooldownMs must be >= 0");
    expect(() => new CircuitBreaker({ halfOpenMaxProbes: 0 })).toThrow("halfOpenMaxProbes must be >= 1");
  });

  test("stays closed below the failure threshold", () => {
    const b = new CircuitBreaker({ failureThreshold: 3 });
    b.recordFailure("t", 100);
    b.recordFailure("t", 200);
    expect(b.snapshot("t")).toEqual({ state: "closed", consecutiveFailures: 2, openedAt: null, halfOpenProbes: 0 });
    expect(b.canAttempt("t", 300)).toBe(true);
  });

  test("opens at the threshold and denies until cooldown elapses", () => {
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000 });
    b.recordFailure("t", 0);
    b.recordFailure("t", 10);
    expect(b.snapshot("t").state).toBe("open");
    expect(b.canAttempt("t", 500)).toBe(false);
    expect(b.snapshot("t").state).toBe("open");
  });

  test("cooldown elapses: first canAttempt moves to half_open and grants one probe", () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, halfOpenMaxProbes: 1 });
    b.recordFailure("t", 0);
    expect(b.canAttempt("t", 999)).toBe(false);
    expect(b.canAttempt("t", 1_000)).toBe(true);
    expect(b.snapshot("t").state).toBe("half_open");
    expect(b.canAttempt("t", 1_001)).toBe(false);
  });

  test("probe success closes the circuit", () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000 });
    b.recordFailure("t", 0);
    expect(b.canAttempt("t", 1_000)).toBe(true);
    b.recordSuccess("t", 1_100);
    expect(b.snapshot("t")).toEqual({ state: "closed", consecutiveFailures: 0, openedAt: null, halfOpenProbes: 0 });
  });

  test("probe failure reopens with a fresh cooldown", () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000 });
    b.recordFailure("t", 0);
    expect(b.canAttempt("t", 1_000)).toBe(true);
    b.recordFailure("t", 1_100);
    expect(b.snapshot("t")).toEqual({ state: "open", consecutiveFailures: 0, openedAt: 1_100, halfOpenProbes: 0 });
    expect(b.canAttempt("t", 2_000)).toBe(false);
    expect(b.canAttempt("t", 2_101)).toBe(true);
  });

  test("success in closed state resets consecutive failures", () => {
    const b = new CircuitBreaker({ failureThreshold: 3 });
    b.recordFailure("t", 0);
    b.recordSuccess("t", 10);
    b.recordFailure("t", 20);
    b.recordFailure("t", 30);
    expect(b.snapshot("t").state).toBe("closed");
  });

  test("halfOpenMaxProbes bounds concurrent probes", () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, halfOpenMaxProbes: 2 });
    b.recordFailure("t", 0);
    expect(b.canAttempt("t", 100)).toBe(true);
    expect(b.canAttempt("t", 101)).toBe(true);
    expect(b.canAttempt("t", 102)).toBe(false);
  });

  test("reset returns to closed and emits a transition", () => {
    const transitions: string[] = [];
    const b = new CircuitBreaker({ failureThreshold: 1 }, () => 0, (tool, from, to) => transitions.push(`${tool}:${from}->${to}`));
    b.recordFailure("t", 0);
    b.reset("t", 50);
    expect(b.snapshot("t").state).toBe("closed");
    expect(transitions).toEqual(["t:closed->open", "t:open->closed"]);
  });

  test("transition listener observes every state change", () => {
    const transitions: string[] = [];
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10 }, () => 0, (_t, from, to, at) => transitions.push(`${from}->${to}@${at}`));
    b.recordFailure("t", 5);
    b.canAttempt("t", 20);
    b.recordSuccess("t", 25);
    expect(transitions).toEqual(["closed->open@5", "open->half_open@20", "half_open->closed@25"]);
  });

  test("restore reproduces a saved state", () => {
    const b = new CircuitBreaker();
    b.restore("t", { state: "open", openedAt: 42, consecutiveFailures: 3 });
    expect(b.snapshot("t")).toEqual({ state: "open", consecutiveFailures: 3, openedAt: 42, halfOpenProbes: 0 });
    expect(b.canAttempt("t", 43)).toBe(false);
  });

  test("noteProbe counts a replayed half-open attempt without transitioning", () => {
    const b = new CircuitBreaker({ failureThreshold: 1, halfOpenMaxProbes: 2 });
    b.restore("t", { state: "half_open" });
    b.noteProbe("t");
    b.noteProbe("t");
    expect(b.snapshot("t").halfOpenProbes).toBe(2);
    b.noteProbe("t");
    expect(b.snapshot("t").halfOpenProbes).toBe(2);
  });

  test("toolNames lists only touched tools", () => {
    const b = new CircuitBreaker();
    b.recordFailure("b", 0);
    b.recordFailure("a", 0);
    expect(b.toolNames()).toEqual(["a", "b"]);
  });
});
