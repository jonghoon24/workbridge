import type { FieldErrorCode } from '../../src/lib/errorCodes';

/**
 * The exact body of a `VALIDATION_FAILED` 400: `message` as the API words it (`<path>: <sentence>`
 * from `validate()`), and the failing field in `fields`.
 */
export function invalidBody(path: string, code: FieldErrorCode, message: string) {
  return { error: { code: 'VALIDATION_FAILED', message, fields: [{ path, code }] } };
}

/**
 * `invalidBody` for a failure in `validate()`, whose message starts with the failing field's path
 * (`budget: Budget is required` → `budget`) — for tables that list the expected messages.
 */
export function invalidBodyFor(code: FieldErrorCode, message: string) {
  const separator = message.indexOf(': ');
  if (separator < 0) throw new Error(`not a "<path>: <message>" validation message: ${message}`);
  return invalidBody(message.slice(0, separator), code, message);
}
