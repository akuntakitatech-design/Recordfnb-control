import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Building2, Landmark, LayoutDashboard, LogOut, ScrollText, ShieldCheck, UsersRound, WalletCards,
} from 'lucide-react';
import { api } from './api';
import { ROLE_LABEL, type LegalEntity, type Permission, type Session } from './types';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Organization } from './pages/Organization';
import { Units } from './pages/Units';
import { BankAccounts } from './pages/BankAccounts';
import { Readiness } from './pages/Readiness';
import { Users } from './pages/Users';
import { Audit } from './pages/Audit';

type Page = 'dashboard' | 'organization' | 'units' | 'banks' | 'readiness' | 'users' | 'audit';

type NavItem = { page: Page; label: string; icon: ReactNode; permission: Permission | null };

const NAV: NavItem[] = [
  { page: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={18} />, permission: null },
  { page: 'organization', label: 'Master Organisasi', icon: <Building2 size={18} />, permission: 'unit.view' },
  { page: 'units', label: 'Unit & Cabang', icon: <ShieldCheck size={18} />, permission: 'unit.view' },
  { page: 'banks', label: 'Rekening & Mapping', icon: <Landmark size={18} />, permission: 'bank.view' },
  { page: 'readiness', label: 'Kesiapan Keuangan', icon: <WalletCards size={18} />, permission: 'unit.view' },
  { page: 'users', label: 'Pengguna & Akses', icon: <UsersRound size={18} />, permission: 'user.manage' },
  { page: 'audit', label: 'Audit Trail', icon: <ScrollText size={18} />, permission: 'audit.view' },
];

const PAGE_TITLES: Record<Page, string> = {
  dashboard: 'Dashboard Yayasan',
  organization: 'Master Organisasi',
  units: 'Unit & Cabang',
  banks: 'Rekening & Mapping',
  readiness: 'Kesiapan Keuangan',
  users: 'Pengguna & Akses',
  audit: 'Audit Trail',
};

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [entity, setEntity] = useState<LegalEntity | null>(null);
  const [page, setPage] = useState<Page>('dashboard');

  async function refreshSession() {
    try {
      setSession(await api<Session>('/api/auth/me'));
    } catch {
      setSession(null);
    }
  }

  useEffect(() => { void refreshSession(); }, []);

  useEffect(() => {
    if (!session) {
      setEntity(null);
      return;
    }
    api<LegalEntity>('/api/v1/organization/legal-entity').then(setEntity).catch(() => setEntity(null));
  }, [session, page]);

  const items = useMemo(() => {
    if (!session) return [] as NavItem[];
    return NAV.filter(item => item.permission === null || session.permissions.includes(item.permission));
  }, [session]);

  if (session === undefined) return <div className="loading-screen">Memuat sistem…</div>;
  if (!session) return <Login onLogin={refreshSession} />;

  const current: Page = items.some(item => item.page === page) ? page : 'dashboard';

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setSession(null);
    setPage('dashboard');
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="logo-mark">Y</div>
          <div>
            <strong>SCHOOL FINANCE ERP</strong>
            <span>Akuntakita</span>
          </div>
        </div>

        <div className="school-badge">
          {entity?.name || 'Yayasan'}
          <small>{entity?.code || 'Badan hukum belum diatur'}</small>
        </div>

        <nav aria-label="Menu utama">
          <div className="nav-group-label">Keuangan Yayasan</div>
          {items.map(item => (
            <button
              key={item.page}
              type="button"
              className={current === item.page ? 'active' : ''}
              onClick={() => setPage(item.page)}
              data-testid={`nav-${item.page}`}
            >
              {item.icon} {item.label}
            </button>
          ))}
        </nav>

        <button type="button" className="logout-button" onClick={logout} data-testid="logout-button">
          <LogOut size={18} /> Keluar
        </button>
      </aside>

      <div className="content-shell">
        <header className="topbar">
          <div>
            <div className="eyebrow">{ROLE_LABEL[session.user.role]}</div>
            <h2 data-testid="page-title">{PAGE_TITLES[current]}</h2>
          </div>
          <div className="user-box">
            <div className="avatar">{session.user.fullName.slice(0, 1).toUpperCase()}</div>
            <div>
              <strong>{session.user.fullName}</strong>
              <span>{session.user.email}</span>
            </div>
          </div>
        </header>

        <main className="page">
          {current === 'dashboard' && <Dashboard session={session} />}
          {current === 'organization' && <Organization session={session} />}
          {current === 'units' && <Units session={session} />}
          {current === 'banks' && <BankAccounts session={session} />}
          {current === 'readiness' && <Readiness session={session} />}
          {current === 'users' && <Users session={session} />}
          {current === 'audit' && <Audit />}
        </main>
      </div>
    </div>
  );
}
