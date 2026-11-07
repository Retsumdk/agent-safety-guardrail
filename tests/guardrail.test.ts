import { describe, test, expect } from "bun:test";
import { Guardrail, type ToolExecutor } from "../src/guardrail.js";
import { JournalStore } from "../src/journal.js";
import { NotFoundError } from "../src/types.js";

function okExecutor(value: unknown = { done: true }): ToolExecutor {
  return () => value;
}

describe("Guardrail registration", () => {
  test("register stores a validated policy and journals a tool event", () => {
    const store = new JournalStore(null);
    const guard = new Guardrail({ journal: store });
    guard.register("calc", { policy: { required: ["expr"] }, executor: okExecutor(), label: "test" });
    expect(guard.has("calc")).toBe(true);
    expect(guard.policyOf("calc").required).toEqual(["expr"]);
    expect(store.size).toBe(1);
    const event = store.all()[0]!.event;
    expect(event.kind).toBe("tool");
  });

  test("register rejects invalid policies", () => {
    const guard = new Guardrail({});
    expect(() => guard.register("bad", { policy: { maxCalls: 0 } })).toThrow();
    expect(() => guard.register("bad", { policy: { strings: [{ key: "x", matches: "[" }] } })).toThrow();
  });

  test("policyOf throws NotFoundError for unknown tools", () => {
    const guard = new Guardrail({});
    expect(() => guard.policyOf("nope")).toThrow(NotFoundError);
  });

  test("rebindExecutor attaches an executor without journaling", () => {
    const store = new JournalStore(null);
    const guard = new Guardrail({ journal: store });
    guard.register("t", {});
    const size = store.size;
    guard.rebindExecutor("t", okExecutor());
    expect(store.size).toBe(size);
  });
});

describe("Guardrail.evaluate", () => {
  test("deny unknown_tool", () => {
    const guard = new Guardrail({});
    const d = guard.evaluate("ghost", {});
    expect(d.status).toBe("deny");
    expect(d.reason).toBe("unknown_tool");
  });

  test("deny tool_disabled", () => {
    const guard = new Guardrail({});
    guard.register("t", { policy: { enabled: false } });
    expect(guard.evaluate("t", {}).reason).toBe("tool_disabled");
  });

  test("deny on required / forbidden / allowOnly / type / string / number rules", () => {
    const guard = new Guardrail({});
    guard.register("t", {
      policy: {
        required: ["a"],
        forbidden: ["danger"],
        allowOnly: ["a", "n"],
        types: [{ key: "n", type: "number" }],
        strings: [{ key: "a", minLength: 3 }],
        numbers: [{ key: "n", min: 0, max: 10, integer: true }],
      },
    });
    expect(guard.evaluate("t", {}).reason).toBe("required:a");
    expect(guard.evaluate("t", { a: "abc", danger: 1 }).reason).toBe("forbidden:danger");
    expect(guard.evaluate("t", { a: "abc", extra: 1 }).reason).toBe("allow_only:extra");
    expect(guard.evaluate("t", { a: "abc", n: "5" }).reason).toBe("type:n");
    expect(guard.evaluate("t", { a: "ab" }).reason).toBe("string:a:minLength");
    expect(guard.evaluate("t", { a: "abc", n: 5.5 }).reason).toBe("number:n:integer");
    expect(guard.evaluate("t", { a: "abc", n: 11 }).reason).toBe("number:n:max");
    expect(guard.evaluate("t", { a: "abc", n: 5 }).status).toBe("allow");
  });

  test("deny on forbiddenPatterns against string values only", () => {
    const guard = new Guardrail({});
    guard.register("t", { policy: { forbiddenPatterns: ["drop\\s+table"] } });
    expect(guard.evaluate("t", { query: "drop table users" }).status).toBe("deny");
    expect(guard.evaluate("t", { query: "select 1" }).status).toBe("allow");
  });

  test("rate_limited once the sliding window is full", () => {
    let now = 1_000;
    const guard = new Guardrail({ clock: () => now });
    guard.register("t", { policy: { maxCalls: 2, windowMs: 5_000 } });
    expect(guard.evaluate("t", {}).status).toBe("allow");
    expect(guard.evaluate("t", {}).status).toBe("allow");
    const d = guard.evaluate("t", {});
    expect(d.status).toBe("deny");
    expect(d.reason).toBe("rate_limited");
    now += 5_000;
    expect(guard.evaluate("t", {}).status).toBe("allow");
  });

  test("circuit_open after failures trip the breaker", async () => {
    const store = new JournalStore(null);
    const guard = new Guardrail({ journal: store, breaker: { failureThreshold: 1, cooldownMs: 1_000 } });
    guard.register("t", { executor: () => { throw new Error("boom"); } });
    await guard.execute("t", {});
    const d = guard.evaluate("t", {});
    expect(d.status).toBe("deny");
    expect(d.reason).toBe("circuit_open");
  });
});

describe("Guardrail.execute", () => {
  test("ok path returns the executor value and records latency", async () => {
    const guard = new Guardrail({});
    guard.register("t", { executor: () => ({ n: 7 }) });
    const r = await guard.execute("t", {});
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.value).toEqual({ n: 7 });
  });

  test("error path records a failed run and counts toward the breaker", async () => {
    const guard = new Guardrail({ breaker: { failureThreshold: 2 } });
    guard.register("t", { executor: () => { throw new Error("nope"); } });
    const r1 = await guard.execute("t", {});
    expect(r1.status).toBe("error");
    const stats = guard.stats().tools.find((t) => t.name === "t");
    expect(stats?.runsFailed).toBe(1);
    expect(stats?.breaker.consecutiveFailures).toBe(1);
    expect(stats?.breaker.state).toBe("closed");
  });

  test("policy-only tool fails with no_executor", async () => {
    const guard = new Guardrail({});
    guard.register("t", {});
    const r = await guard.execute("t", {});
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toContain("no executor");
  });

  test("timeoutMs terminates a hung executor as a failed run", async () => {
    const guard = new Guardrail({});
    guard.register("t", {
      policy: { timeoutMs: 50 },
      executor: () => new Promise(() => {}),
    });
    const r = await guard.execute("t", {});
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toContain("timed out");
  });

  test("denied calls never reach the executor", async () => {
    let calls = 0;
    const guard = new Guardrail({});
    guard.register("t", { policy: { required: ["key"] }, executor: () => { calls += 1; return 1; } });
    await guard.execute("t", {});
    expect(calls).toBe(0);
  });
});

describe("Guardrail.resetBreaker + stats", () => {
  test("resetBreaker returns an open circuit to closed", async () => {
    const guard = new Guardrail({ breaker: { failureThreshold: 1 } });
    guard.register("t", { executor: () => { throw new Error("x"); } });
    await guard.execute("t", {});
    expect(guard.stats().tools[0]!.breaker.state).toBe("open");
    guard.resetBreaker("t");
    expect(guard.stats().tools[0]!.breaker.state).toBe("closed");
  });

  test("resetBreaker on an unknown tool throws NotFoundError", () => {
    const guard = new Guardrail({});
    expect(() => guard.resetBreaker("nope")).toThrow(NotFoundError);
  });

  test("stats aggregates totals across tools", () => {
    const guard = new Guardrail({});
    guard.register("a", { executor: okExecutor() });
    guard.register("b", {});
    guard.evaluate("a", {});
    void guard.evaluate("b", {});
    const stats = guard.stats();
    expect(stats.tools.length).toBe(2);
    expect(stats.gatesAllowed).toBe(2);
  });
});

describe("Guardrail.fromJournal replay", () => {
  test("reconstructs tools, counters, and breaker state from a journal", async () => {
    const store = new JournalStore(null);
    const guard = new Guardrail({ journal: store, breaker: { failureThreshold: 2 } });
    guard.register("t", { policy: { required: ["k"] }, executor: (args) => { if (args["k"] === "bad") throw new Error("x"); return "fine"; }, label: "t" });
    await guard.execute("t", { k: "good" });
    await guard.execute("t", { k: "bad" });
    guard.evaluate("t", {});
    const live = guard.stats();

    const replayed = Guardrail.fromJournal(store);
    const after = replayed.stats();
    expect(after.tools.length).toBe(live.tools.length);
    const t = after.tools.find((tool) => tool.name === "t");
    expect(t?.gatesAllowed).toBe(live.tools[0]!.gatesAllowed);
    expect(t?.gatesDenied).toBe(live.tools[0]!.gatesDenied);
    expect(t?.runsOk).toBe(live.tools[0]!.runsOk);
    expect(t?.runsFailed).toBe(live.tools[0]!.runsFailed);
    expect(t?.breaker.state).toBe(live.tools[0]!.breaker.state);
  });

  test("replay does not append new journal records", async () => {
    const store = new JournalStore(null);
    const guard = new Guardrail({ journal: store, breaker: { failureThreshold: 1 } });
    guard.register("t", { executor: () => { throw new Error("x"); } });
    await guard.execute("t", {});
    const size = store.size;
    Guardrail.fromJournal(store);
    expect(store.size).toBe(size);
  });
});
