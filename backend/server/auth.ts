import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
};

declare global {
  namespace Express {
    interface Request {
      sessionUser?: SessionUser;
    }
  }
}

const secret = () => process.env.JWT_SECRET || 'development-only-secret';
const cookieName = () => process.env.COOKIE_NAME || 'fnb_session';

/**
 * COOKIE_SECURE: `auto` (default) -> flag Secure mengikuti protokol permintaan asli
 * (req.secure / X-Forwarded-Proto lewat `trust proxy`), sehingga cookie tetap terkirim
 * saat backend berada di belakang Nginx/Traefik (HTTP internal, HTTPS di depan).
 * `true`/`false` untuk memaksa.
 */
function cookieSecure(req?: Request) {
  const mode = (process.env.COOKIE_SECURE || 'auto').toLowerCase();
  if (mode === 'true' || mode === '1') return true;
  if (mode === 'false' || mode === '0') return false;
  if (req) return req.secure || req.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
  return process.env.NODE_ENV === 'production';
}

export function signSession(user: SessionUser) {
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
    req.sessionUser = jwt.verify(token, secret()) as SessionUser;
    next();
  } catch {
    return res.status(401).json({ error: 'INVALID_SESSION' });
  }
}
