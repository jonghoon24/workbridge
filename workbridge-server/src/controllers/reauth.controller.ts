import type { NextFunction, Request, Response } from 'express';

import { clientUrl } from '../lib/clientUrl';
import { OAUTH_STATE_COOKIE, OAUTH_STATE_MAX_AGE_MS, oauthStateCookieOptions } from '../lib/googleOAuth';
import { googleReauthStart } from '../services/reauth.service';
import type { GoogleReauthQuery } from '../schemas/auth';

/**
 * `GET /api/auth/google/reauth` — sends the browser to Google to sign in again before a sensitive
 * action. Public: it is a top-level navigation, which carries no access token. The proof the
 * callback issues is matched to the signed-in user where it is used (`assertRecentGoogleReauth`).
 */
export async function getGoogleReauth(req: Request, res: Response, next: NextFunction) {
  try {
    // The callback can only send the browser back to `CLIENT_URL`; without it, fail here (500)
    // rather than after the trip to Google.
    clientUrl();
    const { purpose } = res.locals.query as GoogleReauthQuery;
    const { url, state } = googleReauthStart(purpose);
    res.cookie(OAUTH_STATE_COOKIE, state, { ...oauthStateCookieOptions(), maxAge: OAUTH_STATE_MAX_AGE_MS });
    res.redirect(url);
  } catch (err) {
    next(err);
  }
}
