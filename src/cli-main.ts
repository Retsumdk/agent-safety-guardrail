#!/usr/bin/env node
import { startServer } from "./server.js";
import { JournalStore } from "./journal.js";
import { runDemo } from "./demo.js";
import {
  cmdStats,
  EXIT_DENIED,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_VERIFY_FAILED,
  UsageError,
  buildGuardrail,
  gateLine,
  parseArgs,
  parseArgsJson,
  renderStats,
  usage,
} from "./cli.js";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`asg: ${err.message}\n\n${usage()}\n`);
      return EXIT_USAGE;
    }
    throw err;
  }

  if (parsed.command === null || parsed.command === "help" || parsed.flags.has("--help")) {
    process.stdout.write(`${usage()}\n`);
    return EXIT_OK;
  }

  try {
    switch (parsed.command) {
      case "demo": {
        const out = await runDemo();
        process.stdout.write(`${out}\n`);
        return EXIT_OK;
      }
      case "tools": {
        const { guard } = buildGuardrail(parsed.flags);
        const rows = guard.toolNames().map((name: string) => {
          const policy = guard.policyOf(name);
          const limits: string[] = [];
          if (policy.maxCalls !== null) {
            limits.push(`${policy.maxCalls}/${policy.windowMs}ms`);
          }
          if (policy.timeoutMs !== null) limits.push(`timeout ${policy.timeoutMs}ms`);
          return {
            name,
            description: policy.description ?? "",
            enabled: policy.enabled,
            limits: limits.join(", "),
          };
        });
        if (parsed.flags.get("--json") === "true") {
          process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        } else {
          for (const row of rows) {
            process.stdout.write(`${row.name} — ${row.description}${row.limits ? ` [${row.limits}]` : ""}\n`);
          }
        }
        return EXIT_OK;
      }
      case "evaluate": {
        const tool = requireFlag(parsed.flags, "--tool");
        const args = parseArgsJson(parsed.flags.get("--args"));
        const { guard } = buildGuardrail(parsed.flags);
        const decision = guard.evaluate(tool, args);
        if (parsed.flags.get("--json") === "true") {
          process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
        } else {
          process.stdout.write(`${gateLine(decision)}\n`);
        }
        if (decision.status === "deny" && decision.reason === "unknown_tool") return EXIT_NOT_FOUND;
        return decision.status === "allow" ? EXIT_OK : EXIT_DENIED;
      }
      case "run": {
        const tool = requireFlag(parsed.flags, "--tool");
        const args = parseArgsJson(parsed.flags.get("--args"));
        const { guard } = buildGuardrail(parsed.flags);
        const result = await guard.execute(tool, args);
        if (parsed.flags.get("--json") === "true") {
          process.stdout.write(`${JSON.stringify(result, replacer, 2)}\n`);
        } else {
          process.stdout.write(`${gateLine(result.gate)}\n`);
          if (result.status === "ok") {
            process.stdout.write(`RESULT ${JSON.stringify(result.value)}\n`);
          } else if (result.status === "denied") {
            process.stdout.write(`BLOCKED ${result.reason}: ${result.detail}\n`);
          } else {
            process.stdout.write(`FAILED ${result.error}\n`);
          }
        }
        if (result.status === "denied") {
          return result.reason === "unknown_tool" ? EXIT_NOT_FOUND : EXIT_DENIED;
        }
        return EXIT_OK;
      }
      case "stats": {
        const out = cmdStats(parsed.flags, parsed.flags.get("--json") === "true");
        process.stdout.write(`${out}\n`);
        return EXIT_OK;
      }
      case "verify": {
        const journalPath = parsed.flags.get("--journal");
        if (journalPath === undefined || journalPath === "") {
          process.stderr.write("asg: verify requires --journal FILE\n");
          return EXIT_USAGE;
        }
        const journal = new JournalStore(journalPath);
        const result = journal.load();
        if (parsed.flags.get("--json") === "true") {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else if (result.ok) {
          process.stdout.write(`ok — ${result.records} records, hash chain intact\n`);
        } else {
          for (const err of result.errors) {
            process.stdout.write(`${err.line}: ${err.error}\n`);
          }
          process.stdout.write(`FAILED — ${result.records} valid records, ${result.errors.length} errors\n`);
        }
        return result.ok ? EXIT_OK : EXIT_VERIFY_FAILED;
      }
      case "serve": {
        const port = Number(parsed.flags.get("--port") ?? "8912");
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          process.stderr.write("asg: --port must be an integer between 0 and 65535\n");
          return EXIT_USAGE;
        }
        const { guard } = buildGuardrail(parsed.flags);
        const token = process.env.ASG_TOKEN;
        const server = await startServer(guard, token === undefined ? { port } : { port, token });
        process.stdout.write(`asg serve listening on port ${server.port}\n`);
        process.stdout.write(`auth: ${token === undefined ? "disabled (write endpoints return 503; set ASG_TOKEN)" : "enabled"}\n`);
        process.on("SIGINT", () => {
          void server.close().then(() => process.exit(EXIT_OK));
        });
        await new Promise(() => {});
      }
      default:
        process.stderr.write(`asg: unknown command "${parsed.command}"\n\n${usage()}\n`);
        return EXIT_USAGE;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`asg: ${err.message}\n\n${usage()}\n`);
      return EXIT_USAGE;
    }
    if (err instanceof Error && err.name === "NotFoundError") {
      process.stderr.write(`asg: ${err.message}\n`);
      return EXIT_NOT_FOUND;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`asg: ${message}\n`);
    return EXIT_VERIFY_FAILED;
  }
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value === "") {
    throw new UsageError(`${name} is required for this command`);
  }
  return value;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  return value;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`asg: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });

