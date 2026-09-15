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

export function signSession(user: SessionUser) {
  return jwt.sign(user, secret(), { expiresIn: '12h' });
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(cookieName(), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
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
