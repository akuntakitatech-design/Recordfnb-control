import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, Pencil, Plus } from 'lucide-react';
import { api, messageOf } from '../api';
import { Modal } from '../components/Modal';
import { StatusBadge } from './Organization';
import { ROLES, ROLE_LABEL, type AppUser, type Role, type Session, type Unit } from '../types';

const GLOBAL_ROLES = new Set<Role>(['PIMPINAN', 'ADMIN_YAYASAN', 'FINANCE_PUSAT', 'ACCOUNTING_PUSAT', 'AUDITOR']);

type Form = {
  fullName: string;
  email: string;
  password: string;
  role: Role;
  status: 'ACTIVE' | 'INACTIVE';
  unitIds: string[];
};

const EMPTY: Form = { fullName: '', email: '', password: '', role: 'BENDAHARA_CABANG', status: 'ACTIVE', unitIds: [] };

export function Users({ session }: { session: Session }) {
  const [rows, setRows] = useState<AppUser[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [editing, setEditing] = useState<AppUser | 'new' | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [userList, unitList] = await Promise.all([
        api<AppUser[]>('/api/v1/users'),
        api<{ rows: Unit[] }>('/api/v1/organization/units?pageSize=100'),
      ]);
      setRows(userList);
      setUnits(unitList.rows);
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const isGlobal = useMemo(() => GLOBAL_ROLES.has(form.role), [form.role]);

  function openCreate() {
    setForm(EMPTY);
    setFormError('');
    setEditing('new');
  }

  function openEdit(user: AppUser) {
    setForm({
      fullName: user.full_name,
      email: user.email,
      password: '',
      role: user.role,
      status: user.status,
      unitIds: user.units.map(unit => unit.unit_id),
    });
    setFormError('');
    setEditing(user);
  }

  function toggleUnit(unitId: string) {
    setForm(current => ({
      ...current,
      unitIds: current.unitIds.includes(unitId)
        ? current.unitIds.filter(id => id !== unitId)
        : [...current.unitIds, unitId],
    }));
  }

  async function resetPassword(user: AppUser) {
    const temporary = window.prompt(
      `Password sementara untuk ${user.email} (minimal 8 karakter).\nPengguna wajib menggantinya saat login berikutnya.`,
    );
    if (temporary === null) return;
    if (temporary.length < 8) { setError('Password sementara minimal 8 karakter.'); return; }
    try {
      await api(`/api/v1/users/${user.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ password: temporary }),
      });
      setError('');
      setNotice(
        `Password ${user.email} direset. Sampaikan password sementara secara langsung; `
        + 'pengguna wajib menggantinya saat login.',
      );
    } catch (resetError) {
      setError(messageOf(resetError));
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      if (editing === 'new') {
        await api('/api/v1/users', {
          method: 'POST',
          body: JSON.stringify({
            fullName: form.fullName,
            email: form.email,
            password: form.password,
            role: form.role,
            unitIds: isGlobal ? [] : form.unitIds,
          }),
        });
        setNotice('Pengguna dibuat.');
      } else if (editing) {
        await api(`/api/v1/users/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            fullName: form.fullName,
            role: form.role,
            status: form.status,
            password: form.password || undefined,
          }),
        });
        await api(`/api/v1/users/${editing.id}/units`, {
          method: 'PUT',
          body: JSON.stringify({ unitIds: isGlobal ? [] : form.unitIds }),
        });
        setNotice('Pengguna diperbarui.');
      }
      setEditing(null);
      await load();
    } catch (saveError) {
      setFormError(messageOf(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="card">
        <div className="toolbar">
          <span className="cell-muted">{rows.length} pengguna</span>
          <div className="spacer" />
          <button type="button" className="primary-button" onClick={openCreate} data-testid="user-add">
            <Plus size={16} /> Tambah Pengguna
          </button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nama</th>
                <th>Email</th>
                <th>Role</th>
                <th>Scope unit</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(user => (
                <tr key={user.id}>
                  <td className="cell-strong">
                    {user.full_name}
                    {user.id === session.user.id && <span className="badge brand" style={{ marginLeft: 6 }}>Anda</span>}
                  </td>
                  <td className="cell-muted">{user.email}</td>
                  <td><span className="badge info">{ROLE_LABEL[user.role] || user.role}</span></td>
                  <td className="cell-muted">
                    {GLOBAL_ROLES.has(user.role) ? 'Semua unit' : (user.units.map(unit => unit.unit_code).join(', ') || '—')}
                  </td>
                  <td><StatusBadge value={user.status} /></td>
                  <td>
                    <div className="cell-actions">
                      <button type="button" className="link-button" onClick={() => openEdit(user)}>
                        <Pencil size={14} /> Edit
                      </button>
                      <button type="button" className="link-button" onClick={() => void resetPassword(user)}>
                        <KeyRound size={14} /> Reset password
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && rows.length === 0 && <div className="table-empty">Belum ada pengguna.</div>}
          {loading && <div className="table-empty">Memuat pengguna…</div>}
        </div>
      </section>

      {editing && (
        <Modal title={editing === 'new' ? 'Tambah Pengguna' : `Edit Pengguna — ${editing.full_name}`} onClose={() => setEditing(null)} maxWidth={720}>
          <form onSubmit={save}>
            <div className="form-grid">
              <label className="field">Nama lengkap
                <input className="input" value={form.fullName} onChange={event => setForm({ ...form, fullName: event.target.value })} required />
              </label>
              <label className="field">Email
                <input
                  className="input"
                  type="email"
                  value={form.email}
                  onChange={event => setForm({ ...form, email: event.target.value })}
                  disabled={editing !== 'new'}
                  required
                />
              </label>
              <label className="field">Role
                <select className="select" value={form.role} onChange={event => setForm({ ...form, role: event.target.value as Role })}>
                  {ROLES.map(role => <option key={role} value={role}>{ROLE_LABEL[role]}</option>)}
                </select>
              </label>
              <label className="field">{editing === 'new' ? 'Password' : 'Password baru (opsional)'}
                <input
                  className="input"
                  type="password"
                  value={form.password}
                  onChange={event => setForm({ ...form, password: event.target.value })}
                  required={editing === 'new'}
                  placeholder="Minimal 8 karakter"
                />
              </label>
              {editing !== 'new' && (
                <label className="field">Status
                  <select className="select" value={form.status} onChange={event => setForm({ ...form, status: event.target.value as Form['status'] })}>
                    <option value="ACTIVE">Aktif</option>
                    <option value="INACTIVE">Nonaktif</option>
                  </select>
                </label>
              )}

              <div className="full">
                <div className="notice">
                  {isGlobal
                    ? 'Role pusat memiliki akses ke seluruh unit.'
                    : 'Role cabang wajib memiliki minimal satu unit. Pilih unit yang boleh diakses.'}
                </div>
              </div>

              {!isGlobal && (
                <div className="full">
                  <div className="field" style={{ marginBottom: 8 }}>Scope unit</div>
                  <div className="unit-options">
                    {units.map(unit => (
                      <label key={unit.id} className={`unit-option ${form.unitIds.includes(unit.id) ? 'selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={form.unitIds.includes(unit.id)}
                          onChange={() => toggleUnit(unit.id)}
                        />
                        <span>
                          <strong>{unit.unit_name}</strong>
                          <small>{unit.unit_code} · {unit.level_name}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {formError && <div className="form-error">{formError}</div>}
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setEditing(null)}>Batal</button>
              <button type="submit" className="primary-button" disabled={saving} data-testid="user-save">
                {saving ? 'Menyimpan…' : 'Simpan'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
