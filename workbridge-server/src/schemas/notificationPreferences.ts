import { z } from '../lib/zod';

import { NOTIFICATION_TYPES, isNotificationType, policyFor } from '../lib/notifications/policy';
import type { NotificationType } from '../lib/notifications/types';

/** One validated `PUT` entry: an omitted channel keeps its current setting. */
export interface PreferenceEntry {
  type: NotificationType;
  inApp?: boolean;
  email?: boolean;
}

const MAX_ENTRIES = NOTIFICATION_TYPES.length; // 1–21 entries, one per notification type

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `PUT /api/notifications/preferences`. Two passes, each reporting only its first failure (as
 * `<path>: <message>`, like `validate()`): the **shape** of every entry, in array order and
 * `type` → `inApp` → `email` within an entry; then, once the whole shape is valid, the **entry
 * rules** in array order. Written as one transform rather than a zod object so the order and
 * the messages stay exactly what the tests assert. Unknown keys are ignored.
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
}).openapi({
  // The parser above is hand-written to keep its check order and messages, so it carries no shape of
  // its own; this is the documented shape (metadata only).
  type: 'object',
  required: ['preferences'],
  properties: {
    preferences: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_ENTRIES,
      items: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: [...NOTIFICATION_TYPES] },
          inApp: { type: 'boolean', description: '생략하면 지금 설정을 유지한다.' },
          email: { type: 'boolean', description: '생략하면 지금 설정을 유지한다.' },
        },
      },
      description: '`inApp`과 `email` 중 하나는 있어야 한다. 같은 `type`을 두 번 쓸 수 없고, 잠긴 채널은 기본값으로만 보낼 수 있다.',
    },
  },
});
