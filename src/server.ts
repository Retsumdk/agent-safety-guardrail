import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Guardrail, ToolExecutor } from "./guardrail.js";
import { BUILTIN_EXECUTORS, type BuiltinName } from "./builtins.js";

export type StartServerOptions = {
  port?: number;
  token?: string;
  maxBodyBytes?: number;
};

export type AsgServer = {
  port: number;
  close: () => Promise<void>;
};

function digestEqual(presented: string, secret: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function authorize(req: { headers: Record<string, string | string[] | undefined> }, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return digestEqual(header.slice("Bearer ".length), token);
}

export async function startServer(guardrail: Guardrail, opts: StartServerOptions = {}): Promise<AsgServer> {
  const token = opts.token ?? process.env.ASG_TOKEN ?? null;
  const maxBodyBytes = opts.maxBodyBytes ?? 1_000_000;

  const send = (res: ServerResponseLike, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  };

  const readBody = async (req: IncomingLike): Promise<string> => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buf.length;
      if (size > maxBodyBytes) {
        throw new BodyTooLarge();
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    try {
      if (method === "GET") {
        if (path === "/health") {
          return send(res, 200, { ok: true, tools: guardrail.toolNames().length, journalRecords: guardrail.journalRecords().length });
        }
        if (path === "/tools") {
          return send(res, 200, {
            tools: guardrail.stats().tools,
          });
        }
        if (path === "/stats") {
          return send(res, 200, guardrail.stats());
        }
        if (path === "/verify") {
          return send(res, 200, guardrail.verify());
        }
        if (path === "/events") {
          const limitParam = url.searchParams.get("limit");
          let limit = 50;
          if (limitParam !== null) {
            const parsed = Number(limitParam);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
              return send(res, 400, { error: "validation", message: "limit must be an integer between 1 and 500" });
            }
            limit = parsed;
          }
          const records = guardrail.journalRecords();
          const slice = records.slice(Math.max(0, records.length - limit));
          return send(res, 200, { count: slice.length, events: slice.map((r) => r.event) });
        }
      }

      if (method === "POST") {
        if (!token) {
          return send(res, 503, { error: "degraded", message: "no auth token configured (set ASG_TOKEN); write endpoints are disabled" });
        }
        if (!authorize(req, token)) {
          return send(res, 401, { error: "unauthorized", message: "missing or invalid bearer token" });
        }
        let body: unknown;
        try {
          const raw = await readBody(req);
          body = raw === "" ? {} : JSON.parse(raw);
        } catch (error) {
          if (error instanceof BodyTooLarge) {
            return send(res, 413, { error: "too_large", message: `body exceeds ${maxBodyBytes} bytes` });
          }
          return send(res, 400, { error: "bad_json", message: "request body is not valid JSON" });
        }
        const payload = (body ?? {}) as Record<string, unknown>;

        if (path === "/tools") {
          const name = payload.name;
          if (typeof name !== "string" || name.length === 0) {
            return send(res, 400, { error: "validation", message: "field \"name\" is required" });
          }
          const executorName = payload.executor;
          let executor: ToolExecutor | null = null;
          if (executorName !== undefined) {
            if (typeof executorName !== "string" || !(executorName in BUILTIN_EXECUTORS)) {
              return send(res, 400, { error: "validation", message: 'field "executor" must be one of: echo, flaky, calc' });
            }
            executor = BUILTIN_EXECUTORS[executorName as BuiltinName];
          }
          if (guardrail.has(name)) {
            return send(res, 400, { error: "validation", message: `tool "${name}" is already registered` });
          }
          try {
            guardrail.register(name, {
              policy: payload.policy ?? {},
              executor,
              label: executor ? `builtin:${String(executorName)}` : null,
            });
            return send(res, 201, { ok: true, tool: name });
          } catch (error) {
            return send(res, 400, { error: "validation", message: error instanceof Error ? error.message : String(error) });
          }
        }

        if (path === "/evaluate") {
          const tool = payload.tool;
          if (typeof tool !== "string") {
            return send(res, 400, { error: "validation", message: "field \"tool\" is required" });
          }
          const args = (payload.args ?? {}) as Record<string, unknown>;
          if (typeof args !== "object" || args === null || Array.isArray(args)) {
            return send(res, 400, { error: "validation", message: "field \"args\" must be a JSON object" });
          }
          const decision = guardrail.evaluate(tool, args);
          return send(res, 200, decision);
        }

        if (path === "/execute") {
          const tool = payload.tool;
          if (typeof tool !== "string") {
            return send(res, 400, { error: "validation", message: "field \"tool\" is required" });
          }
          const args = (payload.args ?? {}) as Record<string, unknown>;
          if (typeof args !== "object" || args === null || Array.isArray(args)) {
            return send(res, 400, { error: "validation", message: "field \"args\" must be a JSON object" });
          }
          try {
            if (!guardrail.has(tool)) {
              return send(res, 404, { error: "not_found", message: `unknown tool "${tool}"` });
            }
            const result = await guardrail.execute(tool, args);
            return send(res, 200, result);
          } catch (error) {
            return send(res, 400, { error: "validation", message: error instanceof Error ? error.message : String(error) });
          }
        }

        const resetMatch = /^\/breaker\/([^/]+)\/reset$/.exec(path);
        if (resetMatch) {
          const tool = decodeURIComponent(resetMatch[1] as string);
          try {
            guardrail.resetBreaker(tool);
            return send(res, 200, { ok: true, tool, breaker: guardrail.stats().tools.find((t) => t.name === tool)?.breaker ?? null });
          } catch (error) {
            return send(res, 404, { error: "not_found", message: error instanceof Error ? error.message : String(error) });
          }
        }
      }

      if (path === "/health" || path === "/tools" || path === "/stats" || path === "/verify" || path === "/events" || path === "/tools/" || path === "/evaluate" || path === "/execute" || /^\/breaker\/[^/]+\/reset$/.test(path)) {
        return send(res, 405, { error: "method_not_allowed", message: `${method} ${path} is not supported` });
      }
      return send(res, 404, { error: "not_found", message: `no route for ${method} ${path}` });
    } catch (error) {
      return send(res, 500, { error: "internal", message: error instanceof Error ? error.message : String(error) });
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

class BodyTooLarge extends Error {}

interface ServerResponseLike {
  writeHead: (status: number, headers: Record<string, string | number>) => void;
  end: (body: string) => void;
}

interface IncomingLike {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
  headers: Record<string, string | string[] | undefined>;
}
