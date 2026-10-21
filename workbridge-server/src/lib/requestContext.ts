import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request (or per-job) context, readable anywhere down the call chain without threading it
 * through arguments. The logger stamps `requestId`/`jobId` onto every line, and `enqueueJob`
 * records `requestId` as the job's `traceId`.
 */
export interface RequestContext {
  requestId?: string;
  userId?: string;
  jobId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return requestContext.run(context, fn);
}
