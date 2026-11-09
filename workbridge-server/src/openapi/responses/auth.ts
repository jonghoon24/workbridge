import { z } from '../../lib/zod';
import { id, roleEnum } from './common';

/** `AuthUserResponse` (`src/types/index.ts`) — not the JWT claims. */
export const authUser = z
  .object({
    id,
    email: z.string(),
    name: z.string(),
    role: roleEnum,
  })
  .openapi('AuthUser');

/** Signup, login and role selection. The refresh token goes in the `refreshToken` cookie, not here. */
export const authSession = z
  .object({
    accessToken: z.string().openapi({ description: 'Access Token(JWT). `Authorization: Bearer`로 보낸다.' }),
    user: authUser,
  })
  .openapi('AuthSession');

export const accessTokenBody = z.object({ accessToken: z.string() });
