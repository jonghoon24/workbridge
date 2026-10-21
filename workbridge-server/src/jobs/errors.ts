/**
 * Thrown by a handler when retrying cannot help (bad payload, a referenced row that will never
 * exist, an unsupported provider). The runner marks the job `FAILED` immediately instead of
 * backing off and retrying.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}
