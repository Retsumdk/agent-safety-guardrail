import { describe, test, expect } from "bun:test";
import { evaluatePolicy, validatePolicy, type ToolPolicy, type PolicyInput } from "../src/policy.js";

function policy(input: PolicyInput & { tool?: string }): ToolPolicy {
  return validatePolicy({ tool: "t", ...input }).policy;
}

describe("validatePolicy", () => {
  test("fills defaults", () => {
    const p = policy({});
    expect(p.enabled).toBe(true);
    expect(p.required).toEqual([]);
    expect(p.maxCalls).toBe(null);
    expect(p.windowMs).toBe(60_000);
    expect(p.timeoutMs).toBe(null);
    expect(p.description).toBe("");
  });

  test("rejects a non-object", () => {
    expect(() => validatePolicy("nope")).toThrow("policy must be a JSON object");
    expect(() => validatePolicy(null)).toThrow();
    expect(() => validatePolicy([1])).toThrow();
  });

  test("rejects a missing or empty tool name", () => {
    expect(() => validatePolicy({})).toThrow("policy.tool must be a non-empty string");
    expect(() => validatePolicy({ tool: "" })).toThrow("policy.tool must be a non-empty string");
  });

  test("rejects invalid regex sources everywhere", () => {
    expect(() => policy({ strings: [{ key: "a", matches: "(" }] })).toThrow("not a valid regex");
    expect(() => policy({ strings: [{ key: "a", notMatches: ["("] }] })).toThrow("not a valid regex");
    expect(() => policy({ forbiddenPatterns: ["("] })).toThrow("not a valid regex");
  });

  test("rejects bad numeric constraints", () => {
    expect(() => policy({ maxCalls: 0 })).toThrow("maxCalls must be a positive integer");
    expect(() => policy({ maxCalls: 1.5 })).toThrow("maxCalls must be a positive integer");
    expect(() => policy({ windowMs: 0 })).toThrow("windowMs must be a positive number");
    expect(() => policy({ timeoutMs: -1 })).toThrow("timeoutMs must be a positive number");
    expect(() => policy({ numbers: [{ key: "n", min: "x" as unknown as number }] })).toThrow("must be a number");
  });

  test("rejects unknown type names", () => {
    expect(() => policy({ types: [{ key: "a", type: "symbol" as unknown as "string" }] })).toThrow("unknown type");
  });
});

describe("evaluatePolicy", () => {
  test("no violations for a conforming call", () => {
    const p = policy({
      required: ["path"],
      allowOnly: ["path", "mode"],
      types: [{ key: "path", type: "string" }],
      numbers: [{ key: "mode", min: 0, max: 2, integer: true }],
      strings: [{ key: "path", matches: "^[a-z/]+$", maxLength: 32 }],
    });
    expect(evaluatePolicy(p, { path: "tmp/data", mode: 2 })).toEqual([]);
  });

  test("required and forbidden keys", () => {
    const p = policy({ required: ["a"], forbidden: ["b"] });
    expect(evaluatePolicy(p, {})[0]?.rule).toBe("required:a");
    expect(evaluatePolicy(p, { a: 1, b: 2 })[0]?.rule).toBe("forbidden:b");
  });

  test("allowOnly rejects keys outside the list", () => {
    const p = policy({ allowOnly: ["a"] });
    expect(evaluatePolicy(p, { a: 1, sneak: true })[0]?.rule).toBe("allow_only:sneak");
  });

  test("type rules", () => {
    const p = policy({ types: [{ key: "n", type: "number" }, { key: "xs", type: "array" }, { key: "o", type: "object" }] });
    expect(evaluatePolicy(p, { n: "5", xs: {}, o: [] }).map((v) => v.rule)).toEqual(["type:n", "type:xs", "type:o"]);
  });

  test("string rules: length, matches, notMatches", () => {
    const p = policy({
      strings: [
        { key: "s", minLength: 3, maxLength: 5, matches: "^a", notMatches: ["secret"] },
      ],
    });
    expect(evaluatePolicy(p, { s: "ab" }).map((v) => v.rule)).toContain("string:s:minLength");
    expect(evaluatePolicy(p, { s: "abcdef" }).map((v) => v.rule)).toContain("string:s:maxLength");
    expect(evaluatePolicy(p, { s: "bcd" }).map((v) => v.rule)).toContain("string:s:matches");
    expect(evaluatePolicy(p, { s: "a-secret-b" }).map((v) => v.rule)).toContain("string:s:notMatches");
  });

  test("number rules: integer, min, max", () => {
    const p = policy({ numbers: [{ key: "n", min: 1, max: 10, integer: true }] });
    expect(evaluatePolicy(p, { n: 1.5 }).map((v) => v.rule)).toContain("number:n:integer");
    expect(evaluatePolicy(p, { n: 0 }).map((v) => v.rule)).toContain("number:n:min");
    expect(evaluatePolicy(p, { n: 11 }).map((v) => v.rule)).toContain("number:n:max");
  });

  test("forbidden patterns inspect argument values, not keys", () => {
    const p = policy({ forbiddenPatterns: ["rm\\s+-rf"] });
    expect(evaluatePolicy(p, { shell: "rm -rf /" }).length).toBe(1);
    expect(evaluatePolicy(p, { rm_rf_a_path: "harmless" })).toEqual([]);
  });

  test("forbidden patterns reach into nested structures", () => {
    const p = policy({ forbiddenPatterns: ["DROP\\s+TABLE"] });
    expect(evaluatePolicy(p, { q: { inner: ["select 1; DROP TABLE users"] } }).length).toBe(1);
  });

  test("multiple violations are all reported", () => {
    const p = policy({ required: ["a"], forbidden: ["b"], types: [{ key: "c", type: "number" }] });
    const violations = evaluatePolicy(p, { b: 1, c: "x" });
    expect(violations.length).toBe(3);
  });
});
