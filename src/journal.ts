import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "./canonical.js";
import type { AuditEvent } from "./types.js";

export type JournalRecord = {
  seq: number;
  prevHash: string;
  hash: string;
  event: AuditEvent;
};

export type VerifyResult = {
  ok: boolean;
  records: number;
  errors: { line: number; error: string }[];
};

export const GENESIS_PREV_HASH = "genesis";

export function hashRecord(seq: number, prevHash: string, event: AuditEvent): string {
  const payload = `${seq}|${prevHash}|${canonicalJson(event)}`;
  return sha256Hex(payload);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function recordLine(record: JournalRecord): string {
  return JSON.stringify({ seq: record.seq, prevHash: record.prevHash, hash: record.hash, event: record.event });
}

export class JournalStore {
  private path: string | null;
  private records: JournalRecord[] = [];

  constructor(path: string | null = null) {
    this.path = path;
    if (path !== null && existsSync(path)) {
      this.load();
    }
  }

  static create(path: string | null): JournalStore {
    return new JournalStore(path);
  }

  append(event: AuditEvent): JournalRecord {
    const seq = this.records.length;
    const prevHash = seq === 0 ? GENESIS_PREV_HASH : (this.records[seq - 1] as JournalRecord).hash;
    const hash = hashRecord(seq, prevHash, event);
    const record: JournalRecord = { seq, prevHash, hash, event };
    this.records.push(record);
    if (this.path !== null) {
      this.flushOne(record);
    }
    return record;
  }

  private flushOne(record: JournalRecord): void {
    if (this.path === null) return;
    const dir = dirname(this.path);
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.path, `${recordLine(record)}\n`, { flag: "a" });
  }

  all(): JournalRecord[] {
    return [...this.records];
  }

  get size(): number {
    return this.records.length;
  }

  lastHash(): string {
    if (this.records.length === 0) return GENESIS_PREV_HASH;
    return (this.records[this.records.length - 1] as JournalRecord).hash;
  }

  load(): VerifyResult {
    if (this.path === null) return { ok: true, records: 0, errors: [] };
    if (!existsSync(this.path)) return { ok: true, records: 0, errors: [] };
    const text = readFileSync(this.path, "utf8");
    const errors: { line: number; error: string }[] = [];
    const loaded: JournalRecord[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (raw === undefined || raw.trim() === "") continue;
      try {
        const parsed = JSON.parse(raw) as { seq?: unknown; prevHash?: unknown; hash?: unknown; event?: unknown };
        if (typeof parsed.seq !== "number" || typeof parsed.prevHash !== "string" || typeof parsed.hash !== "string" || parsed.event === undefined) {
          errors.push({ line: i + 1, error: "missing seq/prevHash/hash/event fields" });
          continue;
        }
        const expected = hashRecord(parsed.seq, parsed.prevHash, parsed.event as AuditEvent);
        if (expected !== parsed.hash) {
          errors.push({ line: i + 1, error: "hash mismatch (record tampered or reordered)" });
          continue;
        }
        if (loaded.length > 0) {
          const prev = loaded[loaded.length - 1] as JournalRecord;
          if (parsed.seq !== prev.seq + 1 || parsed.prevHash !== prev.hash) {
            errors.push({ line: i + 1, error: `chain break: expected seq ${prev.seq + 1} with prevHash ${prev.hash.slice(0, 8)}` });
            continue;
          }
        } else if (parsed.seq !== 0 || parsed.prevHash !== GENESIS_PREV_HASH) {
          errors.push({ line: i + 1, error: `first record must have seq 0 and prevHash "${GENESIS_PREV_HASH}"` });
          continue;
        }
        loaded.push({ seq: parsed.seq, prevHash: parsed.prevHash, hash: parsed.hash, event: parsed.event as AuditEvent });
      } catch (err) {
        errors.push({ line: i + 1, error: `unparseable JSON: ${(err as Error).message}` });
      }
    }
    this.records = loaded;
    return { ok: errors.length === 0, records: loaded.length, errors };
  }

  verify(): VerifyResult {
    if (this.path === null) {
      const errors: { line: number; error: string }[] = [];
      for (let i = 0; i < this.records.length; i++) {
        const record = this.records[i] as JournalRecord;
        const expected = hashRecord(record.seq, record.prevHash, record.event);
        if (expected !== record.hash) {
          errors.push({ line: i + 1, error: "hash mismatch" });
        }
        const prevHash = i === 0 ? GENESIS_PREV_HASH : (this.records[i - 1] as JournalRecord).hash;
        if (record.seq !== i || record.prevHash !== prevHash) {
          errors.push({ line: i + 1, error: "chain break" });
        }
      }
      return { ok: errors.length === 0, records: this.records.length, errors };
    }
    if (!existsSync(this.path)) return { ok: true, records: 0, errors: [] };
    const text = readFileSync(this.path, "utf8");
    const errors: { line: number; error: string }[] = [];
    const lines = text.split("\n");
    let prev: JournalRecord | null = null;
    let valid = 0;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (raw === undefined || raw.trim() === "") continue;
      try {
        const parsed = JSON.parse(raw) as { seq?: unknown; prevHash?: unknown; hash?: unknown; event?: unknown };
        if (typeof parsed.seq !== "number" || typeof parsed.prevHash !== "string" || typeof parsed.hash !== "string" || parsed.event === undefined) {
          errors.push({ line: i + 1, error: "missing seq/prevHash/hash/event fields" });
          continue;
        }
        const expected = hashRecord(parsed.seq, parsed.prevHash, parsed.event as AuditEvent);
        if (expected !== parsed.hash) {
          errors.push({ line: i + 1, error: "hash mismatch (record tampered or reordered)" });
          continue;
        }
        if (prev === null) {
          if (parsed.seq !== 0 || parsed.prevHash !== GENESIS_PREV_HASH) {
            errors.push({ line: i + 1, error: `first record must have seq 0 and prevHash "${GENESIS_PREV_HASH}"` });
          }
        } else if (parsed.seq !== prev.seq + 1 || parsed.prevHash !== prev.hash) {
          errors.push({ line: i + 1, error: `chain break: expected seq ${prev.seq + 1} with prevHash ${prev.hash.slice(0, 8)}` });
        }
        prev = { seq: parsed.seq, prevHash: parsed.prevHash, hash: parsed.hash, event: parsed.event as AuditEvent };
        valid += 1;
      } catch (err) {
        errors.push({ line: i + 1, error: `unparseable JSON: ${(err as Error).message}` });
      }
    }
    return { ok: errors.length === 0, records: valid, errors };
  }
}
