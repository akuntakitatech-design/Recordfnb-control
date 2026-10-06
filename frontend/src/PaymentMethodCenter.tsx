import { useEffect, useState } from 'react';
import { CheckCircle2, Pencil, Plus, RefreshCw, Save, X } from 'lucide-react';
import { api } from './api';
import { destinationLabel, flowError, loadOrg, qs, type Company, type Location } from './salesFlowShared';
import './salesFlow.css';

type Method = {
  id: string; code: string; name: string; pos_payment_code: string; evidence_policy: 'REQUIRED' | 'OPTIONAL'; destination_behavior: 'CASH_DIRECT' | 'BANK_DIRECT' | 'SETTLEMENT';
  financial_account_id: string | null; financial_account_name: string | null; status: string; sort_order: number; mapping_ready: boolean;
  clearing_account_id?: string | null; clearing_account_code?: string | null; clearing_account_name?: string | null; fee_account_id?: string | null; fee_account_code?: string | null; fee_account_name?: string | null;
  locations: Array<{ id: string; name: string }>;
};
type PosCode = { code: string; label: string; aliases: string[]; method_type: string; include_in_reconciliation: boolean; status: string };
type Coa = { id: string; code: string; name: string; status: string };
type Account = { id: string; name: string; account_kind: string };
type Variance = { role_code: string; label: string; account_id: string | null; account_code: string | null; account_name: string | null };
type Form = { id: string | null; name: string; posPaymentCode: string; destinationBehavior: string; financialAccountId: string; evidencePolicy: string; locationIds: string[]; clearingAccountId: string; feeAccountId: string; status: string; sortOrder: number };

const blank: Form = { id: null, name: '', posPaymentCode: 'QRIS', destinationBehavior: 'SETTLEMENT', financialAccountId: '', evidencePolicy: 'OPTIONAL', locationIds: [], clearingAccountId: '', feeAccountId: '', status: 'ACTIVE', sortOrder: 0 };

/** Master Metode Pembayaran per outlet. Hanya Accounting yang mengubah; Finance/Owner melihat konfigurasi. */
export function PaymentMethodCenter({ canEdit }: { canEdit: boolean }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [methods, setMethods] = useState<Method[]>([]);
  const [codes, setCodes] = useState<PosCode[]>([]);
  const [coa, setCoa] = useState<Coa[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [variance, setVariance] = useState<Variance[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [newCode, setNewCode] = useState<{ code: string; label: string; methodType: string; aliases: string } | null>(null);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { loadOrg().then(o => { setCompanies(o.companies); setLocations(o.locations); setCompanyId(o.companies[0]?.id || ''); }).catch(e => setBanner({ kind: 'error', message: flowError(e) })); }, []);
  async function refresh() {
    if (!companyId) return;
    try {
      const [m, c, a] = await Promise.all([
        api<{ rows: Method[] }>(`/api/sales-flow/payment-methods?${qs({ companyId })}`), api<PosCode[]>(`/api/sales-flow/pos-codes?${qs({ companyId })}`),
        api<{ accounts: Account[] }>(`/api/cash-bank/accounts?${qs({ companyId })}`).then(r => r.accounts || []).catch(() => [] as Account[]),
      ]);
      setMethods(m.rows); setCodes(c); setAccounts(a);
      if (canEdit) {
        const [coaRows, v] = await Promise.all([api<Coa[]>(`/api/master/accounts?${qs({ companyId })}`), api<Variance[]>(`/api/sales-flow/variance-accounts?${qs({ companyId })}`)]);
        setCoa(coaRows.filter(x => x.status === 'ACTIVE')); setVariance(v);
      }
    } catch (e) { setBanner({ kind: 'error', message: flowError(e) }); }
  }
  useEffect(() => { void refresh(); }, [companyId]);

  const reconCodes = codes.filter(c => c.include_in_reconciliation && c.status === 'ACTIVE');
  const codeLabel = (code: string) => codes.find(c => c.code === code)?.label || code;
  const outlets = locations.filter(l => l.company_id === companyId);

  async function save() {
    if (!form) return;
    setBusy(true);
    try {
      const body = { companyId, name: form.name, posPaymentCode: form.posPaymentCode, destinationBehavior: form.destinationBehavior, financialAccountId: form.financialAccountId || null,
        evidencePolicy: form.evidencePolicy, locationIds: form.locationIds, status: form.status, sortOrder: form.sortOrder, clearingAccountId: form.clearingAccountId || null, feeAccountId: form.feeAccountId || null };
      await api(form.id ? `/api/sales-flow/payment-methods/${form.id}` : '/api/sales-flow/payment-methods', { method: form.id ? 'PUT' : 'POST', body: JSON.stringify(body) });
      setForm(null); setBanner({ kind: 'ok', message: 'Metode pembayaran tersimpan.' }); await refresh();
    } catch (e) { setBanner({ kind: 'error', message: flowError(e) }); } finally { setBusy(false); }
  }
  async function saveVariance(roleCode: string, accountId: string) {
    try { await api('/api/sales-flow/variance-accounts', { method: 'PUT', body: JSON.stringify({ companyId, roleCode, accountId }) }); setBanner({ kind: 'ok', message: 'Akun selisih tersimpan.' }); await refresh(); }
    catch (e) { setBanner({ kind: 'error', message: flowError(e) }); }
  }
  async function addCode() {
    if (!newCode) return;
    try { await api('/api/sales-flow/pos-codes', { method: 'POST', body: JSON.stringify({ companyId, ...newCode }) }); setNewCode(null); setBanner({ kind: 'ok', message: 'Kode pembayaran POS ditambahkan. Parser & import langsung mengenalinya.' }); await refresh(); }
    catch (e) { setBanner({ kind: 'error', message: flowError(e) }); }
  }
  const edit = (m: Method) => setForm({ id: m.id, name: m.name, posPaymentCode: m.pos_payment_code, destinationBehavior: m.destination_behavior, financialAccountId: m.financial_account_id || '', evidencePolicy: m.evidence_policy,
    locationIds: m.locations.map(l => l.id), clearingAccountId: m.clearing_account_id || '', feeAccountId: m.fee_account_id || '', status: m.status, sortOrder: m.sort_order });
  const coaSelect = (value: string, onChange: (v: string) => void, testid: string) => <select value={value} onChange={e => onChange(e.target.value)} data-testid={testid}><option value="">Pilih akun</option>{coa.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select>;

  return <div className="page-content sf-page" data-testid="payment-method-page">
    <section className="section-card">
      <div className="section-title master-heading">
        <div><span className="eyebrow">{canEdit ? 'ACCOUNTING · MASTER' : 'KONFIGURASI (LIHAT SAJA)'}</span><h3>Metode Pembayaran Outlet</h3><p>Metode aktif per outlet, kode POS, tujuan uang (Kas / Bank / Settlement), kewajiban bukti, dan mapping akun. {canEdit ? 'Hanya Accounting yang dapat mengubah.' : 'Diatur oleh Accounting — Finance menggunakan konfigurasi ini.'}</p></div>
        <div className="heading-actions">
          <select value={companyId} onChange={e => setCompanyId(e.target.value)} data-testid="pm-company-select">{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button className="secondary-button compact" onClick={() => void refresh()} data-testid="pm-refresh"><RefreshCw size={15}/></button>
          {canEdit && <button className="primary-button compact" onClick={() => setForm({ ...blank, locationIds: outlets.slice(0, 1).map(l => l.id) })} data-testid="pm-add-btn"><Plus size={15}/> Tambah Metode</button>}
        </div>
      </div>
      {banner && <div className={banner.kind === 'ok' ? 'success-banner sf-banner' : 'form-error sf-banner'} data-testid={banner.kind === 'ok' ? 'pm-success-banner' : 'pm-error-banner'}>{banner.kind === 'ok' && <CheckCircle2 size={17}/>}<span>{banner.message}</span><button className="sf-banner-close" onClick={() => setBanner(null)} data-testid="pm-banner-close">×</button></div>}

      <div className="data-table-wrap"><table className="sf-table" data-testid="pm-table"><thead><tr><th>Metode</th><th>Kode POS</th><th>Outlet</th><th>Tujuan Uang</th><th>Bukti</th><th>Mapping Akun</th><th>Status</th>{canEdit && <th></th>}</tr></thead><tbody>
        {methods.map(m => <tr key={m.id} data-testid={`pm-row-${m.code}`}>
          <td><strong>{m.name}</strong><small className="journal-meta">{m.code}</small></td><td>{codeLabel(m.pos_payment_code)}</td><td>{m.locations.map(l => l.name).join(', ') || '—'}</td>
          <td>{destinationLabel[m.destination_behavior]}{m.financial_account_name && <small className="journal-meta">{m.financial_account_name}</small>}</td>
          <td><span className={m.evidence_policy === 'REQUIRED' ? 'sf-tag warn' : 'sf-tag muted'}>{m.evidence_policy === 'REQUIRED' ? 'Wajib' : 'Opsional'}</span></td>
          <td>{canEdit && m.destination_behavior === 'SETTLEMENT' ? <small>Clearing: {m.clearing_account_code || <span className="sf-error-text">belum</span>}<br/>MDR: {m.fee_account_code || <span className="sf-error-text">belum</span>}</small>
            : <span className={m.mapping_ready ? 'sf-tag good' : 'sf-tag bad'}>{m.mapping_ready ? 'Sudah diatur' : 'Belum diatur Accounting'}</span>}</td>
          <td>{m.status === 'ACTIVE' ? <span className="sf-status good">Aktif</span> : <span className="sf-status muted">Nonaktif</span>}</td>
          {canEdit && <td><button className="icon-button" onClick={() => edit(m)} data-testid={`pm-edit-${m.code}`}><Pencil size={14}/></button></td>}
        </tr>)}
      </tbody></table>{!methods.length && <div className="empty-state"><span>Belum ada metode pembayaran.</span></div>}</div>

      {canEdit && <div className="sf-two-col">
        <div data-testid="pm-variance-section"><h4>Akun Selisih (terpisah)</h4>
          <div className="helper-box">Selisih Kas dipakai untuk kurang/lebih uang Cash Drawer vs POS. Selisih Settlement untuk beda penerimaan channel. MDR/admin fee tetap di akun biaya per metode.</div>
          {variance.map(v => <label key={v.role_code} className="sf-variance-row">{v.label}{coaSelect(v.account_id || '', id => id && void saveVariance(v.role_code, id), `pm-variance-${v.role_code}`)}{!v.account_id && <small className="sf-error-text">Belum diatur — transaksi selisih akan berstatus Needs Review.</small>}</label>)}
        </div>
        <div data-testid="pm-poscode-section"><h4>Kode Pembayaran POS (registry)</h4>
          <div className="data-table-wrap"><table className="sf-table"><thead><tr><th>Kode</th><th>Label</th><th>Alias header/nilai POS</th><th>Rekonsiliasi</th></tr></thead><tbody>
            {codes.map(c => <tr key={c.code} data-testid={`pm-poscode-${c.code}`}><td>{c.code}</td><td>{c.label}</td><td className="journal-meta">{c.aliases.join(', ')}</td><td>{c.include_in_reconciliation ? 'Ya' : 'Tidak (dikecualikan)'}</td></tr>)}
          </tbody></table></div>
          {!newCode ? <button className="secondary-button compact" onClick={() => setNewCode({ code: '', label: '', methodType: 'EWALLET', aliases: '' })} data-testid="pm-poscode-add"><Plus size={14}/> Tambah kode POS</button>
            : <div className="form-grid three"><label>Kode<input value={newCode.code} onChange={e => setNewCode({ ...newCode, code: e.target.value.toUpperCase() })} data-testid="pm-poscode-code"/></label><label>Label<input value={newCode.label} onChange={e => setNewCode({ ...newCode, label: e.target.value })} data-testid="pm-poscode-label"/></label>
              <label>Jenis<select value={newCode.methodType} onChange={e => setNewCode({ ...newCode, methodType: e.target.value })} data-testid="pm-poscode-type">{['EWALLET', 'QRIS', 'CARD', 'OJOL', 'BANK_TRANSFER', 'CASH', 'OTHER'].map(t => <option key={t}>{t}</option>)}</select></label>
              <label>Alias (pisahkan koma)<input value={newCode.aliases} onChange={e => setNewCode({ ...newCode, aliases: e.target.value })} data-testid="pm-poscode-aliases"/></label>
              <div className="sf-actions"><button className="secondary-button compact" onClick={() => setNewCode(null)} data-testid="pm-poscode-cancel">Batal</button><button className="primary-button compact" disabled={!newCode.code || !newCode.label} onClick={() => void addCode()} data-testid="pm-poscode-save">Simpan</button></div></div>}
        </div>
      </div>}
    </section>

    {form && <div className="modal-backdrop" onMouseDown={() => setForm(null)}><div className="modal-card modal-wide" onMouseDown={e => e.stopPropagation()} data-testid="pm-form-modal">
      <div className="cb-modal-head"><div><span className="eyebrow">ACCOUNTING · METODE PEMBAYARAN</span><h3>{form.id ? 'Ubah' : 'Tambah'} Metode</h3></div><button className="icon-button" onClick={() => setForm(null)} data-testid="pm-form-close"><X size={16}/></button></div>
      <div className="form-grid three">
        <label>Nama metode<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="mis. QRIS BCA" data-testid="pm-form-name"/></label>
        <label>Kode POS<select value={form.posPaymentCode} onChange={e => setForm({ ...form, posPaymentCode: e.target.value })} data-testid="pm-form-poscode">{reconCodes.map(c => <option key={c.code} value={c.code}>{c.label} ({c.code})</option>)}</select></label>
        <label>Tujuan uang<select value={form.destinationBehavior} onChange={e => setForm({ ...form, destinationBehavior: e.target.value })} data-testid="pm-form-destination">{Object.entries(destinationLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>{form.destinationBehavior === 'SETTLEMENT' ? 'Rekening penerima default' : 'Rekening Kas/Bank tujuan'}<select value={form.financialAccountId} onChange={e => setForm({ ...form, financialAccountId: e.target.value })} data-testid="pm-form-account"><option value="">{form.destinationBehavior === 'SETTLEMENT' ? '(opsional)' : 'Pilih rekening'}</option>{accounts.filter(a => form.destinationBehavior === 'CASH_DIRECT' ? a.account_kind === 'CASH' : a.account_kind !== 'CASH' || form.destinationBehavior === 'SETTLEMENT').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>Bukti foto<select value={form.evidencePolicy} onChange={e => setForm({ ...form, evidencePolicy: e.target.value })} data-testid="pm-form-evidence"><option value="OPTIONAL">Opsional</option><option value="REQUIRED">Wajib</option></select></label>
        <label>Status<select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} data-testid="pm-form-status"><option value="ACTIVE">Aktif</option><option value="INACTIVE">Nonaktif</option></select></label>
        {form.destinationBehavior === 'SETTLEMENT' && <><label>Akun clearing / piutang settlement{coaSelect(form.clearingAccountId, v => setForm({ ...form, clearingAccountId: v }), 'pm-form-clearing')}</label>
          <label>Akun biaya MDR / komisi{coaSelect(form.feeAccountId, v => setForm({ ...form, feeAccountId: v }), 'pm-form-fee')}</label></>}
      </div>
      <div className="sf-outlet-picks" data-testid="pm-form-outlets"><span>Berlaku di outlet (1 kode POS = 1 metode per outlet):</span>{outlets.map(l => <label key={l.id} className="inline-check"><input type="checkbox" checked={form.locationIds.includes(l.id)} onChange={e => setForm({ ...form, locationIds: e.target.checked ? [...form.locationIds, l.id] : form.locationIds.filter(x => x !== l.id) })} data-testid={`pm-form-outlet-${l.id}`}/> {l.name}</label>)}</div>
      <div className="modal-actions"><button className="secondary-button" onClick={() => setForm(null)} data-testid="pm-form-cancel">Batal</button><button className="primary-button" disabled={busy || !form.name || !form.locationIds.length} onClick={() => void save()} data-testid="pm-form-save"><Save size={15}/> Simpan</button></div>
    </div></div>}
  </div>;
}
