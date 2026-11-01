import { useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, LogOut, ShieldAlert } from 'lucide-react';
import { api, messageOf } from '../api';
import type { Session } from '../types';

/**
 * Layar wajib ganti password: muncul bila password direset admin / lewat env
 * (must_change_password=1). Pengguna tidak bisa memakai menu lain sebelum mengganti.
 */
export function ForcePasswordChange({ session, onDone }: { session: Session; onDone: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) { setError('Konfirmasi password tidak sama.'); return; }
    if (newPassword.length < 8) { setError('Password baru minimal 8 karakter.'); return; }
    setSaving(true);
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      onDone();
    } catch (submitError) {
      setError(messageOf(submitError));
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    onDone();
  }

  return (
    <main className="login-page">
      <section className="login-brand">
        <div className="brand-pill">AKUNTAKITA · SCHOOL FINANCE ERP</div>
        <h1>Amankan akun Anda<br />sebelum melanjutkan.</h1>
        <p>
          Password akun ini baru direset. Buat password pribadi sekarang agar hanya Anda
          yang bisa mengakses data keuangan yayasan.
        </p>
        <div className="login-points">
          <span><ShieldAlert size={18} /> Wajib ganti password</span>
          <span><KeyRound size={18} /> Minimal 8 karakter</span>
        </div>
      </section>

      <section className="login-card-wrap">
        <form className="login-card" onSubmit={submit} data-testid="force-password-form">
          <div className="logo-mark">Y</div>
          <div>
            <h2>Buat password baru</h2>
            <p>{session.user.email}</p>
          </div>

          <label>
            Password sementara (yang baru dipakai)
            <input
              type="password"
              value={currentPassword}
              onChange={event => setCurrentPassword(event.target.value)}
              autoFocus
              autoComplete="current-password"
              data-testid="force-current-password"
            />
          </label>

          <label>
            Password baru
            <input
              type="password"
              value={newPassword}
              onChange={event => setNewPassword(event.target.value)}
              autoComplete="new-password"
              data-testid="force-new-password"
            />
          </label>

          <label>
            Ulangi password baru
            <input
              type="password"
              value={confirmPassword}
              onChange={event => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              data-testid="force-confirm-password"
            />
          </label>

          {error && <div className="form-error">{error}</div>}

          <button type="submit" className="primary-button" disabled={saving} data-testid="force-password-submit">
            {saving ? 'Menyimpan…' : 'Simpan password baru'}
          </button>

          <button type="button" className="link-button" onClick={() => void logout()}>
            <LogOut size={14} /> Keluar
          </button>
        </form>
      </section>
    </main>
  );
}
