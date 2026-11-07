# agent-safety-guardrail

Safety enforcement layer for AI agents: policy-gated tool execution, circuit breakers, rate limits, and a tamper-evident audit journal.

## Why

Agent frameworks let tools run by default and treat safety as the tool author's problem. In practice that means an agent with 20 tools has 20 ad-hoc validation regimes — argument checks live inside tool bodies where they can't be audited, a failing dependency gets retried into the ground because nothing trips a breaker, and there is no record of which calls were blocked or why. `agent-safety-guardrail` moves the gate in front of the tools: every call is evaluated against a declarative policy, failures accumulate into a circuit breaker per tool, and every decision — allowed or denied, with reasons — lands in an append-only, hash-chained journal you can verify after the fact.

## What it does

Every tool call passes through the same pipeline:

```
                ┌────────────────────────────────────────────────────┐
args ──► policy gate ──► rate limiter ──► circuit breaker ──► executor ──► run record
                │                 │                  │                              │
                ▼                 ▼                  ▼                              ▼
        deny + reason      deny + reason      deny + reason                  ok / error + latency
                └────────────────────────────────────────────────────┴──────────────────────────┘
                                             audit journal (SHA-256 chain)
```

- **Policy gate** — declarative per-tool rules: required/forbidden argument keys, an argument-key allowlist, type checks, string rules (`matches`, `notMatches`, length bounds), number rules (min/max/integer), and forbidden regex patterns tested against string argument values only (never against key names, so `"expr"` in a key can't false-trip a pattern aimed at values).
- **Circuit breaker** — per tool. Consecutive failures trip the circuit open; after a cooldown exactly one half-open probe is admitted; a probe success closes the circuit, a probe failure re-opens it with a fresh cooldown.
- **Rate limiter** — sliding-window call budget per tool (`maxCalls` within `windowMs`), reconstructed from the journal on restart so limits survive process boundaries.
- **Audit journal** — every registration, gate decision, run outcome, and breaker transition is appended to a JSONL journal whose records are chained by SHA-256 (`seq | prevHash | canonical-JSON`). `verify()` detects tampering to the line.
- **Zero runtime dependencies.** Node >= 18, ESM. The HTTP server is plain `node:http`.

## Getting started

Clone and run:

```bash
git clone https://github.com/Retsumdk/agent-safety-guardrail.git
cd agent-safety-guardrail
bun install        # or: npm install
bun run build      # emits dist/ (also runs automatically via `prepare`)
bun test
```

Install from GitHub (npm package is not published; `prepare` builds `dist/` during install):

```bash
npm install github:Retsumdk/agent-safety-guardrail
```

> Bun users: bun blocks git-dependency lifecycle scripts by default, so after `bun add github:Retsumdk/agent-safety-guardrail` run `bun pm trust agent-safety-guardrail` once to let `prepare` build the package.

### CLI walkthrough

The `asg` CLI works out of the box with three built-in tools (`calc`, `echo`, `flaky`), each shipped with a default policy. Real output:

```
$ asg evaluate --tool calc --args '{"expr":"(2+3)*4"}'
ALLOW calc [policy_pass] all policy checks passed

$ asg evaluate --tool calc --args '{"expr":"process.exit(1)"}'
DENY calc [forbidden_pattern:[_a-zA-Z]] argument value matches forbidden pattern /[_a-zA-Z]/

$ asg run --tool calc --args '{"expr":"10/4"}'
ALLOW calc [policy_pass] all policy checks passed
RESULT {"expr":"10/4","value":2.5}

$ asg run --tool flaky --args '{"fail":true}'
ALLOW flaky [policy_pass] all policy checks passed
FAILED flaky failed on request
```

With a persisted journal, state survives process boundaries — `stats` replays the journal:

```
$ asg run --tool calc --args '{"expr":"2+2"}' --journal j.jsonl
ALLOW calc [policy_pass] all policy checks passed
RESULT {"expr":"2+2","value":4}

$ asg run --tool calc --args '{"expr":"10*3"}' --journal j.jsonl
ALLOW calc [policy_pass] all policy checks passed
RESULT {"expr":"10*3","value":30}

$ asg verify --journal j.jsonl
ok — 7 records, hash chain intact

$ asg stats --journal j.jsonl
tools: 3
gates: 2 allowed, 0 denied
runs: 2 ok, 0 failed

calc:
  gates: 2 allowed, 0 denied (none)
  runs: 2 ok, 0 failed, avg latency 0.5ms
  breaker: closed (consecutive failures 0)
echo:
  gates: 0 allowed, 0 denied (none)
  runs: 0 ok, 0 failed, avg latency 0ms
  breaker: closed (consecutive failures 0)
flaky:
  gates: 0 allowed, 0 denied (none)
  runs: 0 ok, 0 failed, avg latency 0ms
  breaker: closed (consecutive failures 0)
```

Custom tools come from a policy file. Given `asg.policy.json`:

```json
{
  "version": 1,
  "tools": [
    {
      "tool": "external_search",
      "executor": "echo",
      "description": "Wraps an external search API behind a policy gate",
      "policy": {
        "required": ["query"],
        "types": [{ "key": "query", "type": "string" }],
        "strings": [{ "key": "query", "maxLength": 300 }],
        "forbiddenPatterns": ["drop\\s+table"],
        "maxCalls": 30,
        "windowMs": 60000,
        "timeoutMs": 5000
      }
    },
    {
      "tool": "policy_only_tool",
      "description": "Audited policy gate for a tool executed outside this process"
    }
  ]
}
```

`executor` selects a built-in executor (`echo` returns its args, `calc` evaluates a safe arithmetic expression, `flaky` fails when `args.fail` is true); omitting `executor` registers a **policy-only tool** — evaluated and audited, but execution happens elsewhere and is reported as `no_executor`.

```
$ asg run --tool external_search --policy asg.policy.json --args '{"query":"hello world"}'
ALLOW external_search [policy_pass] all policy checks passed
RESULT {"echoed":{"query":"hello world"}}

$ asg run --tool external_search --policy asg.policy.json --args '{"query":"drop table users"}'
DENY external_search [forbidden_pattern:drop\s+table] argument value matches forbidden pattern /drop\s+table/

$ asg run --tool policy_only_tool --policy asg.policy.json --args '{}'
ALLOW policy_only_tool [policy_pass] all policy checks passed
FAILED policy-only tool "policy_only_tool" has no executor registered
```

CLI commands and exit codes:

| Command | Purpose | Exit codes |
| --- | --- | --- |
| `asg demo` | Run the deterministic feature demo | 0 |
| `asg tools [--policy FILE]` | List registered tools and policies | 0 / 2 |
| `asg evaluate --tool N --args JSON` | Evaluate without executing | 0 allow / 3 unknown / 4 denied / 2 usage |
| `asg run --tool N --args JSON` | Evaluate and execute | 0 ok / 3 unknown / 4 denied / 2 usage |
| `asg stats [--journal FILE]` | Aggregate + per-tool counters | 0 |
| `asg verify --journal FILE` | Verify journal integrity | 0 / 5 tampered |
| `asg serve [--port N]` | HTTP enforcement API | — |

Flags: `--tool/-t`, `--args/-a`, `--policy/-p`, `--journal/-j`, `--port/-P`, `--json/-J`. Exit `1` = crash, `2` = usage, `3` = not found, `4` = denied, `5` = integrity failure.

### Library usage

```ts
import { Guardrail } from "agent-safety-guardrail";

const guard = new Guardrail({});
guard.register("web_search", {
  policy: {
    required: ["query"],
    types: [{ key: "query", type: "string" }],
    strings: [{ key: "query", maxLength: 300 }],
    forbiddenPatterns: ["drop\\s+table"],
    maxCalls: 2,
    windowMs: 60_000,
  },
  executor: (args) => ({ results: [`hit for ${args["query"]}`] }),
});

const ok = await guard.execute("web_search", { query: "agent guardrails" });
console.log(ok.status, JSON.stringify(ok.value));
// ok {"results":["hit for agent guardrails"]}

const denied = guard.evaluate("web_search", { query: "drop table users" });
console.log(denied.status, denied.reason);
// denied forbidden_pattern:drop\s+table

const limited = await guard.execute("web_search", { query: "a" });
const blocked = await guard.execute("web_search", { query: "b" });
console.log(blocked.status, blocked.reason);
// denied rate_limited

const verdict = guard.verify();
console.log("journal:", verdict.ok, verdict.records, "records");
// journal: true 6 records
```

To resume enforcement over a persisted journal (state replays automatically on construction; executors are re-attached by name):

```ts
import { Guardrail } from "agent-safety-guardrail";
import { JournalStore } from "agent-safety-guardrail";
import { BUILTIN_EXECUTORS } from "agent-safety-guardrail";

const journal = new JournalStore("j.jsonl");          // loads + verifies the file
const guard = new Guardrail({ journal });             // replays history: counters, rate windows, breaker state
guard.rebindExecutor("calc", BUILTIN_EXECUTORS.calc, "builtin:calc");
```

### HTTP API

```bash
# write endpoints need a bearer token; GETs are public
ASG_TOKEN=my-secret asg serve --port 8912 --journal j.jsonl
```

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/health` | GET | public | liveness + journal record count |
| `/tools` | GET | public | registered tools with breaker states |
| `/stats` | GET | public | aggregate + per-tool counters |
| `/verify` | GET | public | journal integrity verdict |
| `/events?limit=N` | GET | public | newest journal records (1–500) |
| `/tools` | POST | bearer | register a tool (`name`, optional `executor` name, optional `policy`) |
| `/evaluate` | POST | bearer | evaluate `{tool, args}` without executing |
| `/execute` | POST | bearer | evaluate and execute `{tool, args}` |
| `/breaker/:name/reset` | POST | bearer | force a circuit back to closed |

```bash
curl -s localhost:8912/health
# {"ok":true,"tools":3,"journalRecords":25}

curl -s -X POST localhost:8912/execute \
  -H "Authorization: Bearer my-secret" -H "Content-Type: application/json" \
  -d '{"tool":"calc","args":{"expr":"(2+3)*4"}}'
# {"tool":"calc","status":"ok","value":{"expr":"(2+3)*4","value":20},...}

curl -s -X POST localhost:8912/execute -d '{"tool":"calc"}'   # no token
# 503 {"error":"degraded","message":"no auth token configured (set ASG_TOKEN); write endpoints are disabled"}
```

### Journal integrity

The journal is append-only JSONL; each record carries `seq`, `prevHash`, and `hash = SHA-256(seq | prevHash | canonical-JSON(event))`. `asg verify` (and `GET /verify`) re-hash every line:

```
$ asg verify --journal tamper.jsonl
5: hash mismatch (record tampered or reordered)
6: chain break: expected seq 4 with prevHash 3ac55dda
7: chain break: expected seq 4 with prevHash 3ac55dda
FAILED — 4 valid records, 3 errors
```

Editing one record's payload invalidates its hash and every downstream link — the failure names the exact line.

### Deterministic demo

`asg demo` runs the full pipeline against a frozen clock (breaker trip, half-open probe recovery, rate-limit denial, journal verification) and prints byte-identical output on every run — `bun run verify:demo` diffs it in CI.

## How it works

- **`Guardrail`** (`src/guardrail.ts`) owns the pipeline: `evaluate()` runs the policy checks in order (unknown tool → disabled → argument rules → rate window → circuit state) and journals the decision; `execute()` additionally runs the executor under `timeoutMs`, journals the run outcome, and feeds the breaker.
- **Policies** (`src/policy.ts`) are validated on registration — bad regex sources, non-integer `maxCalls`, non-positive `windowMs`/`timeoutMs` are rejected at `register()` time, not at call time.
- **`CircuitBreaker`** (`src/breaker.ts`) is a standalone state machine with an injectable clock and a transition listener (the Guardrail journals transitions through it). `canAttempt`/`recordSuccess`/`recordFailure` accept explicit timestamps, which is what makes journal replay exact.
- **`JournalStore`** (`src/journal.ts`) appends one JSON line per event, tolerates trailing partial lines, and returns per-line errors from `load()`/`verify()` instead of throwing.
- **Replay** — constructing a `Guardrail` over a loaded journal re-derives counters, rate windows, and breaker state from the event stream. Registration is journaled, so tools reappear with their policies; executors (functions) are not serializable and are re-attached with `rebindExecutor` or an identical re-`register` (which appends a fresh tool event, last-writer-wins on replay).

## Design notes and limits

- Single-process, in-memory enforcement state; the journal reconstructs it across restarts but there is no distributed coordination.
- Rate windows are counted from `Date.now()`-comparable integer milliseconds; wall-clock changes affect sliding windows as they would any wall-clock limiter.
- The `calc` executor parses a deliberately tiny grammar (decimal literals, `+ - * / %`, parentheses, unary `+/-`) — no identifiers, no function calls, no `eval`.
- The journal proves that the recorded history is intact, not that the process wasn't restarted mid-window.

## License

MIT — see [LICENSE](LICENSE).
