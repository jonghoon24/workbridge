import prisma from './prisma';
import { AppError } from './errors';
import { DAY_MS, HOUR_MS } from './time';
import { isProfileComplete } from './profileCompletion';
import { expandSkillSearchTerms, normalizeSkill } from './skills';

/**
 * Skill-based recommendations (docs/domain/projects-contracts.md): freelancers for a client's project, and
 * projects for a freelancer. Both are read-only — no lifecycle sweep — and work in two stages: a
 * database prefilter ordered **before** it is cut to `PREFILTER_LIMIT` rows (so which rows enter
 * never varies between runs), then scoring in memory with a deterministic tie-break.
 *
 * The score tables are stated once, here: `scoreFreelancer` and `scoreProject`.
 */

export const PREFILTER_LIMIT = 200;

/** Two decimals, and results are sorted by this rounded value. */
export function roundScore(score: number): number {
  return Math.round(score * 100) / 100;
}

/** `normalizeSkill` over each entry, de-duplicated, first occurrence kept (project order). */
function canonicalSkills(skills: readonly string[]): string[] {
  return [...new Set(skills.map(normalizeSkill))];
}

/**
 * The project's normalized required skills that the candidate has, in the project's order.
 * Comparison is exact (case-sensitive) after `normalizeSkill`, so `PostgreSQL` matches `SQL`.
 */
export function matchSkills(requiredSkills: readonly string[], candidateSkills: readonly string[]): string[] {
  const owned = new Set(candidateSkills.map(normalizeSkill));
  return canonicalSkills(requiredSkills).filter((skill) => owned.has(skill));
}

// ---------------------------------------------------------------------------------------------
// A freelancer for a project
// ---------------------------------------------------------------------------------------------

export interface FreelancerScoreInput {
  skills: readonly string[];
  activityCategory: string | null;
  experienceYears: number;
  /** Each portfolio item's skills. */
  portfolioSkills: readonly (readonly string[])[];
  /** Mean received rating, `null` with no reviews. */
  avgRating: number | null;
}

/**
 * A freelancer's score, out of 100:
 *
 * | component  | points                                                                   |
 * |------------|--------------------------------------------------------------------------|
 * | skills     | `|matched| / |required| × 50`                                            |
 * | portfolio  | `|required skills in any portfolio item's skills| / |required| × 10`     |
 * | category   | 15 when `activityCategory === project.category` (stored values, exact)   |
 * | rating     | `avgRating / 5 × 15`; 9 (= 0.6 × 15) with no reviews                     |
 * | experience | `min(experienceYears, 10) / 10 × 10`                                     |
 *
 * Against a project with no required skills both skill components are 0.
 */
export function scoreFreelancer(
  project: { requiredSkills: readonly string[]; category: string },
  candidate: FreelancerScoreInput,
): { score: number; matchedSkills: string[] } {
  const required = canonicalSkills(project.requiredSkills);
  const matchedSkills = matchSkills(required, candidate.skills);
  const portfolioMatched = matchSkills(required, candidate.portfolioSkills.flat());

  const skills = required.length ? (matchedSkills.length / required.length) * 50 : 0;
  const portfolio = required.length ? (portfolioMatched.length / required.length) * 10 : 0;
  const category = candidate.activityCategory === project.category ? 15 : 0;
  const rating = candidate.avgRating === null ? 0.6 * 15 : (candidate.avgRating / 5) * 15;
  const experience = (Math.min(candidate.experienceYears, 10) / 10) * 10;

  return { score: roundScore(skills + portfolio + category + rating + experience), matchedSkills };
}

/** Score desc → `reviewCount` desc → `id` asc. */
export function compareFreelancers(
  a: { score: number; reviewCount: number; id: string },
  b: { score: number; reviewCount: number; id: string },
): number {
  return b.score - a.score || b.reviewCount - a.reviewCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** `GET /api/projects/:id/recommended-freelancers`. */
export async function recommendFreelancers(projectId: string, clientId: string, limit: number) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, clientId: true, requiredSkills: true, category: true },
  });
  if (!project) throw new AppError('Project not found', 404);
  if (project.clientId !== clientId) throw new AppError('Not authorized', 403);

  const searchTerms = expandSkillSearchTerms(project.requiredSkills);
  const candidates = await prisma.user.findMany({
    where: {
      role: 'FREELANCER',
      deletedAt: null,
      // Rule 4's gate, as far as the database can express it; a blank `activityCategory` is
      // dropped after the cut.
      AND: [
        { skills: { isEmpty: false } },
        ...(searchTerms.length ? [{ skills: { hasSome: searchTerms } }] : []),
      ],
      activityCategory: { not: null },
      experienceYears: { gte: 0 },
      hourlyRate: { gt: 0 },
      applications: { none: { projectId } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PREFILTER_LIMIT,
    select: {
      id: true,
      name: true,
      role: true,
      profileImage: true,
      companyName: true,
      businessField: true,
      activityCategory: true,
      experienceYears: true,
      hourlyRate: true,
      skills: true,
      portfolioItems: {
        // In `PORTFOLIO_ORDER`, as `portfolio.service.ts` orders them, so the preview is the profile's first three.
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
        select: { id: true, title: true, imageUrl: true, skills: true },
      },
      receivedReviews: { select: { rating: true } },
    },
  });

  return {
    freelancers: candidates
      .filter((candidate) => isProfileComplete(candidate))
      .map((candidate) => {
        const reviewCount = candidate.receivedReviews.length;
        const avgRating = reviewCount
          ? candidate.receivedReviews.reduce((sum, review) => sum + review.rating, 0) / reviewCount
          : null;
        const { score, matchedSkills } = scoreFreelancer(project, {
          skills: candidate.skills,
          activityCategory: candidate.activityCategory,
          experienceYears: candidate.experienceYears ?? 0,
          portfolioSkills: candidate.portfolioItems.map((item) => item.skills),
          avgRating,
        });

        return {
          id: candidate.id,
          name: candidate.name,
          profileImage: candidate.profileImage,
          activityCategory: candidate.activityCategory,
          experienceYears: candidate.experienceYears,
          hourlyRate: candidate.hourlyRate,
          skills: candidate.skills,
          score,
          matchedSkills,
          avgRating,
          reviewCount,
          portfolioPreview: candidate.portfolioItems
            .slice(0, 3)
            .map((item) => ({ id: item.id, title: item.title, imageUrl: item.imageUrl })),
        };
      })
      .sort(compareFreelancers)
      .slice(0, limit),
  };
}

// ---------------------------------------------------------------------------------------------
// A project for a freelancer
// ---------------------------------------------------------------------------------------------

const FRESH_FOR_MS = 7 * DAY_MS;
const STALE_AFTER_MS = 30 * DAY_MS;
const DEADLINE_ROOM_MS = 3 * 24 * HOUR_MS;

/** Freshness: 10 up to 7 days old, then linear to 0 at 30 days. */
export function freshnessPoints(createdAt: Date, now: Date): number {
  const age = now.getTime() - createdAt.getTime();
  if (age <= FRESH_FOR_MS) return 10;
  if (age >= STALE_AFTER_MS) return 0;
  return (10 * (STALE_AFTER_MS - age)) / (STALE_AFTER_MS - FRESH_FOR_MS);
}

/**
 * A project's score, out of 100 (`age = now − project.createdAt`):
 *
 * | component     | points                                                                |
 * |---------------|-----------------------------------------------------------------------|
 * | coverage      | `|matched| / |project's required skills| × 50`                         |
 * | utilization   | `|matched| / |caller's skills| × 10`                                  |
 * | category      | 20 when `category === caller.activityCategory` (stored values, exact) |
 * | freshness     | `freshnessPoints`                                                     |
 * | deadline room | 10 when `deadline − now ≥ 3 × 24 h`, else 0                           |
 */
export function scoreProject(
  project: { requiredSkills: readonly string[]; category: string; createdAt: Date; deadline: Date },
  caller: { skills: readonly string[]; activityCategory: string | null },
  now: Date,
): { score: number; matchedSkills: string[] } {
  const required = canonicalSkills(project.requiredSkills);
  const own = canonicalSkills(caller.skills);
  const matchedSkills = matchSkills(required, own);

  const coverage = required.length ? (matchedSkills.length / required.length) * 50 : 0;
  const utilization = own.length ? (matchedSkills.length / own.length) * 10 : 0;
  const category = project.category === caller.activityCategory ? 20 : 0;
  const freshness = freshnessPoints(project.createdAt, now);
  const deadlineRoom = project.deadline.getTime() - now.getTime() >= DEADLINE_ROOM_MS ? 10 : 0;

  return { score: roundScore(coverage + utilization + category + freshness + deadlineRoom), matchedSkills };
}

/** Score desc → `deadline` asc → `id` asc. */
export function compareProjects(
  a: { score: number; deadline: Date; id: string },
  b: { score: number; deadline: Date; id: string },
): number {
  return b.score - a.score
    || a.deadline.getTime() - b.deadline.getTime()
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * `GET /api/users/me/recommended-projects`. The route's guards have already checked the
 * role and the complete profile.
 */
export async function recommendProjects(freelancerId: string, limit: number, now: Date = new Date()) {
  const caller = await prisma.user.findUniqueOrThrow({
    where: { id: freelancerId },
    select: { skills: true, activityCategory: true },
  });

  const searchTerms = expandSkillSearchTerms(caller.skills);
  const projects = await prisma.project.findMany({
    where: {
      status: 'OPEN',
      // No sweep (read-only): an OPEN project past its deadline is excluded here, not by its status.
      deadline: { gte: now },
      deletedAt: null,
      client: { deletedAt: null },
      applications: { none: { freelancerId } },
      OR: [
        ...(searchTerms.length ? [{ requiredSkills: { hasSome: searchTerms } }] : []),
        ...(caller.activityCategory !== null ? [{ category: caller.activityCategory }] : []),
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: PREFILTER_LIMIT,
    select: {
      id: true,
      title: true,
      category: true,
      budget: true,
      deadline: true,
      requiredSkills: true,
      status: true,
      createdAt: true,
      client: { select: { id: true, name: true, companyName: true } },
    },
  });

  return {
    projects: projects
      .map((project) => ({ ...project, ...scoreProject(project, caller, now) }))
      .sort(compareProjects)
      .slice(0, limit),
  };
}
