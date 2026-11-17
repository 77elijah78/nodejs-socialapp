import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import type { Prisma, PrismaClient, User } from '@prisma/client';
import { prisma } from '../config/database.js';
import { adminSettingsService } from '../admin/settings.service.js';
import { ForbiddenError, ConflictError, ServiceUnavailableError, UnauthorizedError } from '../utils/errors.js';
import { signAccessToken, signRefreshToken } from '../utils/jwt.js';
import { logger } from '../config/logger.js';

interface GoogleVerifier {
  verifyIdToken(input: { idToken: string; audience: string }): Promise<{ getPayload(): TokenPayload | undefined }>;
}

export interface VerifiedGoogleIdentity {
  subject: string;
  email: string;
  emailVerifiedAt: Date;
  displayName?: string;
}

export function validateGoogleClaims(payload: TokenPayload | undefined, expectedAudience: string, now = Date.now()): VerifiedGoogleIdentity {
  if (!payload || !payload.sub || !payload.email || payload.email_verified !== true ||
      !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss ?? '') ||
      !payload.aud || payload.aud !== expectedAudience || !payload.exp || payload.exp * 1000 <= now) {
    throw new UnauthorizedError('Google identity token is invalid');
  }
  if (payload.azp && payload.azp !== expectedAudience) throw new UnauthorizedError('Google identity token is invalid');
  return {
    subject: payload.sub,
    email: payload.email.trim().toLowerCase(),
    emailVerifiedAt: new Date(),
    ...(payload.name ? { displayName: payload.name.slice(0, 60) } : {}),
  };
}

function accountAvailable(user: Pick<User, 'deletedAt' | 'accountStatus'>): void {
  if (user.deletedAt || user.accountStatus === 'DELETED') throw new ForbiddenError('Account is no longer available');
  if (user.accountStatus === 'SUSPENDED') throw new ForbiddenError('Account is suspended');
  if (user.accountStatus === 'BANNED') throw new ForbiddenError('Account is banned');
}

export function createGoogleAuthService(deps: {
  verifier?: GoogleVerifier;
  db?: PrismaClient;
  registrationEnabled?: () => Promise<boolean>;
} = {}) {
  const verifier = deps.verifier ?? new OAuth2Client();
  const db = deps.db ?? prisma;
  const registrationEnabled = deps.registrationEnabled ?? (() => adminSettingsService.isRegistrationEnabled());

  async function verify(idToken: string): Promise<VerifiedGoogleIdentity> {
    const audience = process.env.GOOGLE_CLIENT_ID;
    if (!audience) throw new ServiceUnavailableError('Google sign-in is not configured');
    try {
      const ticket = await verifier.verifyIdToken({ idToken, audience });
      return validateGoogleClaims(ticket.getPayload(), audience);
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      // Do not log tokens, email addresses, or provider responses.
      logger.warn('Google ID-token verification failed');
      throw new UnauthorizedError('Google identity token is invalid');
    }
  }

  function tokensFor(user: Pick<User, 'id' | 'email' | 'username'>) {
    const payload = { userId: user.id, email: user.email, username: user.username };
    return { accessToken: signAccessToken(payload), refreshToken: signRefreshToken(payload) };
  }

  async function saveRefreshToken(tx: Prisma.TransactionClient, user: Pick<User, 'id' | 'email' | 'username'>, refreshToken: string) {
    await tx.refreshToken.create({ data: {
      token: refreshToken,
      userId: user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    } });
  }

  async function existingSession(user: User) {
    accountAvailable(user);
    const { accessToken, refreshToken } = tokensFor(user);
    await db.$transaction([
      db.refreshToken.create({ data: { token: refreshToken, userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } }),
      db.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } }),
    ]);
    const { passwordHash: _passwordHash, ...safeUser } = user;
    return { user: { ...safeUser, lastActiveAt: new Date() }, accessToken, refreshToken };
  }

  async function findIdentity(identity: VerifiedGoogleIdentity) {
    return db.googleIdentity.findUnique({ where: { provider_providerSubject: { provider: 'GOOGLE', providerSubject: identity.subject } }, include: { user: true } });
  }

  return {
    async signIn(idToken: string) {
      const identity = await verify(idToken);
      const linked = await findIdentity(identity);
      if (linked) return existingSession(linked.user);

      const emailOwner = await db.user.findFirst({ where: { email: { equals: identity.email, mode: 'insensitive' } } });
      if (emailOwner) throw new ConflictError('Sign in to your existing account and link Google from account settings');
      if (!(await registrationEnabled())) throw new ForbiddenError('Registration is currently disabled');

      // A random, unexposed hash keeps the existing password column non-null without
      // creating a password the user knows. Normal password login still requires bcrypt.
      const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
      const local = identity.email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
      const username = `${(local.length >= 3 ? local : 'google_user').slice(0, 20)}_${randomBytes(3).toString('hex')}`;
      const userId = randomUUID();
      let user: { created: User; accessToken: string; refreshToken: string };
      try {
        user = await db.$transaction(async tx => {
          const created = await tx.user.create({ data: {
            id: userId,
            username,
            email: identity.email,
            passwordHash,
            displayName: identity.displayName,
            lastActiveAt: new Date(),
          } });
          await tx.googleIdentity.create({ data: {
            provider: 'GOOGLE', providerSubject: identity.subject, userId: created.id,
            email: identity.email, emailVerifiedAt: identity.emailVerifiedAt,
          } });
          const { accessToken, refreshToken } = tokensFor(created);
          await saveRefreshToken(tx, created, refreshToken);
          return { created, accessToken, refreshToken };
        });
      } catch (error) {
        if ((error as { code?: string }).code !== 'P2002') throw error;
        const winner = await findIdentity(identity);
        if (winner) return existingSession(winner.user);
        const owner = await db.user.findFirst({ where: { email: { equals: identity.email, mode: 'insensitive' } } });
        if (owner) throw new ConflictError('Sign in to your existing account and link Google from account settings');
        throw error;
      }
      const { passwordHash: _passwordHash, ...safeUser } = user.created;
      return { user: safeUser, accessToken: user.accessToken, refreshToken: user.refreshToken };
    },

    async linkAccount(userId: string, idToken: string) {
      const identity = await verify(idToken);
      return db.$transaction(async tx => {
        const owner = await tx.user.findUnique({ where: { id: userId } });
        if (!owner) throw new UnauthorizedError('Account is no longer available');
        accountAvailable(owner);
        const existing = await tx.googleIdentity.findUnique({ where: {
          provider_providerSubject: { provider: 'GOOGLE', providerSubject: identity.subject },
        } });
        if (existing) {
          if (existing.userId !== userId) throw new ConflictError('Google account is linked to another user');
          return { provider: 'GOOGLE', email: existing.email, linked: true };
        }
        const accountLink = await tx.googleIdentity.findUnique({ where: { provider_userId: { provider: 'GOOGLE', userId } } });
        if (accountLink) throw new ConflictError('A Google account is already linked');
        await tx.googleIdentity.create({ data: {
          provider: 'GOOGLE', providerSubject: identity.subject, userId,
          email: identity.email, emailVerifiedAt: identity.emailVerifiedAt,
        } });
        return { provider: 'GOOGLE', email: identity.email, linked: true };
      });
    },
  };
}

export const googleAuthService = createGoogleAuthService();
