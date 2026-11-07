/**
 * Safe arithmetic expression evaluator — no eval, no Function constructor.
 * Grammar: number | (expr) | unary -/+ | * / % | + -
 * Numbers: decimal literals only. Everything else is rejected.
 */

const MAX_EXPR_LENGTH = 200;

class CalcError extends Error {}

class Scanner {
  private pos = 0;
  constructor(private readonly src: string) {}

  peek(): string | null {
    if (this.pos >= this.src.length) return null;
    return this.src[this.pos] as string;
  }

  next(): string | null {
    const ch = this.peek();
    if (ch !== null) this.pos += 1;
    return ch;
  }

  skipWhitespace(): void {
    while (this.peek() !== null && /\s/.test(this.peek() as string)) {
      this.pos += 1;
    }
  }

  atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  position(): number {
    return this.pos;
  }
}

function parseNumber(s: Scanner): number {
  let text = "";
  const start = s.position();
  while (s.peek() !== null && /[0-9.]/.test(s.peek() as string)) {
    text += s.next();
  }
  if (text === "" || text === ".") {
    throw new CalcError(`expected a number at position ${start}`);
  }
  if ((text.match(/\./g) ?? []).length > 1) {
    throw new CalcError(`malformed number "${text}" at position ${start}`);
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new CalcError(`malformed number "${text}" at position ${start}`);
  }
  return value;
}

function parsePrimary(s: Scanner): number {
  s.skipWhitespace();
  const ch = s.peek();
  if (ch === null) throw new CalcError(`unexpected end of expression`);
  if (ch === "(") {
    s.next();
    const value = parseSum(s);
    s.skipWhitespace();
    if (s.next() !== ")") {
      throw new CalcError(`expected closing parenthesis at position ${s.position()}`);
    }
    return value;
  }
  if (ch === "-") {
    s.next();
    return -parsePrimary(s);
  }
  if (ch === "+") {
    s.next();
    return parsePrimary(s);
  }
  if (/[0-9.]/.test(ch)) {
    return parseNumber(s);
  }
  throw new CalcError(`unexpected character "${ch}" at position ${s.position()}`);
}

function parseProduct(s: Scanner): number {
  let left = parsePrimary(s);
  for (;;) {
    s.skipWhitespace();
    const ch = s.peek();
    if (ch === "*" || ch === "/" || ch === "%") {
      s.next();
      const right = parsePrimary(s);
      if (ch === "*") {
        left = left * right;
      } else if (ch === "/") {
        if (right === 0) throw new CalcError("division by zero");
        left = left / right;
      } else {
        if (right === 0) throw new CalcError("modulo by zero");
        left = left % right;
      }
      continue;
    }
    return left;
  }
}

function parseSum(s: Scanner): number {
  let left = parseProduct(s);
  for (;;) {
    s.skipWhitespace();
    const ch = s.peek();
    if (ch === "+" || ch === "-") {
      s.next();
      const right = parseProduct(s);
      left = ch === "+" ? left + right : left - right;
      continue;
    }
    return left;
  }
}

export function evaluateExpression(expr: string): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof expr !== "string") {
    return { ok: false, error: "expression must be a string" };
  }
  if (expr.length > MAX_EXPR_LENGTH) {
    return { ok: false, error: `expression longer than ${MAX_EXPR_LENGTH} chars` };
  }
  const scanner = new Scanner(expr);
  try {
    const value = parseSum(scanner);
    scanner.skipWhitespace();
    if (!scanner.atEnd()) {
      return { ok: false, error: `unexpected trailing input at position ${scanner.position()}` };
    }
    if (!Number.isFinite(value)) {
      return { ok: false, error: "expression does not evaluate to a finite number" };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
