import type { NextFunction, Response } from 'express';

import { AppError } from '../lib/errors';
import {
  deleteMessage,
  getContractConversation,
  getConversation,
  listConversations,
  listMessages,
  markRead,
  sendMessage,
  unreadTotal,
} from '../services/messaging.service';
import type { ConversationListQuery } from '../services/messaging.service';
import { MESSAGE_REQUIRED } from '../schemas/conversations';
import type { MessageListQuery } from '../schemas/conversations';
import type { AuthedRequest } from '../types/index';

/** `GET /api/conversations` (MG11). */
export async function getMyConversations(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await listConversations(req.user.id, res.locals.query as ConversationListQuery));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/conversations/unread-count` (MG12). */
export async function getUnreadCount(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await unreadTotal(req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/conversations/:id` (MG13). */
export async function getConversationById(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await getConversation(req.params.id, req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/conversations/:id/messages` (MG14). */
export async function getMessages(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await listMessages(req.params.id, req.user.id, res.locals.query as MessageListQuery));
  } catch (err) {
    next(err);
  }
}

/** `POST /api/conversations/:id/messages` (MG15). */
export async function postMessage(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    const { body } = req.body as { body: string };
    // MG15 step 1, after the schema: it needs `req.files`, which a body schema cannot see.
    if (body === '' && files.length === 0) throw new AppError(MESSAGE_REQUIRED, 400);
    res.status(201).json(await sendMessage(req.params.id, req.user.id, body, files));
  } catch (err) {
    next(err);
  }
}

/** `POST /api/conversations/:id/read` (MG16). */
export async function readConversation(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await markRead(req.params.id, req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `DELETE /api/conversations/:id/messages/:messageId` (MG17). */
export async function removeMessage(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await deleteMessage(req.params.id, req.params.messageId, req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/contracts/:id/conversation` (MG18) — mounted on the contracts router. */
export async function getConversationOfContract(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await getContractConversation(req.params.id, req.user.id));
  } catch (err) {
    next(err);
  }
}
