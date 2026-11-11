import type { Request } from 'express';
import type { Prisma, ProjectStatus, Role, User } from '@prisma/client';

import type { ErrorCode, FieldViolation } from '../lib/errorCodes';

/**
 * Shared types for the server. Import from here — do not redefine these locally.
 *
 * Prisma generates every model, enum, `WhereInput`, and `UpdateInput` type already
 * (`Role`, `ProjectStatus`, `Prisma.ProjectWhereInput`, …). Import those directly from
 * `@prisma/client` rather than hand-rolling equivalents.
 */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * The access token's payload. Minted by `issueTokens` (`lib/authTokens.ts`) as `{ id, email, role }`
 * plus `iat`/`exp` injected by `jsonwebtoken`. The refresh token carries the same claims and one
 * more ({@link RefreshTokenPayload}).
 */
export interface JwtUserPayload {
  id: string;
  email: string;
  role: Role;
  iat?: number;
  exp?: number;
}

/**
 * The refresh token's claims: {@link JwtUserPayload} plus `pwdChangedAt`, the user's
 * `passwordChangedAt` in epoch milliseconds when the token was minted (`null` = never changed).
 * `refresh` accepts the token only while that still equals the stored value, so changing the
 * password ends every session whose refresh token predates it. A token minted before the claim
 * existed has none and reads as `null`. The access token does not carry it.
 */
export interface RefreshTokenPayload extends JwtUserPayload {
  pwdChangedAt?: number | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- `Request` is only augmentable through Express's namespace.
  namespace Express {
    interface Request {
      /**
       * Set by the `authenticate` middleware, which assigns `jwt.verify`'s return value.
       *
       * Deliberately typed as **non-optional**. Every route that reads `req.user` is
       * mounted behind `authenticate`, so in practice it is always present, and this
       * keeps the ~77 `req.user.id` reads free of `!` assertions.
       *
       * The tradeoff: on the 16 public handlers (`signup`, `login`, `logout`, `refresh`, `googleAuth`,
       * `googleCallback`, `getGoogleReauth`, `getProjects`, `getProjectById`, `getUserById`, `getUserReviews` —
       * mounted twice — `getUserPortfolio`, `getUserCareers`, `runJobs`, the internal job
       * endpoint, which is guarded by `requireInternalToken` instead of a JWT, and the API
       * reference's `getOpenApiDocument` and `getDocsPage`; 17 public routes)
       * `req.user` is actually `undefined` at runtime,
       * and the type will not warn you. Middleware that runs on every route (`accessLog`) must
       * read it as optional. **Do not read `req.user` in a handler that is not behind
       * `authenticate`.**
       */
      user: JwtUserPayload;
    }
  }
}

/**
 * Expressive alias for a request on an authenticated route. Identical to `Request` —
 * see the note above on why `user` is non-optional globally. Use it to signal intent
 * in handler signatures.
 */
export type AuthedRequest = Request;

/** A request on an authenticated route that also carries a Multer upload. */
export interface AuthedFileRequest extends Request {
  file?: Express.Multer.File;
}

/** Shape returned to clients on signup/login/refresh — distinct from {@link JwtUserPayload}. */
export interface AuthUserResponse {
  id: string;
  email: string;
  name: string;
  role: Role;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** The uniform error body produced by `errorHandler`. */
export interface ErrorEnvelope {
  /** `fields` only on a `VALIDATION_FAILED`. */
  error: { code: ErrorCode; message: string; fields?: FieldViolation[] };
}

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------

/**
 * The client handed to an interactive-transaction callback. `PrismaClient` is
 * assignable to this, so a function accepting it works both inside and outside a
 * `$transaction` — which is exactly what `projectLifecycle` needs.
 */
export type PrismaTransactionClient = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** The seven fields `isProfileComplete` inspects, matching `profileSelect`. */
export type ProfileCompletionInput = Pick<
  User,
  | 'role'
  | 'companyName'
  | 'businessField'
  | 'skills'
  | 'activityCategory'
  | 'experienceYears'
  | 'hourlyRate'
>;

/**
 * The fields `getProfileCompletion` scores: the gate's seven plus the optional
 * profile fields of both roles.
 */
export type ProfileScoreInput = ProfileCompletionInput & Pick<User, 'bio' | 'profileImage' | 'website'>;

/** What the completion score counts outside the `User` row. */
export interface ProfileCompletionCounts {
  portfolioItems: number;
  careers: number;
  hasPayoutAccount: boolean;
}

/** One completion checklist entry. The client supplies the Korean label for `key`. */
export interface ProfileCompletionItem {
  key: string;
  weight: number;
  done: boolean;
}

/** `GET /api/users/me/profile-completion`. `isComplete` and `percent` are independent. */
export interface ProfileCompletion {
  isComplete: boolean;
  percent: number;
  items: ProfileCompletionItem[];
}

/** Allowed manual project status transitions. Partial — not every status has a target. */
export type ProjectStatusTransitions = Partial<Record<ProjectStatus, readonly ProjectStatus[]>>;

/** `Notification.type` values. Defined next to `notify()`; re-exported here. */
export type { NotificationType } from '../lib/notifications/types';

/** `Message.systemEvent` values. Defined next to `postSystemMessage()`; re-exported here. */
export type { MessageSystemEvent } from '../services/messaging.service';

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

/** Job queue types. Defined in `src/jobs/types.ts` alongside the payload map; re-exported here. */
export type { JobHandler, JobType } from '../jobs/types';

/** One fixed-window rate-limit rule (`lib/rateLimitRules.ts`). */
export interface RateLimitRule {
  /** Prefix of the counter key, e.g. `login.ip`. */
  name: string;
  windowMs: number;
  limit: number;
  /** The per-caller part of the key; `null` skips the rule for this request. */
  key(req: Request): string | null;
}
