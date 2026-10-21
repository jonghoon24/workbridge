import type { Role } from '@prisma/client';

import prisma from '../lib/prisma';
import { effectiveChannels, normalizeStored, typesForRole } from '../lib/notifications/policy';
import type { NotificationCategory } from '../lib/notifications/policy';
import type { NotificationType } from '../lib/notifications/types';
import type { PreferenceEntry } from '../schemas/notificationPreferences';
import type { PrismaTransactionClient } from '../types/index';

/** BEHAVIOR.md "Notification channels" — `GET`/`PUT /api/notifications/preferences` (NC4–NC8). */

export interface PreferenceView {
  type: NotificationType;
  category: NotificationCategory;
  inApp: boolean;
  email: boolean;
  inAppLocked: boolean;
  emailLocked: boolean;
}

interface StoredRow {
  type: string;
  inApp: boolean | null;
  email: boolean | null;
}

/** NC5: the caller's role's types in NC2 order, each with its effective channels (NC3). */
function serialize(role: Role, rows: readonly StoredRow[]): PreferenceView[] {
  const byType = new Map(rows.map((row) => [row.type, row]));
  return typesForRole(role).map((policy) => {
    const channels = effectiveChannels(policy.type, byType.get(policy.type));
    return {
      type: policy.type,
      category: policy.category,
      inApp: channels.inApp,
      email: channels.email,
      inAppLocked: policy.inApp.locked,
      emailLocked: policy.email.locked,
    };
  });
}

/** The role comes from the stored row, not the token (as PF21). */
async function readPreferences(client: PrismaTransactionClient, userId: string) {
  const user = await client.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true } });
  const rows = await client.notificationPreference.findMany({
    where: { userId },
    select: { type: true, inApp: true, email: true },
  });
  return { preferences: serialize(user.role, rows) };
}

/** NC5. Writes nothing. */
export function getNotificationPreferences(userId: string) {
  return readPreferences(prisma, userId);
}

/**
 * NC7–NC8. One transaction whose first statement locks the caller's `User` row (PA7, PF8), so
 * two `PUT`s of one user serialize and no insert can collide on `(userId, type)` — hence plain
 * create/update/delete and no upsert. Each entry is merged into its row (a given channel replaces
 * the stored value, an omitted one keeps it) and normalized per NC4.
 */
export async function putNotificationPreferences(userId: string, entries: readonly PreferenceEntry[]) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;

    const rows = await tx.notificationPreference.findMany({
      where: { userId, type: { in: entries.map((entry) => entry.type) } },
    });
    const byType = new Map(rows.map((row) => [row.type, row]));

    for (const entry of entries) {
      const row = byType.get(entry.type);
      const next = normalizeStored(entry.type, {
        inApp: entry.inApp !== undefined ? entry.inApp : row?.inApp ?? null,
        email: entry.email !== undefined ? entry.email : row?.email ?? null,
      });

      if (next.inApp === null && next.email === null) {
        if (row) await tx.notificationPreference.delete({ where: { id: row.id } });
      } else if (!row) {
        await tx.notificationPreference.create({ data: { userId, type: entry.type, ...next } });
      } else if (row.inApp !== next.inApp || row.email !== next.email) {
        await tx.notificationPreference.update({ where: { id: row.id }, data: next });
      }
    }

    return readPreferences(tx, userId);
  });
}
