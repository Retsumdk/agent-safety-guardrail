import type { PolicyInput } from "./policy.js";

export interface PolicyFileTool {
  tool: string;
  executor?: string;
  description?: string;
  policy?: PolicyInput;
}

export interface PolicyFile {
  version: 1;
  tools: PolicyFileTool[];
}

export function isPolicyFile(value: unknown): value is PolicyFile {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v["version"] !== 1) return false;
  if (!Array.isArray(v["tools"])) return false;
  return (v["tools"] as unknown[]).every((t) => {
    if (t === null || typeof t !== "object") return false;
    const entry = t as Record<string, unknown>;
    if (typeof entry["tool"] !== "string" || entry["tool"].length === 0) return false;
    if (entry["executor"] !== undefined && typeof entry["executor"] !== "string") return false;
    if (entry["description"] !== undefined && typeof entry["description"] !== "string") return false;
    if (entry["policy"] !== undefined && (entry["policy"] === null || typeof entry["policy"] !== "object" || Array.isArray(entry["policy"]))) return false;
    return true;
  });
}

export function parsePolicyFile(text: string): { ok: true; file: PolicyFile } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `policy file is not valid JSON: ${(err as Error).message}` };
  }
  if (!isPolicyFile(parsed)) {
    return { ok: false, error: 'policy file must be {"version":1,"tools":[...]} where every entry has a string "tool", an optional "executor" (echo|flaky|calc), and an optional "policy" object' };
  }
  return { ok: true, file: parsed };
}
