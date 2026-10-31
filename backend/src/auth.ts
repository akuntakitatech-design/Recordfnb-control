import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';

export const ROLES = [
  'PIMPINAN',
  'ADMIN_YAYASAN',
  'FINANCE_PUSAT',
  'ACCOUNTING_PUSAT',
  'KEPALA_JENJANG',
  'KEPALA_CABANG',
  'BENDAHARA_CABANG',
  'AUDITOR',
] as const;

export type UserRole = (typeof ROLES)[number];

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
};

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

const secret = () => process.env.JWT_SECRET || 'development-only-secret';
const cookieName = () => process.env.COOKIE_NAME || 'school_session';

/** COOKIE_SECURE=auto mengikuti protokol asli (aman di belakang Nginx/Traefik). */
function cookieSecure(req?: Request) {
  const mode = (process.env.COOKIE_SECURE || 'auto').toLowerCase();
  if (mode === 'true' || mode === '1') return true;
  if (mode === 'false' || mode === '0') return false;
  if (req) return req.secure || req.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
  return process.env.NODE_ENV === 'production';
}

export function signSession(user: SessionUser): string {
  return jwt.sign(user, secret(), { expiresIn: '12h' });
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(cookieName(), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(res.req),
    maxAge: 12 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(cookieName());
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[cookieName()];
  if (!token) return res.status(401).json({ error: 'UNAUTHENTICATED' });
  try {
    req.user = jwt.verify(token, secret()) as SessionUser;
    next();
  } catch {
    return res.status(401).json({ error: 'INVALID_SESSION' });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'ROLE_FORBIDDEN' });
    next();
  };
}

export function isUserRole(value: string): value is UserRole {
  return (ROLES as readonly string[]).includes(value);
}
