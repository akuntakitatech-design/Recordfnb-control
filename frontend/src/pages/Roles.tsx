import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api, messageOf } from '../api';
import { Modal } from '../components/Modal';
import { StatusBadge } from './Organization';
import type { Permission, PermissionCatalog, RoleDetail, RoleRow, Session } from '../types';

type Form = {
  code: string;
  name: string;
  description: string;
  isGlobal: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  permissions: string[];
};

const EMPTY: Form = { code: '', name: '', description: '', isGlobal: false, status: 'ACTIVE', permissions: [] };

/**
 * Role & kewenangan.
 *
 * Daftar kewenangan mengikuti fitur aplikasi (katalog dari server), sehingga
 * begitu ada fitur baru, centangannya otomatis muncul di sini.
 */
export function Roles({ session }: { session: Session }) {
  const can = (permission: Permission) => session.permissions.includes(permission);

  const [rows, setRows] = useState<RoleRow[]>([]);
  const [catalog, setCatalog] = useState<PermissionCatalog>({ total: 0, groups: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [editing, setEditing] = useState<RoleDetail | 'new' | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<RoleRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [roles, permissions] = await Promise.all([
        api<RoleRow[]>('/api/v1/roles'),
        api<PermissionCatalog>('/api/v1/permissions'),
      ]);
      setRows(roles);
      setCatalog(permissions);
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => new Set(form.permissions), [form.permissions]);

  function openCreate() {
    setForm(EMPTY);
    setFormError('');
    setEditing('new');
  }

  async function openEdit(row: RoleRow) {
    try {
      const detail = await api<RoleDetail>(`/api/v1/roles/${row.id}`);
      setForm({
        code: detail.code,
        name: detail.name,
        description: detail.description || '',
        isGlobal: detail.is_global,
        status: detail.status,
        permissions: detail.permissions,
      });
      setFormError('');
      setEditing(detail);
    } catch (detailError) {
      setError(messageOf(detailError));
    }
  }

  function togglePermission(code: string) {
    setForm(current => ({
      ...current,
      permissions: current.permissions.includes(code)
        ? current.permissions.filter(item => item !== code)
        : [...current.permissions, code],
    }));
  }

  function toggleGroup(codes: string[]) {
    setForm(current => {
      const allChecked = codes.every(code => current.permissions.includes(code));
      return {
        ...current,
        permissions: allChecked
          ? current.permissions.filter(code => !codes.includes(code))
          : [...new Set([...current.permissions, ...codes])],
      };
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      if (editing === 'new') {
        const created = await api<RoleRow>('/api/v1/roles', {
          method: 'POST',
          body: JSON.stringify({
            code: form.code || undefined,
            name: form.name,
            description: form.description || null,
            isGlobal: form.isGlobal,
            permissions: form.permissions,
          }),
        });
        setNotice(`Role ${created.name} dibuat dengan ${form.permissions.length} kewenangan.`);
      } else if (editing) {
        await api<RoleDetail>(`/api/v1/roles/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: form.name,
            description: form.description || null,
            isGlobal: form.isGlobal,
            status: form.status,
            permissions: form.permissions,
          }),
        });
        setNotice(`Role ${form.name} diperbarui (${form.permissions.length} kewenangan).`);
      }
      setEditing(null);
      await load();
    } catch (saveError) {
      setFormError(messageOf(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await api(`/api/v1/roles/${deleting.id}`, { method: 'DELETE', body: JSON.stringify({}) });
      setNotice(`Role ${deleting.name} dihapus.`);
      setDeleting(null);
      await load();
    } catch (deleteError) {
      setError(messageOf(deleteError));
      setDeleting(null);
    }
  }

  const isSystem = editing !== 'new' && editing !== null && editing.is_system;

  return (
    <div className="stack">
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="card">
        <div className="toolbar">
          <div>
            <strong>Role & kewenangan</strong>
            <div className="cell-muted">
              {rows.length} role · {catalog.total} kewenangan mengikuti fitur aplikasi
            </div>
          </div>
          <div className="spacer" />
          {can('role.manage') && (
            <button type="button" className="primary-button" onClick={openCreate} data-testid="role-add">
              <Plus size={16} /> Tambah Role
            </button>
          )}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Kode</th>
                <th>Cakupan unit</th>
                <th style={{ textAlign: 'right' }}>Kewenangan</th>
                <th style={{ textAlign: 'right' }}>Pengguna</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} data-testid={`role-row-${row.code}`}>
                  <td>
                    <div className="cell-strong">{row.name}</div>
                    {row.description && <div className="cell-muted">{row.description}</div>}
                  </td>
                  <td className="cell-muted">{row.code}</td>
                  <td className="cell-muted">{row.is_global ? 'Semua unit' : 'Unit pengguna'}</td>
                  <td style={{ textAlign: 'right' }}>{row.permission_count}</td>
                  <td style={{ textAlign: 'right' }}>{row.user_count}</td>
                  <td>
                    <StatusBadge value={row.status} />
                    {row.is_system && <div className="cell-muted">bawaan</div>}
                  </td>
                  <td>
                    <div className="cell-actions">
                      {can('role.manage') && (
                        <button type="button" className="link-button" onClick={() => void openEdit(row)}
                          data-testid={`role-edit-${row.code}`}>
                          <Pencil size={14} /> Edit
                        </button>
                      )}
                      {can('role.manage') && !row.is_system && (
                        <button type="button" className="link-button danger" onClick={() => setDeleting(row)}
                          data-testid={`role-delete-${row.code}`}>
                          <Trash2 size={14} /> Hapus
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && rows.length === 0 && <div className="table-empty">Belum ada role.</div>}
          {loading && <div className="table-empty">Memuat role…</div>}
        </div>
      </section>

      {editing && (
        <Modal
          title={editing === 'new' ? 'Tambah Role' : `Kewenangan — ${editing.name}`}
          onClose={() => setEditing(null)}
          maxWidth={880}
        >
          <form onSubmit={save}>
            <div className="form-grid">
              <label className="field">Nama jabatan
                <input className="input" value={form.name} required data-testid="role-name"
                  onChange={event => setForm({ ...form, name: event.target.value })}
                  placeholder="Contoh: Staf Gudang" />
              </label>
              <label className="field">Kode
                <input className="input" value={form.code} disabled={editing !== 'new'}
                  onChange={event => setForm({ ...form, code: event.target.value })}
                  placeholder="Otomatis dari nama" />
                <span className="form-hint">
                  {editing === 'new' ? 'Boleh dikosongkan — dibuat otomatis.' : 'Kode tidak bisa diubah.'}
                </span>
              </label>
              <label className="field">Deskripsi
                <input className="input" value={form.description}
                  onChange={event => setForm({ ...form, description: event.target.value })}
                  placeholder="Tugas singkat jabatan ini" />
              </label>
              {editing !== 'new' && (
                <label className="field">Status
                  <select className="select" value={form.status} disabled={isSystem}
                    onChange={event => setForm({ ...form, status: event.target.value as Form['status'] })}>
                    <option value="ACTIVE">Aktif</option>
                    <option value="INACTIVE">Nonaktif</option>
                  </select>
                  {isSystem && <span className="form-hint">Role bawaan selalu aktif.</span>}
                </label>
              )}
              <div className="full">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
                  <input type="checkbox" checked={form.isGlobal} disabled={isSystem}
                    data-testid="role-global"
                    onChange={event => setForm({ ...form, isGlobal: event.target.checked })} />
                  Akses ke semua unit (role pusat)
                </label>
                <span className="form-hint">
                  {form.isGlobal
                    ? 'Pengguna role ini tidak perlu dibatasi per unit.'
                    : 'Pengguna role ini wajib diberi minimal satu unit.'}
                  {isSystem && ' Cakupan role bawaan tidak bisa diubah.'}
                </span>
              </div>
            </div>

            <div style={{ marginTop: 18 }}>
              <div className="toolbar" style={{ padding: '0 0 10px', borderBottom: '1px solid var(--line)' }}>
                <ShieldCheck size={16} />
                <strong>Kewenangan</strong>
                <span className="cell-muted">{form.permissions.length} dari {catalog.total} dipilih</span>
                <div className="spacer" />
                <button type="button" className="ghost-button"
                  onClick={() => setForm({ ...form, permissions: catalog.groups.flatMap(group => group.permissions.map(item => item.code)) })}>
                  <Check size={14} /> Pilih semua
                </button>
                <button type="button" className="link-button danger" onClick={() => setForm({ ...form, permissions: [] })}>
                  Kosongkan
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}>
                {catalog.groups.map(group => {
                  const codes = group.permissions.map(item => item.code);
                  const allChecked = codes.every(code => selected.has(code));
                  return (
                    <div key={group.group}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <strong style={{ fontSize: 13 }}>{group.group}</strong>
                        <button type="button" className="link-button" onClick={() => toggleGroup(codes)}>
                          {allChecked ? 'lepas semua' : 'pilih semua'}
                        </button>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 6 }}>
                        {group.permissions.map(item => (
                          <label key={item.code} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, fontWeight: 400 }}>
                            <input type="checkbox" checked={selected.has(item.code)}
                              data-testid={`perm-${item.code}`}
                              onChange={() => togglePermission(item.code)} style={{ marginTop: 3 }} />
                            <span>
                              {item.label}
                              <div className="cell-muted">{item.code}</div>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {formError && <div className="form-error" style={{ marginTop: 12 }}>{formError}</div>}
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setEditing(null)} disabled={saving}>Batal</button>
              <button type="submit" className="primary-button" disabled={saving} data-testid="role-save">
                {saving ? 'Menyimpan…' : 'Simpan'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleting && (
        <Modal title={`Hapus role ${deleting.name}`} onClose={() => setDeleting(null)} maxWidth={520}>
          <p>
            Role <strong>{deleting.name}</strong> akan dihapus permanen. Role yang masih dipakai pengguna
            tidak bisa dihapus.
          </p>
          <div className="modal-actions">
            <button type="button" className="ghost-button" onClick={() => setDeleting(null)}>Batal</button>
            <button type="button" className="primary-button danger-button" onClick={() => void confirmDelete()}
              data-testid="role-delete-confirm">
              Hapus role
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
