import { z } from '../lib/zod';

import { bodyEnum, bodyWholeWon, requiredString } from './common';

/** Request bodies of the application routes. A failure is a 400 `<field>: <message>`. */

/**
 * `POST /api/projects/:id/applications`. `expectedRate` is a whole number of won of at least 1 — it
 * becomes the contract amount, and a rate below 1 won would create a milestone that can never be
 * paid.
 */
export const applicationCreateBody = z.object({
  coverLetter: requiredString('Cover letter'),
  expectedRate: bodyWholeWon('Expected rate', { min: 1 }),
  expectedDuration: requiredString('Expected duration'),
});

export type ApplicationCreateInput = z.infer<typeof applicationCreateBody>;

/** `PATCH /api/projects/:projectId/applications/:appId`. */
export const applicationDecisionBody = z.object({
  status: bodyEnum('Status', ['ACCEPTED', 'REJECTED'] as const),
});
