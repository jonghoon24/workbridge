import { z } from 'zod';

import { NOTIFICATION_TYPES, isNotificationType, policyFor } from '../lib/notifications/policy';
import type { NotificationType } from '../lib/notifications/types';

/** One validated `PUT` entry: an omitted channel keeps its current setting (NC6). */
export interface PreferenceEntry {
  type: NotificationType;
  inApp?: boolean;
  email?: boolean;
}

const MAX_ENTRIES = NOTIFICATION_TYPES.length; // NC1: 1–20

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `PUT /api/notifications/preferences` (NC6). Two passes, each reporting only its first failure
 * (rule 12's `<path>: <message>`): the **shape** of every entry, in array order and `type` →
 * `inApp` → `email` within an entry; then, once the whole shape is valid, the **entry rules** in
 * array order. Written as one transform rather than a zod object so the order and the messages
 * are exactly NC6's. Unknown keys are ignored.
 */
export const preferencesBody = z.unknown().transform((body, ctx): { preferences: PreferenceEntry[] } => {
  const fail = (path: (string | number)[], message: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    return z.NEVER;
  };

  // 1. Shape.
  const raw = isRecord(body) ? body.preferences : undefined;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ENTRIES) {
    return fail(['preferences'], `Expected 1 to ${MAX_ENTRIES} entries`);
  }

  const entries: PreferenceEntry[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry)) return fail(['preferences', i], 'Expected an object');
    if (!isNotificationType(entry.type)) return fail(['preferences', i, 'type'], 'Unknown notification type');
    for (const channel of ['inApp', 'email'] as const) {
      if (channel in entry && typeof entry[channel] !== 'boolean') {
        return fail(['preferences', i, channel], 'Expected a boolean');
      }
    }
    entries.push({
      type: entry.type,
      ...(typeof entry.inApp === 'boolean' ? { inApp: entry.inApp } : {}),
      ...(typeof entry.email === 'boolean' ? { email: entry.email } : {}),
    });
  }

  // 2. Entry rules. A locked channel set to its own value passes and changes nothing.
  const seen = new Set<NotificationType>();
  for (const [i, entry] of entries.entries()) {
    if (entry.inApp === undefined && entry.email === undefined) {
      return fail(['preferences', i], 'Specify inApp or email');
    }
    if (seen.has(entry.type)) return fail(['preferences', i, 'type'], 'Duplicate notification type');
    seen.add(entry.type);

    const policy = policyFor(entry.type);
    if (entry.inApp === true && policy.inApp.locked && !policy.inApp.on) {
      return fail(['preferences', i, 'inApp'], `${entry.type} has no in-app notifications`);
    }
    if (entry.inApp === false && policy.inApp.locked && policy.inApp.on) {
      return fail(['preferences', i, 'inApp'], `${entry.type} in-app notifications cannot be disabled`);
    }
    if (entry.email === false && policy.email.locked) {
      return fail(['preferences', i, 'email'], `${entry.type} email notifications cannot be disabled`);
    }
  }

  return { preferences: entries };
});
