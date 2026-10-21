import { maintenanceCleanup } from './handlers/maintenanceCleanup';
import { projectLifecycleSweep } from './handlers/projectLifecycleSweep';
import type { JobHandler, JobType } from './types';

/** One handler per job type. The mapped type makes a missing handler a compile error. */
export const registry: { [T in JobType]: JobHandler<T> } = {
  'project.lifecycleSweep': projectLifecycleSweep,
  'maintenance.cleanup': maintenanceCleanup,
};

export function handlerFor(type: string): JobHandler | undefined {
  return Object.prototype.hasOwnProperty.call(registry, type)
    ? (registry[type as JobType] as JobHandler)
    : undefined;
}
