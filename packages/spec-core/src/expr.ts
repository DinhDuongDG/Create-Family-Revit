/**
 * Small expression language shared by the studio, the agent and the Revit add-in.
 * It is deliberately restricted to what Revit family formulas understand:
 * + - * / % ^, parentheses, numbers, [parameter references] and a fixed set of
 * functions that work in degrees for trigonometry.
 */

export class ExpressionError extends Error {
  readonly position?: number;

  constructor(message: string, position?: number) {
    super(message);
    this.name = "ExpressionError";
    this.position = position;
  }
}

type Token =
  | { k: "num"; v: number; p: number }
  | { k: "name"; v: string; p: number }
  | { k: "op"; v: string; p: number };

export type ExprNode =
  | { t: "num"; v: number }
  | { t: "ref"; name: string }
  | { t: "bin"; op: "+" | "-" | "*" | "/" | "%" | "^"; a: ExprNode; b: ExprNode }
  | { t: "neg"; a: ExprNode }
  | { t: "call"; name: string; args: ExprNode[] };

const DEG = Math.PI / 180;

function tokenText(token: Token): string {
  return token.k === "num" ? String(token.v) : token.v;
}

const UNITS: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
  deg: 1,
  "°": 1,
};

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const text = src.trim();
  if (text.startsWith("=")) i = src.indexOf("=") + 1;

  while (i < src.length) {
    const ch = src[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }

    if (ch === "[") {
      const end = src.indexOf("]", i + 1);
      if (end < 0) throw new ExpressionError(`Unclosed "[" in "${src}"`, i);
      const name = src.slice(i + 1, end).trim();
      if (!name) throw new ExpressionError(`Empty parameter reference in "${src}"`, i);
      tokens.push({ k: "name", v: name, p: i });
      i = end + 1;
      continue;
    }

    if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ k: "op", v: ch, p: i });
      i += 1;
      continue;
    }

    if ("+-*/^%".includes(ch)) {
      tokens.push({ k: "op", v: ch, p: i });
      i += 1;
      continue;
    }

    if (/[0-9.]/.test(ch)) {
      const start = i;
      let seenDot = false;
      while (i < src.length && /[0-9.]/.test(src[i])) {
        if (src[i] === ".") {
          if (seenDot) throw new ExpressionError(`Invalid number in "${src}"`, start);
          seenDot = true;
        }
        i += 1;
      }
      if (src[i] === "e" || src[i] === "E") {
        const mark = i;
        i += 1;
        if (src[i] === "+" || src[i] === "-") i += 1;
        if (!/[0-9]/.test(src[i] ?? "")) i = mark;
        else while (i < src.length && /[0-9]/.test(src[i])) i += 1;
      }
      const raw = src.slice(start, i);
      let value = Number(raw);
      if (!Number.isFinite(value)) throw new ExpressionError(`Invalid number "${raw}" in "${src}"`, start);

      if (/[A-Za-z°]/.test(src[i] ?? "")) {
        const unitStart = i;
        while (i < src.length && /[A-Za-z°]/.test(src[i])) i += 1;
        const suffix = src.slice(unitStart, i);
        const factor = UNITS[suffix.toLowerCase()];
        if (factor === undefined) {
          throw new ExpressionError(`Unknown unit "${suffix}" in "${src}"`, unitStart);
        }
        value *= factor;
      }

      tokens.push({ k: "num", v: value, p: start });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i += 1;
      tokens.push({ k: "name", v: src.slice(start, i), p: start });
      continue;
    }

    throw new ExpressionError(`Unexpected character "${ch}" in "${src}"`, i);
  }

  if (!tokens.length) throw new ExpressionError("Empty expression");
  return tokens;
}

class Parser {
  private i = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
  ) {}

  parse(): ExprNode {
    const node = this.parseSum();
    if (this.i < this.tokens.length) {
      const token = this.tokens[this.i];
      throw new ExpressionError(`Unexpected "${tokenText(token)}" in "${this.src}"`, token.p);
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private takeOp(...ops: string[]): Token | undefined {
    const token = this.peek();
    if (token && token.k === "op" && ops.includes(token.v)) {
      this.i += 1;
      return token;
    }
    return undefined;
  }

  private parseSum(): ExprNode {
    let left = this.parseProduct();
    for (;;) {
      const op = this.takeOp("+", "-");
      if (!op) return left;
      left = { t: "bin", op: op.v as "+" | "-", a: left, b: this.parseProduct() };
    }
  }

  private parseProduct(): ExprNode {
    let left = this.parseUnary();
    for (;;) {
      const op = this.takeOp("*", "/", "%");
      if (!op) return left;
      left = { t: "bin", op: op.v as "*" | "/" | "%", a: left, b: this.parseUnary() };
    }
  }

  private parseUnary(): ExprNode {
    if (this.takeOp("-")) return { t: "neg", a: this.parseUnary() };
    if (this.takeOp("+")) return this.parseUnary();
    return this.parsePower();
  }

  private parsePower(): ExprNode {
    const base = this.parsePrimary();
    if (this.takeOp("^")) return { t: "bin", op: "^", a: base, b: this.parseUnary() };
    return base;
  }

  private parsePrimary(): ExprNode {
    const token = this.peek();
    if (!token) throw new ExpressionError(`Unexpected end of "${this.src}"`);

    if (token.k === "num") {
      this.i += 1;
      return { t: "num", v: token.v };
    }

    if (token.k === "name") {
      this.i += 1;
      const next = this.peek();
      if (next && next.k === "op" && next.v === "(") {
        this.i += 1;
        const args: ExprNode[] = [];
        const closing = this.takeOp(")");
        if (!closing) {
          for (;;) {
            args.push(this.parseSum());
            if (this.takeOp(",")) continue;
            break;
          }
          if (!this.takeOp(")")) throw new ExpressionError(`Missing ")" in "${this.src}"`, token.p);
        }
        return { t: "call", name: token.v.toLowerCase(), args };
      }
      return { t: "ref", name: token.v };
    }

    if (token.v === "(") {
      this.i += 1;
      const node = this.parseSum();
      if (!this.takeOp(")")) throw new ExpressionError(`Missing ")" in "${this.src}"`, token.p);
      return node;
    }

    throw new ExpressionError(`Unexpected "${tokenText(token)}" in "${this.src}"`, token.p);
  }
}

function roundHalfAway(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return Number.isFinite(rounded) ? rounded / factor : rounded;
}

function callFunction(name: string, args: number[]): number {
  const expect = (count: number) => {
    if (args.length !== count) {
      throw new ExpressionError(`Function "${name}" expects ${count} argument(s), got ${args.length}`);
    }
  };

  switch (name) {
    case "abs":
      expect(1);
      return Math.abs(args[0]);
    case "sqrt":
      expect(1);
      if (args[0] < 0) throw new ExpressionError("sqrt() of a negative number");
      return Math.sqrt(args[0]);
    case "round":
      if (args.length < 1 || args.length > 2) throw new ExpressionError(`Function "round" expects 1 or 2 arguments`);
      return roundHalfAway(args[0], args[1] ?? 0);
    case "roundup":
      if (args.length < 1 || args.length > 2) throw new ExpressionError(`Function "roundup" expects 1 or 2 arguments`);
      return Math.ceil(args[0] * 10 ** (args[1] ?? 0)) / 10 ** (args[1] ?? 0);
    case "rounddown":
      if (args.length < 1 || args.length > 2) throw new ExpressionError(`Function "rounddown" expects 1 or 2 arguments`);
      return Math.floor(args[0] * 10 ** (args[1] ?? 0)) / 10 ** (args[1] ?? 0);
    case "min":
      if (!args.length) throw new ExpressionError(`Function "min" expects at least 1 argument`);
      return Math.min(...args);
    case "max":
      if (!args.length) throw new ExpressionError(`Function "max" expects at least 1 argument`);
      return Math.max(...args);
    case "pow":
      expect(2);
      return args[0] ** args[1];
    case "exp":
      expect(1);
      return Math.exp(args[0]);
    case "ln":
      expect(1);
      if (args[0] <= 0) throw new ExpressionError("ln() needs a positive number");
      return Math.log(args[0]);
    case "log":
      expect(1);
      if (args[0] <= 0) throw new ExpressionError("log() needs a positive number");
      return Math.log10(args[0]);
    case "sin":
      expect(1);
      return Math.sin(args[0] * DEG);
    case "cos":
      expect(1);
      return Math.cos(args[0] * DEG);
    case "tan":
      expect(1);
      return Math.tan(args[0] * DEG);
    case "asin":
      expect(1);
      return Math.asin(args[0]) / DEG;
    case "acos":
      expect(1);
      return Math.acos(args[0]) / DEG;
    case "atan":
      expect(1);
      return Math.atan(args[0]) / DEG;
    default:
      throw new ExpressionError(`Unknown function "${name}"`);
  }
}

export function evaluateNode(node: ExprNode, lookup: (name: string) => number): number {
  switch (node.t) {
    case "num":
      return node.v;
    case "ref": {
      if (node.name.toLowerCase() === "pi") return Math.PI;
      const value = lookup(node.name);
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ExpressionError(`"${node.name}" is not a number`);
      }
      return value;
    }
    case "neg":
      return -evaluateNode(node.a, lookup);
    case "call":
      return callFunction(node.name, node.args.map((arg) => evaluateNode(arg, lookup)));
    case "bin": {
      const a = evaluateNode(node.a, lookup);
      const b = evaluateNode(node.b, lookup);
      switch (node.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          if (b === 0) throw new ExpressionError("Division by zero");
          return a / b;
        case "%":
          if (b === 0) throw new ExpressionError("Division by zero");
          return a % b;
        case "^":
          return a ** b;
      }
    }
  }
}

export function collectReferences(node: ExprNode, into: Set<string> = new Set()): Set<string> {
  switch (node.t) {
    case "ref":
      if (node.name.toLowerCase() !== "pi") into.add(node.name);
      break;
    case "neg":
      collectReferences(node.a, into);
      break;
    case "bin":
      collectReferences(node.a, into);
      collectReferences(node.b, into);
      break;
    case "call":
      for (const arg of node.args) collectReferences(arg, into);
      break;
    case "num":
      break;
  }
  return into;
}

const cache = new Map<string, ExprNode>();

export function compileExpression(source: string): ExprNode {
  const key = source.trim();
  const cached = cache.get(key);
  if (cached) return cached;
  const node = new Parser(tokenize(key), key).parse();
  if (cache.size > 500) cache.clear();
  cache.set(key, node);
  return node;
}

export function expressionDependencies(source: string): string[] {
  return [...collectReferences(compileExpression(source))];
}

export function evaluateExpression(source: string, lookup: (name: string) => number): number {
  return evaluateNode(compileExpression(source), lookup);
}
