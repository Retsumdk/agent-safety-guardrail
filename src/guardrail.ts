import { CircuitBreaker, type BreakerConfig, type BreakerSnapshot } from "./breaker.js";
import { evaluatePolicy, validatePolicy, type ToolPolicy } from "./policy.js";
import { JournalStore } from "./journal.js";
import { NotFoundError, ValidationError, type AuditEvent, type JsonArgs } from "./types.js";

export type GateStatus = "allow" | "deny";

export interface GateDecision {
  tool: string;
  status: GateStatus;
  reason: string;
  detail: string;
}

export type ExecutionResult =
  | { tool: string; status: "ok"; value: unknown; latencyMs: number; gate: GateDecision }
  | { tool: string; status: "error"; error: string; latencyMs: number; gate: GateDecision }
  | { tool: string; status: "denied"; reason: string; detail: string; gate: GateDecision };

export type ToolExecutor = (args: JsonArgs) => unknown | Promise<unknown>;

export interface ToolSpec {
  policy?: unknown;
  executor?: ToolExecutor | null;
  label?: string | null;
}

export interface ToolEntry {
  name: string;
  policy: ToolPolicy;
  executor: ToolExecutor | null;
  label: string | null;
}

export interface ToolStat {
  name: string;
  enabled: boolean;
  label: string | null;
  hasRealExecutor: boolean;
  description: string | null;
  breaker: BreakerSnapshot;
  gatesAllowed: number;
  gatesDenied: number;
  deniesByReason: Record<string, number>;
  runsOk: number;
  runsFailed: number;
  totalLatencyMs: number;
}

export interface GuardrailStats {
  tools: ToolStat[];
  gatesAllowed: number;
  gatesDenied: number;
  runsOk: number;
  runsFailed: number;
}

export interface GuardrailOptions {
  journal?: JournalStore;
  clock?: () => number;
  breaker?: Partial<BreakerConfig>;
}

interface ToolCounters {
  gatesAllowed: number;
  gatesDenied: number;
  deniesByReason: Record<string, number>;
  runsOk: number;
  runsFailed: number;
  totalLatencyMs: number;
}

function emptyCounters(): ToolCounters {
  return { gatesAllowed: 0, gatesDenied: 0, deniesByReason: {}, runsOk: 0, runsFailed: 0, totalLatencyMs: 0 };
}

export class Guardrail {
  private tools: Map<string, ToolEntry> = new Map();
  private counters: Map<string, ToolCounters> = new Map();
  private rateWindows: Map<string, number[]> = new Map();
  private readonly breaker: CircuitBreaker;
  private readonly journal: JournalStore;
  private readonly clock: () => number;

  private replaying = false;

  constructor(opts: GuardrailOptions = {}) {
    this.journal = opts.journal ?? new JournalStore(null);
    this.clock = opts.clock ?? (() => Date.now());
    this.breaker = new CircuitBreaker(opts.breaker ?? {}, this.clock, (tool, from, to, at) => {
      if (!this.replaying) {
        this.append({ kind: "breaker", tool, from, to, at });
      }
    });
    if (this.journal.size > 0) {
      this.replaying = true;
      try {
        for (const record of this.journal.all()) {
          this.absorb(record.event);
        }
      } finally {
        this.replaying = false;
      }
    }
  }

  get journalStore(): JournalStore {
    return this.journal;
  }

  register(name: string, spec: ToolSpec = {}): void {
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("tool name must be a non-empty string");
    }
    const rawPolicy = { ...(typeof spec.policy === "object" && spec.policy !== null ? spec.policy as Record<string, unknown> : {}), tool: name };
    const { policy } = validatePolicy(rawPolicy);
    this.tools.set(name, {
      name,
      policy,
      executor: spec.executor ?? null,
      label: spec.label ?? null,
    });
    this.append({ kind: "tool", name, policy, executorLabel: spec.label ?? null, at: this.clock() });
  }

  rebindExecutor(name: string, executor: ToolExecutor | null, label: string | null = null): void {
    const entry = this.entryOf(name);
    entry.executor = executor;
    entry.label = label;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  toolNames(): string[] {
    return [...this.tools.keys()].sort();
  }

  policyOf(name: string): ToolPolicy {
    return this.entryOf(name).policy;
  }

  breakerSnapshotOf(name: string): BreakerSnapshot {
    return this.breaker.snapshot(name);
  }

  evaluate(name: string, args: JsonArgs): GateDecision {
    const at = this.clock();
    const entry = this.tools.get(name);
    if (!entry) {
      return this.decide(name, "deny", "unknown_tool", `no tool registered under "${name}"`, at, args);
    }
    if (!entry.policy.enabled) {
      return this.decide(name, "deny", "tool_disabled", `tool "${name}" is disabled by policy`, at, args);
    }
    const violations = evaluatePolicy(entry.policy, args);
    if (violations.length > 0) {
      const first = violations[0] as (typeof violations)[number];
      const detail = violations.map((v) => v.message).join("; ");
      return this.decide(name, "deny", first.rule, detail, at, args);
    }
    const p = entry.policy;
    if (p.maxCalls !== null) {
      const window = this.rateWindow(name);
      this.pruneWindow(window, at, p.windowMs);
      if (window.length >= p.maxCalls) {
        return this.decide(name, "deny", "rate_limited", `rate limit reached: ${p.maxCalls} calls per ${p.windowMs}ms window`, at, args);
      }
    }
    if (!this.breaker.canAttempt(name, at)) {
      const snap = this.breaker.snapshot(name);
      const reason = snap.state === "open" ? "circuit_open" : "circuit_probing";
      const detail = snap.state === "open"
        ? `circuit open for "${name}"; cooldown ends in ${Math.max(0, (snap.openedAt ?? at) + this.cooldownMs() - at)}ms`
        : `half-open probe budget exhausted for "${name}"`;
      return this.decide(name, "deny", reason, detail, at, args);
    }
    if (p.maxCalls !== null) {
      this.rateWindow(name).push(at);
    }
    return this.decide(name, "allow", "policy_pass", "all policy checks passed", at, args);
  }

  async execute(name: string, args: JsonArgs): Promise<ExecutionResult> {
    const gate = this.evaluate(name, args);
    if (gate.status === "deny") {
      return { tool: name, status: "denied", reason: gate.reason, detail: gate.detail, gate };
    }
    const entry = this.entryOf(name);
    const started = this.clock();
    let outcome: { ok: boolean; value?: unknown; error?: string };
    const timeoutMs = entry.policy.timeoutMs;
    if (timeoutMs !== null) {
      outcome = await withTimeout(() => (entry.executor === null ? Promise.reject(new Error(noExecutorMessage(name))) : entry.executor(args)), timeoutMs);
    } else if (entry.executor === null) {
      outcome = { ok: false, error: noExecutorMessage(name) };
    } else {
      try {
        outcome = { ok: true, value: await entry.executor(args) };
      } catch (err) {
        outcome = { ok: false, error: (err as Error).message };
      }
    }
    const latency = Math.max(0, this.clock() - started);
    const at = this.clock();
    if (outcome.ok) {
      const counters = this.counters0(name);
      counters.runsOk += 1;
      counters.totalLatencyMs += latency;
      this.breaker.recordSuccess(name, at);
      this.append({ kind: "run", tool: name, ok: true, error: null, latencyMs: latency, at });
      return { tool: name, status: "ok", value: outcome.value, latencyMs: latency, gate };
    }
    const counters = this.counters0(name);
    counters.runsFailed += 1;
    this.breaker.recordFailure(name, at);
    this.append({ kind: "run", tool: name, ok: false, error: outcome.error ?? "unknown", latencyMs: latency, at });
    return { tool: name, status: "error", error: outcome.error ?? "unknown", latencyMs: latency, gate };
  }

  resetBreaker(name: string): void {
    this.entryOf(name);
    this.breaker.reset(name, this.clock());
  }

  stats(): GuardrailStats {
    const tools: ToolStat[] = [];
    let gatesAllowed = 0;
    let gatesDenied = 0;
    let runsOk = 0;
    let runsFailed = 0;
    for (const name of this.toolNames()) {
      const entry = this.entryOf(name);
      const c = this.counters0(name);
      const stat: ToolStat = {
        name,
        enabled: entry.policy.enabled,
        label: entry.label,
        hasRealExecutor: entry.executor !== null,
        description: entry.policy.description === "" ? null : entry.policy.description,
        breaker: this.breaker.snapshot(name),
        gatesAllowed: c.gatesAllowed,
        gatesDenied: c.gatesDenied,
        deniesByReason: { ...c.deniesByReason },
        runsOk: c.runsOk,
        runsFailed: c.runsFailed,
        totalLatencyMs: c.totalLatencyMs,
      };
      tools.push(stat);
      gatesAllowed += c.gatesAllowed;
      gatesDenied += c.gatesDenied;
      runsOk += c.runsOk;
      runsFailed += c.runsFailed;
    }
    return { tools, gatesAllowed, gatesDenied, runsOk, runsFailed };
  }

  verify(): ReturnType<JournalStore["verify"]> {
    return this.journal.verify();
  }

  journalRecords(): ReturnType<JournalStore["all"]> {
    return this.journal.all();
  }

  static fromJournal(journal: JournalStore, clock: () => number = () => Date.now(), breaker?: Partial<BreakerConfig>): Guardrail {
    return new Guardrail({
      journal,
      clock,
      ...(breaker !== undefined ? { breaker } : {}),
    });
  }

  private absorb(event: AuditEvent): void {
    if (event.kind === "tool") {
      this.tools.set(event.name, { name: event.name, policy: event.policy as ToolPolicy, executor: null, label: null });
      return;
    }
    if (event.kind === "gate") {
      const counters = this.counters0(event.tool);
      if (event.status === "allow") {
        counters.gatesAllowed += 1;
        const entry = this.tools.get(event.tool);
        if (entry && entry.policy.maxCalls !== null) {
          this.rateWindow(event.tool).push(event.at);
        }
        const snap = this.breaker.snapshot(event.tool);
        if (snap.state === "half_open") {
          this.breaker.noteProbe(event.tool);
        }
      } else {
        counters.gatesDenied += 1;
        counters.deniesByReason[event.reason] = (counters.deniesByReason[event.reason] ?? 0) + 1;
      }
      return;
    }
    if (event.kind === "run") {
      const counters = this.counters0(event.tool);
      if (event.ok) {
        counters.runsOk += 1;
        counters.totalLatencyMs += event.latencyMs;
        this.breaker.recordSuccess(event.tool, event.at);
      } else {
        counters.runsFailed += 1;
        this.breaker.recordFailure(event.tool, event.at);
      }
      return;
    }
    if (event.kind === "breaker") {
      const to = event.to as BreakerSnapshot["state"];
      if (to === "open") {
        this.breaker.restore(event.tool, { state: to, openedAt: event.at });
      } else if (to === "half_open") {
        this.breaker.restore(event.tool, { state: to, openedAt: null, halfOpenProbes: 0 });
      } else {
        this.breaker.restore(event.tool, { state: to, openedAt: null, halfOpenProbes: 0, consecutiveFailures: 0 });
      }
      return;
    }
    throw new Error(`unknown event kind in journal: ${(event as { kind?: string }).kind ?? "undefined"}`);
  }

  private decide(tool: string, status: GateStatus, reason: string, detail: string, at: number, args: JsonArgs): GateDecision {
    const counters = this.counters0(tool);
    if (status === "allow") {
      counters.gatesAllowed += 1;
    } else {
      counters.gatesDenied += 1;
      counters.deniesByReason[reason] = (counters.deniesByReason[reason] ?? 0) + 1;
    }
    this.append({ kind: "gate", tool, status, reason, detail, at, argsKeys: Object.keys(args).sort() });
    return { tool, status, reason, detail };
  }

  private append(event: AuditEvent): void {
    this.journal.append(event);
  }

  private entryOf(name: string): ToolEntry {
    const entry = this.tools.get(name);
    if (!entry) throw new NotFoundError(`unknown tool "${name}"`);
    return entry;
  }

  private cooldownMs(): number {
    return this.breaker.configValue().cooldownMs;
  }

  private counters0(name: string): ToolCounters {
    let c = this.counters.get(name);
    if (!c) {
      c = emptyCounters();
      this.counters.set(name, c);
    }
    return c;
  }

  private rateWindow(name: string): number[] {
    let w = this.rateWindows.get(name);
    if (!w) {
      w = [];
      this.rateWindows.set(name, w);
    }
    return w;
  }

  private pruneWindow(window: number[], at: number, windowMs: number): void {
    while (window.length > 0 && (window[0] as number) <= at - windowMs) {
      window.shift();
    }
  }
}

function noExecutorMessage(name: string): string {
  return `tool "${name}" has policy but no executor`;
}

type TimeoutOutcome = { ok: true; value: unknown } | { ok: false; error: string };

async function withTimeout(run: () => unknown | Promise<unknown>, timeoutMs: number): Promise<TimeoutOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimeoutOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `timed out after ${timeoutMs}ms` }), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(run)
        .then(
          (value): TimeoutOutcome => ({ ok: true, value }),
          (err: unknown): TimeoutOutcome => ({ ok: false, error: (err as Error).message }),
        ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { validatePolicy, evaluatePolicy };
