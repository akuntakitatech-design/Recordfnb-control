import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { api, messageOf } from '../api';
import { Modal } from '../components/Modal';
import type { Hierarchy, Session } from '../types';

type TabKey = 'entity' | 'levels' | 'groups' | 'schools' | 'locations' | 'years';

type FieldDef = {
  key: string;
  label: string;
  type?: 'text' | 'date' | 'number' | 'select' | 'textarea';
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
  full?: boolean;
};

type Column = { key: string; label: string; render?: (row: any) => ReactNode };

const TABS: { key: TabKey; label: string }[] = [
  { key: 'entity', label: 'Badan Hukum' },
  { key: 'levels', label: 'Jenjang' },
  { key: 'groups', label: 'Kelompok Sekolah' },
  { key: 'schools', label: 'Sekolah Resmi' },
  { key: 'locations', label: 'Lokasi' },
  { key: 'years', label: 'Tahun Ajaran' },
];

export function Organization({ session }: { session: Session }) {
  const canEdit = session.permissions.includes('entity.manage');
  const [tab, setTab] = useState<TabKey>('entity');
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      setHierarchy(await api<Hierarchy>('/api/v1/organization/hierarchy'));
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const levelOptions = useMemo(
    () => (hierarchy?.levels || []).map(level => ({ value: level.id, label: `${level.code} — ${level.name}` })),
    [hierarchy],
  );

  const config = useMemo(() => {
    if (!hierarchy) return null;
    const common = { canEdit };
    switch (tab) {
      case 'levels':
        return {
          ...common,
          title: 'Jenjang pendidikan',
          endpoint: '/api/v1/organization/education-levels',
          rows: hierarchy.levels,
          columns: [
            { key: 'code', label: 'Kode' },
            { key: 'name', label: 'Nama' },
            { key: 'sort_order', label: 'Urutan' },
            { key: 'status', label: 'Status', render: (row: any) => <StatusBadge value={row.status} /> },
          ] as Column[],
          fields: [
            { key: 'code', label: 'Kode', required: true, placeholder: 'TK' },
            { key: 'name', label: 'Nama', required: true, placeholder: 'Taman Kanak-kanak' },
            { key: 'sortOrder', label: 'Urutan', type: 'number' },
          ] as FieldDef[],
        };
      case 'groups':
        return {
          ...common,
          title: 'Kelompok sekolah',
          endpoint: '/api/v1/organization/school-groups',
          rows: hierarchy.groups,
          columns: [
            { key: 'code', label: 'Kode' },
            { key: 'name', label: 'Nama' },
            { key: 'level_name', label: 'Jenjang' },
            { key: 'status', label: 'Status', render: (row: any) => <StatusBadge value={row.status} /> },
          ] as Column[],
          fields: [
            { key: 'code', label: 'Kode', required: true },
            { key: 'name', label: 'Nama', required: true },
            { key: 'educationLevelId', label: 'Jenjang', type: 'select', required: true, options: levelOptions, full: true },
          ] as FieldDef[],
        };
      case 'schools':
        return {
          ...common,
          title: 'Sekolah resmi',
          endpoint: '/api/v1/organization/official-schools',
          rows: hierarchy.schools,
          columns: [
            { key: 'name', label: 'Nama' },
            { key: 'npsn', label: 'NPSN', render: (row: any) => row.npsn || '—' },
            { key: 'level_name', label: 'Jenjang' },
            { key: 'verification_status', label: 'Verifikasi', render: (row: any) => <StatusBadge value={row.verification_status} /> },
          ] as Column[],
          fields: [
            { key: 'name', label: 'Nama sekolah', required: true, full: true },
            { key: 'npsn', label: 'NPSN (8 karakter)', placeholder: 'Opsional' },
            { key: 'educationLevelId', label: 'Jenjang', type: 'select', required: true, options: levelOptions },
            {
              key: 'verificationStatus', label: 'Status verifikasi', type: 'select',
              options: [{ value: 'UNVERIFIED', label: 'Belum terverifikasi' }, { value: 'VERIFIED', label: 'Terverifikasi' }],
            },
            { key: 'governmentReference', label: 'Referensi dokumen', full: true },
          ] as FieldDef[],
        };
      case 'locations':
        return {
          ...common,
          title: 'Lokasi',
          endpoint: '/api/v1/organization/locations',
          rows: hierarchy.locations,
          columns: [
            { key: 'name', label: 'Nama' },
            { key: 'city', label: 'Kota' },
            { key: 'province', label: 'Provinsi' },
            { key: 'postal_code', label: 'Kode pos' },
          ] as Column[],
          fields: [
            { key: 'name', label: 'Nama lokasi', required: true },
            { key: 'phone', label: 'Telepon' },
            { key: 'address', label: 'Alamat', full: true },
            { key: 'province', label: 'Provinsi' },
            { key: 'city', label: 'Kota / Kabupaten' },
            { key: 'district', label: 'Kecamatan' },
            { key: 'postalCode', label: 'Kode pos' },
          ] as FieldDef[],
        };
      case 'years':
        return {
          ...common,
          title: 'Tahun ajaran',
          endpoint: '/api/v1/organization/academic-years',
          rows: hierarchy.academicYears,
          columns: [
            { key: 'name', label: 'Tahun ajaran' },
            { key: 'start_date', label: 'Mulai' },
            { key: 'end_date', label: 'Selesai' },
          ] as Column[],
          fields: [
            { key: 'name', label: 'Nama', required: true, placeholder: '2026/2027' },
            { key: 'startDate', label: 'Tanggal mulai', type: 'date', required: true },
            { key: 'endDate', label: 'Tanggal selesai', type: 'date', required: true },
          ] as FieldDef[],
        };
      default:
        return null;
    }
  }, [hierarchy, tab, canEdit, levelOptions]);

  return (
    <div className="stack">
      <div className="tabs" role="tablist">
        {TABS.map(item => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={tab === item.key ? 'active' : ''}
            onClick={() => { setTab(item.key); setNotice(''); setError(''); }}
            data-testid={`org-tab-${item.key}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && <div className="form-error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {tab === 'entity' && hierarchy && (
        <EntityForm
          hierarchy={hierarchy}
          canEdit={canEdit}
          onSaved={async message => { setNotice(message); await load(); }}
        />
      )}

      {config && (
        <MasterTable
          key={tab}
          config={config}
          onSaved={async message => { setNotice(message); await load(); }}
        />
      )}
    </div>
  );
}

function EntityForm({ hierarchy, canEdit, onSaved }: { hierarchy: Hierarchy; canEdit: boolean; onSaved: (message: string) => void }) {
  const entity = hierarchy.legalEntity;
  const [form, setForm] = useState({
    code: entity.code,
    name: entity.name,
    npsn: entity.npsn || '',
    address: entity.address || '',
    phone: entity.phone || '',
    email: entity.email || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api('/api/v1/organization/legal-entity', { method: 'PUT', body: JSON.stringify(form) });
      onSaved('Profil badan hukum tersimpan.');
    } catch (saveError) {
      setError(messageOf(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h3>Profil badan hukum</h3>
          <p>Satu badan hukum menaungi seluruh jenjang dan cabang.</p>
        </div>
      </div>
      <div className="card-body">
        <form onSubmit={save}>
          <div className="form-grid">
            <label className="field">Kode yayasan
              <input className="input" value={form.code} onChange={event => setForm({ ...form, code: event.target.value })} disabled={!canEdit} required />
            </label>
            <label className="field">Nama yayasan
              <input className="input" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} disabled={!canEdit} required />
            </label>
            <label className="field">NPSN yayasan
              <input className="input" value={form.npsn} onChange={event => setForm({ ...form, npsn: event.target.value })} disabled={!canEdit} />
            </label>
            <label className="field">Telepon
              <input className="input" value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })} disabled={!canEdit} />
            </label>
            <label className="field full">Alamat
              <input className="input" value={form.address} onChange={event => setForm({ ...form, address: event.target.value })} disabled={!canEdit} />
            </label>
            <label className="field full">Email
              <input className="input" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} disabled={!canEdit} />
            </label>
            {error && <div className="form-error">{error}</div>}
          </div>
          {canEdit && (
            <div className="modal-actions">
              <button type="submit" className="primary-button" disabled={saving} data-testid="entity-save">
                {saving ? 'Menyimpan…' : 'Simpan Profil'}
              </button>
            </div>
          )}
        </form>
      </div>
    </section>
  );
}

type MasterConfig = {
  title: string;
  endpoint: string;
  rows: any[];
  columns: Column[];
  fields: FieldDef[];
  canEdit: boolean;
};

function MasterTable({ config, onSaved }: { config: MasterConfig; onSaved: (message: string) => void }) {
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<any | null>(null);
  const [rowError, setRowError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  function open(row: any | 'new') {
    const next: Record<string, string> = {};
    for (const field of config.fields) {
      // API mengirim snake_case (start_date) sedangkan field memakai camelCase (startDate).
      const value = row === 'new' ? '' : (row[field.key] ?? row[snakeKey(field.key)]);
      next[field.key] = value === null || value === undefined ? '' : String(value);
    }
    setForm(next);
    setFormError('');
    setEditing(row);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      if (editing === 'new') {
        await api(config.endpoint, { method: 'POST', body: JSON.stringify(form) });
      } else {
        await api(`${config.endpoint}/${editing.id}`, { method: 'PUT', body: JSON.stringify(form) });
      }
      setEditing(null);
      onSaved('Data tersimpan.');
    } catch (saveError) {
      setFormError(messageOf(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(row: any) {
    const next = row.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    setBusyId(row.id);
    setRowError('');
    try {
      await api(`${config.endpoint}/${row.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      onSaved(next === 'ACTIVE'
        ? `${labelOf(row)} diaktifkan kembali.`
        : `${labelOf(row)} dinonaktifkan. Data tetap tersimpan dan bisa diaktifkan lagi.`);
    } catch (statusError) {
      setRowError(messageOf(statusError));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: any) {
    setBusyId(row.id);
    setRowError('');
    try {
      await api(`${config.endpoint}/${row.id}`, { method: 'DELETE' });
      setConfirming(null);
      onSaved(`${labelOf(row)} dihapus.`);
    } catch (deleteError) {
      setRowError(messageOf(deleteError));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <div><h3>{config.title}</h3><p>{config.rows.length} data</p></div>
        {config.canEdit && (
          <button type="button" className="primary-button" onClick={() => open('new')}>
            <Plus size={16} /> Tambah
          </button>
        )}
      </div>
      <div className="table-wrap">
        {rowError && !confirming && <div className="form-error">{rowError}</div>}
        <table>
          <thead>
            <tr>
              {config.columns.map(column => <th key={column.key}>{column.label}</th>)}
              {config.canEdit && <th style={{ textAlign: 'right' }}>Aksi</th>}
            </tr>
          </thead>
          <tbody>
            {config.rows.map((row, index) => (
              <tr key={row.id || index}>
                {config.columns.map(column => (
                  <td key={column.key}>
                    {column.render ? column.render(row) : (row[column.key] ?? '—')}
                  </td>
                ))}
                {config.canEdit && (
                  <td>
                    <div className="cell-actions">
                      <button type="button" className="link-button" onClick={() => open(row)}>
                        <Pencil size={14} /> Edit
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void toggleStatus(row)}
                        disabled={busyId === row.id}
                        data-testid={`master-toggle-${row.id}`}
                      >
                        <Power size={14} /> {row.status === 'ACTIVE' ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                      <button
                        type="button"
                        className="link-button danger"
                        onClick={() => { setRowError(''); setConfirming(row); }}
                        disabled={busyId === row.id}
                        data-testid={`master-delete-${row.id}`}
                      >
                        <Trash2 size={14} /> Hapus
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {config.rows.length === 0 && <div className="table-empty">Belum ada data.</div>}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? `Tambah ${config.title}` : `Edit ${config.title}`} onClose={() => setEditing(null)}>
          <form onSubmit={save}>
            <div className="form-grid">
              {config.fields.map(field => (
                <label key={field.key} className={`field ${field.full ? 'full' : ''}`}>
                  {field.label}
                  {field.type === 'select' ? (
                    <select
                      className="select"
                      value={form[field.key] || ''}
                      onChange={event => setForm({ ...form, [field.key]: event.target.value })}
                      required={field.required}
                    >
                      <option value="">Pilih…</option>
                      {(field.options || []).map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="input"
                      type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'}
                      value={form[field.key] || ''}
                      onChange={event => setForm({ ...form, [field.key]: event.target.value })}
                      required={field.required}
                      placeholder={field.placeholder}
                    />
                  )}
                </label>
              ))}
              {formError && <div className="form-error">{formError}</div>}
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setEditing(null)}>Batal</button>
              <button type="submit" className="primary-button" disabled={saving}>{saving ? 'Menyimpan…' : 'Simpan'}</button>
            </div>
          </form>
        </Modal>
      )}

      {confirming && (
        <Modal title={`Hapus ${config.title}`} onClose={() => setConfirming(null)} maxWidth={520}>
          <p style={{ marginTop: 0 }}>
            Hapus permanen <strong>{labelOf(confirming)}</strong>? Data yang dihapus tidak bisa dikembalikan.
          </p>
          <div className="notice">
            Bila data ini sudah dipakai unit, tarif, atau tagihan, penghapusan akan ditolak.
            Gunakan <strong>Nonaktifkan</strong> agar data tetap tersimpan.
          </div>
          {rowError && <div className="form-error">{rowError}</div>}
          <div className="modal-actions">
            <button type="button" className="ghost-button" onClick={() => setConfirming(null)}>Batal</button>
            <button
              type="button"
              className="danger-button"
              onClick={() => void remove(confirming)}
              disabled={busyId === confirming.id}
              data-testid="master-delete-confirm"
            >
              {busyId === confirming.id ? 'Menghapus…' : 'Hapus'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** Label ringkas satu baris master untuk pesan konfirmasi/notifikasi. */
function labelOf(row: any): string {
  const name = row?.name || '';
  const code = row?.code || '';
  if (code && name) return `${code} — ${name}`;
  return name || code || 'data ini';
}

/** startDate -> start_date, educationLevelId -> education_level_id. */
function snakeKey(key: string): string {
  return key.replace(/[A-Z]/g, character => `_${character.toLowerCase()}`);
}

export function StatusBadge({ value }: { value: string }) {
  const map: Record<string, string> = {
    ACTIVE: 'success', READY: 'success', VERIFIED: 'success',
    DRAFT: 'neutral', INACTIVE: 'neutral', UNVERIFIED: 'info',
    NOT_CONFIGURED: 'warning', BLOCKED: 'danger', ARCHIVED: 'neutral',
    POSTED: 'success', APPROVED: 'success', PAID: 'success',
    SUBMITTED: 'info', PARTIAL: 'warning', REJECTED: 'danger',
    CANCELLED: 'neutral', VOID: 'danger', ISSUED: 'info',
    OPEN: 'success', CLOSED: 'neutral', REVERSED: 'warning',
  };
  return <span className={`badge ${map[value] || 'neutral'}`}>{value}</span>;
}
