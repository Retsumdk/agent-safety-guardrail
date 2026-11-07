import { afterAll, describe, expect, test } from "bun:test";
import { Guardrail } from "../src/guardrail.js";
import { startServer } from "../src/server.js";
import { BUILTIN_EXECUTORS, BUILTIN_POLICIES } from "../src/builtins.js";
import type { AsgServer } from "../src/server.js";

const servers: AsgServer[] = [];

async function makeServer(token: string | null): Promise<AsgServer> {
  const guard = new Guardrail({});
  guard.register("calc", { policy: BUILTIN_POLICIES.calc, executor: BUILTIN_EXECUTORS.calc, label: "builtin:calc" });
  guard.register("blocked", { policy: { forbiddenPatterns: ["secret"] }, executor: BUILTIN_EXECUTORS.echo, label: "x" });
  const s = await startServer(guard, token === null ? {} : { token, maxBodyBytes: 4096 });
  servers.push(s);
  return s;
}

async function call(server: AsgServer, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

describe("HTTP enforcement API", () => {
  afterAll(async () => {
    for (const s of servers) await s.close();
  });

  test("GET /health and /stats and /verify are public", async () => {
    const s = await makeServer(null);
    expect((await call(s, "GET", "/health")).status).toBe(200);
    const stats = await call(s, "GET", "/stats");
    expect(stats.status).toBe(200);
    expect((stats.json.tools as unknown[]).length).toBe(2);
    expect((await call(s, "GET", "/verify")).json.ok).toBe(true);
  });

  test("POST endpoints return 503 degraded without a configured token", async () => {
    const s = await makeServer(null);
    const r = await call(s, "POST", "/evaluate", { tool: "calc", args: { expr: "1+1" } });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("degraded");
  });

  test("POST endpoints reject a wrong bearer token with 401", async () => {
    const s = await makeServer("secret-token");
    const r = await call(s, "POST", "/evaluate", { tool: "calc", args: { expr: "1+1" } }, "wrong");
    expect(r.status).toBe(401);
  });

  test("POST /evaluate returns the gate decision (allow and deny)", async () => {
    const s = await makeServer("tok");
    const ok = await call(s, "POST", "/evaluate", { tool: "calc", args: { expr: "2+2" } }, "tok");
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("allow");
    const bad = await call(s, "POST", "/evaluate", { tool: "calc", args: { expr: "process.exit(1)" } }, "tok");
    expect(bad.json.status).toBe("deny");
    expect(bad.json.reason).toBe("forbidden_pattern:[_a-zA-Z]");
  });

  test("POST /execute runs an allowed tool and blocks a denied one", async () => {
    const s = await makeServer("tok");
    const ok = await call(s, "POST", "/execute", { tool: "calc", args: { expr: "(1+2)*3" } }, "tok");
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("ok");
    expect((ok.json.value as { value: number }).value).toBe(9);
    const bad = await call(s, "POST", "/execute", { tool: "blocked", args: { text: "my secret" } }, "tok");
    expect(bad.json.status).toBe("denied");
  });

  test("POST /tools registers a policy-only tool; executing it fails with no_executor", async () => {
    const s = await makeServer("tok");
    const created = await call(s, "POST", "/tools", { name: "audited", policy: { required: ["q"] } }, "tok");
    expect(created.status).toBe(201);
    const dup = await call(s, "POST", "/tools", { name: "audited" }, "tok");
    expect(dup.status).toBe(400);
    const run = await call(s, "POST", "/execute", { tool: "audited", args: { q: "x" } }, "tok");
    expect(run.json.status).toBe("error");
    expect(run.json.error).toContain("no executor");
  });

  test("POST /tools accepts a builtin executor by name", async () => {
    const s = await makeServer("tok");
    const created = await call(s, "POST", "/tools", { name: "remote-calc", executor: "calc" }, "tok");
    expect(created.status).toBe(201);
    const run = await call(s, "POST", "/execute", { tool: "remote-calc", args: { expr: "6*7" } }, "tok");
    expect((run.json.value as { value: number }).value).toBe(42);
  });

  test("POST /breaker/:name/reset returns an open circuit to closed", async () => {
    const s = await makeServer("tok");
    await call(s, "POST", "/tools", { name: "fragile", executor: "flaky" }, "tok");
    for (let i = 0; i < 3; i++) await call(s, "POST", "/execute", { tool: "fragile", args: { fail: true } }, "tok");
    const denied = await call(s, "POST", "/evaluate", { tool: "fragile", args: {} }, "tok");
    expect(denied.json.reason).toBe("circuit_open");
    const reset = await call(s, "POST", "/breaker/fragile/reset", {}, "tok");
    expect(reset.status).toBe(200);
    expect((reset.json.breaker as { state: string }).state).toBe("closed");
  });

  test("validation: 400 bad JSON, 400 missing fields, 404 unknown route, 405 wrong method, 413 oversized body", async () => {
    const s = await makeServer("tok");
    const authz = { authorization: "Bearer tok" };
    const noJson = await fetch(`http://127.0.0.1:${s.port}/evaluate`, { method: "POST", headers: { ...authz, "content-type": "application/json" }, body: "{nope" });
    expect(noJson.status).toBe(400);
    const noTool = await call(s, "POST", "/evaluate", { args: {} }, "tok");
    expect(noTool.status).toBe(400);
    expect((await call(s, "GET", "/nope")).status).toBe(404);
    expect((await call(s, "DELETE", "/health")).status).toBe(405);
    expect((await call(s, "GET", "/evaluate")).status).toBe(405);
    const big = await fetch(`http://127.0.0.1:${s.port}/evaluate`, { method: "POST", headers: { ...authz, "content-type": "application/json" }, body: JSON.stringify({ tool: "calc", args: { expr: "1+".repeat(3000) + "1" } }) });
    expect(big.status).toBe(413);
  });

  test("GET /events returns the newest journal records with a validated limit", async () => {
    const s = await makeServer("tok");
    await call(s, "POST", "/evaluate", { tool: "calc", args: { expr: "1+1" } }, "tok");
    const events = await call(s, "GET", "/events?limit=2");
    expect(events.status).toBe(200);
    expect((events.json.count as number) <= 2).toBe(true);
    expect((await call(s, "GET", "/events?limit=0")).status).toBe(400);
    expect((await call(s, "GET", "/events?limit=501")).status).toBe(400);
  });
});
