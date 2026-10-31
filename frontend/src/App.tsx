import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Banknote, Building2, FileText, Landmark, LayoutDashboard, LogOut, PieChart, Receipt, ScrollText,
  ShieldCheck, Users, UsersRound, Wallet, WalletCards,
} from 'lucide-react';
import { api } from './api';
import { ROLE_LABEL, type LegalEntity, type Permission, type Session } from './types';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Organization } from './pages/Organization';
import { Units } from './pages/Units';
import { BankAccounts } from './pages/BankAccounts';
import { Readiness } from './pages/Readiness';
import { Users as UsersPage } from './pages/Users';
import { Audit } from './pages/Audit';
import { Students } from './pages/Students';
import { Fees } from './pages/Fees';
import { Billing } from './pages/Billing';
import { Receivables } from './pages/Receivables';
import { Receipts } from './pages/Receipts';
import { CashBank } from './pages/CashBank';
import { Expenses } from './pages/Expenses';

type Page =
  | 'dashboard' | 'organization' | 'units' | 'banks' | 'readiness'
  | 'students' | 'fees' | 'billing' | 'receivables' | 'receipts' | 'cashbank' | 'expenses'
  | 'users' | 'audit';

type NavItem = { page: Page; label: string; icon: ReactNode; permission: Permission | null };
type NavGroup = { label: string; items: NavItem[] };

const NAV: NavGroup[] = [
  {
    label: 'Organisasi',
    items: [
      { page: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={18} />, permission: null },
      { page: 'organization', label: 'Master Organisasi', icon: <Building2 size={18} />, permission: 'unit.view' },
      { page: 'units', label: 'Unit & Cabang', icon: <ShieldCheck size={18} />, permission: 'unit.view' },
      { page: 'banks', label: 'Rekening & Mapping', icon: <Landmark size={18} />, permission: 'bank.view' },
      { page: 'readiness', label: 'Kesiapan Keuangan', icon: <WalletCards size={18} />, permission: 'unit.view' },
    ],
  },
  {
    label: 'Billing & Piutang',
    items: [
      { page: 'students', label: 'Siswa', icon: <Users size={18} />, permission: 'student.view' },
      { page: 'fees', label: 'Tarif', icon: <Receipt size={18} />, permission: 'fee.view' },
      { page: 'billing', label: 'Tagihan', icon: <FileText size={18} />, permission: 'billing.view' },
      { page: 'receivables', label: 'Piutang', icon: <PieChart size={18} />, permission: 'receivable.view' },
      { page: 'receipts', label: 'Penerimaan', icon: <Banknote size={18} />, permission: 'receipt.view' },
    ],
  },
  {
    label: 'Pengeluaran',
    items: [
      { page: 'expenses', label: 'Pengeluaran', icon: <WalletCards size={18} />, permission: 'expense.view' },
    ],
  },
  {
    label: 'Kas & Bank',
    items: [
      { page: 'cashbank', label: 'Saldo & Mutasi', icon: <Wallet size={18} />, permission: 'cashbank.view' },
    ],
  },
  {
    label: 'Administrasi',
    items: [
      { page: 'users', label: 'Pengguna & Akses', icon: <UsersRound size={18} />, permission: 'user.manage' },
      { page: 'audit', label: 'Audit Trail', icon: <ScrollText size={18} />, permission: 'audit.view' },
    ],
  },
];

const PAGE_TITLES: Record<Page, string> = {
  dashboard: 'Dashboard Yayasan',
  organization: 'Master Organisasi',
  units: 'Unit & Cabang',
  banks: 'Rekening & Mapping',
  readiness: 'Kesiapan Keuangan',
  students: 'Data Siswa',
  fees: 'Jenis Biaya & Tarif',
  billing: 'Tagihan Siswa',
  receivables: 'Piutang & Aging',
  receipts: 'Penerimaan Pembayaran',
  cashbank: 'Kas & Bank',
  expenses: 'Pengeluaran',
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

  const groups = useMemo(() => {
    if (!session) return [] as NavGroup[];
    return NAV
      .map(group => ({
        ...group,
        items: group.items.filter(item => item.permission === null || session.permissions.includes(item.permission)),
      }))
      .filter(group => group.items.length > 0);
  }, [session]);

  const allowed = useMemo(
    () => new Set(groups.flatMap(group => group.items.map(item => item.page))),
    [groups],
  );

  if (session === undefined) return <div className="loading-screen">Memuat sistem…</div>;
  if (!session) return <Login onLogin={refreshSession} />;

  const current: Page = allowed.has(page) ? page : 'dashboard';

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
          {groups.map(group => (
            <div key={group.label} style={{ display: 'contents' }}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map(item => (
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
            </div>
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
          {current === 'students' && <Students session={session} />}
          {current === 'fees' && <Fees session={session} />}
          {current === 'billing' && <Billing session={session} />}
          {current === 'receivables' && <Receivables session={session} />}
          {current === 'receipts' && <Receipts session={session} />}
          {current === 'cashbank' && <CashBank session={session} />}
          {current === 'expenses' && <Expenses session={session} />}
          {current === 'users' && <UsersPage session={session} />}
          {current === 'audit' && <Audit />}
        </main>
      </div>
    </div>
  );
}
