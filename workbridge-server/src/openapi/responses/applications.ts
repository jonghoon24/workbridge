import { z } from '../../lib/zod';
import { applicationStatusEnum, contractStatusEnum, dateTime, id, legacyWon, projectStatusEnum, won } from './common';
import { contract } from './contracts';

/** An `Application` row. */
export const applicationFields = {
  id,
  projectId: id,
  freelancerId: id,
  coverLetter: z.string(),
  expectedRate: legacyWon,
  expectedDuration: z.string(),
  status: applicationStatusEnum,
  createdAt: dateTime,
};

export const application = z.object(applicationFields).openapi('Application');

const contractRef = z.object({ id, status: contractStatusEnum }).nullable().openapi({ description: '수락돼 계약이 생겼으면 그 계약' });

/** `GET /api/projects/:id/applications`. */
export const projectApplication = z.object({
  ...applicationFields,
  freelancer: z.object({
    id,
    name: z.string(),
    profileImage: z.string().nullable(),
    bio: z.string().nullable(),
    skills: z.array(z.string()),
    activityCategory: z.string().nullable(),
    experienceYears: z.number().int().nullable(),
    hourlyRate: won.nullable(),
    portfolioUrl: z.string().nullable(),
  }),
  contract: contractRef,
  project: z.object({ budget: won }),
});

/** `GET /api/users/me/applications`. */
export const myApplication = z.object({
  ...applicationFields,
  contract: contractRef,
  project: z.object({
    id,
    title: z.string(),
    category: z.string(),
    budget: won,
    status: projectStatusEnum,
    deadline: dateTime,
    client: z.object({ id, name: z.string(), companyName: z.string().nullable() }),
  }),
});

/** `PATCH …/applications/:appId` with `ACCEPTED`: the application and the contract it created. */
export const acceptedApplication = z
  .object({ application, contract })
  .openapi('AcceptedApplication', { description: '수락 — 지원과 새 계약' });

export const applicationDecision = z.union([
  acceptedApplication,
  application.openapi({ description: '거절 — 지원' }),
]);
