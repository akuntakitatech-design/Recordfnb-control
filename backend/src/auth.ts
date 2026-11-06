import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { roleIsActive } from './permissions.js';

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  /** Kode role. Daftar role dikelola di tabel `roles` (bisa ditambah admin). */
  role: string;
  /** Nama tampilan role, diisi saat login/me dari tabel roles. */
  roleName?: string;
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
    const user = jwt.verify(token, secret()) as SessionUser;
    // Role bisa dinonaktifkan atau dihapus setelah token diterbitkan.
    if (!roleIsActive(user.role)) return res.status(403).json({ error: 'ROLE_INACTIVE' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'INVALID_SESSION' });
  }
}
