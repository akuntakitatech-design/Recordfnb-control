import { useEffect, useMemo, useState } from 'react';
import { Ban, CheckCircle2, HandCoins, Paperclip, RefreshCw } from 'lucide-react';
import { api } from './api';
import { flowError, loadOrg, qs, rupiah, settlementLabel, statusTone, today, uploadEvidence, type Company } from './salesFlowShared';
import './salesFlow.css';

type Outstanding = { id: string; reconciliation_number: string; business_date: string; location_id: string; location_name: string; payment_method_id: string; method_name: string; pos_payment_code: string; expected_amount: string; settled_amount: string; remaining: string; settlement_status: string; default_financial_account_id: string | null };
type Settlement = { id: string; transaction_number: string; transaction_date: string; reference_number: string | null; gross_amount: string; net_amount: string; fee_amount: string | null; difference_amount: string | null; source_name: string; accounting_status: string; financial_account_name: string | null; location_name: string | null; attachment_count: number; workflow_status: string; allocation_summary: string | null };
type Account = { id: string; name: string; account_kind: string };

/** Settlement QRIS / EDC / OJOL: outstanding per metode, catat penerimaan bank (full/partial, MDR, selisih). Batal settlement = Accounting. */
export function SalesSettlementPage({ canCreate, canAccounting }: { canCreate: boolean; canAccounting: boolean }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [rows, setRows] = useState<Outstanding[]>([]);
  const [history, setHistory] = useState<Settlement[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [methodFilter, setMethodFilter] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ settlementDate: today(), financialAccountId: '', reference: '', netAmount: '', feeAmount: '', notes: '', acceptDifference: false });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const [cancelFor, setCancelFor] = useState<Settlement | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  useEffect(() => { loadOrg().then(o => { setCompanies(o.companies); setCompanyId(o.companies[0]?.id || ''); }).catch(e => setBanner({ kind: 'error', message: flowError(e) })); }, []);
  async function refresh() {
    if (!companyId) return;
    try {
      const [o, h, a] = await Promise.all([
        api<Outstanding[]>(`/api/sales-flow/settlements/outstanding?${qs({ companyId })}`),
        api<Settlement[]>(`/api/sales-flow/settlements?${qs({ companyId })}`),
        api<{ accounts: Account[] }>(`/api/cash-bank/accounts?${qs({ companyId })}`).then(r => r.accounts || []).catch(() => [] as Account[]),
      ]);
      setRows(o); setHistory(h); setAccounts(a.filter(x => ['BANK', 'EWALLET', 'CASH'].includes(x.account_kind)));
    } catch (e) { setBanner({ kind: 'error', message: flowError(e) }); }
  }
  useEffect(() => { void refresh(); setPicked({}); }, [companyId]);

  const methods = useMemo(() => [...new Map(rows.map(r => [r.payment_method_id, r.method_name])).entries()], [rows]);
  const visible = rows.filter(r => !methodFilter || r.payment_method_id === methodFilter);
  const pickedRows = rows.filter(r => picked[r.id] !== undefined);
  const gross = pickedRows.reduce((s, r) => s + Number(picked[r.id] || 0), 0);
  const net = Number(form.netAmount || 0); const fee = Number(form.feeAmount || 0);
  const difference = gross - net - fee;
  const mixed = new Set(pickedRows.map(r => r.payment_method_id)).size > 1 || new Set(pickedRows.map(r => r.location_id)).size > 1;

  function toggle(r: Outstanding) {
    setPicked(p => { const n = { ...p }; if (n[r.id] !== undefined) delete n[r.id]; else n[r.id] = String(Number(r.remaining)); return n; });
    if (!form.financialAccountId && r.default_financial_account_id) setForm(f => ({ ...f, financialAccountId: r.default_financial_account_id! }));
  }
  async function save() {
    setBusy(true); setBanner(null);
    try {
      const r = await api<{ id: string; transactionNumber: string; difference: string }>('/api/sales-flow/settlements', { method: 'POST', body: JSON.stringify({
        companyId, ...form, netAmount: net, feeAmount: fee, allocations: pickedRows.map(x => ({ lineId: x.id, grossAmount: Number(picked[x.id] || 0) })),
      }) });
      if (file) await uploadEvidence('SALES_SETTLEMENT', r.id, file, false);
      setBanner({ kind: 'ok', message: `Settlement ${r.transactionNumber} tercatat. Uang masuk tampil di Kas & Bank; jurnal clearing/MDR terbentuk otomatis.` });
      setPicked({}); setFile(null); setForm(f => ({ ...f, reference: '', netAmount: '', feeAmount: '', notes: '', acceptDifference: false }));
      await refresh();
    } catch (e) { setBanner({ kind: 'error', message: flowError(e) }); } finally { setBusy(false); }
  }
  async function cancel() {
    if (!cancelFor) return;
    setBusy(true);
    try {
      await api(`/api/sales-flow/settlements/${cancelFor.id}/cancel`, { method: 'POST', body: JSON.stringify({ companyId, reason: cancelReason }) });
      setBanner({ kind: 'ok', message: `Settlement ${cancelFor.transaction_number} dibatalkan. Outstanding dipulihkan; histori tetap tersimpan.` });
      setCancelFor(null); setCancelReason(''); await refresh();
    } catch (e) { setBanner({ kind: 'error', message: flowError(e) }); } finally { setBusy(false); }
  }

  return <div className="page-content sf-page" data-testid="settlement-page">
    <section className="section-card">
      <div className="section-title master-heading">
        <div><span className="eyebrow">FINANCE CONTROL</span><h3>Settlement QRIS / EDC / OJOL</h3><p>Penjualan non-tunai yang sudah diverifikasi menunggu uang masuk bank. Pilih outstanding, isi nominal yang diterima bank dan potongan MDR/komisi — tanpa input penjualan kedua.</p></div>
        <div className="heading-actions">
          <select value={companyId} onChange={e => setCompanyId(e.target.value)} data-testid="st-company-select">{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button className="secondary-button compact" onClick={() => void refresh()} data-testid="st-refresh"><RefreshCw size={15}/></button>
        </div>
      </div>
      {banner && <div className={banner.kind === 'ok' ? 'success-banner sf-banner' : 'form-error sf-banner'} data-testid={banner.kind === 'ok' ? 'st-success-banner' : 'st-error-banner'}>{banner.kind === 'ok' && <CheckCircle2 size={17}/>}<span>{banner.message}</span><button className="sf-banner-close" onClick={() => setBanner(null)} data-testid="st-banner-close">×</button></div>}

      <div className="tabs finance-tabs">{[['', 'Semua metode'], ...methods].map(([id, name]) => <button key={id} className={methodFilter === id ? 'active' : ''} onClick={() => setMethodFilter(id)} data-testid={`st-method-tab-${name}`}>{name}{id && ` (${rows.filter(r => r.payment_method_id === id).length})`}</button>)}</div>
      <div className="data-table-wrap"><table className="sf-table" data-testid="st-outstanding-table"><thead><tr><th></th><th>Tanggal</th><th>Outlet</th><th>Metode</th><th className="numeric">Seharusnya</th><th className="numeric">Sudah diterima</th><th className="numeric">Sisa</th><th>Status</th>{canCreate && <th className="numeric">Dialokasikan</th>}</tr></thead><tbody>
        {visible.map(r => <tr key={r.id} className={picked[r.id] !== undefined ? 'sf-row-picked' : ''} data-testid={`st-row-${r.business_date.slice(0, 10)}-${r.pos_payment_code}`}>
          <td>{canCreate && <input type="checkbox" checked={picked[r.id] !== undefined} onChange={() => toggle(r)} data-testid={`st-pick-${r.id}`}/>}</td>
          <td>{r.business_date.slice(0, 10)}<small className="journal-meta">{r.reconciliation_number}</small></td><td>{r.location_name}</td><td>{r.method_name}</td>
          <td className="numeric">{rupiah(r.expected_amount)}</td><td className="numeric">{rupiah(r.settled_amount)}</td><td className="numeric"><strong>{rupiah(r.remaining)}</strong></td>
          <td><span className={`sf-status ${statusTone[r.settlement_status] || 'muted'}`}>{settlementLabel[r.settlement_status]}</span></td>
          {canCreate && <td className="numeric">{picked[r.id] !== undefined && <input className="number-input sf-alloc" type="number" min="0" value={picked[r.id]} onChange={e => setPicked(p => ({ ...p, [r.id]: e.target.value }))} data-testid={`st-alloc-${r.id}`}/>}</td>}
        </tr>)}
      </tbody></table>{!visible.length && <div className="empty-state" data-testid="st-empty"><HandCoins size={30}/><strong>Tidak ada outstanding settlement</strong><span>Semua penjualan QRIS/EDC/OJOL yang terverifikasi sudah diterima.</span></div>}</div>

      {canCreate && pickedRows.length > 0 && <div className="sf-settle-form" data-testid="st-form">
        <h4>Catat penerimaan settlement</h4>
        {mixed && <div className="form-error" data-testid="st-mixed-warning">Satu penerimaan hanya untuk satu metode pembayaran dan satu outlet.</div>}
        <div className="form-grid three">
          <label>Tanggal diterima<input type="date" value={form.settlementDate} onChange={e => setForm({ ...form, settlementDate: e.target.value })} data-testid="st-date"/></label>
          <label>Rekening penerima<select value={form.financialAccountId} onChange={e => setForm({ ...form, financialAccountId: e.target.value })} data-testid="st-account"><option value="">Pilih rekening</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label>No. referensi / mutasi<input value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} data-testid="st-reference"/></label>
          <label>Nominal diterima bank<input className="number-input" type="number" min="0" value={form.netAmount} onChange={e => setForm({ ...form, netAmount: e.target.value })} data-testid="st-net"/></label>
          <label>MDR / biaya admin / komisi<input className="number-input" type="number" min="0" value={form.feeAmount} onChange={e => setForm({ ...form, feeAmount: e.target.value })} data-testid="st-fee"/></label>
          <label className="sf-upload"><Paperclip size={14}/> {file ? file.name : 'Bukti mutasi / laporan (foto/PDF)'}<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => setFile(e.target.files?.[0] || null)} data-testid="st-file"/></label>
        </div>
        <div className="cb-summary-strip">
          <div><span>Penjualan dialokasikan</span><strong data-testid="st-gross">{rupiah(gross)}</strong></div>
          <div><span>Diterima bank</span><strong>{rupiah(net)}</strong></div><div><span>MDR / biaya</span><strong>{rupiah(fee)}</strong></div>
          <div><span>Selisih</span><strong className={Math.abs(difference) > 0.5 ? 'cb-text-out' : ''} data-testid="st-difference">{rupiah(difference)}</strong></div>
        </div>
        {Math.abs(difference) > 0.5 && <label className="inline-check standalone" data-testid="st-accept-difference"><input type="checkbox" checked={form.acceptDifference} onChange={e => setForm({ ...form, acceptDifference: e.target.checked })}/> Catat {rupiah(difference)} sebagai selisih settlement (akun Selisih Settlement, bukan MDR)</label>}
        <label>Catatan<input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} data-testid="st-notes"/></label>
        <div className="sf-actions"><button className="primary-button compact" disabled={busy || mixed || !form.financialAccountId || (Math.abs(difference) > 0.5 && !form.acceptDifference)} onClick={() => void save()} data-testid="st-save-btn"><HandCoins size={15}/> Simpan Settlement</button></div>
      </div>}

      <h4>Riwayat settlement</h4>
      <div className="data-table-wrap"><table className="sf-table" data-testid="st-history-table"><thead><tr><th>Tanggal</th><th>No.</th><th>Metode</th><th>Outlet</th><th>Rekening</th><th className="numeric">Penjualan</th><th className="numeric">Diterima</th><th className="numeric">MDR</th><th className="numeric">Selisih</th><th>Status</th><th></th></tr></thead><tbody>
        {history.map(h => <tr key={h.id} className={h.workflow_status === 'CANCELLED' ? 'sf-row-cancelled' : ''} data-testid={`st-history-${h.transaction_number}`}>
          <td>{h.transaction_date}</td><td><strong>{h.transaction_number}</strong>{h.reference_number && <small className="journal-meta">{h.reference_number}</small>}</td><td>{h.source_name.replace(/^Settlement /, '')}<small className="journal-meta">{h.allocation_summary}</small></td><td>{h.location_name || '-'}</td><td>{h.financial_account_name || '-'}</td>
          <td className="numeric">{rupiah(h.gross_amount)}</td><td className="numeric">{rupiah(h.net_amount)}</td><td className="numeric">{rupiah(h.fee_amount)}</td><td className="numeric">{rupiah(h.difference_amount)}</td>
          <td>{h.workflow_status === 'CANCELLED' ? <span className="sf-status bad">Dibatalkan</span> : <span className="sf-status good">Diterima</span>}{h.attachment_count > 0 && <span className="attachment-count"><Paperclip size={11}/>{h.attachment_count}</span>}</td>
          <td>{canAccounting && h.workflow_status !== 'CANCELLED' && <button className="icon-button danger" title="Batalkan settlement (Accounting)" onClick={() => setCancelFor(h)} data-testid={`st-cancel-${h.transaction_number}`}><Ban size={14}/></button>}</td>
        </tr>)}
      </tbody></table>{!history.length && <div className="empty-state"><span>Belum ada settlement.</span></div>}</div>
    </section>

    {cancelFor && <div className="modal-backdrop" onMouseDown={() => setCancelFor(null)}><div className="modal-card" onMouseDown={e => e.stopPropagation()} data-testid="st-cancel-modal">
      <div className="cb-modal-head"><div><span className="eyebrow">ACCOUNTING CONTROL</span><h3>Batalkan {cancelFor.transaction_number}</h3></div></div>
      <div className="helper-box sf-warn">Transaksi menjadi Dibatalkan (tidak dihapus), jurnal di-VOID/di-reverse, dan sisa outstanding settlement dipulihkan.</div>
      <label>Alasan (wajib)<textarea rows={3} value={cancelReason} onChange={e => setCancelReason(e.target.value)} data-testid="st-cancel-reason"/></label>
      <div className="modal-actions"><button className="secondary-button" onClick={() => setCancelFor(null)} data-testid="st-cancel-close">Tutup</button><button className="primary-button sf-danger-fill" disabled={busy || cancelReason.trim().length < 5} onClick={() => void cancel()} data-testid="st-cancel-submit">Batalkan Settlement</button></div>
    </div></div>}
  </div>;
}
