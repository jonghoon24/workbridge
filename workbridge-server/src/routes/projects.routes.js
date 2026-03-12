import { Router } from 'express';
import {
  getProjects,
  createProject,
  getProjectById,
  updateProject,
  deleteProject,
  updateProjectStatus,
  analyzeProject,
} from '../controllers/projects.controller.js';
import { authenticate, requireRole } from '../middlewares/auth.js';

const router = Router();

router.get('/', getProjects);
router.post('/', authenticate, requireRole('CLIENT'), createProject);
router.get('/:id', getProjectById);
router.patch('/:id', authenticate, requireRole('CLIENT'), updateProject);
router.delete('/:id', authenticate, requireRole('CLIENT'), deleteProject);
router.patch('/:id/status', authenticate, requireRole('CLIENT'), updateProjectStatus);
router.post('/:id/analyze', authenticate, requireRole('CLIENT'), analyzeProject);

export default router;
