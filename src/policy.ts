import { ValidationError, type JsonArgs, type ToolPolicy, type TypeRule, type StringRule, type NumberRule, type Violation, type PolicyInput } from "./types.js";

export type { ToolPolicy, TypeRule, StringRule, NumberRule, Violation, PolicyInput };

const emptyPolicy = (tool: string): ToolPolicy => ({
  tool,
  enabled: true,
  required: [],
  forbidden: [],
  allowOnly: [],
  types: [],
  strings: [],
  numbers: [],
  forbiddenPatterns: [],
  maxCalls: null,
  windowMs: 60_000,
  timeoutMs: null,
  description: "",
});

export function validatePolicy(raw: unknown): { tool: string; policy: ToolPolicy } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(`policy must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const tool = obj.tool;
  if (typeof tool !== "string" || tool.length === 0) {
    throw new ValidationError(`policy.tool must be a non-empty string`);
  }
  const policy = emptyPolicy(tool);
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") throw new ValidationError(`policy.enabled must be a boolean`);
    policy.enabled = obj.enabled;
  }
  if (obj.required !== undefined) {
    if (!isStringArray(obj.required)) throw new ValidationError(`policy.required must be an array of strings`);
    policy.required = [...obj.required];
  }
  if (obj.forbidden !== undefined) {
    if (!isStringArray(obj.forbidden)) throw new ValidationError(`policy.forbidden must be an array of strings`);
    policy.forbidden = [...obj.forbidden];
  }
  if (obj.allowOnly !== undefined) {
    if (!isStringArray(obj.allowOnly)) throw new ValidationError(`policy.allowOnly must be an array of strings`);
    policy.allowOnly = [...obj.allowOnly];
  }
  if (obj.types !== undefined) {
    if (!Array.isArray(obj.types)) throw new ValidationError(`policy.types must be an array`);
    policy.types = (obj.types as unknown[]).map((r) => {
      if (r === null || typeof r !== "object" || Array.isArray(r)) throw new ValidationError(`policy.types entries must be objects`);
      const t = r as Record<string, unknown>;
      if (typeof t.key !== "string" || t.key.length === 0) throw new ValidationError(`policy.types entries need a "key"`);
      if (!(t.type === "string" || t.type === "number" || t.type === "boolean" || t.type === "array" || t.type === "object" || t.type === "null")) {
        throw new ValidationError(`policy.types entry for "${t.key}" has unknown type ${JSON.stringify(t.type)}`);
      }
      return { key: t.key, type: t.type } as TypeRule;
    });
  }
  if (obj.strings !== undefined) {
    if (!Array.isArray(obj.strings)) throw new ValidationError(`policy.strings must be an array`);
    policy.strings = (obj.strings as unknown[]).map((r) => {
      if (r === null || typeof r !== "object" || Array.isArray(r)) throw new ValidationError(`policy.strings entries must be objects`);
      const s = r as Record<string, unknown>;
      if (typeof s.key !== "string" || s.key.length === 0) throw new ValidationError(`policy.strings entries need a "key"`);
      const rule: StringRule = { key: s.key, matches: null, notMatches: [], minLength: null, maxLength: null };
      if (s.matches !== undefined && s.matches !== null) {
        if (typeof s.matches !== "string") throw new ValidationError(`policy.strings.matches for "${s.key}" must be a regex source string`);
        try {
          new RegExp(s.matches);
        } catch {
          throw new ValidationError(`policy.strings.matches for "${s.key}" is not a valid regex: ${s.matches}`);
        }
        rule.matches = s.matches;
      }
      if (s.notMatches !== undefined) {
        if (!isStringArray(s.notMatches)) throw new ValidationError(`policy.strings.notMatches for "${s.key}" must be an array of regex sources`);
        for (const src of s.notMatches) {
          try {
            new RegExp(src);
          } catch {
            throw new ValidationError(`policy.strings.notMatches entry for "${s.key}" is not a valid regex: ${src}`);
          }
        }
        rule.notMatches = [...s.notMatches];
      }
      if (s.minLength !== undefined && s.minLength !== null) {
        if (typeof s.minLength !== "number" || s.minLength < 0) throw new ValidationError(`policy.strings.minLength for "${s.key}" must be a non-negative number`);
        rule.minLength = s.minLength;
      }
      if (s.maxLength !== undefined && s.maxLength !== null) {
        if (typeof s.maxLength !== "number" || s.maxLength < 0) throw new ValidationError(`policy.strings.maxLength for "${s.key}" must be a non-negative number`);
        rule.maxLength = s.maxLength;
      }
      return rule;
    });
  }
  if (obj.numbers !== undefined) {
    if (!Array.isArray(obj.numbers)) throw new ValidationError(`policy.numbers must be an array`);
    policy.numbers = (obj.numbers as unknown[]).map((r) => {
      if (r === null || typeof r !== "object" || Array.isArray(r)) throw new ValidationError(`policy.numbers entries must be objects`);
      const n = r as Record<string, unknown>;
      if (typeof n.key !== "string" || n.key.length === 0) throw new ValidationError(`policy.numbers entries need a "key"`);
      const rule: NumberRule = { key: n.key, min: null, max: null, integer: false };
      if (n.min !== undefined && n.min !== null) {
        if (typeof n.min !== "number") throw new ValidationError(`policy.numbers.min for "${n.key}" must be a number`);
        rule.min = n.min;
      }
      if (n.max !== undefined && n.max !== null) {
        if (typeof n.max !== "number") throw new ValidationError(`policy.numbers.max for "${n.key}" must be a number`);
        rule.max = n.max;
      }
      if (n.integer !== undefined) {
        if (typeof n.integer !== "boolean") throw new ValidationError(`policy.numbers.integer for "${n.key}" must be a boolean`);
        rule.integer = n.integer;
      }
      return rule;
    });
  }
  if (obj.forbiddenPatterns !== undefined) {
    if (!isStringArray(obj.forbiddenPatterns)) throw new ValidationError(`policy.forbiddenPatterns must be an array of regex sources`);
    for (const src of obj.forbiddenPatterns) {
      try {
        new RegExp(src);
      } catch {
        throw new ValidationError(`policy.forbiddenPatterns entry is not a valid regex: ${src}`);
      }
    }
    policy.forbiddenPatterns = [...obj.forbiddenPatterns];
  }
  if (obj.maxCalls !== undefined && obj.maxCalls !== null) {
    if (typeof obj.maxCalls !== "number" || !Number.isInteger(obj.maxCalls) || obj.maxCalls < 1) {
      throw new ValidationError(`policy.maxCalls must be a positive integer`);
    }
    policy.maxCalls = obj.maxCalls;
  }
  if (obj.windowMs !== undefined) {
    if (typeof obj.windowMs !== "number" || obj.windowMs <= 0) throw new ValidationError(`policy.windowMs must be a positive number`);
    policy.windowMs = obj.windowMs;
  }
  if (obj.timeoutMs !== undefined && obj.timeoutMs !== null) {
    if (typeof obj.timeoutMs !== "number" || obj.timeoutMs <= 0) throw new ValidationError(`policy.timeoutMs must be a positive number`);
    policy.timeoutMs = obj.timeoutMs;
  }
  if (obj.description !== undefined) {
    if (typeof obj.description !== "string") throw new ValidationError(`policy.description must be a string`);
    policy.description = obj.description;
  }
  return { tool, policy };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function evaluatePolicy(policy: ToolPolicy, args: JsonArgs): Violation[] {
  const violations: Violation[] = [];
  for (const key of policy.required) {
    if (!(key in args)) violations.push({ rule: `required:${key}`, message: `missing required argument "${key}"` });
  }
  for (const key of policy.forbidden) {
    if (key in args) violations.push({ rule: `forbidden:${key}`, message: `forbidden argument "${key}" is present` });
  }
  if (policy.allowOnly.length > 0) {
    for (const key of Object.keys(args)) {
      if (!policy.allowOnly.includes(key)) {
        violations.push({ rule: `allow_only:${key}`, message: `argument "${key}" is not in the allowOnly list` });
      }
    }
  }
  for (const rule of policy.types) {
    const value = args[rule.key];
    if (value === undefined) continue;
    if (!typeMatches(value, rule.type)) {
      violations.push({ rule: `type:${rule.key}`, message: `argument "${rule.key}" must be of type ${rule.type}, got ${actualType(value)}` });
    }
  }
  for (const rule of policy.strings) {
    const value = args[rule.key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      violations.push({ rule: `string:${rule.key}`, message: `argument "${rule.key}" must be a string for string rules to apply` });
      continue;
    }
    if (rule.minLength !== null && value.length < rule.minLength) {
      violations.push({ rule: `string:${rule.key}:minLength`, message: `argument "${rule.key}" is ${value.length} chars, minimum is ${rule.minLength}` });
    }
    if (rule.maxLength !== null && value.length > rule.maxLength) {
      violations.push({ rule: `string:${rule.key}:maxLength`, message: `argument "${rule.key}" is ${value.length} chars, maximum is ${rule.maxLength}` });
    }
    if (rule.matches !== null && !new RegExp(rule.matches).test(value)) {
      violations.push({ rule: `string:${rule.key}:matches`, message: `argument "${rule.key}" does not match /${rule.matches}/` });
    }
    for (const src of rule.notMatches) {
      if (new RegExp(src).test(value)) {
        violations.push({ rule: `string:${rule.key}:notMatches`, message: `argument "${rule.key}" must not match /${src}/` });
      }
    }
  }
  for (const rule of policy.numbers) {
    const value = args[rule.key];
    if (value === undefined) continue;
    if (typeof value !== "number" || Number.isNaN(value)) {
      violations.push({ rule: `number:${rule.key}`, message: `argument "${rule.key}" must be a number for number rules to apply` });
      continue;
    }
    if (rule.integer && !Number.isInteger(value)) {
      violations.push({ rule: `number:${rule.key}:integer`, message: `argument "${rule.key}" must be an integer, got ${value}` });
    }
    if (rule.min !== null && value < rule.min) {
      violations.push({ rule: `number:${rule.key}:min`, message: `argument "${rule.key}" is ${value}, minimum is ${rule.min}` });
    }
    if (rule.max !== null && value > rule.max) {
      violations.push({ rule: `number:${rule.key}:max`, message: `argument "${rule.key}" is ${value}, maximum is ${rule.max}` });
    }
  }
  if (policy.forbiddenPatterns.length > 0) {
    for (const value of collectStringValues(args)) {
      for (const src of policy.forbiddenPatterns) {
        if (new RegExp(src).test(value)) {
          violations.push({ rule: `forbidden_pattern:${src}`, message: `argument value matches forbidden pattern /${src}/` });
        }
      }
    }
  }
  return violations;
}

function typeMatches(value: unknown, type: TypeRule["type"]): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null": return value === null;
  }
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function collectStringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStringValues(item, out);
  }
  return out;
}
