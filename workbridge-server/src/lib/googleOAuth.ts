import axios from 'axios';

import { env } from '../env';

/**
 * What the Google login (`auth.controller.ts`) and the Google re-authentication
 * (`services/reauth.service.ts`) share: Google's endpoints, the `state` cookie and the code exchange.
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The `iss` values a Google ID token carries. */
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * The Google OAuth `state` cookie (login CSRF defence). Scoped to the OAuth routes under
 * `/api/auth/google` and short-lived: it only has to survive one trip to Google's consent screen.
 * `SameSite=Lax` still sends it on Google's top-level redirect back to the callback.
 */
export const OAUTH_STATE_COOKIE = 'oauthState';
export const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

export function oauthStateCookieOptions() {
  return { httpOnly: true, secure: env.isProduction, sameSite: 'lax' as const, path: '/api/auth/google' };
}

/** Google's token endpoint response. `id_token` comes with the `openid` scope. */
export interface GoogleTokenResponse {
  access_token: string;
  id_token?: string;
}

/** Exchanges an authorization code at Google's token endpoint (authenticated with the client secret). */
export async function exchangeGoogleCode(code: string): Promise<GoogleTokenResponse> {
  const response = await axios.post<GoogleTokenResponse>(GOOGLE_TOKEN_URL, {
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: env.GOOGLE_CALLBACK_URL,
    grant_type: 'authorization_code',
  });
  return response.data;
}
