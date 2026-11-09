import { z } from 'zod';

/**
 * Query-string building blocks for expansion routes (BEHAVIOR.md rule 12): an empty value is
 * absent, a repeated parameter is a 400, and integers must be plain integers (`1.5` and `2abc`
 * are 400s). Pre-existing endpoints do not use these — their Q12/Q13 behavior is untouched.
 */

const SINGLE_VALUE = 'must be a single value';

function scalar(value: unknown, ctx: z.RefinementCtx): string | undefined | typeof z.NEVER {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: SINGLE_VALUE });
    return z.NEVER;
  }
  return value;
}

export interface QueryIntOptions {
  min?: number;
  max?: number;
}

/** An optional integer query parameter; `undefined` when absent or empty. */
export function queryInt(options?: QueryIntOptions): z.ZodType<number | undefined, z.ZodTypeDef, unknown>;
/** An integer query parameter that falls back to `fallback` when absent or empty. */
export function queryInt(options: QueryIntOptions & { fallback: number }): z.ZodType<number, z.ZodTypeDef, unknown>;
export function queryInt(
  { min, max, fallback }: QueryIntOptions & { fallback?: number } = {},
): z.ZodType<number | undefined, z.ZodTypeDef, unknown> {
  return z.unknown().transform((value, ctx): number | undefined => {
    const raw = scalar(value, ctx);
    if (raw === z.NEVER) return z.NEVER;
    if (raw === undefined) return fallback;

    if (!/^-?\d+$/.test(raw)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be an integer' });
      return z.NEVER;
    }

    const parsed = Number(raw);
    if (min !== undefined && parsed < min) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be at least ${min}` });
      return z.NEVER;
    }
    if (max !== undefined && parsed > max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be at most ${max}` });
      return z.NEVER;
    }
    return parsed;
  });
}

/** An optional string query parameter; `undefined` when absent or empty, 400 when repeated. */
export function queryString() {
  return z.unknown().transform((value, ctx) => {
    const raw = scalar(value, ctx);
    return raw === z.NEVER ? z.NEVER : raw;
  });
}

/** One of `values`; `fallback` (or `undefined`) when absent or empty. */
export function queryEnum<const T extends readonly [string, ...string[]]>(values: T, fallback?: T[number]) {
  return z.unknown().transform((value, ctx): T[number] | undefined => {
    const raw = scalar(value, ctx);
    if (raw === z.NEVER) return z.NEVER;
    if (raw === undefined) return fallback;
    if (!(values as readonly string[]).includes(raw)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be one of ${values.join(', ')}` });
      return z.NEVER;
    }
    return raw as T[number];
  });
}

// ---------------------------------------------------------------------------------------------
// Added when the pre-existing routes moved to zod. Query helpers keep the style above (lowercase,
// `validate()` prefixes the field path).
// ---------------------------------------------------------------------------------------------

const DECIMAL = /^-?\d+(\.\d+)?$/;

export interface QueryNumberOptions {
  min?: number;
}

/**
 * An optional decimal query parameter (`1500000`, `4999999.5`); `undefined` when absent or empty.
 * Trailing garbage (`3abc`), exponents and a repeated parameter → 400.
 */
export function queryNumber({ min }: QueryNumberOptions = {}) {
  return z.unknown().transform((value, ctx): number | undefined => {
    const raw = scalar(value, ctx);
    if (raw === z.NEVER) return z.NEVER;
    if (raw === undefined) return undefined;

    if (!DECIMAL.test(raw)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a number' });
      return z.NEVER;
    }

    const parsed = Number(raw);
    if (min !== undefined && parsed < min) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be at least ${min}` });
      return z.NEVER;
    }
    return parsed;
  });
}

/**
 * Body fields below take a `label` and produce sentence messages (`Budget is required`), the style
 * of the expansion bodies (`schemas/milestones.ts`). `validate()` prefixes the field path.
 */

const WHOLE_WON = /^-?\d+$/;

/**
 * A whole number of won (money-time rule, rule 12) of at least `min`: a JSON integer or a plain
 * integer string (`'2500000'` — form inputs and the TossPayments redirect deliver strings).
 * Anything else — a fraction (`1000.5`), `'3abc'`, `'1e6'`, `'Infinity'`, whitespace, a boolean,
 * `null`, an unsafe integer, or a value below `min` — is one message:
 * `<Label> must be a positive whole number of won` (`non-negative` when `min` is 0). Absent →
 * `<Label> is required`.
 */
export function bodyWholeWon(label: string, { min }: { min: 0 | 1 }) {
  const message = `${label} must be a ${min === 0 ? 'non-negative' : 'positive'} whole number of won`;
  return z
    .union([z.number(), z.string().trim().regex(WHOLE_WON, message)], {
      errorMap: (_issue, ctx) => ({ message: ctx.data === undefined ? `${label} is required` : message }),
    })
    // `+ 0` turns `'-0'` into 0.
    .transform((value) => Number(value) + 0)
    .superRefine((value, ctx) => {
      if (!Number.isSafeInteger(value) || value < min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      }
    });
}

/** A required body field that must be one of `values`: `<Label> must be one of A, B`. */
export function bodyEnum<const T extends readonly [string, ...string[]]>(label: string, values: T) {
  return z.enum(values as unknown as [T[number], ...T[number][]], {
    errorMap: (_issue, ctx) => ({
      message: ctx.data === undefined ? `${label} is required` : `${label} must be one of ${values.join(', ')}`,
    }),
  });
}

/**
 * A required body string: trimmed, and empty or whitespace-only counts as missing
 * (`<Label> is required`); a non-string is `<Label> must be a string`.
 */
export function requiredString(label: string) {
  return z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be a string` })
    .trim()
    .min(1, `${label} is required`);
}
