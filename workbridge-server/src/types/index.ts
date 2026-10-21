import type { Request } from 'express';
import type { Prisma, ProjectStatus, Role, User } from '@prisma/client';

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
 * The JWT payload. Minted in `auth.controller.ts` as `{ id, email, role }` — access
 * and refresh tokens carry the identical shape — plus `iat`/`exp` injected by
 * `jsonwebtoken`.
 */
export interface JwtUserPayload {
  id: string;
  email: string;
  role: Role;
  iat?: number;
  exp?: number;
}

declare global {
  namespace Express {
    interface Request {
      /**
       * Set by the `authenticate` middleware, which assigns `jwt.verify`'s return value.
       *
       * Deliberately typed as **non-optional**. Every route that reads `req.user` is
       * mounted behind `authenticate`, so in practice it is always present, and this
       * keeps the ~77 `req.user.id` reads free of `!` assertions.
       *
       * The tradeoff: on the 12 public handlers (`signup`, `login`, `refresh`, `googleAuth`,
       * `googleCallback`, `getProjects`, `getProjectById`, `getUserById`, `getUserReviews` —
       * mounted twice — `getUserPortfolio`, `getUserCareers`, and `runJobs`, the internal job
       * endpoint, which is guarded by `requireInternalToken` instead of a JWT; 13 public routes)
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
  error: { message: string };
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
 * The fields `getProfileCompletion` scores (BEHAVIOR.md PF21): the gate's seven plus the optional
 * profile fields of both roles.
 */
export type ProfileScoreInput = ProfileCompletionInput & Pick<User, 'bio' | 'profileImage' | 'website'>;

/** What PF21 counts outside the `User` row. */
export interface ProfileCompletionCounts {
  portfolioItems: number;
  careers: number;
  hasPayoutAccount: boolean;
}

/** One PF21 checklist entry. The client supplies the Korean label for `key`. */
export interface ProfileCompletionItem {
  key: string;
  weight: number;
  done: boolean;
}

/** `GET /api/users/me/profile-completion` (PF21). `isComplete` and `percent` are independent. */
export interface ProfileCompletion {
  isComplete: boolean;
  percent: number;
  items: ProfileCompletionItem[];
}

/** Allowed manual project status transitions. Partial — not every status has a target. */
export type ProjectStatusTransitions = Partial<Record<ProjectStatus, readonly ProjectStatus[]>>;

/** `Notification.type` values. Defined next to `notify()`; re-exported here. */
export type { NotificationType } from '../lib/notifications/types';

/** `Message.systemEvent` values (BEHAVIOR.md MG6). Defined next to `postSystemMessage()`; re-exported here. */
export type { MessageSystemEvent } from '../services/messaging.service';

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

/** Job queue types. Defined in `src/jobs/types.ts` alongside the payload map; re-exported here. */
export type { JobHandler, JobType } from '../jobs/types';

/** One fixed-window rate-limit rule (BEHAVIOR.md rule 10). */
export interface RateLimitRule {
  /** Prefix of the counter key, e.g. `login.ip`. */
  name: string;
  windowMs: number;
  limit: number;
  /** The per-caller part of the key; `null` skips the rule for this request. */
  key(req: Request): string | null;
}

// ---------------------------------------------------------------------------
// AI pricing analysis
// ---------------------------------------------------------------------------

/** Untrusted JSON parsed from the OpenAI response, before normalization. */
export interface RawPricingAnalysis {
  features?: unknown;
  summary?: unknown;
  marketReference?: unknown;
}

/**
 * A single normalized feature row persisted into `PricingAnalysis.features` (Json).
 *
 * Declared as a **type alias, not an interface**, on purpose: TypeScript grants implicit
 * index signatures only to type aliases, and without one an array of these is neither
 * assignable nor directly castable to `Prisma.InputJsonArray` — which would force an
 * `as unknown as` double cast at the persistence site.
 */
export type PricingAnalysisFeature = {
  name: string;
  description: string;
  estimatedCost: number;
  rationale: string;
  duration: string | null;
};

/** The normalized, validated result of `normalizePricingAnalysisData`. */
export type PricingAnalysisData = {
  features: PricingAnalysisFeature[];
  totalAmount: number;
  summary: string | null;
  marketReference: string | null;
};
