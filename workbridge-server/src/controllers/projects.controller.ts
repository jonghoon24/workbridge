import type { NextFunction, Request, Response } from 'express';

import {
  changeProjectStatus,
  editProject,
  getProjectDetail,
  listProjects,
  registerProject,
  softDeleteProject,
} from '../services/projects.service';
import { addBookmark, getBookmarkState, removeBookmark } from '../services/bookmarks.service';
import type {
  ProjectCreateInput,
  ProjectListQuery,
  ProjectStatusInput,
  ProjectUpdateInput,
} from '../schemas/projects';
import type { AuthedRequest } from '../types/index';

/** `GET /api/projects`. Public; runs the lazy lifecycle sweep, so it writes rows. */
export async function getProjects(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await listProjects(res.locals.query as ProjectListQuery));
  } catch (err) {
    next(err);
  }
}

/** `POST /api/projects`. The body was parsed by `projectCreateBody`. */
export async function createProject(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await registerProject(req.user.id, req.body as ProjectCreateInput, new Date()));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/projects/:id`. Public; runs the lazy lifecycle sweep, so it writes rows. */
export async function getProjectById(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await getProjectDetail(req.params.id));
  } catch (err) {
    next(err);
  }
}

/** `GET /api/projects/:id/bookmark`. */
export async function getProjectBookmark(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await getBookmarkState(req.params.id, req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `POST /api/projects/:id/bookmark`. */
export async function createProjectBookmark(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await addBookmark(req.params.id, req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `DELETE /api/projects/:id/bookmark`. */
export async function deleteProjectBookmark(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await removeBookmark(req.params.id, req.user.id));
  } catch (err) {
    next(err);
  }
}

/** `PATCH /api/projects/:id`. The body was parsed by `projectUpdateBody`. */
export async function updateProject(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await editProject(req.params.id, req.user.id, req.body as ProjectUpdateInput, new Date()));
  } catch (err) {
    next(err);
  }
}

/** `DELETE /api/projects/:id`. */
export async function deleteProject(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    await softDeleteProject(req.params.id, req.user.id, new Date());
    res.json({ message: 'Project deleted successfully' });
  } catch (err) {
    next(err);
  }
}

/** `PATCH /api/projects/:id/status`. The body was parsed by `projectStatusBody`. */
export async function updateProjectStatus(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    res.json(await changeProjectStatus(req.params.id, req.user.id, req.body as ProjectStatusInput, new Date()));
  } catch (err) {
    next(err);
  }
}
