import { useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { api } from './api';

const errorMessages: Record<string, string> = {
  CURRENT_AND_NEW_PASSWORD_REQUIRED: 'Password lama dan password baru wajib diisi.',
  NEW_PASSWORD_TOO_SHORT: 'Password baru minimal 8 karakter.',
  NEW_PASSWORD_MUST_BE_DIFFERENT: 'Password baru harus berbeda dari password lama.',
  CURRENT_PASSWORD_INVALID: 'Password lama tidak sesuai.',
  USER_NOT_FOUND: 'Akun pengguna tidak ditemukan.',
};

export function SettingsSecurity() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess(false);

    if (newPassword.length < 8) {
      setError('Password baru minimal 8 karakter.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Konfirmasi password baru belum sama.');
      return;
    }

    setSaving(true);
    try {
      await api<{ ok: boolean }>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSuccess(true);
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      setError(errorMessages[code] || 'Password belum berhasil diubah. Silakan coba lagi.');
    } finally {
      setSaving(false);
    }
  }

  return <div className="page-content settings-page">
    <section className="section-card settings-card">
      <div className="section-title">
        <div>
          <span className="eyebrow">PENGATURAN · KEAMANAN</span>
          <h3>Ganti Password</h3>
          <p>Ubah password login sistem tanpa perlu masuk ke VPS.</p>
        </div>
        <div className="settings-icon"><ShieldCheck size={22}/></div>
      </div>

      <form className="security-form" onSubmit={submit}>
        <div className="security-intro">
          <KeyRound size={20}/>
          <div>
            <strong>Keamanan akun</strong>
            <span>Gunakan password yang tidak dipakai di akun lain. Minimal 8 karakter.</span>
          </div>
        </div>

        <label>Password Lama
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            placeholder="Masukkan password saat ini"
            required
          />
        </label>

        <label>Password Baru
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            placeholder="Minimal 8 karakter"
            minLength={8}
            required
          />
        </label>

        <label>Konfirmasi Password Baru
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            placeholder="Ulangi password baru"
            minLength={8}
            required
          />
        </label>

        {error && <div className="form-error">{error}</div>}
        {success && <div className="success-banner settings-success"><ShieldCheck size={18}/><span>Password login berhasil diubah.</span></div>}

        <div className="security-actions">
          <button className="primary-button" disabled={saving || !currentPassword || !newPassword || !confirmPassword}>
            {saving ? 'Menyimpan...' : 'Ubah Password'}
          </button>
        </div>
      </form>
    </section>
  </div>;
}
