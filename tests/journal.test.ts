import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { JournalStore, GENESIS_PREV_HASH, type JournalRecord } from "../src/journal.js";
import type { AuditEvent } from "../src/types.js";

const gate = (tool: string, at: number): AuditEvent => ({ kind: "gate", tool, status: "allow", reason: "policy_pass", detail: "ok", at });

function tmpJournal(): string {
  return join(mkdtempSync(join(tmpdir(), "asg-journal-")), "audit.jsonl");
}

describe("JournalStore", () => {
  test("memory mode appends without touching the filesystem", () => {
    const store = new JournalStore(null);
    const r1 = store.append(gate("calc", 1));
    const r2 = store.append(gate("echo", 2));
    expect(r1.seq).toBe(0);
    expect(r1.prevHash).toBe(GENESIS_PREV_HASH);
    expect(r2.seq).toBe(1);
    expect(r2.prevHash).toBe(r1.hash);
    expect(store.size).toBe(2);
    expect(store.verify()).toEqual({ ok: true, records: 2, errors: [] });
  });

  test("file mode persists one JSON line per record and reloads", () => {
    const path = tmpJournal();
    const store = new JournalStore(path);
    store.append(gate("calc", 1));
    store.append(gate("echo", 2));
    expect(existsSync(path)).toBe(true);
    const reloaded = new JournalStore(path);
    expect(reloaded.size).toBe(2);
    expect(reloaded.all().map((r) => r.event)).toEqual(store.all().map((r) => r.event));
    expect(reloaded.verify().ok).toBe(true);
  });

  test("append-time and load-time hashes agree (canonical JSON is stable)", () => {
    const path = tmpJournal();
    const store = new JournalStore(path);
    const event: AuditEvent = { kind: "gate", tool: "t", status: "deny", reason: "r", detail: "d", at: 5, argsKeys: ["z", "a"] };
    const appended = store.append(event);
    const reloaded = new JournalStore(path);
    const loaded = reloaded.all()[0] as JournalRecord;
    expect(loaded.hash).toBe(appended.hash);
  });

  test("verify detects a tampered line with file:line detail", () => {
    const path = tmpJournal();
    const store = new JournalStore(path);
    store.append(gate("calc", 1));
    store.append(gate("echo", 2));
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const parsed = JSON.parse(lines[1] as string) as { event: { tool: string } };
    parsed.event.tool = "hijacked";
    lines[1] = JSON.stringify(parsed);
    writeFileSync(path, lines.join("\n") + "\n");
    const verdict = new JournalStore(path).verify();
    expect(verdict.ok).toBe(false);
    expect(verdict.errors[0]?.line).toBe(2);
    expect(verdict.errors[0]?.error).toContain("hash mismatch");
  });

  test("verify detects a chain break when a middle line is deleted", () => {
    const path = tmpJournal();
    const store = new JournalStore(path);
    store.append(gate("a", 1));
    store.append(gate("b", 2));
    store.append(gate("c", 3));
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    writeFileSync(path, [lines[0], lines[2]].join("\n") + "\n");
    const verdict = new JournalStore(path).verify();
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((e) => e.error.includes("chain break") || e.error.includes("expected seq"))).toBe(true);
  });

  test("load tolerates blank lines and unparseable JSON without throwing", () => {
    const path = tmpJournal();
    const store = new JournalStore(path);
    store.append(gate("a", 1));
    const good = readFileSync(path, "utf8");
    writeFileSync(path, `${good}\n{not json\n\n`);
    const verdict = new JournalStore(path).load();
    expect(verdict.records).toBe(1);
    expect(verdict.errors.map((e) => e.error).some((m) => m.includes("unparseable JSON"))).toBe(true);
  });

  test("an empty or missing file verifies clean", () => {
    expect(new JournalStore(tmpJournal()).verify()).toEqual({ ok: true, records: 0, errors: [] });
    expect(new JournalStore(join(mkdtempSync(join(tmpdir(), "asg-journal-")), "nope.jsonl")).verify()).toEqual({ ok: true, records: 0, errors: [] });
  });

  test("load repositions the append head after reopening a persisted journal", () => {
    const path = tmpJournal();
    const first = new JournalStore(path);
    first.append(gate("a", 1));
    const second = new JournalStore(path);
    const r = second.append(gate("b", 2));
    expect(r.seq).toBe(1);
    const verdict = new JournalStore(path).verify();
    expect(verdict).toEqual({ ok: true, records: 2, errors: [] });
  });
});
