import prisma from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import {
  closeExpiredOpenProjects,
  rejectPendingApplicationsForClosedProjects,
} from '../lib/projectLifecycle.js';
import { uploadToSupabase } from '../middlewares/upload.js';
import { v4 as uuidv4 } from 'uuid';

export async function getMe(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        profileImage: true,
        bio: true,
        companyName: true,
        businessField: true,
        website: true,
        skills: true,
        activityCategory: true,
        experienceYears: true,
        hourlyRate: true,
        portfolioUrl: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    res.json(user);
  } catch (err) {
    next(err);
  }
}

export async function updateMe(req, res, next) {
  try {
    const {
      name,
      bio,
      companyName,
      businessField,
      website,
      skills,
      activityCategory,
      experienceYears,
      hourlyRate,
      portfolioUrl,
    } = req.body;

    let profileImage;
    if (req.file) {
      const filename = `${req.user.id}-${uuidv4()}.${req.file.mimetype.split('/')[1]}`;
      profileImage = await uploadToSupabase(req.file.buffer, req.file.mimetype, filename);
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (bio !== undefined) updateData.bio = bio;
    if (profileImage) updateData.profileImage = profileImage;

    if (req.user.role === 'CLIENT') {
      if (companyName !== undefined) updateData.companyName = companyName;
      if (businessField !== undefined) updateData.businessField = businessField;
      if (website !== undefined) updateData.website = website;
    } else if (req.user.role === 'FREELANCER') {
      if (skills !== undefined) updateData.skills = Array.isArray(skills)
        ? skills
        : skills.split(',').map(s => s.trim()).filter(Boolean);
      if (activityCategory !== undefined) updateData.activityCategory = activityCategory;
      if (experienceYears !== undefined) updateData.experienceYears = parseInt(experienceYears);
      if (hourlyRate !== undefined) updateData.hourlyRate = parseFloat(hourlyRate);
      if (portfolioUrl !== undefined) updateData.portfolioUrl = portfolioUrl;
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        profileImage: true,
        bio: true,
        companyName: true,
        businessField: true,
        website: true,
        skills: true,
        activityCategory: true,
        experienceYears: true,
        hourlyRate: true,
        portfolioUrl: true,
        createdAt: true,
      },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
}

export async function getUserById(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        name: true,
        role: true,
        profileImage: true,
        bio: true,
        companyName: true,
        businessField: true,
        website: true,
        skills: true,
        activityCategory: true,
        experienceYears: true,
        hourlyRate: true,
        portfolioUrl: true,
        createdAt: true,
        receivedReviews: {
          select: {
            id: true,
            rating: true,
            content: true,
            tags: true,
            createdAt: true,
            reviewer: {
              select: { id: true, name: true, profileImage: true },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const avgRating = user.receivedReviews.length > 0
      ? user.receivedReviews.reduce((sum, r) => sum + r.rating, 0) / user.receivedReviews.length
      : null;

    res.json({ ...user, avgRating, reviewCount: user.receivedReviews.length });
  } catch (err) {
    next(err);
  }
}

export async function getMyApplications(req, res, next) {
  try {
    if (req.user.role !== 'FREELANCER') {
      throw new AppError('Only freelancers can view their applications', 403);
    }

    await closeExpiredOpenProjects();
    await rejectPendingApplicationsForClosedProjects({ freelancerId: req.user.id });

    const applications = await prisma.application.findMany({
      where: { freelancerId: req.user.id },
      include: {
        contract: { select: { id: true, status: true } },
        project: {
          select: {
            id: true,
            title: true,
            category: true,
            budget: true,
            status: true,
            deadline: true,
            client: { select: { id: true, name: true, companyName: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(applications);
  } catch (err) {
    next(err);
  }
}

export async function getMyBookmarks(req, res, next) {
  try {
    if (req.user.role !== 'FREELANCER') {
      throw new AppError('Only freelancers can view their bookmarks', 403);
    }

    const bookmarks = await prisma.projectBookmark.findMany({
      where: {
        userId: req.user.id,
        project: { deletedAt: null },
      },
      include: {
        project: {
          include: {
            client: { select: { id: true, name: true, companyName: true, profileImage: true } },
            _count: { select: { applications: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(bookmarks.map((bookmark) => ({
      ...bookmark.project,
      isBookmarked: true,
      bookmarkedAt: bookmark.createdAt,
    })));
  } catch (err) {
    next(err);
  }
}

export async function getMyProjects(req, res, next) {
  try {
    if (req.user.role !== 'CLIENT') {
      throw new AppError('Only clients can view their projects', 403);
    }

    const projects = await prisma.project.findMany({
      where: { clientId: req.user.id, deletedAt: null },
      include: {
        _count: { select: { applications: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(projects);
  } catch (err) {
    next(err);
  }
}
