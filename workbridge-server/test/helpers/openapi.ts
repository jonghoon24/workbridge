import type { ResponseConfig, RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { Response } from 'supertest';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';

import { buildRegistry } from '../../src/openapi/registry';
import { errorBody } from '../../src/openapi/responses/common';

/**
 * Response conformance: every response a test receives through `api()` / `authed()` is checked
 * against the OpenAPI document's response schema for its method, path and status. The suite's
 * ~2,200 tests thereby double as contract tests — a status the document does not list, or a body
 * that differs from its schema, fails the test that received it, at the request.
 *
 * - Bodies are checked **strictly**: every object rejects keys the schema does not list, so a field
 *   added to a response without documenting it is caught.
 * - A request whose path matches no documented route is not checked — it is the app's own HTML 404
 *   for an unknown path (#19), or one of the docs routes (`UNDOCUMENTED_ROUTES`).
 *   `test/openapi.test.ts` keeps the documented routes equal to the mounted ones.
 * - A 500 is never documented — it is a bug by definition — so it is only checked to be
 *   the error envelope. The suite's deliberate 500s (`test/helpers/faults.ts`, and the profile image upload's 500 for a bad file) pass that.
 * - A documented response without content (the OAuth redirects) has its body ignored.
 */

type Method = RouteConfig['method'];

export interface DocumentedOperation {
  method: Method;
  /** OpenAPI template, `/api/projects/{id}`. */
  path: string;
  responses: RouteConfig['responses'];
  matches(path: string): boolean;
  /** Literal (non-parameter) segments; the most literal match wins, as in the routers. */
  literalSegments: number;
}

/** Express's `/:id` → OpenAPI's `/{id}`. */
export function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function compile(template: string): RegExp {
  const pattern = template
    .split('/')
    .map((segment) => (/^\{.+\}$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^$()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${pattern}/?$`);
}

let operations: DocumentedOperation[] | undefined;

/** Every route registered in `src/openapi/registry.ts`. */
export function documentedOperations(): DocumentedOperation[] {
  operations ??= buildRegistry()
    .definitions.flatMap((definition) => (definition.type === 'route' ? [definition.route] : []))
    .map((route) => {
      const regex = compile(route.path);
      return {
        method: route.method,
        path: route.path,
        responses: route.responses,
        matches: (path: string) => regex.test(path),
        literalSegments: route.path.split('/').filter((s) => s && !s.startsWith('{')).length,
      };
    });
  return operations;
}

/** The documented operation a request lands on, preferring literal segments over parameters. */
export function findOperation(method: string, path: string): DocumentedOperation | undefined {
  return documentedOperations()
    .filter((op) => op.method === method.toLowerCase() && op.matches(path))
    .sort((a, b) => b.literalSegments - a.literalSegments)[0];
}

// ---------------------------------------------------------------------------------------------
// Strict schemas
// ---------------------------------------------------------------------------------------------

const strictCache = new WeakMap<ZodTypeAny, ZodTypeAny>();

/**
 * `schema` with every nested object made `.strict()`. Response schemas are documentation and stay
 * open (clients must tolerate new fields), so strictness is applied here, for checking only.
 */
export function strictDeep(schema: ZodTypeAny): ZodTypeAny {
  const cached = strictCache.get(schema);
  if (cached) return cached;

  let result: ZodTypeAny = schema;
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(
      Object.entries(schema.shape as Record<string, ZodTypeAny>).map(([key, value]) => [key, strictDeep(value)]),
    );
    result = new z.ZodObject({ ...schema._def, shape: () => shape, unknownKeys: 'strict' });
  } else if (schema instanceof z.ZodArray) {
    result = new z.ZodArray({ ...schema._def, type: strictDeep(schema._def.type) });
  } else if (schema instanceof z.ZodNullable) {
    result = new z.ZodNullable({ ...schema._def, innerType: strictDeep(schema._def.innerType) });
  } else if (schema instanceof z.ZodOptional) {
    result = new z.ZodOptional({ ...schema._def, innerType: strictDeep(schema._def.innerType) });
  } else if (schema instanceof z.ZodUnion) {
    result = new z.ZodUnion({ ...schema._def, options: schema._def.options.map(strictDeep) });
  } else if (schema instanceof z.ZodIntersection) {
    result = new z.ZodIntersection({ ...schema._def, left: strictDeep(schema._def.left), right: strictDeep(schema._def.right) });
  } else if (schema instanceof z.ZodEffects) {
    result = new z.ZodEffects({ ...schema._def, schema: strictDeep(schema._def.schema) });
  }

  strictCache.set(schema, result);
  return result;
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

function isResponseConfig(value: unknown): value is ResponseConfig {
  return typeof value === 'object' && value !== null && 'description' in value;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}${'keys' in issue ? ` ${JSON.stringify(issue.keys)}` : ''}`)
    .join('\n');
}

/** Why `res` does not conform to the document, or `null` when it does (or is not checked). */
export function conformanceError(res: Response): string | null {
  const request = (res as Response & { request: { method: string; url: string } }).request;
  const method = request.method.toUpperCase();
  const path = new URL(request.url).pathname;
  const label = `${method} ${path} → ${res.status}`;

  const operation = findOperation(method, path);
  if (!operation) return null;

  const contentType = String(res.headers['content-type'] ?? '');

  if (res.status === 500) {
    const parsed = errorBody.strict().safeParse(res.body);
    return parsed.success ? null : `${label}: a 500 must still be the error envelope\n${formatIssues(parsed.error)}`;
  }

  const documented = operation.responses[String(res.status)];
  if (!documented) {
    const listed = Object.keys(operation.responses).join(', ');
    return `${label}: status ${res.status} is not documented for ${operation.method.toUpperCase()} ${operation.path} (documented: ${listed})`;
  }
  if (!isResponseConfig(documented) || !documented.content) return null;

  const mediaType = Object.keys(documented.content).find((type) => contentType.startsWith(type));
  if (!mediaType) {
    return `${label}: content type "${contentType}" is not documented (documented: ${Object.keys(documented.content).join(', ')})`;
  }
  const schema = documented.content[mediaType]?.schema;
  if (!(schema instanceof z.ZodType)) return null;

  const body = mediaType === 'application/json' ? res.body : res.text;
  const parsed = strictDeep(schema).safeParse(body);
  return parsed.success
    ? null
    : `${label}: the body does not match the documented schema of ${operation.method.toUpperCase()} ${operation.path}\n${formatIssues(parsed.error)}`;
}

/** A supertest assertion (`.expect(conformsToOpenApi)`); `api()` and `authed()` add it to every request. */
export function conformsToOpenApi(res: Response): void {
  const error = conformanceError(res);
  if (error) throw new Error(`OpenAPI conformance: ${error}`);
}
