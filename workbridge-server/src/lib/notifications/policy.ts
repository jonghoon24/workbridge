import type { Role } from '@prisma/client';

import type { NotificationType } from './types';

/**
 * The notification channel policy (BEHAVIOR.md NC2) and the one rule that turns it plus a stored
 * preference into the channels a notification uses (NC3). `notify()`, `GET` and `PUT
 * /api/notifications/preferences` all decide through this file — never restate it elsewhere.
 */

export type NotificationCategory = 'APPLICATION' | 'CONTRACT' | 'MILESTONE' | 'SETTLEMENT' | 'MESSAGE';

/** "BOTH" = either party of a contract, whichever the event addresses. */
export type PolicyRecipient = 'CLIENT' | 'FREELANCER' | 'BOTH';

export interface ChannelPolicy {
  /** The NC2 default. */
  on: boolean;
  /** A locked channel is always its default; the recipient cannot change it. */
  locked: boolean;
}

export interface TypePolicy {
  type: NotificationType;
  category: NotificationCategory;
  recipient: PolicyRecipient;
  inApp: ChannelPolicy;
  email: ChannelPolicy;
}

const ON: ChannelPolicy = { on: true, locked: false };
const OFF: ChannelPolicy = { on: false, locked: false };
const LOCKED_ON: ChannelPolicy = { on: true, locked: true };
const LOCKED_OFF: ChannelPolicy = { on: false, locked: true };

/**
 * NC2, in its order (which is also `GET`'s order, NC5). Trade and money notifications are locked
 * in-app; the auto-approval reminder, a held and a failed payout are locked by email too. The
 * digest's in-app channel is locked off: messages are seen in the conversation itself (MG20).
 */
export const NOTIFICATION_POLICY: readonly TypePolicy[] = [
  { type: 'APPLICATION_CREATED', category: 'APPLICATION', recipient: 'CLIENT', inApp: ON, email: ON },
  { type: 'APPLICATION_ACCEPTED', category: 'APPLICATION', recipient: 'FREELANCER', inApp: LOCKED_ON, email: ON },
  { type: 'APPLICATION_REJECTED', category: 'APPLICATION', recipient: 'FREELANCER', inApp: ON, email: OFF },
  { type: 'PROJECT_STATUS_CHANGED', category: 'APPLICATION', recipient: 'FREELANCER', inApp: ON, email: OFF },
  { type: 'CONTRACT_ACTIVATED', category: 'CONTRACT', recipient: 'BOTH', inApp: LOCKED_ON, email: ON },
  { type: 'MILESTONE_PLAN_UPDATED', category: 'MILESTONE', recipient: 'FREELANCER', inApp: LOCKED_ON, email: ON },
  { type: 'MILESTONE_FUNDED', category: 'MILESTONE', recipient: 'FREELANCER', inApp: LOCKED_ON, email: ON },
  { type: 'MILESTONE_SUBMITTED', category: 'MILESTONE', recipient: 'CLIENT', inApp: LOCKED_ON, email: ON },
  { type: 'MILESTONE_REVISION_REQUESTED', category: 'MILESTONE', recipient: 'FREELANCER', inApp: LOCKED_ON, email: ON },
  { type: 'MILESTONE_APPROVED', category: 'MILESTONE', recipient: 'FREELANCER', inApp: LOCKED_ON, email: ON },
  { type: 'MILESTONE_AUTO_APPROVED', category: 'MILESTONE', recipient: 'BOTH', inApp: LOCKED_ON, email: ON },
  { type: 'MILESTONE_AUTO_APPROVE_REMINDER', category: 'MILESTONE', recipient: 'CLIENT', inApp: LOCKED_ON, email: LOCKED_ON },
  { type: 'MILESTONE_DUE_SOON', category: 'MILESTONE', recipient: 'FREELANCER', inApp: ON, email: ON },
  { type: 'MILESTONE_OVERDUE', category: 'MILESTONE', recipient: 'BOTH', inApp: ON, email: ON },
  { type: 'CONTRACT_COMPLETED', category: 'CONTRACT', recipient: 'BOTH', inApp: LOCKED_ON, email: ON },
  { type: 'SETTLEMENT_SCHEDULED', category: 'SETTLEMENT', recipient: 'FREELANCER', inApp: ON, email: OFF },
  { type: 'SETTLEMENT_PAID', category: 'SETTLEMENT', recipient: 'FREELANCER', inApp: LOCKED_ON, email: ON },
  { type: 'SETTLEMENT_ON_HOLD', category: 'SETTLEMENT', recipient: 'FREELANCER', inApp: LOCKED_ON, email: LOCKED_ON },
  { type: 'SETTLEMENT_FAILED', category: 'SETTLEMENT', recipient: 'FREELANCER', inApp: LOCKED_ON, email: LOCKED_ON },
  { type: 'MESSAGE_UNREAD_DIGEST', category: 'MESSAGE', recipient: 'BOTH', inApp: LOCKED_OFF, email: ON },
];

const BY_TYPE = new Map<string, TypePolicy>(NOTIFICATION_POLICY.map((policy) => [policy.type, policy]));

/** NC1: the 20 notification types, in NC2 order. */
export const NOTIFICATION_TYPES: readonly NotificationType[] = NOTIFICATION_POLICY.map((policy) => policy.type);

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && BY_TYPE.has(value);
}

export function policyFor(type: NotificationType): TypePolicy {
  const policy = BY_TYPE.get(type);
  if (!policy) throw new Error(`No notification policy for type "${type}"`);
  return policy;
}

/** NC5: the types a role receives — its own plus the "BOTH" ones (CLIENT 8, FREELANCER 17). */
export function typesForRole(role: Role): TypePolicy[] {
  return NOTIFICATION_POLICY.filter((policy) => policy.recipient === 'BOTH' || policy.recipient === role);
}

/** A stored `NotificationPreference`: `null` = follow the NC2 default (NC4). */
export interface StoredChannels {
  inApp: boolean | null;
  email: boolean | null;
}

export interface EffectiveChannels {
  inApp: boolean;
  email: boolean;
}

/**
 * NC3 — the only place a channel is decided: a locked channel is always its default (a stored
 * value for it is ignored); an unlocked one is the stored choice when there is one, else the
 * default. The recipient's role plays no part.
 */
function channel(policy: ChannelPolicy, stored: boolean | null | undefined): boolean {
  if (policy.locked) return policy.on;
  return stored ?? policy.on;
}

export function effectiveChannels(type: NotificationType, stored: StoredChannels | null | undefined): EffectiveChannels {
  const policy = policyFor(type);
  return {
    inApp: channel(policy.inApp, stored?.inApp),
    email: channel(policy.email, stored?.email),
  };
}

/**
 * NC4 — what a write stores: a locked channel, or a value equal to the default, becomes `null`.
 * A result whose two columns are both `null` means "no row".
 */
export function normalizeStored(type: NotificationType, wanted: StoredChannels): StoredChannels {
  const policy = policyFor(type);
  const store = (p: ChannelPolicy, value: boolean | null) =>
    p.locked || value === null || value === p.on ? null : value;
  return { inApp: store(policy.inApp, wanted.inApp), email: store(policy.email, wanted.email) };
}
