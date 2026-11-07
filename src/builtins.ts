import { evaluateExpression } from "./calc.js";
import type { ToolExecutor } from "./guardrail.js";
import type { PolicyInput } from "./policy.js";
import type { JsonArgs } from "./types.js";

export type BuiltinName = "calc" | "echo" | "flaky";

export const BUILTIN_POLICIES: Record<BuiltinName, PolicyInput> = {
  calc: {
    tool: "calc",
    description: "Evaluates a safe arithmetic expression (digits, + - * / %, parentheses). No eval, no functions.",
    required: ["expr"],
    types: [{ key: "expr", type: "string" }],
    strings: [{ key: "expr", maxLength: 200 }],
    forbiddenPatterns: ["[_a-zA-Z]", ";", "`", "\\$\\{"],
    timeoutMs: 2_000,
  },
  echo: {
    tool: "echo",
    description: "Returns its arguments unchanged. Useful as a policy test target.",
    required: ["text"],
    allowOnly: ["text"],
    types: [{ key: "text", type: "string" }],
    strings: [{ key: "text", maxLength: 1_000 }],
    maxCalls: 3,
    windowMs: 60_000,
    timeoutMs: 2_000,
  },
  flaky: {
    tool: "flaky",
    description: "Fails when args.fail is true. Deterministic target for circuit-breaker demonstrations.",
    types: [{ key: "fail", type: "boolean" }],
    timeoutMs: 2_000,
  },
};

export const BUILTIN_EXECUTORS: Record<BuiltinName, ToolExecutor> = {
  calc: (args) => {
    const expr = args["expr"];
    if (typeof expr !== "string") throw new Error("calc requires a string expr");
    const result = evaluateExpression(expr);
    if (!result.ok) throw new Error(result.error);
    return { expr, value: result.value };
  },
  echo: (args) => ({ echoed: args }),
  flaky: (args) => {
    if (args["fail"] === true) throw new Error("flaky failed on request");
    return { ok: true, fail: false };
  },
};

export function isBuiltin(name: string): name is BuiltinName {
  return name === "calc" || name === "echo" || name === "flaky";
}
