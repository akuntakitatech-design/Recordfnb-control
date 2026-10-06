import { useEffect, useMemo, useState } from 'react';
import {
  BookOpenCheck,
  Boxes,
  Building2,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  Database,
  Eye,
  Factory,
  FileStack,
  Landmark,
  LayoutDashboard,
  LogOut,
  MapPin,
  PackageSearch,
  ReceiptText,
  Search,
  Settings2,
  ShieldCheck,
  Store,
  Users,
  UsersRound,
  WalletCards,
} from 'lucide-react';
import { api } from './api';
import { MasterItemCenter } from './MasterItemCenter';
import { MasterFinanceCenter } from './MasterFinanceCenter';
import { TransactionForm } from './TransactionForm';
import { SettingsSecurity } from './SettingsSecurity';
import { UserAccessCenter } from './UserAccessCenter';
import { StandardCoaCenter } from './StandardCoaCenter';
import { JournalCenter } from './JournalCenter';
import { ClientItemCenter } from './ClientItemCenter';
import { ClientPartnerCenter } from './ClientPartnerCenter';
import { ClientPurchaseInvoice } from './ClientPurchaseInvoice';
import { ClientItemUsage } from './ClientItemUsage';
import { ClientStockTransfer } from './ClientStockTransfer';
import { ClientStockOpname } from './ClientStockOpname';
import { ClientSalesImport } from './ClientSalesImport';
import { ClientBomProduction } from './ClientBomProduction';
import { ClientInventoryControl } from './ClientInventoryControl';
import { CashBankCenter } from './CashBankCenter';
import { AccountingCompanyPage } from './AccountingCompanyPage';

type Membership = {
  workspace_id: string;
  workspace_name: string;
  company_id: string | null;
  company_name: string | null;
  location_id: string | null;
  location_name: string | null;
  role_code: string;
  role_name: string;
  side: 'CLIENT' | 'AKUNTAKITA' | 'SYSTEM';
};
type Session = {
  user: { id: string; email: string; fullName: string; isSystemAdmin: boolean };
  memberships: Membership[];
};

type Summary = { workspaces: number; companies: number; locations: number; items: number; partners: number; transactions: number };
type Workspace = { id: string; code: string; name: string; status: string };
type Company = { id: string; workspace_id: string; code: string; name: string; status: string; workspace_name?: string };
type Location = { id: string; company_id: string; code: string; name: string; location_type: string; status: string; company_name?: string };
type Page =
  | 'dashboard'
  // Finance Control
  | 'sales' | 'cash-bank' | 'purchase' | 'payables' | 'item-usage' | 'stock-transfer' | 'stock-opname' | 'inventory-control' | 'production' | 'items' | 'partners'
  // Accounting Control
  | 'control' | 'accounting-source' | 'coa-standard' | 'transactions' | 'bom' | 'periods' | 'finance' | 'items-master'
  // Administrasi
  | 'organization' | 'access' | 'settings';
type OrganizationTab = 'workspace' | 'company' | 'location';

/* ---- Role V2: pengelompokan role existing (tanpa role baru) ---- */
const FINANCE_ROLES = ['CLIENT_FINANCE_MANAGER', 'CLIENT_FINANCE_STAFF'];
const ACCOUNTING_ROLES = ['AK_SUPER_ADMIN', 'AK_ACCOUNTING_REVIEWER', 'AK_ACCOUNTING_STAFF'];
const OWNER_ROLES = ['CLIENT_OWNER'];
const OUTLET_ROLES = ['CLIENT_OUTLET_USER'];

export type RoleFlags = {
  isAccounting: boolean; isFinance: boolean; isOwner: boolean; isOutlet: boolean; isSystemAdmin: boolean;
  financeArea: boolean; canVerify: boolean; canOverrideInventory: boolean; canPostJournal: boolean; canManageUsers: boolean;
};

export function roleFlags(session: Session): RoleFlags {
  const codes = new Set(session.memberships.map(m => m.role_code));
  const has = (list: string[]) => list.some(code => codes.has(code));
  const isAccounting = has(ACCOUNTING_ROLES);
  const isFinance = has(FINANCE_ROLES);
  return {
    isAccounting,
    isFinance,
    isOwner: has(OWNER_ROLES),
    isOutlet: has(OUTLET_ROLES),
    isSystemAdmin: Boolean(session.user.isSystemAdmin),
    financeArea: isAccounting || isFinance,
    canVerify: isAccounting || isFinance,
    canOverrideInventory: isAccounting || codes.has('CLIENT_FINANCE_MANAGER'),
    canPostJournal: codes.has('AK_SUPER_ADMIN') || codes.has('AK_ACCOUNTING_REVIEWER'),
    canManageUsers: Boolean(session.user.isSystemAdmin) || codes.has('AK_SUPER_ADMIN'),
  };
}

type NavItem = { page: Page; label: string; icon: React.ReactNode; allowed: (f: RoleFlags) => boolean };
type NavGroup = { label: string; sub?: string; items: NavItem[] };

const financeOrAcc = (f: RoleFlags) => f.financeArea;
const operational = (f: RoleFlags) => f.financeArea || f.isOutlet;
const accountingOnly = (f: RoleFlags) => f.isAccounting;

const NAV: NavGroup[] = [
  { label: 'Finance Control', items: [
    { page: 'sales', label: 'Penjualan', icon: <Store size={18}/>, allowed: operational },
    { page: 'cash-bank', label: 'Kas & Bank', icon: <Landmark size={18}/>, allowed: financeOrAcc },
    { page: 'purchase', label: 'Pembelian', icon: <ReceiptText size={18}/>, allowed: financeOrAcc },
    { page: 'payables', label: 'Hutang Supplier', icon: <WalletCards size={18}/>, allowed: financeOrAcc },
  ] },
  { label: 'Inventory', items: [
    { page: 'item-usage', label: 'Pemakaian Barang', icon: <PackageSearch size={18}/>, allowed: operational },
    { page: 'stock-transfer', label: 'Transfer Barang', icon: <Boxes size={18}/>, allowed: operational },
    { page: 'stock-opname', label: 'Stock Opname', icon: <ClipboardList size={18}/>, allowed: operational },
    { page: 'inventory-control', label: 'Kontrol & Kartu Stok', icon: <PackageSearch size={18}/>, allowed: financeOrAcc },
    { page: 'production', label: 'Produksi', icon: <Factory size={18}/>, allowed: financeOrAcc },
  ] },
  { label: 'Master Operasional', items: [
    { page: 'items', label: 'Barang / Item', icon: <Boxes size={18}/>, allowed: financeOrAcc },
    { page: 'partners', label: 'Supplier & Relasi', icon: <UsersRound size={18}/>, allowed: financeOrAcc },
  ] },
  { label: 'Accounting Control', items: [
    { page: 'control', label: 'Control Center', icon: <ShieldCheck size={18}/>, allowed: accountingOnly },
    { page: 'accounting-source', label: 'Accounting Source', icon: <FileStack size={18}/>, allowed: accountingOnly },
    { page: 'coa-standard', label: 'COA & Mapping', icon: <BookOpenCheck size={18}/>, allowed: accountingOnly },
    { page: 'transactions', label: 'Jurnal / Engine', icon: <ReceiptText size={18}/>, allowed: accountingOnly },
    { page: 'bom', label: 'BOM / Resep', icon: <Boxes size={18}/>, allowed: accountingOnly },
    { page: 'periods', label: 'Periode & Closing', icon: <CircleDollarSign size={18}/>, allowed: accountingOnly },
    { page: 'finance', label: 'Finance Master', icon: <Landmark size={18}/>, allowed: accountingOnly },
    { page: 'items-master', label: 'Barang & Inventory', icon: <Database size={18}/>, allowed: accountingOnly },
  ] },
  { label: 'Administrasi', items: [
    { page: 'access', label: 'User & Akses', icon: <Users size={18}/>, allowed: f => f.canManageUsers },
    { page: 'organization', label: 'Organisasi', icon: <Building2 size={18}/>, allowed: f => f.isSystemAdmin || f.isAccounting },
    { page: 'settings', label: 'Pengaturan', icon: <Settings2 size={18}/>, allowed: () => true },
  ] },
];

const pageTitles: Record<Page, string> = {
  dashboard: 'Dashboard', sales: 'Penjualan / Import POS', 'cash-bank': 'Kas & Bank', purchase: 'Pembelian / Invoice Supplier', payables: 'Hutang Supplier',
  'item-usage': 'Pemakaian Barang', 'stock-transfer': 'Transfer Barang', 'stock-opname': 'Stock Opname', 'inventory-control': 'Kontrol Stok & Kartu Stok',
  production: 'Produksi', items: 'Barang / Item', partners: 'Supplier & Relasi',
  control: 'Accounting Control Center', 'accounting-source': 'Accounting Source', 'coa-standard': 'COA Standard & Mapping', transactions: 'Jurnal / Transaction Engine',
  bom: 'BOM / Resep', periods: 'Periode & Closing', finance: 'Finance & Accounting Master', 'items-master': 'Barang & Inventory (Master)',
  organization: 'Master Organisasi', access: 'User & Hak Akses', settings: 'Pengaturan',
};

const locationLabel: Record<string, string> = {
  HEAD_OFFICE: 'Head Office', OUTLET: 'Outlet', CENTRAL_KITCHEN: 'Central Kitchen', WAREHOUSE: 'Warehouse',
  PRODUCTION_KITCHEN: 'Production Kitchen', CLOUD_KITCHEN: 'Cloud Kitchen', BOOTH: 'Booth', OTHER: 'Lainnya',
};

function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setLoading(true); setError('');
    try { await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); onLogin(); }
    catch { setError('Email atau password belum sesuai.'); }
    finally { setLoading(false); }
  }

  return <main className="login-page">
    <section className="login-brand">
      <div className="brand-pill">AKUNTAKITA · F&B CONTROL</div>
      <h1>Finance Client bekerja sederhana.<br/>Accounting tetap terbentuk rapi.</h1>
      <p>Platform multi-client, multi-company dan multi-outlet yang menjembatani Finance Client dengan Accounting Akuntakita tanpa input dua kali.</p>
      <div className="login-points"><span><ShieldCheck size={18}/> Finance Control</span><span><Database size={18}/> Satu sumber data</span><span><CircleDollarSign size={18}/> Accounting Engine</span></div>
    </section>
    <section className="login-card-wrap"><form className="login-card" onSubmit={submit} data-testid="login-form">
      <div className="logo-mark">A</div><div><h2>Masuk ke sistem</h2><p>Gunakan akun Finance Client atau Akuntakita.</p></div>
      <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="nama@perusahaan.com" autoFocus data-testid="login-email"/></label>
      <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" data-testid="login-password"/></label>
      {error && <div className="form-error" data-testid="login-error">{error}</div>}
      <button className="primary-button" disabled={loading} data-testid="login-submit">{loading ? 'Memeriksa...' : 'Masuk'}</button><small>Foundation v0.18 · Role V2</small>
    </form></section>
  </main>;
}

function Metric({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return <div className="metric-card"><div className="metric-icon">{icon}</div><div><strong>{value}</strong><span>{label}</span></div></div>;
}

function NavLabel({ children }: { children: React.ReactNode }) {
  return <span className="nav-group-label">{children}</span>;
}

function portalLabel(f: RoleFlags) {
  if (f.isAccounting) return 'Accounting Control';
  if (f.isFinance) return 'Finance Control';
  if (f.isOutlet) return 'Outlet';
  if (f.isOwner) return 'Owner · Read-only';
  if (f.isSystemAdmin) return 'System Administration';
  return 'Tanpa akses';
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [active, setActive] = useState<Page>('dashboard');

  async function refreshSession() { try { setSession(await api<Session>('/api/auth/me')); } catch { setSession(null); } }
  useEffect(() => { void refreshSession(); }, []);
  useEffect(() => { if (session) api<Summary>('/api/foundation/summary').then(setSummary).catch(() => setSummary(null)); }, [session, active]);

  async function logout() { await api('/api/auth/logout', { method: 'POST' }); setSession(null); setActive('dashboard'); }

  const flags = useMemo(() => (session ? roleFlags(session) : null), [session]);
  const nav = useMemo(() => (flags ? NAV.map(g => ({ ...g, items: g.items.filter(i => i.allowed(flags)) })).filter(g => g.items.length) : []), [flags]);
  const allowedPages = useMemo(() => new Set<Page>(['dashboard', ...nav.flatMap(g => g.items.map(i => i.page))]), [nav]);

  if (session === undefined) return <div className="loading-screen">Memuat sistem...</div>;
  if (!session || !flags) return <Login onLogin={refreshSession}/>;

  const page: Page = allowedPages.has(active) ? active : 'dashboard';
  const outletOnly = flags.isOutlet && !flags.financeArea;
  const outletNames = [...new Set(session.memberships.filter(m => OUTLET_ROLES.includes(m.role_code)).map(m => m.location_name || 'Semua outlet'))];

  return <div className="app-shell" data-testid="app-shell" data-portal={portalLabel(flags)}>
    <aside className="sidebar">
      <div className="sidebar-brand"><div className="logo-mark small">A</div><div><strong>AKUNTAKITA</strong><span>F&B Control</span></div></div>
      <div className="portal-badge" data-testid="portal-badge"><span>{portalLabel(flags)}</span>{outletOnly && <small>{outletNames.join(', ')}</small>}{flags.isSystemAdmin && (flags.financeArea || flags.isOwner || flags.isOutlet) && <small>+ System Admin</small>}</div>
      <nav data-testid="sidebar-nav">
        <button className={page === 'dashboard' ? 'active' : ''} onClick={() => setActive('dashboard')} data-testid="nav-dashboard"><LayoutDashboard size={18}/> Dashboard</button>
        {nav.map(group => <div key={group.label} style={{ display: 'contents' }} data-testid={`nav-group-${group.label.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
          <NavLabel>{group.label}</NavLabel>
          {group.items.map(item => <button key={item.page} className={page === item.page ? 'active' : ''} onClick={() => setActive(item.page)} data-testid={`nav-${item.page}`}>{item.icon} {item.label}</button>)}
        </div>)}
      </nav>
      <button className="logout-button" onClick={logout} data-testid="logout-button"><LogOut size={18}/> Keluar</button>
    </aside>

    <section className="content-shell">
      <header className="topbar"><div><span className="eyebrow">{portalLabel(flags).toUpperCase()}</span><h2 data-testid="page-title">{pageTitles[page]}</h2></div><div className="user-box"><div className="avatar">{session.user.fullName.slice(0,1).toUpperCase()}</div><div><strong>{session.user.fullName}</strong><span>{session.user.email}</span></div></div></header>
      {page === 'dashboard' && <Dashboard summary={summary} setActive={setActive} flags={flags} session={session}/>}
      {page === 'sales' && <ClientSalesImport canVerify={flags.canVerify} canOverride={flags.canOverrideInventory}/>}
      {page === 'cash-bank' && <CashBankCenter key="cash-bank" canVerify={flags.canVerify} canAccounting={flags.isAccounting}/>}
      {page === 'payables' && <CashBankCenter key="payables" initialTab="payables" canVerify={flags.canVerify} canAccounting={flags.isAccounting}/>}
      {page === 'purchase' && <ClientPurchaseInvoice canVerify={flags.canVerify}/>}
      {page === 'item-usage' && <ClientItemUsage canVerify={flags.canVerify} canOverride={flags.canOverrideInventory}/>}
      {page === 'stock-transfer' && <ClientStockTransfer canVerify={flags.canVerify} canOverride={flags.canOverrideInventory}/>}
      {page === 'stock-opname' && <ClientStockOpname canVerify={flags.canVerify}/>}
      {page === 'inventory-control' && <ClientInventoryControl/>}
      {page === 'production' && <ClientBomProduction key="production" view="production" canManageBom={false} canVerify={flags.canVerify} canOverride={flags.canOverrideInventory}/>}
      {page === 'items' && <ClientItemCenter/>}
      {page === 'partners' && <ClientPartnerCenter/>}
      {page === 'control' && <JournalCenter canReview={flags.isAccounting} canPost={flags.canPostJournal}/>}
      {page === 'accounting-source' && <AccountingCompanyPage key="source" mode="source"/>}
      {page === 'coa-standard' && <StandardCoaCenter/>}
      {page === 'transactions' && <TransactionForm canVerify={flags.canVerify}/>}
      {page === 'bom' && <ClientBomProduction key="bom" view="bom" canManageBom={flags.isAccounting} canVerify={flags.canVerify} canOverride={flags.canOverrideInventory}/>}
      {page === 'periods' && <AccountingCompanyPage key="period" mode="period"/>}
      {page === 'finance' && <MasterFinanceCenter/>}
      {page === 'items-master' && <MasterItemCenter/>}
      {page === 'organization' && <OrganizationMaster/>}
      {page === 'access' && <UserAccessCenter/>}
      {page === 'settings' && <SettingsSecurity/>}
    </section>
  </div>;
}

function Dashboard({ summary, setActive, flags, session }: { summary: Summary | null; setActive: (v: Page) => void; flags: RoleFlags; session: Session }) {
  if (flags.isAccounting) return <div className="page-content" data-testid="dashboard-accounting">
    <section className="hero-panel"><div><span className="eyebrow">ACCOUNTING CONTROL · FULL BUSINESS ACCESS</span><h1>Operasional sederhana, accounting tetap terkendali.</h1><p>Finance Control menangkap transaksi bisnis. Accounting Akuntakita mengarahkan, mereview, memposting dan menutup periode tanpa input ulang.</p></div><button className="primary-button compact" onClick={() => setActive('control')} data-testid="dashboard-open-control">Buka Accounting Control <ChevronRight size={17}/></button></section>
    <div className="metrics-grid"><Metric icon={<Users/>} value={summary?.workspaces ?? 0} label="Client / Workspace"/><Metric icon={<Building2/>} value={summary?.companies ?? 0} label="Company"/><Metric icon={<MapPin/>} value={summary?.locations ?? 0} label="Location"/><Metric icon={<PackageSearch/>} value={summary?.items ?? 0} label="Item"/></div>
    <section className="section-card"><div className="section-title"><div><span className="eyebrow">STRUKTUR KERJA</span><h3>Finance Control + Accounting Control</h3></div></div><div className="foundation-list">
      <div><b>01</b><span><strong>Finance Control</strong><small>Penjualan, Kas & Bank, Pembelian, Hutang Supplier, Inventory dan Produksi — Accounting dapat menjalankannya bila diperlukan.</small></span></div>
      <div><b>02</b><span><strong>BOM / Resep</strong><small>Master BOM dimiliki Accounting: create, edit (versi baru) dan nonaktif. Finance hanya melihat dan menjalankan produksi.</small></span></div>
      <div><b>03</b><span><strong>Accounting</strong><small>Control Center, Accounting Source, COA & Mapping, jurnal, review, posting dan closing periode.</small></span></div>
      <div><b>04</b><span><strong>Satu company, satu pembukuan</strong><small>Multi outlet/location dalam satu company tetap satu pembukuan; akses mengikuti company & location assignment.</small></span></div>
    </div></section>
  </div>;

  if (flags.isFinance) return <div className="page-content" data-testid="dashboard-finance">
    <section className="hero-panel"><div><span className="eyebrow">FINANCE CONTROL</span><h1>Catat kegiatan bisnis, bukan jurnal.</h1><p>Kategori, COA, mapping akun, BOM/Resep dan setup accounting dikelola Akuntakita. Tim Finance fokus pada administrasi operasional sehari-hari.</p></div><button className="primary-button compact" onClick={() => setActive('sales')} data-testid="dashboard-open-sales">Import Penjualan <ChevronRight size={17}/></button></section>
    <div className="metrics-grid"><Metric icon={<Building2/>} value={summary?.companies ?? 0} label="Company"/><Metric icon={<MapPin/>} value={summary?.locations ?? 0} label="Location"/><Metric icon={<PackageSearch/>} value={summary?.items ?? 0} label="Item"/><Metric icon={<UsersRound/>} value={summary?.partners ?? 0} label="Supplier / Relasi"/></div>
    <section className="section-card"><div className="section-title"><div><span className="eyebrow">ALUR KERJA FINANCE</span><h3>Area kerja harian</h3></div></div><div className="foundation-list">
      <div><b>01</b><span><strong>Penjualan & Kas/Bank</strong><small>Import POS, pembayaran, pindah uang, penerimaan lain dan rekonsiliasi dalam Kas & Bank terpadu.</small></span></div>
      <div><b>02</b><span><strong>Pembelian & Hutang</strong><small>Invoice supplier dan pelunasan hutang (partial) tanpa memilih akun.</small></span></div>
      <div><b>03</b><span><strong>Inventory & Produksi</strong><small>Pemakaian, transfer, stock opname, kartu stok dan produksi STJ berdasarkan BOM aktif dari Accounting.</small></span></div>
      <div><b>04</b><span><strong>Accounting otomatis</strong><small>Setelah Finance Verified, transaksi masuk Accounting Review tanpa client memilih akun.</small></span></div>
    </div></section>
  </div>;

  if (flags.isOutlet) {
    const outlets = session.memberships.filter(m => OUTLET_ROLES.includes(m.role_code));
    return <div className="page-content" data-testid="dashboard-outlet">
      <section className="hero-panel"><div><span className="eyebrow">OUTLET</span><h1>Operasional outlet</h1><p>Catat penjualan/POS, pemakaian barang, transfer dan stock opname untuk outlet yang ditugaskan kepada Anda.</p></div><button className="primary-button compact" onClick={() => setActive('sales')} data-testid="dashboard-open-sales">Import Penjualan <ChevronRight size={17}/></button></section>
      <section className="section-card"><div className="section-title"><div><span className="eyebrow">ASSIGNMENT</span><h3>Outlet yang ditugaskan</h3></div></div><div className="role-scope-list" data-testid="outlet-assignment-list">
        {outlets.map((m, index) => <div key={`${m.location_id}-${index}`}><strong>{m.location_name || 'Semua outlet'}</strong><span>{m.company_name || m.workspace_name}</span></div>)}
      </div></section>
    </div>;
  }

  if (flags.isOwner) return <div className="page-content" data-testid="dashboard-owner">
    <section className="hero-panel"><div><span className="eyebrow">OWNER · READ-ONLY</span><h1>Ringkasan bisnis</h1><p>Area Owner bersifat hanya-lihat. Dashboard Owner lengkap (penjualan, kas, laba) disiapkan pada fase berikutnya.</p></div><span className="readonly-pill" data-testid="owner-readonly-badge"><Eye size={15}/> Hanya lihat</span></section>
    <div className="metrics-grid"><Metric icon={<Building2/>} value={summary?.companies ?? 0} label="Company"/><Metric icon={<MapPin/>} value={summary?.locations ?? 0} label="Outlet / Location"/><Metric icon={<PackageSearch/>} value={summary?.items ?? 0} label="Item"/><Metric icon={<ReceiptText/>} value={summary?.transactions ?? 0} label="Transaksi"/></div>
  </div>;

  return <div className="page-content" data-testid="dashboard-sysadmin">
    <section className="hero-panel"><div><span className="eyebrow">SYSTEM ADMINISTRATION</span><h1>Administrasi teknis sistem</h1><p>System Admin mengelola user, hak akses, organisasi dan pengaturan. Akses bisnis (Finance/Accounting) diberikan lewat membership role di User & Akses.</p></div>{flags.canManageUsers && <button className="primary-button compact" onClick={() => setActive('access')} data-testid="dashboard-open-access">Kelola User & Akses <ChevronRight size={17}/></button>}</section>
    <div className="metrics-grid"><Metric icon={<Users/>} value={summary?.workspaces ?? 0} label="Client / Workspace"/><Metric icon={<Building2/>} value={summary?.companies ?? 0} label="Company"/><Metric icon={<MapPin/>} value={summary?.locations ?? 0} label="Location"/><Metric icon={<ShieldCheck/>} value={session.memberships.length} label="Membership Anda"/></div>
  </div>;
}

function OrganizationMaster() {
  const [tab, setTab] = useState<OrganizationTab>('workspace');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');

  async function load() {
    const [w,c,l] = await Promise.all([api<Workspace[]>('/api/master/workspaces'), api<Company[]>('/api/master/companies'), api<Location[]>('/api/master/locations')]);
    setWorkspaces(w); setCompanies(c); setLocations(l);
  }
  useEffect(() => { void load(); }, []);

  const raw = tab === 'workspace' ? workspaces : tab === 'company' ? companies : locations;
  const filtered = raw.filter(x => !search.trim() || JSON.stringify(x).toLowerCase().includes(search.toLowerCase()));

  return <div className="page-content"><section className="section-card">
    <div className="section-title master-heading"><div><span className="eyebrow">MASTER DATA CENTER</span><h3>Struktur Organisasi</h3><p>Client / Workspace → Company → Location. Setup awal dikelola dari Workspace Akuntakita.</p></div><button className="primary-button compact" onClick={() => setShowForm(true)}>+ Tambah</button></div>
    <div className="tabs"><button className={tab === 'workspace' ? 'active' : ''} onClick={() => setTab('workspace')}>Client / Workspace</button><button className={tab === 'company' ? 'active' : ''} onClick={() => setTab('company')}>Company</button><button className={tab === 'location' ? 'active' : ''} onClick={() => setTab('location')}>Location</button></div>
    <div className="table-toolbar"><div className="search-box"><Search size={16}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cari data..."/></div><span>{filtered.length} data</span></div>
    <div className="data-table-wrap">
      {tab === 'workspace' && <table><thead><tr><th>Kode</th><th>Nama Client</th><th>Status</th></tr></thead><tbody>{(filtered as Workspace[]).map(x => <tr key={x.id}><td><code>{x.code}</code></td><td><strong>{x.name}</strong></td><td><span className="status-ok">Aktif</span></td></tr>)}</tbody></table>}
      {tab === 'company' && <table><thead><tr><th>Kode</th><th>Company</th><th>Client</th><th>Status</th></tr></thead><tbody>{(filtered as Company[]).map(x => <tr key={x.id}><td><code>{x.code}</code></td><td><strong>{x.name}</strong></td><td>{x.workspace_name}</td><td><span className="status-ok">Aktif</span></td></tr>)}</tbody></table>}
      {tab === 'location' && <table><thead><tr><th>Kode</th><th>Location</th><th>Tipe</th><th>Company</th></tr></thead><tbody>{(filtered as Location[]).map(x => <tr key={x.id}><td><code>{x.code}</code></td><td><strong>{x.name}</strong></td><td>{locationLabel[x.location_type] || x.location_type}</td><td>{x.company_name}</td></tr>)}</tbody></table>}
      {filtered.length === 0 && <div className="empty-state"><Database size={34}/><strong>Belum ada data</strong><span>Tambahkan data pertama untuk mulai membangun struktur client.</span></div>}
    </div>
  </section>{showForm && <QuickCreate type={tab} workspaces={workspaces} companies={companies} onClose={() => setShowForm(false)} onSaved={async () => { setShowForm(false); await load(); }}/>}</div>;
}

function QuickCreate({ type, workspaces, companies, onClose, onSaved }: { type: OrganizationTab; workspaces: Workspace[]; companies: Company[]; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(''); const [name, setName] = useState('');
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id || ''); const [companyId, setCompanyId] = useState(companies[0]?.id || '');
  const [locationType, setLocationType] = useState('OUTLET'); const [saving, setSaving] = useState(false); const [error, setError] = useState('');

  async function save(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setError('');
    try {
      if (type === 'workspace') await api('/api/master/workspaces', { method: 'POST', body: JSON.stringify({ code, name }) });
      if (type === 'company') await api('/api/master/companies', { method: 'POST', body: JSON.stringify({ workspaceId, code, name }) });
      if (type === 'location') await api('/api/master/locations', { method: 'POST', body: JSON.stringify({ companyId, code, name, locationType }) });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Gagal menyimpan'); }
    finally { setSaving(false); }
  }

  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal-card" onSubmit={save} onMouseDown={e => e.stopPropagation()}>
    <div><span className="eyebrow">TAMBAH MASTER</span><h3>{type === 'workspace' ? 'Client / Workspace' : type === 'company' ? 'Company' : 'Location'}</h3></div>
    {type === 'company' && <label>Client / Workspace<select value={workspaceId} onChange={e => setWorkspaceId(e.target.value)}>{workspaces.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
    {type === 'location' && <><label>Company<select value={companyId} onChange={e => setCompanyId(e.target.value)}>{companies.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>Tipe Location<select value={locationType} onChange={e => setLocationType(e.target.value)}>{Object.entries(locationLabel).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label></>}
    <label>Kode<input value={code} onChange={e => setCode(e.target.value)} placeholder="Contoh: MN"/></label><label>Nama<input value={name} onChange={e => setName(e.target.value)} placeholder="Nama lengkap"/></label>
    {error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Batal</button><button className="primary-button" disabled={saving}>{saving ? 'Menyimpan...' : 'Simpan'}</button></div>
  </form></div>;
}
