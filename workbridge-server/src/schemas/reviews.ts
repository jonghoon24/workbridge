import { z } from 'zod';

/**
 * `POST /api/reviews` (BEHAVIOR.md "Reviews"). A failure is a 400 `<field>: <message>` for the
 * first failing field, before the contract is looked up (rule 12). The client maps the messages
 * to Korean (`workbridge-client/src/lib/errorMessages.js`), so keep the two in sync.
 */

export const RATING_MESSAGE = 'Rating must be an integer between 1 and 5';

function requiredText(label: string) {
  return z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be a string` })
    .trim()
    .min(1, `${label} is required`);
}

export const reviewBody = z.object({
  contractId: requiredText('Contract ID'),
  revieweeId: requiredText('Reviewee ID'),
  // A JSON integer 1–5. `0`, `'abc'`, `{ … }` and `3.7` are 400s (D9: they used to reach the
  // database or be truncated).
  rating: z
    .number({ required_error: 'Rating is required', invalid_type_error: RATING_MESSAGE })
    .int(RATING_MESSAGE)
    .min(1, RATING_MESSAGE)
    .max(5, RATING_MESSAGE),
  content: requiredText('Content'),
  // Absent or not an array → `[]`, as before. An array must hold strings only (D17).
  tags: z.preprocess(
    (value) => (Array.isArray(value) ? value : []),
    z.array(z.string({ invalid_type_error: 'Tags must be strings' })),
  ),
});

export type ReviewInput = z.infer<typeof reviewBody>;
