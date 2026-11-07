import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") {
    return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
  }
  if (type === "boolean" || type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(serialize).join(",") + "]";
  }
  if (type === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + serialize(v)).join(",") + "}";
  }
  return "null";
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
