import bcrypt from 'bcryptjs';
import axios from 'axios';
import type { NextFunction, Request, Response } from 'express';
import type { User } from '@prisma/client';
import prisma from '../lib/prisma';
import { generateAccessToken, generateRefreshToken } from '../lib/jwt';
import { AppError } from '../lib/errors';
import { env } from '../env';
import type { AuthedRequest, AuthUserResponse, JwtUserPayload } from '../types/index';
import jwt from 'jsonwebtoken';

function setRefreshTokenCookie(res: Response, token: string) {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

/** Builds the JWT claims — distinct from {@link authUserPayload}, the HTTP response shape. */
function issueTokens(user: Pick<User, 'id' | 'email' | 'role'>) {
  const payload = { id: user.id, email: user.email, role: user.role };
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);
  return { accessToken, refreshToken };
}

/** Builds the user object sent to clients — distinct from the JWT claims in {@link issueTokens}. */
function authUserPayload(user: Pick<User, 'id' | 'email' | 'name' | 'role'>): AuthUserResponse {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export async function signup(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password, name, role } = req.body;

    if (!email || !password || !name || !role) {
      throw new AppError('All fields are required', 400);
    }

    if (!['CLIENT', 'FREELANCER'].includes(role)) {
      throw new AppError('Role must be CLIENT or FREELANCER', 400);
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new AppError('Email already in use', 409);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hashedPassword, name, role },
    });

    const { accessToken, refreshToken } = issueTokens(user);
    setRefreshTokenCookie(res, refreshToken);

    res.status(201).json({
      accessToken,
      user: authUserPayload(user),
    });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new AppError('Email and password are required', 400);
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.password) {
      throw new AppError('Invalid credentials', 401);
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      throw new AppError('Invalid credentials', 401);
    }

    const { accessToken, refreshToken } = issueTokens(user);
    setRefreshTokenCookie(res, refreshToken);

    res.json({
      accessToken,
      user: authUserPayload(user),
    });
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    res.clearCookie('refreshToken');
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.refreshToken;
    if (!token) {
      throw new AppError('Refresh token not found', 401);
    }

    // `jwt.verify` is typed `string | JwtPayload`; we only ever sign `JwtUserPayload` claims.
    let decoded: JwtUserPayload;
    try {
      decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtUserPayload;
    } catch {
      throw new AppError('Invalid or expired refresh token', 401);
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user) {
      throw new AppError('User not found', 401);
    }

    const accessToken = generateAccessToken({ id: user.id, email: user.email, role: user.role });

    res.json({ accessToken });
  } catch (err) {
    next(err);
  }
}

// The try/catch is load-bearing even though nothing here is awaited: `env` reads are
// throwing getters, and because this function is `async`, a synchronous throw becomes a
// rejected promise. Express 4 does not capture those, so an unhandled rejection would
// terminate the process (Node treats them as fatal by default) instead of returning a
// response. Do not remove it as dead weight.
export async function googleAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: env.GOOGLE_CALLBACK_URL,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
    });

    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  } catch (err) {
    next(err);
  }
}

export async function googleCallback(req: Request, res: Response, next: NextFunction) {
  try {
    const { code } = req.query;
    if (!code) {
      return res.redirect(`${env.CLIENT_URL}/login?error=oauth_failed`);
    }

    // Exchange code for tokens
    const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_CALLBACK_URL,
      grant_type: 'authorization_code',
    });

    const { access_token } = tokenResponse.data;

    // Get user info
    const userInfoResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const { id: googleId, email, name, picture } = userInfoResponse.data;

    // Upsert user
    let user = await prisma.user.findFirst({
      where: { OR: [{ googleId }, { email }] },
    });

    let needsRoleSelection = false;

    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId, profileImage: user.profileImage || picture },
      });
      needsRoleSelection = !user.roleSelected;
    } else {
      user = await prisma.user.create({
        data: {
          email,
          name,
          googleId,
          profileImage: picture,
          role: 'FREELANCER',
          roleSelected: false,
        },
      });
      needsRoleSelection = true;
    }

    const { accessToken, refreshToken } = issueTokens(user);
    setRefreshTokenCookie(res, refreshToken);

    const params = new URLSearchParams({
      token: accessToken,
      needsRoleSelection: String(needsRoleSelection),
    });

    res.redirect(`${env.CLIENT_URL}/auth/callback?${params}`);
  } catch (err) {
    console.error('Google OAuth error:', err);
    res.redirect(`${env.CLIENT_URL}/login?error=oauth_failed`);
  }
}

export async function selectRole(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { role } = req.body;

    if (!['CLIENT', 'FREELANCER'].includes(role)) {
      throw new AppError('Role must be CLIENT or FREELANCER', 400);
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    if (user.roleSelected) {
      throw new AppError('Role has already been selected', 400);
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { role, roleSelected: true },
    });

    const { accessToken, refreshToken } = issueTokens(updated);
    setRefreshTokenCookie(res, refreshToken);

    res.json({ accessToken, user: authUserPayload(updated) });
  } catch (err) {
    next(err);
  }
}
