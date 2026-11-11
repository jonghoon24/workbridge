import { ERROR_CODES } from './errorCodes';
import type { ErrorCode, FieldErrorCode, FieldViolation } from './errorCodes';

/**
 * The codes a throw site may use. `INTERNAL_ERROR` is only ever `errorHandler`'s answer to an
 * error that is *not* an `AppError` — a 500 is a bug, never something the code decides to send.
 */
export type AppErrorCode = Exclude<ErrorCode, 'INTERNAL_ERROR'>;

/**
 * An error the API answers with `{ error: { code, message, fields? } }` (`errorHandler`).
 *
 * The code is required and fixes the status (`ERROR_CODES` in `./errorCodes.ts`). `message` is the
 * English sentence for developers and logs; the client never matches it.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly statusCode: number;
  readonly fields?: FieldViolation[];

  constructor(code: AppErrorCode, message: string, options: { fields?: FieldViolation[] } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_CODES[code].status;
    if (options.fields) this.fields = options.fields;
  }
}

/**
 * A `VALIDATION_FAILED` about one request field, for the checks a schema cannot make (they need a
 * stored row or the file `multer` parsed). Same response as a failure in `validate()`.
 */
export function invalidField(path: string, code: FieldErrorCode, message: string): AppError {
  return new AppError('VALIDATION_FAILED', message, { fields: [{ path, code }] });
}
