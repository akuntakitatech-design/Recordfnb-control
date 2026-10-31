import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { api, messageOf } from '../api';
import { Modal } from '../components/Modal';
import { money } from '../format';
import { StatusBadge } from './Organization';
import type { FeeScheme, FeeType, Hierarchy, Permission, Session } from '../types';

type Tab = 'types' | 'schemes';

const EMPTY_TYPE = { code: '', name: '', description: '', revenueAccountCode: '', recognitionMode: 'IMMEDIATE' };
const EMPTY_SCHEME = {
  unitId: '', academicYearId: '', feeTypeId: '', name: '', amount: '',
  frequency: 'MONTHLY', installmentCount: '1', dueDay: '', effectiveStart: '', effectiveEnd: '',
};

export function Fees({ session }: { session: Session }) {
  const can = (permission: Permission) => session.permissions.includes(permission);
  const [tab, setTab] = useState<Tab>('types');
  const [types, setTypes] = useState<FeeType[]>([]);
  const [schemes, setSchemes] = useState<FeeScheme[]>([]);
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [unitFilter, setUnitFilter] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [typeEditing, setTypeEditing] = useState<FeeType | 'new' | null>(null);
  const [typeForm, setTypeForm] = useState(EMPTY_TYPE);
  const [typeError, setTypeError] = useState('');

  const [schemeEditing, setSchemeEditing] = useState<FeeScheme | 'new' | null>(null);
  const [schemeForm, setSchemeForm] = useState(EMPTY_SCHEME);
  const [schemeError, setSchemeError] = useState('');
  const [saving, setSaving] = useState(false);

  const loadTypes = useCallback(async () => {
    try { setTypes(await api<FeeType[]>('/api/v1/fee-types')); } catch (loadError) { setError(messageOf(loadError)); }
  }, []);

  const loadSchemes = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (unitFilter) params.set('unitId', unitFilter);
      setSchemes(await api<FeeScheme[]>(`/api/v1/fee-schemes?${params.toString()}`));
    } catch (loadError) { setError(messageOf(loadError)); }
  }, [unitFilter]);

  useEffect(() => { void loadTypes(); }, [loadTypes]);
  useEffect(() => { void loadSchemes(); }, [loadSchemes]);
  useEffect(() => { api<Hierarchy>('/api/v1/organization/hierarchy').then(setHierarchy).catch(() => undefined); }, []);

  const units = hierarchy?.units || [];
  const years = hierarchy?.academicYears || [];

  async function saveType(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setTypeError('');
    try {
      if (typeEditing === 'new') {
        await api('/api/v1/fee-types', { method: 'POST', body: JSON.stringify(typeForm) });
        setNotice('Jenis biaya dibuat.');
      } else if (typeEditing) {
        await api(`/api/v1/fee-types/${typeEditing.id}`, { method: 'PATCH', body: JSON.stringify(typeForm) });
        setNotice('Jenis biaya diperbarui.');
      }
      setTypeEditing(null);
      await loadTypes();
    } catch (saveError) {
      setTypeError(messageOf(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function saveScheme(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSchemeError('');
    try {
      const payload = {
        ...schemeForm,
        amount: Number(schemeForm.amount),
        installmentCount: Number(schemeForm.installmentCount),
        dueDay: schemeForm.dueDay || null,
        effectiveEnd: schemeForm.effectiveEnd || null,
      };
      if (schemeEditing === 'new') {
        await api('/api/v1/fee-schemes', { method: 'POST', body: JSON.stringify(payload) });
        setNotice('Tarif dibuat.');
      } else if (schemeEditing) {
        await api(`/api/v1/fee-schemes/${schemeEditing.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        setNotice('Tarif diperbarui.');
      }
      setSchemeEditing(null);
      await loadSchemes();
    } catch (saveError) {
      setSchemeError(messageOf(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'types'} className={tab === 'types' ? 'active' : ''} onClick={() => setTab('types')} data-testid="fees-tab-types">
          Jenis Biaya
        </button>
        <button type="button" role="tab" aria-selected={tab === 'schemes'} className={tab === 'schemes' ? 'active' : ''} onClick={() => setTab('schemes')} data-testid="fees-tab-schemes">
          Tarif per Unit
        </button>
      </div>

      {tab === 'types' && (
        <section className="card">
          <div className="toolbar">
            <span className="cell-muted">{types.length} jenis biaya</span>
            <div className="spacer" />
            {can('fee.manage') && (
              <button type="button" className="primary-button" onClick={() => { setTypeForm(EMPTY_TYPE); setTypeError(''); setTypeEditing('new'); }} data-testid="fee-type-add">
                <Plus size={16} /> Tambah Jenis
              </button>
            )}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Kode</th><th>Nama</th><th>Akun pendapatan</th><th>Pengakuan</th><th>Status</th><th style={{ textAlign: 'right' }}>Aksi</th></tr></thead>
              <tbody>
                {types.map(type => (
                  <tr key={type.id}>
                    <td className="cell-muted">{type.code}</td>
                    <td className="cell-strong">{type.name}</td>
                    <td className="cell-muted">{type.revenue_account_code || '—'}</td>
                    <td>{type.recognition_mode === 'DEFERRED' ? 'Diterima di muka' : 'Langsung'}</td>
                    <td><StatusBadge value={type.status} /></td>
                    <td>
                      {can('fee.manage') && (
                        <div className="cell-actions">
                          <button type="button" className="link-button" onClick={() => {
                            setTypeForm({
                              code: type.code, name: type.name, description: type.description || '',
                              revenueAccountCode: type.revenue_account_code || '', recognitionMode: type.recognition_mode,
                            });
                            setTypeError('');
                            setTypeEditing(type);
                          }}>
                            <Pencil size={14} /> Edit
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {types.length === 0 && <div className="table-empty">Belum ada jenis biaya.</div>}
          </div>
        </section>
      )}

      {tab === 'schemes' && (
        <section className="card">
          <div className="toolbar">
            <select className="select" value={unitFilter} onChange={event => setUnitFilter(event.target.value)}>
              <option value="">Semua unit</option>
              {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
            </select>
            <div className="spacer" />
            <span className="cell-muted">{schemes.length} tarif</span>
            {can('fee.manage') && (
              <button type="button" className="primary-button" onClick={() => {
                setSchemeForm({
                  ...EMPTY_SCHEME,
                  unitId: units[0]?.id || '',
                  academicYearId: years[0]?.id || '',
                  feeTypeId: types[0]?.id || '',
                  effectiveStart: new Date().toISOString().slice(0, 10),
                });
                setSchemeError('');
                setSchemeEditing('new');
              }} data-testid="fee-scheme-add">
                <Plus size={16} /> Tambah Tarif
              </button>
            )}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Unit</th><th>Jenis</th><th>Nama tarif</th><th style={{ textAlign: 'right' }}>Nominal</th><th>Frekuensi</th><th>Angsuran</th><th>Berlaku</th><th>Status</th><th style={{ textAlign: 'right' }}>Aksi</th></tr></thead>
              <tbody>
                {schemes.map(scheme => (
                  <tr key={scheme.id}>
                    <td>{scheme.unit_name}</td>
                    <td className="cell-muted">{scheme.fee_code}</td>
                    <td className="cell-strong">{scheme.name}</td>
                    <td style={{ textAlign: 'right' }}>{money(scheme.amount)}</td>
                    <td>{scheme.frequency}</td>
                    <td>{scheme.installment_count}×</td>
                    <td className="cell-muted">{scheme.effective_start} → {scheme.effective_end || 'seterusnya'}</td>
                    <td><StatusBadge value={scheme.status} /></td>
                    <td>
                      {can('fee.manage') && (
                        <div className="cell-actions">
                          <button type="button" className="link-button" onClick={() => {
                            setSchemeForm({
                              unitId: scheme.unit_id, academicYearId: scheme.academic_year_id,
                              feeTypeId: scheme.fee_type_id, name: scheme.name, amount: String(Number(scheme.amount)),
                              frequency: scheme.frequency, installmentCount: String(scheme.installment_count),
                              dueDay: scheme.due_day ? String(scheme.due_day) : '',
                              effectiveStart: scheme.effective_start, effectiveEnd: scheme.effective_end || '',
                            });
                            setSchemeError('');
                            setSchemeEditing(scheme);
                          }}>
                            <Pencil size={14} /> Edit
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {schemes.length === 0 && <div className="table-empty">Belum ada tarif.</div>}
          </div>
        </section>
      )}

      {typeEditing && (
        <Modal title={typeEditing === 'new' ? 'Tambah Jenis Biaya' : `Edit — ${typeEditing.name}`} onClose={() => setTypeEditing(null)}>
          <form onSubmit={saveType}>
            <div className="form-grid">
              <label className="field">Kode
                <input className="input" value={typeForm.code} onChange={event => setTypeForm({ ...typeForm, code: event.target.value.toUpperCase() })} required />
              </label>
              <label className="field">Nama
                <input className="input" value={typeForm.name} onChange={event => setTypeForm({ ...typeForm, name: event.target.value })} required />
              </label>
              <label className="field">Akun pendapatan
                <input className="input" value={typeForm.revenueAccountCode} onChange={event => setTypeForm({ ...typeForm, revenueAccountCode: event.target.value })} placeholder="4-1100" />
              </label>
              <label className="field">Pengakuan
                <select className="select" value={typeForm.recognitionMode} onChange={event => setTypeForm({ ...typeForm, recognitionMode: event.target.value })}>
                  <option value="IMMEDIATE">Langsung</option>
                  <option value="DEFERRED">Diterima di muka</option>
                </select>
              </label>
              <label className="field full">Keterangan
                <input className="input" value={typeForm.description} onChange={event => setTypeForm({ ...typeForm, description: event.target.value })} />
              </label>
              {typeError && <div className="form-error">{typeError}</div>}
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setTypeEditing(null)}>Batal</button>
              <button type="submit" className="primary-button" disabled={saving}>{saving ? 'Menyimpan…' : 'Simpan'}</button>
            </div>
          </form>
        </Modal>
      )}

      {schemeEditing && (
        <Modal title={schemeEditing === 'new' ? 'Tambah Tarif' : `Edit Tarif — ${schemeEditing.name}`} onClose={() => setSchemeEditing(null)} maxWidth={720}>
          <form onSubmit={saveScheme}>
            <div className="form-grid">
              <label className="field">Unit
                <select className="select" value={schemeForm.unitId} onChange={event => setSchemeForm({ ...schemeForm, unitId: event.target.value })} required disabled={schemeEditing !== 'new'}>
                  <option value="">Pilih…</option>
                  {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
                </select>
              </label>
              <label className="field">Tahun ajaran
                <select className="select" value={schemeForm.academicYearId} onChange={event => setSchemeForm({ ...schemeForm, academicYearId: event.target.value })} required disabled={schemeEditing !== 'new'}>
                  <option value="">Pilih…</option>
                  {years.map(year => <option key={year.id} value={year.id}>{year.name}</option>)}
                </select>
              </label>
              <label className="field">Jenis biaya
                <select className="select" value={schemeForm.feeTypeId} onChange={event => setSchemeForm({ ...schemeForm, feeTypeId: event.target.value })} required disabled={schemeEditing !== 'new'}>
                  <option value="">Pilih…</option>
                  {types.map(type => <option key={type.id} value={type.id}>{type.code} — {type.name}</option>)}
                </select>
              </label>
              <label className="field">Nama tarif
                <input className="input" value={schemeForm.name} onChange={event => setSchemeForm({ ...schemeForm, name: event.target.value })} required placeholder="SPP TK A" />
              </label>
              <label className="field">Nominal (Rp)
                <input className="input" inputMode="numeric" value={schemeForm.amount} onChange={event => setSchemeForm({ ...schemeForm, amount: event.target.value })} required />
              </label>
              <label className="field">Frekuensi
                <select className="select" value={schemeForm.frequency} onChange={event => setSchemeForm({ ...schemeForm, frequency: event.target.value })}>
                  <option value="MONTHLY">Bulanan</option>
                  <option value="ANNUAL">Tahunan</option>
                  <option value="ONE_TIME">Sekali</option>
                </select>
              </label>
              <label className="field">Jumlah angsuran
                <input className="input" type="number" min={1} max={12} value={schemeForm.installmentCount} onChange={event => setSchemeForm({ ...schemeForm, installmentCount: event.target.value })} />
              </label>
              <label className="field">Tanggal jatuh tempo (1–28)
                <input className="input" type="number" min={1} max={28} value={schemeForm.dueDay} onChange={event => setSchemeForm({ ...schemeForm, dueDay: event.target.value })} />
              </label>
              <label className="field">Berlaku mulai
                <input type="date" className="input" value={schemeForm.effectiveStart} onChange={event => setSchemeForm({ ...schemeForm, effectiveStart: event.target.value })} required />
              </label>
              <label className="field">Berlaku sampai
                <input type="date" className="input" value={schemeForm.effectiveEnd} onChange={event => setSchemeForm({ ...schemeForm, effectiveEnd: event.target.value })} />
              </label>
              {schemeError && <div className="form-error">{schemeError}</div>}
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setSchemeEditing(null)}>Batal</button>
              <button type="submit" className="primary-button" disabled={saving}>{saving ? 'Menyimpan…' : 'Simpan'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
