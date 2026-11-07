import { Guardrail } from "./guardrail.js";
import { JournalStore } from "./journal.js";
import { BUILTIN_EXECUTORS, BUILTIN_POLICIES } from "./builtins.js";
import { gateLine, renderStats } from "./report.js";

const FROZEN_NOW = 1_767_225_600_000; // 2026-01-01T00:00:00.000Z

export async function runDemo(): Promise<string> {
  let now = FROZEN_NOW;
  const clock = (): number => now;
  const journal = new JournalStore(null);
  const guard = new Guardrail({
    journal,
    clock,
    breaker: { failureThreshold: 2, cooldownMs: 5_000, halfOpenMaxProbes: 1 },
  });
  guard.register("calc", { policy: BUILTIN_POLICIES.calc, executor: BUILTIN_EXECUTORS.calc, label: "builtin:calc" });
  guard.register("echo", { policy: BUILTIN_POLICIES.echo, executor: BUILTIN_EXECUTORS.echo, label: "builtin:echo" });
  guard.register("flaky", { policy: BUILTIN_POLICIES.flaky, executor: BUILTIN_EXECUTORS.flaky, label: "builtin:flaky" });

  const lines: string[] = [];
  lines.push("asg demo — safety enforcement layer for AI agents");
  lines.push(`clock frozen at 2026-01-01T00:00:00.000Z (ms ${FROZEN_NOW})`);
  lines.push("");

  lines.push("[1] policy gate allows a well-formed call");
  const r1 = await guard.execute("calc", { expr: "(2+3)*4" });
  lines.push(gateLine(r1.gate));
  if (r1.status === "ok") lines.push(`RESULT ${JSON.stringify(r1.value)}`);
  lines.push("");

  lines.push("[2] policy gate denies malformed and dangerous calls");
  lines.push(gateLine(guard.evaluate("calc", {})));
  lines.push(gateLine(guard.evaluate("calc", { expr: "process.exit(1)" })));
  lines.push(gateLine(guard.evaluate("echo", { text: "hello", cmd: "rm -rf /" })));
  lines.push("");

  lines.push("[3] rate limiting (echo: 3 calls per 60000ms window — the 4th call is denied)");
  for (const text of ["first", "second"]) {
    const r = await guard.execute("echo", { text });
    lines.push(gateLine(r.gate));
    if (r.status === "ok") lines.push(`RESULT ${JSON.stringify(r.value)}`);
  }
  const r3 = await guard.execute("echo", { text: "third" });
  lines.push(gateLine(r3.gate));
  if (r3.status === "ok") lines.push(`RESULT ${JSON.stringify(r3.value)}`);
  const r4 = await guard.execute("echo", { text: "fourth" });
  lines.push(gateLine(r4.gate));
  if (r4.status === "denied") lines.push(`BLOCKED ${r4.reason}: ${r4.detail}`);
  lines.push("");

  lines.push("[4] circuit breaker (flaky: opens after 2 consecutive failures, 5000ms cooldown)");
  for (let i = 0; i < 2; i++) {
    const r = await guard.execute("flaky", { fail: true });
    lines.push(gateLine(r.gate));
    if (r.status === "error") lines.push(`FAILED ${r.error}`);
  }
  const blocked = await guard.execute("flaky", { fail: false });
  lines.push(gateLine(blocked.gate));
  if (blocked.status === "denied") lines.push(`BLOCKED ${blocked.reason}: ${blocked.detail}`);
  lines.push("  (clock advances 5000ms — cooldown elapses, one half-open probe allowed)");
  now += 5_000;
  for (let i = 0; i < 2; i++) {
    const r = await guard.execute("flaky", { fail: false });
    lines.push(gateLine(r.gate));
    if (r.status === "ok") lines.push(`RESULT ${JSON.stringify(r.value)}`);
  }
  lines.push("");

  lines.push("[5] audit journal");
  const verdict = journal.verify();
  lines.push(verdict.ok ? `verify: ok — ${verdict.records} records, hash chain intact` : "verify: FAILED");
  lines.push("");

  lines.push("[6] stats");
  lines.push(renderStats(guard.stats()));
  return lines.join("\n");
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isMain) {
  console.log(await runDemo());
}
