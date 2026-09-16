import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Plus, Search, ShieldCheck, UserCog, UserRoundCheck, UserRoundX } from 'lucide-react';
import { api } from './api';

type Role = { id: string; code: string; name: string; side: 'CLIENT' | 'AKUNTAKITA' | 'SYSTEM' };
type Workspace = { id: string; code: string; name: string; status: string };
type Company = { id: string; workspace_id: string; code: string; name: string; status: string };
type Location = { id: string; company_id: string; code: string; name: string; location_type: string; status: string };
type Membership = {
  id: string;
  status: 'ACTIVE' | 'INACTIVE';
  workspaceId: string;
  workspaceName: string;
  companyId: string | null;
  companyName: string | null;
  locationId: string | null;
  locationName: string | null;
  roleId: string;
  roleCode: string;
  roleName: string;
  side: string;
};
type AccessUser = {
  id: string;
  email: string;
  fullName: string;
  status: 'ACTIVE' | 'INACTIVE' | 'LOCKED';
  isSystemAdmin: boolean;
  memberships: Membership[];
};

type AccessDraft = {
  workspaceId: string;
  roleId: string;
  companyId: string;
  locationId: string;
};

const emptyAccess: AccessDraft = { workspaceId: '', roleId: '', companyId: '', locationId: '' };

function messageFor(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  const map: Record<string, string> = {
    EMAIL_ALREADY_EXISTS: 'Email sudah terdaftar di sistem.',
    PASSWORD_TOO_SHORT: 'Password minimal 8 karakter.',
    MEMBERSHIP_ALREADY_EXISTS: 'Akses yang sama sudah dimiliki user ini.',
    LOCATION_OUTSIDE_COMPANY: 'Location tidak sesuai dengan company.',
    COMPANY_OUTSIDE_WORKSPACE: 'Company tidak sesuai dengan client/workspace.',
    FORBIDDEN: 'Akun ini tidak memiliki hak untuk mengubah akses tersebut.',
    CANNOT_DISABLE_SELF: 'Akun yang sedang digunakan tidak dapat dinonaktifkan sendiri.',
    CANNOT_DISABLE_OWN_ADMIN_ACCESS: 'Akses admin yang sedang digunakan tidak dapat dinonaktifkan sendiri.',
  };
  return map[code] || code.replaceAll('_', ' ');
}

export function UserAccessCenter() {
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'create' | 'edit' | 'access' | 'password' | null>(null);
  const [selected, setSelected] = useState<AccessUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true); setError('');
    try {
      const [userRows, roleRows, workspaceRows, companyRows, locationRows] = await Promise.all([
        api<AccessUser[]>('/api/access/users'),
        api<Role[]>('/api/access/roles'),
        api<Workspace[]>('/api/master/workspaces'),
        api<Company[]>('/api/master/companies'),
        api<Location[]>('/api/master/locations'),
      ]);
      setUsers(userRows); setRoles(roleRows); setWorkspaces(workspaceRows); setCompanies(companyRows); setLocations(locationRows);
    } catch (err) {
      setError(messageFor(err));
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(user => `${user.fullName} ${user.email} ${user.memberships.map(m => `${m.workspaceName} ${m.companyName || ''} ${m.locationName || ''} ${m.roleName}`).join(' ')}`.toLowerCase().includes(q));
  }, [users, search]);

  function open(modeValue: typeof mode, user: AccessUser | null = null) {
    setSelected(user); setMode(modeValue);
  }

  return <div className="page-content access-page">
    <section className="section-card">
      <div className="section-title master-heading">
        <div>
          <span className="eyebrow">USER · ROLE · SCOPE</span>
          <h3>User & Hak Akses</h3>
          <p>Atur siapa yang boleh mengakses Client, Company, dan Location. Data antar-client dipisahkan dari level API.</p>
        </div>
        <button className="primary-button compact" onClick={() => open('create')}><Plus size={16}/> Tambah User</button>
      </div>

      <div className="access-security-note"><ShieldCheck size={18}/><div><strong>Tenant isolation aktif</strong><span>User hanya dapat melihat data pada workspace/company/location yang ditugaskan.</span></div></div>

      <div className="table-toolbar">
        <div className="search-box"><Search size={16}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cari user, client, role..."/></div>
        <span>{filtered.length} user</span>
      </div>

      {error && <div className="form-error">{error}</div>}
      {loading ? <div className="empty-state">Memuat user & akses...</div> : <div className="access-user-list">
        {filtered.map(user => <article className="access-user-card" key={user.id}>
          <div className="access-user-head">
            <div className="access-avatar">{user.fullName.slice(0,1).toUpperCase()}</div>
            <div className="access-user-identity"><strong>{user.fullName}</strong><span>{user.email}</span></div>
            <span className={user.status === 'ACTIVE' ? 'status-ok' : 'status-muted'}>{user.status === 'ACTIVE' ? 'Aktif' : user.status}</span>
            {user.isSystemAdmin && <span className="access-system-badge">System Admin</span>}
            <div className="access-actions">
              <button className="secondary-button compact" onClick={() => open('edit', user)}><UserCog size={15}/> Edit</button>
              <button className="secondary-button compact" onClick={() => open('access', user)}><Plus size={15}/> Akses</button>
              <button className="secondary-button compact" onClick={() => open('password', user)}><KeyRound size={15}/></button>
            </div>
          </div>
          <div className="membership-list">
            {user.isSystemAdmin && user.memberships.length === 0 && <div className="membership-row system"><div><strong>Seluruh Sistem</strong><span>Semua client, company, location dan modul.</span></div></div>}
            {user.memberships.map(m => <div className={`membership-row ${m.status === 'INACTIVE' ? 'inactive' : ''}`} key={m.id}>
              <div className="membership-role"><strong>{m.roleName}</strong><span>{m.side}</span></div>
              <div className="membership-scope"><b>{m.workspaceName}</b><span>{m.companyName || 'Semua Company'} · {m.locationName || 'Semua Location'}</span></div>
              <button
                className="membership-toggle"
                title={m.status === 'ACTIVE' ? 'Nonaktifkan akses' : 'Aktifkan akses'}
                onClick={async () => {
                  try {
                    await api(`/api/access/memberships/${m.id}`, { method: 'PATCH', body: JSON.stringify({ status: m.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }) });
                    await load();
                  } catch (err) { setError(messageFor(err)); }
                }}
              >{m.status === 'ACTIVE' ? <UserRoundCheck size={18}/> : <UserRoundX size={18}/>} {m.status === 'ACTIVE' ? 'Aktif' : 'Nonaktif'}</button>
            </div>)}
            {!user.isSystemAdmin && user.memberships.length === 0 && <div className="membership-empty">Belum memiliki akses ke client.</div>}
          </div>
        </article>)}
        {filtered.length === 0 && <div className="empty-state"><UserCog size={34}/><strong>Tidak ada user yang cocok</strong><span>Coba kata pencarian lain atau tambah user baru.</span></div>}
      </div>}
    </section>

    {mode === 'create' && <CreateUserModal roles={roles} workspaces={workspaces} companies={companies} locations={locations} onClose={() => setMode(null)} onSaved={async () => { setMode(null); await load(); }}/>} 
    {mode === 'edit' && selected && <EditUserModal user={selected} onClose={() => setMode(null)} onSaved={async () => { setMode(null); await load(); }}/>} 
    {mode === 'access' && selected && <AddAccessModal user={selected} roles={roles} workspaces={workspaces} companies={companies} locations={locations} onClose={() => setMode(null)} onSaved={async () => { setMode(null); await load(); }}/>} 
    {mode === 'password' && selected && <ResetPasswordModal user={selected} onClose={() => setMode(null)} onSaved={() => setMode(null)}/>} 
  </div>;
}

function AccessFields({ value, setValue, roles, workspaces, companies, locations }: {
  value: AccessDraft; setValue: (value: AccessDraft) => void; roles: Role[]; workspaces: Workspace[]; companies: Company[]; locations: Location[];
}) {
  const availableCompanies = companies.filter(x => x.workspace_id === value.workspaceId);
  const availableLocations = locations.filter(x => !value.companyId || x.company_id === value.companyId);
  return <>
    <label>Client / Workspace<select required value={value.workspaceId} onChange={e => setValue({ ...value, workspaceId: e.target.value, companyId: '', locationId: '' })}><option value="">Pilih client</option>{workspaces.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
    <label>Role<select required value={value.roleId} onChange={e => setValue({ ...value, roleId: e.target.value })}><option value="">Pilih role</option><optgroup label="Akuntakita">{roles.filter(x => x.side === 'AKUNTAKITA').map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup><optgroup label="Client">{roles.filter(x => x.side === 'CLIENT').map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup></select></label>
    <label>Company <small>(opsional)</small><select value={value.companyId} disabled={!value.workspaceId} onChange={e => setValue({ ...value, companyId: e.target.value, locationId: '' })}><option value="">Semua Company</option>{availableCompanies.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
    <label>Location / Outlet <small>(opsional)</small><select value={value.locationId} disabled={!value.companyId} onChange={e => setValue({ ...value, locationId: e.target.value })}><option value="">Semua Location</option>{availableLocations.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
  </>;
}

function CreateUserModal({ roles, workspaces, companies, locations, onClose, onSaved }: {
  roles: Role[]; workspaces: Workspace[]; companies: Company[]; locations: Location[]; onClose: () => void; onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(''); const [email, setEmail] = useState(''); const [temporaryPassword, setTemporaryPassword] = useState('');
  const [access, setAccess] = useState<AccessDraft>(emptyAccess); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setError('');
    try {
      await api('/api/access/users', { method: 'POST', body: JSON.stringify({ fullName, email, temporaryPassword, ...access }) });
      onSaved();
    } catch (err) { setError(messageFor(err)); } finally { setSaving(false); }
  }
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal-card access-modal" onSubmit={save} onMouseDown={e => e.stopPropagation()}>
    <div><span className="eyebrow">USER BARU</span><h3>Tambah User & Akses Awal</h3><p className="modal-caption">Password sementara dapat diganti sendiri oleh user dari menu Pengaturan.</p></div>
    <div className="access-form-grid"><label>Nama Lengkap<input required value={fullName} onChange={e => setFullName(e.target.value)}/></label><label>Email<input required type="email" value={email} onChange={e => setEmail(e.target.value)}/></label><label className="span-2">Password Sementara<input required minLength={8} type="password" value={temporaryPassword} onChange={e => setTemporaryPassword(e.target.value)} placeholder="Minimal 8 karakter"/></label><AccessFields value={access} setValue={setAccess} roles={roles} workspaces={workspaces} companies={companies} locations={locations}/></div>
    {error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Batal</button><button className="primary-button" disabled={saving}>{saving ? 'Menyimpan...' : 'Buat User'}</button></div>
  </form></div>;
}

function AddAccessModal({ user, roles, workspaces, companies, locations, onClose, onSaved }: {
  user: AccessUser; roles: Role[]; workspaces: Workspace[]; companies: Company[]; locations: Location[]; onClose: () => void; onSaved: () => void;
}) {
  const [access, setAccess] = useState<AccessDraft>(emptyAccess); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setError('');
    try { await api(`/api/access/users/${user.id}/memberships`, { method: 'POST', body: JSON.stringify(access) }); onSaved(); }
    catch (err) { setError(messageFor(err)); } finally { setSaving(false); }
  }
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal-card access-modal" onSubmit={save} onMouseDown={e => e.stopPropagation()}><div><span className="eyebrow">TAMBAH AKSES</span><h3>{user.fullName}</h3><p className="modal-caption">Satu user dapat mempunyai beberapa role/scope pada client yang berbeda.</p></div><div className="access-form-grid"><AccessFields value={access} setValue={setAccess} roles={roles} workspaces={workspaces} companies={companies} locations={locations}/></div>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Batal</button><button className="primary-button" disabled={saving}>{saving ? 'Menyimpan...' : 'Tambah Akses'}</button></div></form></div>;
}

function EditUserModal({ user, onClose, onSaved }: { user: AccessUser; onClose: () => void; onSaved: () => void }) {
  const [fullName, setFullName] = useState(user.fullName); const [status, setStatus] = useState(user.status); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  async function save(e: React.FormEvent) { e.preventDefault(); setSaving(true); setError(''); try { await api(`/api/access/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ fullName, status }) }); onSaved(); } catch (err) { setError(messageFor(err)); } finally { setSaving(false); } }
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal-card" onSubmit={save} onMouseDown={e => e.stopPropagation()}><div><span className="eyebrow">EDIT USER</span><h3>{user.email}</h3></div><label>Nama Lengkap<input required value={fullName} onChange={e => setFullName(e.target.value)}/></label><label>Status<select value={status} onChange={e => setStatus(e.target.value as AccessUser['status'])}><option value="ACTIVE">Aktif</option><option value="INACTIVE">Nonaktif</option><option value="LOCKED">Dikunci</option></select></label>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Batal</button><button className="primary-button" disabled={saving}>{saving ? 'Menyimpan...' : 'Simpan'}</button></div></form></div>;
}

function ResetPasswordModal({ user, onClose, onSaved }: { user: AccessUser; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [success, setSuccess] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault(); setError(''); setSuccess('');
    if (password !== confirm) return setError('Konfirmasi password belum sama.');
    setSaving(true);
    try { await api(`/api/access/users/${user.id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword: password }) }); setSuccess('Password sementara berhasil diperbarui.'); setTimeout(onSaved, 700); }
    catch (err) { setError(messageFor(err)); } finally { setSaving(false); }
  }
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal-card" onSubmit={save} onMouseDown={e => e.stopPropagation()}><div><span className="eyebrow">RESET PASSWORD</span><h3>{user.fullName}</h3><p className="modal-caption">Gunakan hanya saat user tidak dapat masuk. User dapat menggantinya lagi setelah login.</p></div><label>Password Baru<input required minLength={8} type="password" value={password} onChange={e => setPassword(e.target.value)}/></label><label>Konfirmasi<input required minLength={8} type="password" value={confirm} onChange={e => setConfirm(e.target.value)}/></label>{error && <div className="form-error">{error}</div>}{success && <div className="form-success">{success}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Batal</button><button className="primary-button" disabled={saving}>{saving ? 'Menyimpan...' : 'Reset Password'}</button></div></form></div>;
}
