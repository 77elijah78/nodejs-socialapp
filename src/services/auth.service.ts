import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database.js';
import { signAccessToken, signRefreshToken, verifyToken } from '../utils/jwt.js';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/errors.js';
import { adminSettingsService } from '../admin/settings.service.js';

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  displayName?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export const authService = {
  async register(input: RegisterInput) {
    const registrationEnabled = await adminSettingsService.isRegistrationEnabled();
    if (!registrationEnabled) {
      throw new ForbiddenError('Registration is currently disabled');
    }

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: input.email }, { username: input.username }] },
    });
    if (existing) {
      throw new ConflictError(
        existing.email === input.email ? 'Email already in use' : 'Username already taken'
      );
    }

    const passwordHash = await bcrypt.hash(input.password, 12);

    const user = await prisma.user.create({
      data: {
        username: input.username,
        email: input.email,
        passwordHash,
        displayName: input.displayName,
        lastActiveAt: new Date(),
      },
      select: { id: true, username: true, email: true, displayName: true, avatarUrl: true, createdAt: true },
    });

    const payload = { userId: user.id, email: user.email, username: user.username };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    // Persist refresh token
    await prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return { user, accessToken, refreshToken };
  },

  async login(input: LoginInput) {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user) throw new UnauthorizedError('Invalid credentials');

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) throw new UnauthorizedError('Invalid credentials');

    if (user.deletedAt || user.accountStatus === 'DELETED') {
      throw new ForbiddenError('Account is no longer available');
    }
    if (user.accountStatus === 'SUSPENDED') {
      throw new ForbiddenError('Account is suspended');
    }
    if (user.accountStatus === 'BANNED') {
      throw new ForbiddenError('Account is banned');
    }

    const payload = { userId: user.id, email: user.email, username: user.username };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    await prisma.$transaction([
      prisma.refreshToken.create({
        data: {
          token: refreshToken,
          userId: user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { lastActiveAt: new Date() },
      }),
    ]);

    const { passwordHash: _, ...safeUser } = user;
    return { user: { ...safeUser, lastActiveAt: new Date() }, accessToken, refreshToken };
  },

  async refresh(token: string) {
    const stored = await prisma.refreshToken.findUnique({ where: { token } });
    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    const payload = verifyToken(token);
    const newAccessToken = signAccessToken({
      userId: payload.userId,
      email: payload.email,
      username: payload.username,
    });

    return { accessToken: newAccessToken };
  },

  async logout(token: string) {
    await prisma.refreshToken.deleteMany({ where: { token } });
  },
};
