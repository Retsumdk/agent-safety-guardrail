export type JsonArgs = Record<string, unknown>;

export type TypeRule = { key: string; type: "string" | "number" | "boolean" | "array" | "object" | "null" };
export type StringRule = { key: string; matches: string | null; notMatches: string[]; minLength: number | null; maxLength: number | null };
export type NumberRule = { key: string; min: number | null; max: number | null; integer: boolean };
export type ToolPolicy = {
  tool: string;
  enabled: boolean;
  required: string[];
  forbidden: string[];
  allowOnly: string[];
  types: TypeRule[];
  strings: StringRule[];
  numbers: NumberRule[];
  forbiddenPatterns: string[];
  maxCalls: number | null;
  windowMs: number;
  timeoutMs: number | null;
  description: string;
};
export type PolicyInput = {
  tool?: string;
  enabled?: boolean;
  required?: string[];
  forbidden?: string[];
  allowOnly?: string[];
  types?: { key: string; type: TypeRule["type"] }[];
  strings?: { key: string; matches?: string | null; notMatches?: string[]; minLength?: number | null; maxLength?: number | null }[];
  numbers?: { key: string; min?: number | null; max?: number | null; integer?: boolean }[];
  forbiddenPatterns?: string[];
  maxCalls?: number | null;
  windowMs?: number;
  timeoutMs?: number | null;
  description?: string;
};
export type Violation = { rule: string; message: string };


export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export type AuditEventKind = "tool" | "gate" | "run" | "breaker";

export interface ToolRegisteredEvent {
  kind: "tool";
  name: string;
  policy: unknown;
  executorLabel: string | null;
  at: number;
}

export interface GateEvent {
  kind: "gate";
  tool: string;
  status: "allow" | "deny";
  reason: string;
  detail: string;
  at: number;
  argsKeys?: string[];
}

export interface RunEvent {
  kind: "run";
  tool: string;
  ok: boolean;
  error: string | null;
  latencyMs: number;
  at: number;
}

export interface BreakerEvent {
  kind: "breaker";
  tool: string;
  from: string;
  to: string;
  at: number;
}

export type AuditEvent = ToolRegisteredEvent | GateEvent | RunEvent | BreakerEvent;

export interface JournalEvent {
  seq: number;
  prevHash: string;
  hash: string;
  event: AuditEvent;
}

export type AuditEventLike = AuditEvent;
