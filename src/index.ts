#!/usr/bin/env bun
/**
 * agent-safety-guardrail — safety enforcement layer for AI agents.
 *
 * Public surface: Guardrail (engine), policy types + validation, CircuitBreaker,
 * JournalStore (tamper-evident audit journal), built-in tools, HTTP server, CLI.
 */

export {
  CircuitBreaker,
  DEFAULT_BREAKER_CONFIG,
  type BreakerConfig,
  type BreakerSnapshot,
  type BreakerState,
  type TransitionListener,
} from "./breaker.js";
export { evaluateExpression } from "./calc.js";
export {
  BUILTIN_EXECUTORS,
  BUILTIN_POLICIES,
  isBuiltin,
  type BuiltinName,
} from "./builtins.js";
export { canonicalJson } from "./canonical.js";
export {
  Guardrail,
  type ExecutionResult,
  type GateDecision,
  type GateStatus,
  type GuardrailOptions,
  type GuardrailStats,
  type ToolEntry,
  type ToolExecutor,
  type ToolSpec,
  type ToolStat,
} from "./guardrail.js";
export { JournalStore, GENESIS_PREV_HASH, type JournalRecord, type VerifyResult } from "./journal.js";
export { evaluatePolicy, validatePolicy } from "./policy.js";
export { parsePolicyFile, type PolicyFile, type PolicyFileTool } from "./policy-file.js";
export { startServer, type StartServerOptions, type AsgServer } from "./server.js";
export type { JsonArgs, PolicyInput, ToolPolicy, TypeRule, StringRule, NumberRule, Violation } from "./types.js";
export { ValidationError, NotFoundError } from "./types.js";
