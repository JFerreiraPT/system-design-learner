import type { EstimationFieldSpec, EstimationProblemSpec } from "./index.js";

/**
 * How a submitted value compares to the field's expected order of magnitude.
 *
 * `unknown` covers every case where we deliberately have no opinion: text
 * fields, fields with no generated band, and blank values. Legacy specs
 * produce `unknown` everywhere, which is what keeps the UI unchanged for them.
 */
export type CalibrationVerdict = "ok" | "off-by-one-order" | "way-off" | "unknown";

export type FieldCalibration = {
  verdict: CalibrationVerdict;
  /** Which side of the band the value fell on. Absent when `ok`/`unknown`. */
  direction?: "low" | "high";
  /** How far outside the band, as a multiplier. Absent when `ok`/`unknown`. */
  factor?: number;
  /** The band's justification, surfaced only once the candidate is out of
   * range — showing it earlier would give the answer away. */
  rationale?: string;
};

export type SpecCalibration = {
  perField: Record<string, FieldCalibration>;
  /** Count of fields off by up to two orders of magnitude. */
  offByOne: number;
  /** Count of fields off by 100x or more. */
  wayOff: number;
  /** Fields the candidate filled in (any type). */
  filled: number;
  /** Fields in the checklist. */
  total: number;
};

/** Values at or beyond this multiple outside the band are "several orders of
 * magnitude" wrong rather than merely an order out. */
const WAY_OFF_FACTOR = 100;

/**
 * Judge one field's value against its expected magnitude band.
 *
 * `baseValue` must already be in the field's BASE unit — callers convert with
 * `toBaseUnit` first. Comparing a display value against a base-unit band is
 * the exact bug this whole mechanism exists to catch.
 */
export function calibrateField(
  field: EstimationFieldSpec,
  baseValue: number | undefined
): FieldCalibration {
  const band = field.expectedMagnitude;
  if (field.type !== "number" || !band) return { verdict: "unknown" };
  if (typeof baseValue !== "number" || !Number.isFinite(baseValue)) {
    return { verdict: "unknown" };
  }

  if (baseValue >= band.min && baseValue <= band.max) return { verdict: "ok" };

  // Zero or negative is not merely "low" — there is no meaningful ratio, so
  // treat it as maximally wrong rather than dividing by it.
  if (baseValue <= 0) {
    return {
      verdict: "way-off",
      direction: "low",
      rationale: band.rationale
    };
  }

  const direction: "low" | "high" = baseValue < band.min ? "low" : "high";
  const factor = direction === "low" ? band.min / baseValue : baseValue / band.max;
  const verdict: CalibrationVerdict =
    factor >= WAY_OFF_FACTOR ? "way-off" : "off-by-one-order";

  return { verdict, direction, factor, rationale: band.rationale };
}

/** Run `calibrateField` across a whole checklist and summarise. */
export function calibrateAll(
  spec: EstimationProblemSpec,
  estimation: Record<string, unknown>
): SpecCalibration {
  const perField: Record<string, FieldCalibration> = {};
  let offByOne = 0;
  let wayOff = 0;
  let filled = 0;

  for (const field of spec.fields) {
    const raw = estimation[field.key];
    if (raw !== undefined && raw !== null && raw !== "") filled += 1;

    const baseValue = typeof raw === "number" ? raw : undefined;
    const calibration = calibrateField(field, baseValue);
    perField[field.key] = calibration;

    if (calibration.verdict === "off-by-one-order") offByOne += 1;
    if (calibration.verdict === "way-off") wayOff += 1;
  }

  return { perField, offByOne, wayOff, filled, total: spec.fields.length };
}

export type DerivedValue = {
  id: string;
  label: string;
  /** `undefined` when the formula could not be evaluated — a referenced field
   * is blank, the expression is malformed, or the maths blew up. */
  value: number | undefined;
  displayUnit?: string;
};

/** Evaluate a spec's `derivedFormulas` against the candidate's base-unit
 * values. Formulas that cannot be evaluated yield `value: undefined` rather
 * than being dropped, so the panel can show the label with a placeholder. */
export function evaluateDerivedFormulas(
  spec: EstimationProblemSpec,
  estimation: Record<string, unknown>
): DerivedValue[] {
  const formulas = spec.derivedFormulas ?? [];
  if (formulas.length === 0) return [];

  const scope: Record<string, number> = {};
  for (const field of spec.fields) {
    const raw = estimation[field.key];
    if (typeof raw === "number" && Number.isFinite(raw)) scope[field.key] = raw;
  }

  return formulas.map((formula) => ({
    id: formula.id,
    label: formula.label,
    value: evaluateExpression(formula.expression, scope),
    displayUnit: formula.displayUnit
  }));
}

/* ------------------------------------------------------------------ *
 * Expression evaluation
 *
 * Formula strings are model-generated, so they are parsed and evaluated by
 * hand — never `eval`, never `new Function`, never a string-compiling
 * dependency. The grammar is intentionally tiny: identifiers, numeric
 * literals, `+ - * /`, parentheses, and unary minus.
 *
 * Every failure mode (unknown identifier, division by zero, malformed input,
 * overflow) returns `undefined`. Nothing throws.
 * ------------------------------------------------------------------ */

type Token =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: BinaryOp | "neg" }
  | { t: "lparen" }
  | { t: "rparen" };

type BinaryOp = "+" | "-" | "*" | "/";

/** Guards against pathological generated input; the schema caps the string at
 * 200 chars, so a real formula is far below this. */
const MAX_TOKENS = 256;

const PRECEDENCE: Record<BinaryOp | "neg", number> = {
  "+": 1,
  "-": 1,
  "*": 2,
  "/": 2,
  neg: 3
};

export function evaluateExpression(
  expression: string,
  scope: Record<string, number>
): number | undefined {
  const tokens = tokenize(expression);
  if (!tokens) return undefined;
  const rpn = toReversePolish(tokens);
  if (!rpn) return undefined;
  return evaluateRpn(rpn, scope);
}

function tokenize(expression: string): Token[] | null {
  if (typeof expression !== "string") return null;
  const src = expression.trim();
  if (src.length === 0) return null;

  const tokens: Token[] = [];
  let i = 0;

  const previous = (): Token | undefined => tokens[tokens.length - 1];
  // A `-` is unary when nothing can precede it as a value.
  const expectsValue = () => {
    const prev = previous();
    return !prev || prev.t === "op" || prev.t === "lparen";
  };

  while (i < src.length) {
    if (tokens.length > MAX_TOKENS) return null;
    const ch = src[i]!;

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }

    if (ch === "(") {
      tokens.push({ t: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ t: "rparen" });
      i += 1;
      continue;
    }

    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      if (ch === "-" && expectsValue()) {
        tokens.push({ t: "op", v: "neg" });
      } else {
        if (expectsValue()) return null; // binary operator with no left operand
        tokens.push({ t: "op", v: ch });
      }
      i += 1;
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < src.length && src[j]! >= "0" && src[j]! <= "9") j += 1;
      if (j < src.length && src[j] === ".") {
        j += 1;
        while (j < src.length && src[j]! >= "0" && src[j]! <= "9") j += 1;
      }
      const value = Number(src.slice(i, j));
      if (!Number.isFinite(value)) return null;
      tokens.push({ t: "num", v: value });
      i = j;
      continue;
    }

    if ((ch >= "a" && ch <= "z") || ch === "_") {
      let j = i;
      while (j < src.length) {
        const c = src[j]!;
        const isWord =
          (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_";
        if (!isWord) break;
        j += 1;
      }
      tokens.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }

    // Anything else (uppercase, `^`, `%`, `,`, stray symbols) is not part of
    // the grammar. Reject rather than guessing.
    return null;
  }

  return tokens.length > 0 ? tokens : null;
}

/** Shunting-yard. Iterative, so nesting depth costs heap, not stack. */
function toReversePolish(tokens: Token[]): Token[] | null {
  const output: Token[] = [];
  const stack: Token[] = [];

  for (const token of tokens) {
    if (token.t === "num" || token.t === "id") {
      output.push(token);
      continue;
    }

    if (token.t === "op") {
      while (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        if (top.t !== "op") break;
        const topPrec = PRECEDENCE[top.v];
        const tokenPrec = PRECEDENCE[token.v];
        // Unary minus is right-associative; binary operators are left.
        const shouldPop =
          token.v === "neg" ? topPrec > tokenPrec : topPrec >= tokenPrec;
        if (!shouldPop) break;
        output.push(stack.pop()!);
      }
      stack.push(token);
      continue;
    }

    if (token.t === "lparen") {
      stack.push(token);
      continue;
    }

    // rparen
    let matched = false;
    while (stack.length > 0) {
      const top = stack.pop()!;
      if (top.t === "lparen") {
        matched = true;
        break;
      }
      output.push(top);
    }
    if (!matched) return null; // unbalanced
  }

  while (stack.length > 0) {
    const top = stack.pop()!;
    if (top.t === "lparen") return null; // unbalanced
    output.push(top);
  }

  return output;
}

function evaluateRpn(rpn: Token[], scope: Record<string, number>): number | undefined {
  const stack: number[] = [];

  for (const token of rpn) {
    if (token.t === "num") {
      stack.push(token.v);
      continue;
    }

    if (token.t === "id") {
      const value = scope[token.v];
      // An unknown or blank identifier makes the whole formula unanswerable.
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      stack.push(value);
      continue;
    }

    if (token.t !== "op") return undefined;

    if (token.v === "neg") {
      const operand = stack.pop();
      if (operand === undefined) return undefined;
      stack.push(-operand);
      continue;
    }

    const right = stack.pop();
    const left = stack.pop();
    if (right === undefined || left === undefined) return undefined;

    let result: number;
    switch (token.v) {
      case "+":
        result = left + right;
        break;
      case "-":
        result = left - right;
        break;
      case "*":
        result = left * right;
        break;
      case "/":
        if (right === 0) return undefined;
        result = left / right;
        break;
    }
    if (!Number.isFinite(result)) return undefined;
    stack.push(result);
  }

  if (stack.length !== 1) return undefined;
  const [only] = stack;
  return typeof only === "number" && Number.isFinite(only) ? only : undefined;
}
