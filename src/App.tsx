import { useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  Building2,
  ChevronRight,
  CircleDollarSign,
  Database,
  Landmark,
  LogOut,
  MapPin,
  PackageSearch,
  ReceiptText,
  Search,
  Settings2,
  ShieldCheck,
  Store,
  Users,
} from 'lucide-react';
import { api } from './api';
import { MasterItemCenter } from './MasterItemCenter';
import { MasterFinanceCenter } from './MasterFinanceCenter';
import { TransactionForm } from './TransactionForm';

type Session = {
  user: { id: string; email: string; fullName: string };
  memberships: Array<{
    workspace_id: string;
    workspace_name: string;
    company_id: string | null;
    company_name: string | null;
    location_id: string | null;
    location_name: string | null;
    role_code: string;
    role_name: string;
    side: 'CLIENT' | 'AKUNTAKITA' | 'SYSTEM';
  }>;
};

type Summary = { workspaces: number; companies: number; locations: number; items: number; partners: number; transactions: number };
type Workspace = { id: string; code: string; name: string; status: string };
type Company = { id: string; workspace_id: string; code: string; name: string; status: string; workspace_name?: string };
type Location = { id: string; company_id: string; code: string; name: string; location_type: string; status: string; company_name?: string };
type Page = 'dashboard' | 'organization' | 'items' | 'finance' | 'transactions';
type OrganizationTab = 'workspace' | 'company' | 'location';

const locationLabel: Record<string, string> = {
  HEAD_OFFICE: 'Head Office', OUTLET: 'Outlet', CENTRAL_KITCHEN: 'Central Kitchen', WAREHOUSE: 'Warehouse',
  PRODUCTION_KITCHEN: 'Production Kitchen', CLOUD_KITCHEN: 'Cloud Kitchen', BOOTH: 'Booth', OTHER: 'Lainnya',
};

const pageTitles: Record<Page, string> = {
  dashboard: 'Dashboard', organization: 'Master Organisasi', items: 'Barang & Inventory',
  finance: 'Finance & Accounting Master', transactions: 'Transaksi',
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
    <section className="login-card-wrap"><form className="login-card" onSubmit={submit}>
      <div className="logo-mark">A</div><div><h2>Masuk ke sistem</h2><p>Gunakan akun Finance Client atau Akuntakita.</p></div>
      <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="nama@perusahaan.com" autoFocus/></label>
      <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••"/></label>
      {error && <div className="form-error">{error}</div>}
      <button className="primary-button" disabled={loading}>{loading ? 'Memeriksa...' : 'Masuk'}</button><small>Foundation v0.3 · Development</small>
    </form></section>
  </main>;
}

function Metric({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return <div className="metric-card"><div className="metric-icon">{icon}</div><div><strong>{value}</strong><span>{label}</span></div></div>;
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [active, setActive] = useState<Page>('dashboard');

  async function refreshSession() { try { setSession(await api<Session>('/api/auth/me')); } catch { setSession(null); } }
  useEffect(() => { void refreshSession(); }, []);
  useEffect(() => { if (session) api<Summary>('/api/foundation/summary').then(setSummary).catch(() => setSummary(null)); }, [session, active]);

  async function logout() { await api('/api/auth/logout', { method: 'POST' }); setSession(null); }

  const portal = useMemo(() => {
    const sides = new Set(session?.memberships.map(x => x.side));
    if (sides.has('AKUNTAKITA')) return 'Accounting Workspace';
    if (sides.has('CLIENT')) return 'Finance Control Panel';
    return 'Foundation Admin';
  }, [session]);

  if (session === undefined) return <div className="loading-screen">Memuat sistem...</div>;
  if (!session) return <Login onLogin={refreshSession}/>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="sidebar-brand"><div className="logo-mark small">A</div><div><strong>AKUNTAKITA</strong><span>F&B Control</span></div></div>
      <div className="portal-badge">{portal}</div>
      <nav>
        <button className={active === 'dashboard' ? 'active' : ''} onClick={() => setActive('dashboard')}><Store size={18}/> Dashboard</button>
        <button className={active === 'organization' ? 'active' : ''} onClick={() => setActive('organization')}><Building2 size={18}/> Organisasi</button>
        <button className={active === 'items' ? 'active' : ''} onClick={() => setActive('items')}><Boxes size={18}/> Barang & Inventory</button>
        <button className={active === 'finance' ? 'active' : ''} onClick={() => setActive('finance')}><Landmark size={18}/> Finance Master</button>
        <button className={active === 'transactions' ? 'active' : ''} onClick={() => setActive('transactions')}><ReceiptText size={18}/> Transaksi</button>
        <button disabled><ShieldCheck size={18}/> Control Center <span className="soon">Next</span></button>
        <button disabled><Settings2 size={18}/> Pengaturan <span className="soon">Next</span></button>
      </nav>
      <button className="logout-button" onClick={logout}><LogOut size={18}/> Keluar</button>
    </aside>

    <section className="content-shell">
      <header className="topbar"><div><span className="eyebrow">FOUNDATION v0.3</span><h2>{pageTitles[active]}</h2></div><div className="user-box"><div className="avatar">{session.user.fullName.slice(0,1).toUpperCase()}</div><div><strong>{session.user.fullName}</strong><span>{session.user.email}</span></div></div></header>
      {active === 'dashboard' && <Dashboard summary={summary} setActive={setActive}/>} 
      {active === 'organization' && <OrganizationMaster/>}
      {active === 'items' && <MasterItemCenter/>}
      {active === 'finance' && <MasterFinanceCenter/>}
      {active === 'transactions' && <TransactionForm/>}
    </section>
  </div>;
}

function Dashboard({ summary, setActive }: { summary: Summary | null; setActive: (v: Page) => void }) {
  return <div className="page-content">
    <section className="hero-panel"><div><span className="eyebrow">PONDASI SISTEM</span><h1>Master rapi, transaksi satu kali.</h1><p>Foundation menghubungkan client, company, location, item, finance master dan transaksi multi-baris sebagai dasar Finance Control → Accounting.</p></div><button className="primary-button compact" onClick={() => setActive('transactions')}>Coba Form Transaksi <ChevronRight size={17}/></button></section>
    <div className="metrics-grid"><Metric icon={<Users/>} value={summary?.workspaces ?? 0} label="Client / Workspace"/><Metric icon={<Building2/>} value={summary?.companies ?? 0} label="Company"/><Metric icon={<MapPin/>} value={summary?.locations ?? 0} label="Location"/><Metric icon={<PackageSearch/>} value={summary?.items ?? 0} label="Item"/></div>
    <section className="section-card"><div className="section-title"><div><span className="eyebrow">FOUNDATION v0.3</span><h3>Yang sudah hidup</h3></div></div><div className="foundation-list">
      <div><b>01</b><span><strong>Multi-client, company & location</strong><small>Outlet, Central Kitchen, gudang, HO, production kitchen dan struktur cabang.</small></span></div>
      <div><b>02</b><span><strong>Master Data Center</strong><small>Item, kategori, satuan, relasi bisnis, COA, kas/bank, settlement, cost center dan pajak.</small></span></div>
      <div><b>03</b><span><strong>Generic multi-line transaction</strong><small>Multi-item / multi-account, diskon persen atau nominal, pajak per baris dan dimensi per baris.</small></span></div>
      <div><b>04</b><span><strong>Finance → Accounting foundation</strong><small>Transaksi sumber disimpan sekali dan status accounting berdiri terpisah dari status operasional.</small></span></div>
    </div></section>
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
    <div className="section-title master-heading"><div><span className="eyebrow">MASTER DATA CENTER</span><h3>Struktur Organisasi</h3><p>Client / Workspace → Company → Location. Tidak dikunci untuk satu outlet atau satu Central Kitchen.</p></div><button className="primary-button compact" onClick={() => setShowForm(true)}>+ Tambah</button></div>
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
