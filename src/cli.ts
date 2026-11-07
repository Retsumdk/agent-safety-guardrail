import { Guardrail, type GateDecision, type ToolExecutor } from "./guardrail.js";
import { readFileSync } from "node:fs";
import { JournalStore } from "./journal.js";
import { BUILTIN_EXECUTORS, BUILTIN_POLICIES } from "./builtins.js";
import { parsePolicyFile } from "./policy-file.js";
import { canonicalJson } from "./canonical.js";
import { validatePolicy, type PolicyInput, type ToolPolicy } from "./policy.js";
import { runDemo } from "./demo.js";
import { gateLine, renderStats } from "./report.js";
export { gateLine, renderStats };

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_DENIED = 4;
export const EXIT_VERIFY_FAILED = 5;

export interface ParsedArgs {
  command: string | null;
  flags: Map<string, string>;
  positional: string[];
}

const ALIASES: Record<string, string> = {
  "-t": "--tool",
  "-a": "--args",
  "-p": "--policy",
  "-j": "--journal",
  "-P": "--port",
  "-T": "--token",
  "-J": "--json",
};

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let command: string | null = null;
  let i = 0;
  while (i < argv.length) {
    let arg = argv[i] as string;
    if (arg === "--") {
      for (const rest of argv.slice(i + 1)) positional.push(rest);
      break;
    }
    if (arg.startsWith("-")) {
      let value: string | undefined;
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        value = arg.slice(eq + 1);
        arg = arg.slice(0, eq);
      }
      const flag = ALIASES[arg] ?? arg;
      if (!flag.startsWith("--")) {
        throw new UsageError(`unknown flag "${arg}"`);
      }
      if (value === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          value = next;
          i += 1;
        } else {
          value = "";
        }
      }
      flags.set(flag, value);
    } else if (command === null) {
      command = arg;
    } else {
      positional.push(arg);
    }
    i += 1;
  }
  return { command, flags, positional };
}

export class UsageError extends Error {
  exitCode = EXIT_USAGE;
}

export function usage(): string {
  return [
    "asg — safety enforcement layer for AI agents",
    "",
    "Usage: asg <command> [options]",
    "",
    "Commands:",
    "  demo                                   Run the deterministic feature demo",
    "  tools [--policy FILE] [--json]         List registered tools and policies",
    "  evaluate --tool NAME --args JSON       Evaluate a tool call without executing it",
    "         [--policy FILE] [--journal FILE] [--json]",
    "  run --tool NAME --args JSON            Evaluate AND execute a tool call",
    "         [--policy FILE] [--journal FILE] [--json]",
    "  stats [--journal FILE] [--json]        Print aggregate + per-tool stats",
    "  verify --journal FILE                  Verify journal integrity (exit 5 on failure)",
    "  serve [--port N] [--journal FILE]      Start the HTTP enforcement API",
    "  help                                   Show this help",
    "",
    "Aliases: -t --tool  -a --args  -p --policy  -j --journal  -P --port  -J --json",
    "Environment: ASG_TOKEN sets the bearer token for `asg serve` write endpoints.",
  ].join("\n");
}

export interface LoadedContext {
  guard: Guardrail;
  journalPath: string | null;
}

export function buildGuardrail(flags: Map<string, string>, opts: { journal: boolean } = { journal: true }): LoadedContext {
  const journalPath = opts.journal ? (flags.get("--journal") ?? null) : null;
  const journal = new JournalStore(journalPath);
  const guard = new Guardrail({ journal });
  registerBuiltins(guard);
  const policyFlag = flags.get("--policy");
  if (policyFlag !== undefined && policyFlag !== "") {
    let text: string;
    try {
      text = readFileSync(policyFlag, "utf8");
    } catch (err) {
      throw new UsageError(`cannot read policy file "${policyFlag}": ${(err as Error).message}`);
    }
    const parsed = parsePolicyFile(text);
    if (!parsed.ok) throw new UsageError(parsed.error);
    for (const tool of parsed.file.tools) {
      const name = tool.tool;
      const executor = executorFor(tool.executor);
      const policy = tool.policy ?? {};
      if (tool.description !== undefined && policy.description === undefined) {
        policy.description = tool.description;
      }
      if (guard.has(name)) {
        const existing = guard.policyOf(name);
        const samePolicy = canonicalJson(existing) === canonicalJson(resolvePolicyInput(name, policy));
        if (samePolicy) {
          guard.rebindExecutor(name, executor, executor ? `builtin:${String(tool.executor)}` : null);
          continue;
        }
      }
      guard.register(name, {
        policy,
        executor,
        label: executor ? `builtin:${String(tool.executor)}` : null,
      });
    }
  }
  return { guard, journalPath };
}

function executorFor(name: unknown): ToolExecutor | null {
  if (name === undefined || name === null || name === "") {
    return null;
  }
  if (name === "echo" || name === "flaky" || name === "calc") {
    return BUILTIN_EXECUTORS[name];
  }
  throw new UsageError(`unknown executor "${String(name)}" (allowed: echo, flaky, calc)`);
}

function resolvePolicyInput(name: string, policy: PolicyInput): ToolPolicy {
  return validatePolicy({ ...(policy as Record<string, unknown>), tool: name }).policy;
}

function registerBuiltins(guard: Guardrail): void {
  for (const name of ["calc", "echo", "flaky"] as const) {
    if (guard.has(name)) {
      guard.rebindExecutor(name, BUILTIN_EXECUTORS[name], `builtin:${name}`);
      continue;
    }
    guard.register(name, { policy: BUILTIN_POLICIES[name], executor: BUILTIN_EXECUTORS[name], label: `builtin:${name}` });
  }
}

export function parseArgsJson(text: string | undefined): Record<string, unknown> {
  if (text === undefined || text === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`--args is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("--args must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}



export function cmdStats(flags: Map<string, string>, json: boolean): string {
  const journalFlag = flags.get("--journal");
  if (journalFlag !== undefined && journalFlag !== "") {
    const store = new JournalStore(journalFlag);
    const guard = Guardrail.fromJournal(store);
    const stats = guard.stats();
    if (json) return JSON.stringify(stats, null, 2);
    return renderStats(stats);
  }
  const stats = buildGuardrail(flags).guard.stats();
  if (json) return JSON.stringify(stats, null, 2);
  return renderStats(stats);
}
