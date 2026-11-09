import type { NextFunction, Response } from 'express';

import { getNotificationPreferences, putNotificationPreferences } from '../services/notificationPreferences.service';
import type { PreferenceEntry } from '../schemas/notificationPreferences';
import type { AuthedRequest } from '../types/index';

/** `GET /api/notifications/preferences`. */
export async function getMyNotificationPreferences(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await getNotificationPreferences(req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `PUT /api/notifications/preferences`. The body was validated by `preferencesBody`. */
export async function putMyNotificationPreferences(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { preferences } = req.body as { preferences: PreferenceEntry[] };
    res.json(await putNotificationPreferences(req.user.id, preferences));
  } catch (err) {
    next(err);
  }
}
