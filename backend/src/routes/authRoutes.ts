import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { exec, one } from '../db.js';
import { clearSessionCookie, requireAuth, setSessionCookie, signSession, type SessionUser } from '../auth.js';
import { allowedUnitIds, permissionsOf } from '../permissions.js';
import { text } from '../http.js';

export const authRouter = Router();

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: SessionUser['role'];
  status: string;
};

function toSession(user: UserRow): SessionUser {
  return { id: user.id, email: user.email, fullName: user.full_name, role: user.role };
}

authRouter.post('/login', async (req, res) => {
  const email = text(req.body?.email).toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password) return res.status(400).json({ error: 'EMAIL_PASSWORD_REQUIRED' });

  const user = await one<UserRow>(
    'SELECT id,email,password_hash,full_name,role,status FROM users WHERE email=? LIMIT 1', [email],
  );
  if (!user || user.status !== 'ACTIVE' || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }

  const session = toSession(user);
  setSessionCookie(res, signSession(session));
  res.json({ user: session, permissions: permissionsOf(user.role) });
});

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await one<UserRow>(
    'SELECT id,email,password_hash,full_name,role,status FROM users WHERE id=? LIMIT 1', [req.user!.id],
  );
  if (!user || user.status !== 'ACTIVE') return res.status(401).json({ error: 'USER_INACTIVE' });
  const unitScope = await allowedUnitIds(req.user!);
  res.json({
    user: toSession(user),
    permissions: permissionsOf(user.role),
    unitScope,
  });
});

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword ?? '');
  const newPassword = String(req.body?.newPassword ?? '');
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'CURRENT_AND_NEW_PASSWORD_REQUIRED' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'NEW_PASSWORD_TOO_SHORT' });
  if (currentPassword === newPassword) return res.status(400).json({ error: 'NEW_PASSWORD_MUST_BE_DIFFERENT' });

  const user = await one<UserRow>(
    'SELECT id,email,password_hash,full_name,role,status FROM users WHERE id=? LIMIT 1', [req.user!.id],
  );
  if (!user || user.status !== 'ACTIVE') return res.status(404).json({ error: 'USER_NOT_FOUND' });
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    return res.status(400).json({ error: 'CURRENT_PASSWORD_INVALID' });
  }

  await exec('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(newPassword, 12), user.id]);
  setSessionCookie(res, signSession(toSession(user)));
  res.json({ ok: true });
});
