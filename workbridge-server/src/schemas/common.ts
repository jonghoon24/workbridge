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
