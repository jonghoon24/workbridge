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
       * keeps the ~43 `req.user.id` reads free of `!` assertions.
       *
       * The tradeoff: on the 9 public routes (`signup`, `login`, `refresh`, `googleAuth`,
       * `googleCallback`, `getProjects`, `getProjectById`, `getUserById`, `getUserReviews`)
       * `req.user` is actually `undefined` at runtime, and the type will not warn you.
       * **Do not read `req.user` in a handler that is not behind `authenticate`.**
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

/** Allowed manual project status transitions. Partial — not every status has a target. */
export type ProjectStatusTransitions = Partial<Record<ProjectStatus, readonly ProjectStatus[]>>;

/** `Notification.type` is a bare `String` in the schema; only these four are ever written. */
export type NotificationType =
  | 'APPLICATION_CREATED'
  | 'APPLICATION_ACCEPTED'
  | 'APPLICATION_REJECTED'
  | 'PROJECT_STATUS_CHANGED';

// ---------------------------------------------------------------------------
// AI pricing analysis
// ---------------------------------------------------------------------------

/** Untrusted JSON parsed from the OpenAI response, before normalization. */
export interface RawPricingAnalysis {
  features?: unknown;
  summary?: unknown;
  marketReference?: unknown;
}

/** A single normalized feature row persisted into `PricingAnalysis.features` (Json). */
export interface PricingAnalysisFeature {
  name: string;
  description: string;
  estimatedCost: number;
  rationale: string;
  duration: string | null;
}

/** The normalized, validated result of `normalizePricingAnalysisData`. */
export interface PricingAnalysisData {
  features: PricingAnalysisFeature[];
  totalAmount: number;
  summary: string | null;
  marketReference: string | null;
}
