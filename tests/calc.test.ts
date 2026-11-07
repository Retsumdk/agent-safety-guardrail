import { describe, test, expect } from "bun:test";
import { evaluateExpression } from "../src/calc.js";

describe("evaluateExpression", () => {
  test("respects operator precedence", () => {
    expect(evaluateExpression("2+3*4")).toEqual({ ok: true, value: 14 });
    expect(evaluateExpression("10-6/3")).toEqual({ ok: true, value: 8 });
  });

  test("parentheses group", () => {
    expect(evaluateExpression("(2+3)*4")).toEqual({ ok: true, value: 20 });
    expect(evaluateExpression("2*(3+4)*(5-1)")).toEqual({ ok: true, value: 56 });
  });

  test("unary minus and plus", () => {
    expect(evaluateExpression("-3+5")).toEqual({ ok: true, value: 2 });
    expect(evaluateExpression("2*-3")).toEqual({ ok: true, value: -6 });
    expect(evaluateExpression("--4")).toEqual({ ok: true, value: 4 });
  });

  test("modulo and division by zero are handled", () => {
    expect(evaluateExpression("7%3")).toEqual({ ok: true, value: 1 });
    expect(evaluateExpression("1/0").ok).toBe(false);
    expect(evaluateExpression("1%0").ok).toBe(false);
  });

  test("decimals", () => {
    expect(evaluateExpression("1.5*2")).toEqual({ ok: true, value: 3 });
    expect(evaluateExpression("1.2.3").ok).toBe(false);
  });

  test("rejects identifiers, template literals, and shell metacharacters", () => {
    for (const bad of ["process.exit(1)", "require('fs')", "`ls`", "$(whoami)", "import fs", "1; rm -rf /", "alert(1)"]) {
      expect(evaluateExpression(bad).ok).toBe(false);
    }
  });

  test("rejects trailing input and unbalanced parens", () => {
    expect(evaluateExpression("1 2").ok).toBe(false);
    expect(evaluateExpression("(1+2").ok).toBe(false);
    expect(evaluateExpression("1+2)").ok).toBe(false);
  });

  test("rejects non-finite results and oversize expressions", () => {
    expect(evaluateExpression("1e400").ok).toBe(false);
    expect(evaluateExpression("1".repeat(201) + "+1").ok).toBe(false);
  });

  test("rejects non-string input", () => {
    expect(evaluateExpression(undefined as unknown as string).ok).toBe(false);
  });
});
