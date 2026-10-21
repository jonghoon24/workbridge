import type { Career, Prisma } from '@prisma/client';

import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { kstMonthIndex, kstMonthOrNull, kstMonthString, kstMonthToDate } from '../lib/time';
import { lockUserRow } from '../lib/locks';
import { CAREER_LIMITS, monthRangeIssue } from '../schemas/profile';
import type { CareerCreateInput, CareerPatchInput } from '../schemas/profile';

/** BEHAVIOR.md "Portfolio and careers", PF4–PF6, PF13–PF15, PF17. */

const NOT_FOUND = 'Career not found';
const LIMIT_REACHED = `Careers are limited to ${CAREER_LIMITS.entries} entries`;

/** PF5: newest start first; among equal starts, current positions, then the latest end. */
export const CAREER_ORDER: Prisma.CareerOrderByWithRelationInput[] = [
  { startDate: 'desc' },
  { endDate: { sort: 'desc', nulls: 'first' } },
  { createdAt: 'desc' },
  { id: 'asc' },
];

/** PF4: months as `YYYY-MM` (PF2); `endDate: null` is a current position. */
export function serializeCareer(career: Career) {
  return {
    id: career.id,
    userId: career.userId,
    company: career.company,
    position: career.position,
    employmentType: career.employmentType,
    startDate: kstMonthString(career.startDate),
    endDate: kstMonthOrNull(career.endDate),
    description: career.description,
    createdAt: career.createdAt,
    updatedAt: career.updatedAt,
  };
}

export interface CareerSummary {
  totalMonths: number;
  years: number;
  months: number;
}

/**
 * PF6: months covered inclusively from start through end (a current position through the KST
 * month of `now`), with overlapping **or adjacent** ranges merged so each month counts once.
 * Display only — never written to `experienceYears`.
 */
export function summarizeCareers(
  careers: { startDate: Date; endDate: Date | null }[],
  now: Date = new Date(),
): CareerSummary {
  const current = kstMonthIndex(kstMonthString(now));
  const ranges = careers
    .map((career) => ({
      start: kstMonthIndex(kstMonthString(career.startDate)),
      end: career.endDate ? kstMonthIndex(kstMonthString(career.endDate)) : current,
    }))
    // Unreachable through the API (PF13 rejects both), but a range that ends before it starts
    // must not subtract months.
    .filter((range) => range.end >= range.start)
    .sort((a, b) => a.start - b.start);

  let totalMonths = 0;
  let open: { start: number; end: number } | null = null;
  for (const range of ranges) {
    if (open && range.start <= open.end + 1) {
      open.end = Math.max(open.end, range.end);
      continue;
    }
    if (open) totalMonths += open.end - open.start + 1;
    open = { ...range };
  }
  if (open) totalMonths += open.end - open.start + 1;

  return { totalMonths, years: Math.floor(totalMonths / 12), months: totalMonths % 12 };
}

/** The careers of `userId` in PF5 order with their summary. The caller has checked visibility. */
export async function listCareers(userId: string, now: Date = new Date()) {
  const careers = await prisma.career.findMany({ where: { userId }, orderBy: CAREER_ORDER });
  return { careers: careers.map(serializeCareer), careerSummary: summarizeCareers(careers, now) };
}

/** PF17. */
export async function getPublicCareers(userId: string, now: Date = new Date()) {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true } });
  if (!user) throw new AppError('User not found', 404);
  return listCareers(userId, now);
}

/** PF13: the count is checked under PF8's lock. */
export async function createCareer(userId: string, input: CareerCreateInput) {
  const career = await prisma.$transaction(async (tx) => {
    await lockUserRow(tx, userId);
    if (await tx.career.count({ where: { userId } }) >= CAREER_LIMITS.entries) {
      throw new AppError(LIMIT_REACHED, 409);
    }
    return tx.career.create({
      data: {
        userId,
        company: input.company,
        position: input.position,
        employmentType: input.employmentType,
        startDate: kstMonthToDate(input.startDate),
        endDate: input.endDate === null ? null : kstMonthToDate(input.endDate),
        description: input.description ?? null,
      },
    });
  });

  return { career: serializeCareer(career) };
}

/** PF7's existence-then-ownership check. */
async function findOwnCareer(userId: string, careerId: string): Promise<Career> {
  const career = await prisma.career.findUnique({ where: { id: careerId } });
  if (!career) throw new AppError(NOT_FOUND, 404);
  if (career.userId !== userId) throw new AppError('Not authorized', 403);
  return career;
}

/** PF14. No lock: an update changes no count. */
export async function updateCareer(userId: string, careerId: string, input: CareerPatchInput) {
  const stored = await findOwnCareer(userId, careerId);

  const merged = {
    start: input.startDate !== undefined ? input.startDate : kstMonthString(stored.startDate),
    end: input.endDate !== undefined ? input.endDate : kstMonthOrNull(stored.endDate),
  };
  const monthIssue = monthRangeIssue(merged);
  if (monthIssue) throw new AppError(`endDate: ${monthIssue}`, 400);

  const data: Prisma.CareerUpdateManyMutationInput = {};
  if (input.company !== undefined) data.company = input.company;
  if (input.position !== undefined) data.position = input.position;
  if (input.employmentType !== undefined) data.employmentType = input.employmentType;
  if (input.startDate !== undefined) data.startDate = kstMonthToDate(input.startDate);
  if (input.endDate !== undefined) data.endDate = input.endDate === null ? null : kstMonthToDate(input.endDate);
  if (input.description !== undefined) data.description = input.description;

  // An empty patch writes nothing (Prisma skips an `updateMany` without data and reports 0 rows).
  const { count } = Object.keys(data).length
    ? await prisma.career.updateMany({ where: { id: careerId, userId }, data })
    : { count: 1 };
  const career = count === 1 ? await prisma.career.findUnique({ where: { id: careerId } }) : null;
  if (!career) throw new AppError(NOT_FOUND, 404);

  return { career: serializeCareer(career) };
}

/** PF15: hard delete, no lock. */
export async function deleteCareer(userId: string, careerId: string) {
  await findOwnCareer(userId, careerId);
  const { count } = await prisma.career.deleteMany({ where: { id: careerId, userId } });
  if (count === 0) throw new AppError(NOT_FOUND, 404);
  return { id: careerId, deleted: true as const };
}
