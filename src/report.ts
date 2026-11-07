import type { GateDecision, GuardrailStats, ToolStat } from "./guardrail.js";

export function gateLine(d: GateDecision): string {
  const arrow = d.status === "allow" ? "ALLOW" : "DENY";
  return `${arrow} ${d.tool} [${d.reason}] ${d.detail}`;
}

export function renderStats(stats: GuardrailStats): string {
  const lines: string[] = [];
  lines.push(`tools: ${stats.tools.length}`);
  lines.push(`gates: ${stats.gatesAllowed} allowed, ${stats.gatesDenied} denied`);
  lines.push(`runs: ${stats.runsOk} ok, ${stats.runsFailed} failed`);
  lines.push("");
  for (const t of stats.tools) {
    const avg = t.runsOk > 0 ? Math.round((t.totalLatencyMs / t.runsOk) * 100) / 100 : 0;
    const denySummary = Object.entries(t.deniesByReason)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, n]) => `${reason}:${n}`)
      .join(" ") || "none";
    lines.push(`${t.name}:`);
    lines.push(`  gates: ${t.gatesAllowed} allowed, ${t.gatesDenied} denied (${denySummary})`);
    lines.push(`  runs: ${t.runsOk} ok, ${t.runsFailed} failed, avg latency ${avg}ms`);
    lines.push(`  breaker: ${t.breaker.state} (consecutive failures ${t.breaker.consecutiveFailures})`);
  }
  return lines.join("\n");
}

