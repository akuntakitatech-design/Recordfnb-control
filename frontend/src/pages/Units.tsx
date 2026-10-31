import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Pencil, Plus, ShieldCheck } from 'lucide-react';
import { api, messageOf } from '../api';
import { Modal } from '../components/Modal';
import { formatDateTime } from './Dashboard';
import { StatusBadge } from './Organization';
import type {
  BankAccount, Hierarchy, Permission, Readiness, Session, Unit, UnitDetail,
} from '../types';

type UnitForm = {
  unitCode: string;
  unitName: string;
  shortName: string;
  educationLevelId: string;
  schoolGroupId: string;
  officialSchoolId: string;
  locationId: string;
  defaultAcademicYearId: string;
  unitType: 'HEAD_OFFICE' | 'SCHOOL_BRANCH';
  address: string;
  effectiveStart: string;
  effectiveEnd: string;
  notes: string;
};

const EMPTY: UnitForm = {
  unitCode: '', unitName: '', shortName: '', educationLevelId: '', schoolGroupId: '',
  officialSchoolId: '', locationId: '', defaultAcademicYearId: '', unitType: 'SCHOOL_BRANCH',
  address: '', effectiveStart: '', effectiveEnd: '', notes: '',
};

export function Units({ session }: { session: Session }) {
  const can = (permission: Permission) => session.permissions.includes(permission);

  const [units, setUnits] = useState<Unit[]>([]);
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [editing, setEditing] = useState<Unit | 'new' | null>(null);
  const [form, setForm] = useState<UnitForm>(EMPTY);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState<UnitDetail | null>(null);
  const [detailError, setDetailError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [unitResult, hierarchyResult] = await Promise.all([
        api<{ rows: Unit[] }>('/api/v1/organization/units?pageSize=100'),
        api<Hierarchy>('/api/v1/organization/hierarchy'),
      ]);
      setUnits(unitResult.rows);
      setHierarchy(hierarchyResult);
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openCreate() {
    const currentYear = hierarchy?.academicYears[0]?.id || '';
    setForm({ ...EMPTY, defaultAcademicYearId: currentYear });
    setFormError('');
    setEditing('new');
  }

  function openEdit(unit: Unit) {
    setForm({
      unitCode: unit.unit_code,
      unitName: unit.unit_name,
      shortName: unit.short_name || '',
      educationLevelId: unit.education_level_id,
      schoolGroupId: unit.school_group_id || '',
      officialSchoolId: unit.official_school_id || '',
      locationId: unit.location_id || '',
      defaultAcademicYearId: unit.default_academic_year_id || '',
      unitType: unit.unit_type,
      address: unit.address || '',
      effectiveStart: unit.effective_start || '',
      effectiveEnd: unit.effective_end || '',
      notes: unit.notes || '',
    });
    setFormError('');
    setEditing(unit);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      const payload = {
        ...form,
        schoolGroupId: form.schoolGroupId || null,
        officialSchoolId: form.officialSchoolId || null,
        locationId: form.locationId || null,
        defaultAcademicYearId: form.defaultAcademicYearId || null,
        effectiveStart: form.effectiveStart || null,
        effectiveEnd: form.effectiveEnd || null,
      };
      if (editing === 'new') {
        await api('/api/v1/organization/units', { method: 'POST', body: JSON.stringify(payload) });
        setNotice('Unit dibuat sebagai Draft.');
      } else if (editing) {
        await api(`/api/v1/organization/units/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        setNotice('Perubahan unit tersimpan.');
      }
      setEditing(null);
      await load();
    } catch (saveError) {
      setFormError(messageOf(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(unit: Unit) {
    setDetailError('');
    try {
      setDetail(await api<UnitDetail>(`/api/v1/organization/units/${unit.id}`));
    } catch (detailLoadError) {
      setDetailError(messageOf(detailLoadError));
    }
  }

  async function refreshDetail(unitId: string) {
    setDetail(await api<UnitDetail>(`/api/v1/organization/units/${unitId}`));
    await load();
  }

  async function activate(unit: Unit) {
    const reason = window.prompt('Catatan aktivasi (opsional):') || '';
    try {
      await api(`/api/v1/organization/units/${unit.id}/activate`, {
        method: 'POST', body: JSON.stringify({ reason }),
      });
      setNotice('Unit diaktifkan.');
      await refreshDetail(unit.id);
    } catch (activateError) {
      setDetailError(messageOf(activateError));
    }
  }

  async function deactivate(unit: Unit) {
    const reason = window.prompt('Alasan menonaktifkan unit (minimal 5 karakter):') || '';
    if (reason.trim().length < 5) {
      setDetailError('Alasan minimal 5 karakter.');
      return;
    }
    try {
      await api(`/api/v1/organization/units/${unit.id}/deactivate`, {
        method: 'POST', body: JSON.stringify({ reason }),
      });
      setNotice('Unit dinonaktifkan.');
      await refreshDetail(unit.id);
    } catch (deactivateError) {
      setDetailError(messageOf(deactivateError));
    }
  }

  return (
    <div className="stack">
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="card">
        <div className="toolbar">
          <span className="cell-muted">{units.length} unit</span>
          <div className="spacer" />
          {can('unit.create') && (
            <button type="button" className="primary-button" onClick={openCreate} data-testid="unit-add">
              <Plus size={16} /> Tambah Unit
            </button>
          )}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Kode</th>
                <th>Nama unit</th>
                <th>Jenjang</th>
                <th>Status</th>
                <th>Kesiapan</th>
                <th>Rekening</th>
                <th style={{ textAlign: 'right' }}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {units.map(unit => (
                <tr key={unit.id}>
                  <td className="cell-muted">{unit.unit_code}</td>
                  <td>
                    <button type="button" className="link-button" onClick={() => openDetail(unit)}>
                      {unit.unit_name}
                    </button>
                    {unit.location_name && <div className="cell-muted">{unit.location_name}</div>}
                  </td>
                  <td>{unit.level_name}</td>
                  <td><StatusBadge value={unit.operational_status} /></td>
                  <td><StatusBadge value={unit.finance_status} /></td>
                  <td className="cell-muted">{unit.bank_assignments || 0} mapping</td>
                  <td>
                    <div className="cell-actions">
                      {can('unit.edit') && (
                        <button type="button" className="link-button" onClick={() => openEdit(unit)}>
                          <Pencil size={14} /> Edit
                        </button>
                      )}
                      <button type="button" className="link-button" onClick={() => openDetail(unit)}>
                        <ShieldCheck size={14} /> Detail
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && units.length === 0 && <div className="table-empty">Belum ada unit.</div>}
          {loading && <div className="table-empty">Memuat unit…</div>}
        </div>
      </section>

      {editing && hierarchy && (
        <Modal title={editing === 'new' ? 'Tambah Unit / Cabang' : `Edit Unit — ${editing.unit_name}`} onClose={() => setEditing(null)} maxWidth={760}>
          <form onSubmit={save}>
            <div className="form-grid">
              <label className="field">Kode unit
                <input className="input" value={form.unitCode} onChange={event => setForm({ ...form, unitCode: event.target.value.toUpperCase() })}
                  placeholder="TK-PANAM" required disabled={editing !== 'new'} data-testid="unit-code" />
              </label>
              <label className="field">Nama unit
                <input className="input" value={form.unitName} onChange={event => setForm({ ...form, unitName: event.target.value })} required data-testid="unit-name" />
              </label>
              <label className="field">Nama singkat
                <input className="input" value={form.shortName} onChange={event => setForm({ ...form, shortName: event.target.value })} />
              </label>
              <label className="field">Jenis unit
                <select className="select" value={form.unitType} onChange={event => setForm({ ...form, unitType: event.target.value as UnitForm['unitType'] })}>
                  <option value="SCHOOL_BRANCH">Cabang sekolah</option>
                  <option value="HEAD_OFFICE">Kantor pusat</option>
                </select>
              </label>
              <label className="field">Jenjang
                <select className="select" value={form.educationLevelId} onChange={event => setForm({ ...form, educationLevelId: event.target.value })} required data-testid="unit-level">
                  <option value="">Pilih…</option>
                  {hierarchy.levels.map(level => <option key={level.id} value={level.id}>{level.code} — {level.name}</option>)}
                </select>
              </label>
              <label className="field">Kelompok sekolah
                <select className="select" value={form.schoolGroupId} onChange={event => setForm({ ...form, schoolGroupId: event.target.value })}>
                  <option value="">—</option>
                  {hierarchy.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
              </label>
              <label className="field">Sekolah resmi
                <select className="select" value={form.officialSchoolId} onChange={event => setForm({ ...form, officialSchoolId: event.target.value })}>
                  <option value="">—</option>
                  {hierarchy.schools.map(school => (
                    <option key={school.id} value={school.id}>{school.name}{school.npsn ? ` (${school.npsn})` : ''}</option>
                  ))}
                </select>
              </label>
              <label className="field">Lokasi
                <select className="select" value={form.locationId} onChange={event => setForm({ ...form, locationId: event.target.value })}>
                  <option value="">—</option>
                  {hierarchy.locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}
                </select>
              </label>
              <label className="field">Tahun ajaran
                <select className="select" value={form.defaultAcademicYearId} onChange={event => setForm({ ...form, defaultAcademicYearId: event.target.value })}>
                  <option value="">—</option>
                  {hierarchy.academicYears.map(year => <option key={year.id} value={year.id}>{year.name}</option>)}
                </select>
              </label>
              <label className="field">Mulai efektif
                <input type="date" className="input" value={form.effectiveStart} onChange={event => setForm({ ...form, effectiveStart: event.target.value })} />
              </label>
              <label className="field">Berakhir
                <input type="date" className="input" value={form.effectiveEnd} onChange={event => setForm({ ...form, effectiveEnd: event.target.value })} />
              </label>
              <label className="field full">Alamat
                <input className="input" value={form.address} onChange={event => setForm({ ...form, address: event.target.value })} />
              </label>
              <label className="field full">Catatan
                <input className="input" value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} />
              </label>
              {formError && <div className="form-error">{formError}</div>}
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setEditing(null)}>Batal</button>
              <button type="submit" className="primary-button" disabled={saving} data-testid="unit-save">
                {saving ? 'Menyimpan…' : 'Simpan'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {detail && (
        <UnitDetailModal
          unit={detail}
          session={session}
          onClose={() => setDetail(null)}
          onActivate={() => activate(detail)}
          onDeactivate={() => deactivate(detail)}
          onRefresh={() => refreshDetail(detail.id)}
          detailError={detailError}
          setDetailError={setDetailError}
        />
      )}
    </div>
  );
}

function UnitDetailModal({
  unit, session, onClose, onActivate, onDeactivate, onRefresh, detailError, setDetailError,
}: {
  unit: UnitDetail;
  session: Session;
  onClose: () => void;
  onActivate: () => void;
  onDeactivate: () => void;
  onRefresh: () => Promise<void>;
  detailError: string;
  setDetailError: (message: string) => void;
}) {
  const can = (permission: Permission) => session.permissions.includes(permission);
  const [mode, setMode] = useState(unit.settings?.account_mode || 'MIXED');
  const [receivable, setReceivable] = useState(unit.settings?.receivable_account_code || '');
  const [cash, setCash] = useState(unit.settings?.cash_account_code || '');
  const [revenue, setRevenue] = useState(unit.settings?.revenue_account_code || '');
  const [savingSettings, setSavingSettings] = useState(false);

  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [bankId, setBankId] = useState('');
  const [usageType, setUsageType] = useState<'CENTRAL_SHARED' | 'UNIT_DEDICATED'>('CENTRAL_SHARED');
  const [effectiveStart, setEffectiveStart] = useState(new Date().toISOString().slice(0, 10));
  const [savingAssignment, setSavingAssignment] = useState(false);

  useEffect(() => {
    api<BankAccount[]>('/api/v1/bank-accounts').then(setBanks).catch(() => undefined);
  }, []);

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setSavingSettings(true);
    setDetailError('');
    try {
      await api(`/api/v1/organization/units/${unit.id}/finance-settings`, {
        method: 'PUT',
        body: JSON.stringify({
          accountMode: mode,
          receivableAccountCode: receivable || null,
          cashAccountCode: cash || null,
          revenueAccountCode: revenue || null,
        }),
      });
      await onRefresh();
    } catch (saveError) {
      setDetailError(messageOf(saveError));
    } finally {
      setSavingSettings(false);
    }
  }

  async function addAssignment(event: FormEvent) {
    event.preventDefault();
    setSavingAssignment(true);
    setDetailError('');
    try {
      await api(`/api/v1/organization/units/${unit.id}/bank-assignments`, {
        method: 'POST',
        body: JSON.stringify({ bankAccountId: bankId, usageType, effectiveStart }),
      });
      setBankId('');
      await onRefresh();
    } catch (saveError) {
      setDetailError(messageOf(saveError));
    } finally {
      setSavingAssignment(false);
    }
  }

  async function removeAssignment(assignmentId: string) {
    const reason = window.prompt('Alasan melepas mapping rekening (minimal 5 karakter):') || '';
    if (reason.trim().length < 5) {
      setDetailError('Alasan minimal 5 karakter.');
      return;
    }
    try {
      await api(`/api/v1/organization/units/${unit.id}/bank-assignments/${assignmentId}`, {
        method: 'DELETE', body: JSON.stringify({ reason }),
      });
      await onRefresh();
    } catch (removeError) {
      setDetailError(messageOf(removeError));
    }
  }

  const readiness: Readiness = unit.readiness;

  return (
    <Modal title={`${unit.unit_name} — ${unit.unit_code}`} onClose={onClose} maxWidth={920}>
      {detailError && <div className="form-error" style={{ marginBottom: 14 }}>{detailError}</div>}

      <div className="stack">
        <div className="detail-grid">
          <DetailItem label="Jenjang" value={unit.level_name} />
          <DetailItem label="Kelompok" value={unit.group_name || '—'} />
          <DetailItem label="Sekolah resmi" value={unit.official_school_name || '—'} />
          <DetailItem label="Lokasi" value={unit.location_name || '—'} />
          <DetailItem label="Tahun ajaran" value={unit.academic_year_name || '—'} />
          <DetailItem label="Mulai efektif" value={unit.effective_start || '—'} />
          <DetailItem label="Status operasional" value={<StatusBadge value={unit.operational_status} />} />
          <DetailItem label="Kesiapan keuangan" value={<StatusBadge value={unit.finance_status} />} />
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {can('unit.activate') && unit.operational_status === 'DRAFT' && (
            <button type="button" className="primary-button" onClick={onActivate} data-testid="unit-activate">Aktifkan Unit</button>
          )}
          {can('unit.deactivate') && unit.operational_status === 'ACTIVE' && (
            <button type="button" className="ghost-button danger-button" onClick={onDeactivate} data-testid="unit-deactivate">Nonaktifkan</button>
          )}
        </div>

        <section>
          <h4 style={{ marginBottom: 8 }}>Checklist kesiapan keuangan</h4>
          <div className="checklist">
            {readiness.checks.map(check => (
              <div key={check.field} className={`checklist-item ${check.ok ? 'ok' : 'missing'}`}>
                <span>{check.ok ? '✓' : '✕'}</span>
                <div>
                  <strong>{check.label}</strong>
                  <div className="cell-muted">{check.ok ? 'Siap' : 'Belum diisi'}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="cell-muted" style={{ marginTop: 8 }}>Mode rekening: <strong>{readiness.accountMode}</strong></div>
        </section>

        <section>
          <h4 style={{ marginBottom: 8 }}>Konfigurasi keuangan</h4>
          <form onSubmit={saveSettings}>
            <div className="form-grid">
              <label className="field">Mode rekening
                <select className="select" value={mode} onChange={event => setMode(event.target.value as typeof mode)} disabled={!can('unit.finance')}>
                  <option value="MIXED">MIXED — pusat + khusus</option>
                  <option value="CENTRAL_ONLY">CENTRAL_ONLY — pusat saja</option>
                  <option value="DEDICATED_ONLY">DEDICATED_ONLY — khusus saja</option>
                </select>
              </label>
              <label className="field">Akun piutang
                <input className="input" value={receivable} onChange={event => setReceivable(event.target.value)} disabled={!can('unit.finance')} placeholder="1-1200" />
              </label>
              <label className="field">Akun kas/bank
                <input className="input" value={cash} onChange={event => setCash(event.target.value)} disabled={!can('unit.finance')} placeholder="1-1100" />
              </label>
              <label className="field">Akun pendapatan
                <input className="input" value={revenue} onChange={event => setRevenue(event.target.value)} disabled={!can('unit.finance')} placeholder="4-1100" />
              </label>
            </div>
            {can('unit.finance') && (
              <div className="modal-actions">
                <button type="submit" className="primary-button" disabled={savingSettings}>
                  {savingSettings ? 'Menyimpan…' : 'Simpan Konfigurasi'}
                </button>
              </div>
            )}
          </form>
        </section>

        <section>
          <h4 style={{ marginBottom: 8 }}>Mapping rekening</h4>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Rekening</th><th>Tipe</th><th>Periode</th><th>Default</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {unit.assignments.map(assignment => (
                  <tr key={assignment.id}>
                    <td>
                      <strong>{assignment.bank_name}</strong>
                      <div className="cell-muted">{assignment.account_number} · {assignment.account_usage}</div>
                    </td>
                    <td>{assignment.usage_type}</td>
                    <td className="cell-muted">{assignment.effective_start} → {assignment.effective_end || 'seterusnya'}</td>
                    <td>
                      {assignment.is_default_receipt && <span className="badge info">Terima</span>}{' '}
                      {assignment.is_default_disbursement && <span className="badge warning">Bayar</span>}
                      {!assignment.is_default_receipt && !assignment.is_default_disbursement && '—'}
                    </td>
                    <td><StatusBadge value={assignment.status} /></td>
                    <td>
                      {can('bank.assign') && assignment.status === 'ACTIVE' && (
                        <button type="button" className="link-button danger" onClick={() => removeAssignment(assignment.id)}>Lepas</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {unit.assignments.length === 0 && <div className="table-empty">Belum ada rekening terhubung.</div>}
          </div>

          {can('bank.assign') && (
            <form onSubmit={addAssignment} className="toolbar" style={{ paddingLeft: 0, paddingRight: 0 }}>
              <select className="select" value={bankId} onChange={event => setBankId(event.target.value)} required>
                <option value="">Pilih rekening…</option>
                {banks.filter(bank => bank.status === 'ACTIVE' && bank.verified_at).map(bank => (
                  <option key={bank.id} value={bank.id}>{bank.bank_name} — {bank.account_number} ({bank.account_usage})</option>
                ))}
              </select>
              <select className="select" value={usageType} onChange={event => setUsageType(event.target.value as typeof usageType)}>
                <option value="CENTRAL_SHARED">CENTRAL_SHARED</option>
                <option value="UNIT_DEDICATED">UNIT_DEDICATED</option>
              </select>
              <input type="date" className="input" value={effectiveStart} onChange={event => setEffectiveStart(event.target.value)} />
              <button type="submit" className="ghost-button" disabled={savingAssignment || !bankId}>
                {savingAssignment ? 'Menyimpan…' : 'Hubungkan'}
              </button>
            </form>
          )}
        </section>

        <section>
          <h4 style={{ marginBottom: 8 }}>Riwayat perubahan</h4>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Waktu</th><th>Aksi</th><th>Alasan</th></tr></thead>
              <tbody>
                {unit.auditLogs.map(log => (
                  <tr key={log.id}>
                    <td className="cell-muted">{formatDateTime(log.created_at)}</td>
                    <td><span className="badge neutral">{log.action}</span></td>
                    <td className="cell-muted">{log.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {unit.auditLogs.length === 0 && <div className="table-empty">Belum ada riwayat.</div>}
          </div>
        </section>
      </div>
    </Modal>
  );
}

function DetailItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="cell-muted" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 13.5, marginTop: 2 }}>{value}</div>
    </div>
  );
}
