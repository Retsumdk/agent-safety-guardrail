import { describe, test, expect } from "bun:test";
describe("agent-safety-guardrail", () => {
  test("module loads", async () => { const m = await import("./index"); expect(m).toBeDefined(); });
});
