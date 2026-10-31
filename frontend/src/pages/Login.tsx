import { useState } from 'react';
import type { FormEvent } from 'react';
import { Building2, Landmark, ShieldCheck } from 'lucide-react';
import { api, messageOf } from '../api';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      onLogin();
    } catch (submitError) {
      setError(messageOf(submitError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-brand">
        <div className="brand-pill">AKUNTAKITA · SCHOOL FINANCE ERP</div>
        <h1>Keuangan yayasan multiunit,<br />tercatat rapi dan bisa ditelusuri.</h1>
        <p>
          Satu badan hukum, banyak jenjang dan cabang. Rekening campuran, kesiapan keuangan per unit,
          dan jejak audit untuk setiap perubahan konfigurasi.
        </p>
        <div className="login-points">
          <span><Building2 size={18} /> Multi cabang</span>
          <span><Landmark size={18} /> Rekening campuran</span>
          <span><ShieldCheck size={18} /> Akses per unit</span>
        </div>
      </section>

      <section className="login-card-wrap">
        <form className="login-card" onSubmit={submit} data-testid="login-form">
          <div className="logo-mark">Y</div>
          <div>
            <h2>Masuk ke sistem</h2>
            <p>Gunakan akun yang diberikan Admin Yayasan.</p>
          </div>

          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              placeholder="nama@yayasan.sch.id"
              autoFocus
              autoComplete="username"
              data-testid="login-email"
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              data-testid="login-password"
            />
          </label>

          {error && <div className="form-error" data-testid="login-error">{error}</div>}

          <button className="primary-button" disabled={loading} data-testid="login-submit">
            {loading ? 'Memeriksa…' : 'Masuk'}
          </button>
          <small>School Finance ERP v0.1 · Foundation</small>
        </form>
      </section>
    </main>
  );
}
