import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronLeft, Eye, FileImage, History, Paperclip, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import { api } from './api';
import { evidenceUrl, flowError, loadOrg, qs, rupiah, statusTone, today, uploadEvidence, type Company, type Location } from './salesFlowShared';
import './salesFlow.css';

type Row = { location_id: string; location_name: string; date: string; status: string; status_label: string; totals: Totals; reconciliation_number: string | null; can_verify: boolean; blocker_count: number };
type Totals = { pos: string; actual: string; difference: string; pos_sales: string; compliment: string };
type Line = {
  payment_method_id: string | null; method_name: string; pos_payment_code: string; destination_behavior: string | null; destination_label: string;
  pos_amount: string; actual_amount: string; difference: string; evidence_required: boolean; evidence_missing: boolean; configured: boolean;
  resolution: null | { id: string; reason_label: string; notes: string | null; created_by_name: string | null; valid: boolean; attachment_count: number };
  resolution_needed: boolean; settlement_status?: string; settled_amount?: string;
};
type Detail = {
  status: string; status_label: string; can_verify: boolean; blockers: string[]; lines: Line[]; totals: Totals; reasons: Record<string, string>;
  header: null | { status: string; reconciliation_number: string | null; verified_by_name: string | null; verified_at: string | null; reopen_reason: string | null; reopen_count: number; verification_round: number };
  drawers: Array<{ id: string; shift_label: string; status: string; created_by_name: string | null; lines: Array<{ id: string; payment_method_id: string; actual_amount: string; evidence_id: string | null; evidence_count: number }> }>;
  invoices: Array<{ invoiceNumber: string; net: string; payments: Record<string, string>; batchNumber: string }>;
  resolutions: Array<{ id: string; pos_payment_code: string; difference: string; reason_code: string; notes: string | null; status: string; created_at: string; created_by_name: string | null }>;
  shortages: unknown[];
};

const days = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/** Rekonsiliasi Penjualan: POS vs aktual (Cash Drawer) per outlet + tanggal, penyelesaian selisih, Verifikasi Penjualan, Reopen (Accounting). */
export function SalesReconciliationPage({ canVerify, canAccounting, canOverride }: { canVerify: boolean; canAccounting: boolean; canOverride: boolean }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [from, setFrom] = useState(days(14));
  const [to, setTo] = useState(today());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<{ locationId: string; date: string } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const [resolveFor, setResolveFor] = useState<Line | null>(null);
  const [reason, setReason] = useState('UANG_KURANG');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [allowBelowZero, setAllowBelowZero] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [history, setHistory] = useState<Array<{ action: string; created_at: string; user_name: string | null; after_data: any }> | null>(null);

  useEffect(() => { loadOrg().then(o => { setCompanies(o.companies); setLocations(o.locations); setCompanyId(o.companies[0]?.id || ''); }).catch(e => setBanner({ kind: 'error', message: flowError(e) })); }, []);

  async function loadList() {
    if (!companyId) return;
    setRows(null);
    try { setRows((await api<{ rows: Row[] }>(`/api/sales-flow/reconciliations?${qs({ companyId, locationId, from, to })}`)).rows); }
    catch (e) { setRows([]); setBanner({ kind: 'error', message: flowError(e) }); }
  }
  async function loadDetail(target = open) {
    if (!target) return;
    setDetail(null); setHistory(null);
    try { setDetail(await api<Detail>(`/api/sales-flow/reconciliations/detail?${qs({ companyId, locationId: target.locationId, date: target.date })}`)); }
    catch (e) { setBanner({ kind: 'error', message: flowError(e) }); }
  }
  useEffect(() => { void loadList(); }, [companyId, locationId, from, to]);
  useEffect(() => { void loadDetail(); }, [open?.locationId, open?.date]);

  const verified = detail?.header?.status === 'VERIFIED';
  const locName = (id: string) => locations.find(l => l.id === id)?.name || '-';

  async function submitResolve() {
    if (!open || !resolveFor?.payment_method_id) return;
    setBusy(true);
    try {
      const r = await api<{ id: string }>('/api/sales-flow/reconciliations/resolve', { method: 'POST', body: JSON.stringify({ companyId, locationId: open.locationId, date: open.date, paymentMethodId: resolveFor.payment_method_id, reasonCode: reason, notes }) });
      if (file) await uploadEvidence('SALES_RECON_RESOLUTION', r.id, file, false);
      setResolveFor(null); setNotes(''); setFile(null);
      setBanner({ kind: 'ok', message: 'Penyelesaian selisih tersimpan. Jejak selisih awal tetap tercatat.' });
      await loadDetail();
    } catch (e) { setBanner({ kind: 'error', message: flowError(e) }); } finally { setBusy(false); }
  }
  async function verify() {
    if (!open) return;
    setBusy(true);
    try {
      const r = await api<{ reconciliationNumber: string; invoiceCount: number }>('/api/sales-flow/reconciliations/verify', { method: 'POST', body: JSON.stringify({ companyId, locationId: open.locationId, date: open.date, allowBelowZero }) });
      setBanner({ kind: 'ok', message: `Penjualan terverifikasi (${r.reconciliationNumber}, ${r.invoiceCount} invoice). Cash/transfer langsung masuk Kas & Bank; QRIS/EDC/OJOL menunggu settlement.` });
      await Promise.all([loadDetail(), loadList()]);
    } catch (e) { setBanner({ kind: 'error', message: flowError(e) }); } finally { setBusy(false); }
  }
  async function reopen() {
    if (!open) return;
    setBusy(true);
    try {
      await api('/api/sales-flow/reconciliations/reopen', { method: 'POST', body: JSON.stringify({ companyId, locationId: open.locationId, date: open.date, reason: reopenReason }) });
      setReopenOpen(false); setReopenReason('');
      setBanner({ kind: 'ok', message: 'Verifikasi dibuka kembali. Transaksi lama di-VOID/di-reverse (histori tetap). Setelah koreksi, Finance wajib verifikasi ulang.' });
      await Promise.all([loadDetail(), loadList()]);
    } catch (e) { setBanner({ kind: 'error', message: flowError(e) }); } finally { setBusy(false); }
  }
  async function openHistory() {
    if (!open) return;
    try { setHistory(await api(`/api/sales-flow/reconciliations/history?${qs({ companyId, locationId: open.locationId, date: open.date })}`)); } catch (e) { setBanner({ kind: 'error', message: flowError(e) }); }
  }

  const bannerEl = banner && <div className={banner.kind === 'ok' ? 'success-banner sf-banner' : 'form-error sf-banner'} data-testid={banner.kind === 'ok' ? 'rc-success-banner' : 'rc-error-banner'}>{banner.kind === 'ok' && <CheckCircle2 size={17}/>}<span>{banner.message}</span><button className="sf-banner-close" onClick={() => setBanner(null)} data-testid="rc-banner-close">×</button></div>;

  if (open) return <div className="page-content sf-page" data-testid="recon-detail-page">
    <section className="section-card">
      <div className="section-title master-heading">
        <div><button className="secondary-button compact sf-back" onClick={() => { setOpen(null); setDetail(null); void loadList(); }} data-testid="rc-back"><ChevronLeft size={15}/> Daftar</button>
          <span className="eyebrow">REKONSILIASI PENJUALAN</span><h3>{locName(open.locationId)} · {open.date}</h3>
          {detail && <p><span className={`sf-status ${statusTone[detail.status] || 'muted'}`} data-testid="rc-detail-status">{detail.status_label}</span>{detail.header?.reconciliation_number && <span className="journal-meta"> {detail.header.reconciliation_number}{detail.header.verified_by_name ? ` · diverifikasi ${detail.header.verified_by_name}` : ''}</span>}</p>}</div>
        <div className="heading-actions">
          <button className="secondary-button compact" onClick={() => void openHistory()} data-testid="rc-history-btn"><History size={14}/> Audit Trail</button>
          <button className="secondary-button compact" onClick={() => void loadDetail()} data-testid="rc-detail-refresh"><RefreshCw size={15}/></button>
          {canAccounting && verified && <button className="secondary-button compact sf-danger" onClick={() => setReopenOpen(true)} data-testid="rc-reopen-btn"><RotateCcw size={14}/> Reopen (Accounting)</button>}
          {canVerify && !verified && <button className="primary-button compact" disabled={busy || !detail?.can_verify} onClick={() => void verify()} data-testid="rc-verify-btn"><ShieldCheck size={15}/> Verifikasi Penjualan</button>}
        </div>
      </div>
      {bannerEl}
      {!detail && <div className="empty-state"><span>Memuat rekonsiliasi...</span></div>}
      {detail && <>
        {detail.header?.status === 'REOPENED' && <div className="helper-box sf-warn" data-testid="rc-reopened-info"><AlertTriangle size={15}/> Dibuka kembali oleh Accounting: “{detail.header.reopen_reason}”. Lakukan koreksi lalu verifikasi ulang.</div>}
        <div className="cb-summary-strip">
          <div><span>Penjualan POS (net)</span><strong data-testid="rc-pos-sales">{rupiah(detail.totals.pos_sales)}</strong></div>
          <div><span>POS direkonsiliasi</span><strong data-testid="rc-pos-total">{rupiah(detail.totals.pos)}</strong></div>
          <div><span>Aktual (Cash Drawer)</span><strong data-testid="rc-actual-total">{rupiah(detail.totals.actual)}</strong></div>
          <div><span>Selisih</span><strong className={Number(detail.totals.difference) ? 'cb-text-out' : ''} data-testid="rc-diff-total">{rupiah(detail.totals.difference)}</strong></div>
        </div>
        {Number(detail.totals.compliment) > 0 && <div className="helper-box" data-testid="rc-compliment-info">Compliment {rupiah(detail.totals.compliment)} tercatat di penjualan, tetapi tidak ikut rekonsiliasi dan tidak masuk Kas/Bank.</div>}
        <div className="data-table-wrap"><table className="sf-table" data-testid="rc-lines-table"><thead><tr><th>Metode Pembayaran</th><th>Tujuan Uang</th><th className="numeric">POS</th><th className="numeric">Aktual</th><th className="numeric">Selisih</th><th>Bukti</th><th>Penyelesaian / Settlement</th></tr></thead><tbody>
          {detail.lines.map(l => { const diff = Number(l.difference); return <tr key={l.payment_method_id || l.pos_payment_code} className={!l.configured || l.resolution_needed ? 'sf-row-bad' : ''} data-testid={`rc-line-${l.pos_payment_code}`}>
            <td><strong>{l.method_name}</strong><small className="journal-meta">Kode POS {l.pos_payment_code}</small></td>
            <td>{l.destination_label}</td>
            <td className="numeric">{rupiah(l.pos_amount)}</td><td className="numeric">{rupiah(l.actual_amount)}</td>
            <td className={`numeric ${diff ? 'cb-text-out' : ''}`} data-testid={`rc-diff-${l.pos_payment_code}`}>{rupiah(l.difference)}</td>
            <td>{l.evidence_missing ? <span className="sf-tag bad">Wajib, belum ada</span> : l.evidence_required ? <span className="sf-tag good">Lengkap</span> : <span className="sf-tag muted">Opsional</span>}</td>
            <td>{!l.configured ? <span className="sf-tag bad">Belum dikonfigurasi Accounting</span>
              : verified ? (l.settlement_status && l.settlement_status !== 'NOT_REQUIRED' ? <span className={`sf-status ${statusTone[l.settlement_status] || 'muted'}`}>{({ OUTSTANDING: 'Menunggu settlement', PARTIAL: 'Settlement sebagian', SETTLED: 'Settled' } as Record<string, string>)[l.settlement_status]}</span> : l.destination_behavior === 'SETTLEMENT' || Number(l.actual_amount) <= 0 ? <span className="sf-tag muted">—</span> : <span className="sf-tag good">Masuk Kas & Bank</span>)
              : l.resolution ? <span className={l.resolution.valid ? 'sf-tag info' : 'sf-tag bad'}>{l.resolution.reason_label}{l.resolution.notes ? ` — ${l.resolution.notes}` : ''}{!l.resolution.valid ? ' (nilai berubah, selesaikan ulang)' : ''}</span>
              : diff ? (canVerify ? <button className="secondary-button compact" onClick={() => { setResolveFor(l); setReason(diff < 0 ? 'UANG_KURANG' : 'UANG_LEBIH'); }} data-testid={`rc-resolve-${l.pos_payment_code}`}>Selesaikan selisih</button> : <span className="sf-tag bad">Ada selisih</span>)
              : <span className="sf-tag good">Cocok</span>}</td>
          </tr>; })}
          {!detail.lines.length && <tr><td colSpan={7}>Belum ada metode pembayaran untuk outlet ini.</td></tr>}
        </tbody></table></div>
        {!verified && detail.blockers.length > 0 && <div className="form-error sf-blockers" data-testid="rc-blockers"><AlertTriangle size={15}/><div><strong>Belum bisa diverifikasi:</strong><ul>{detail.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></div></div>}
        {!verified && detail.shortages.length > 0 && canOverride && <label className="inline-check standalone" data-testid="rc-allow-below-zero"><input type="checkbox" checked={allowBelowZero} onChange={e => setAllowBelowZero(e.target.checked)}/> Izinkan stok minus ({detail.shortages.length} item)</label>}

        <div className="sf-two-col">
          <div><h4>Cash Drawer ({detail.drawers.length} shift)</h4>
            <div className="data-table-wrap"><table className="sf-table"><thead><tr><th>Shift</th><th>Diisi</th><th>Rincian</th></tr></thead><tbody>
              {detail.drawers.map(d => <tr key={d.id}><td>{d.shift_label || 'Tanpa shift'}</td><td>{d.created_by_name || '-'}</td><td>{d.lines.map(l => { const m = detail.lines.find(x => x.payment_method_id === l.payment_method_id); return <span key={l.id} className="sf-inline">{m?.method_name || '-'} {rupiah(l.actual_amount)}{l.evidence_id && <a href={evidenceUrl(l.evidence_id)} target="_blank" rel="noreferrer" title="Lihat bukti" data-testid={`rc-evidence-${l.id}`}><FileImage size={13}/></a>}</span>; })}</td></tr>)}
              {!detail.drawers.length && <tr><td colSpan={3}>Outlet belum mengisi Cash Drawer.</td></tr>}
            </tbody></table></div></div>
          <div><h4>Invoice POS ({detail.invoices.length})</h4>
            <div className="data-table-wrap sf-scroll"><table className="sf-table"><thead><tr><th>Invoice</th><th>Pembayaran</th><th className="numeric">Net</th></tr></thead><tbody>
              {detail.invoices.map(i => <tr key={i.invoiceNumber}><td>{i.invoiceNumber}<small className="journal-meta">{i.batchNumber}</small></td><td>{Object.entries(i.payments).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${k} ${rupiah(v)}`).join(' · ')}</td><td className="numeric">{rupiah(i.net)}</td></tr>)}
              {!detail.invoices.length && <tr><td colSpan={3}>{verified ? 'Invoice sudah menjadi transaksi penjualan terverifikasi.' : 'Data POS belum diimport Finance.'}</td></tr>}
            </tbody></table></div></div>
        </div>
        {detail.resolutions.length > 0 && <><h4>Riwayat penyelesaian selisih</h4><div className="data-table-wrap"><table className="sf-table" data-testid="rc-resolutions"><thead><tr><th>Waktu</th><th>Kode POS</th><th className="numeric">Selisih</th><th>Alasan</th><th>Oleh</th><th>Status</th></tr></thead><tbody>
          {detail.resolutions.map(r => <tr key={r.id}><td>{new Date(r.created_at).toLocaleString('id-ID')}</td><td>{r.pos_payment_code}</td><td className="numeric">{rupiah(r.difference)}</td><td>{detail.reasons[r.reason_code] || r.reason_code}{r.notes ? ` — ${r.notes}` : ''}</td><td>{r.created_by_name || '-'}</td><td>{r.status === 'ACTIVE' ? 'Aktif' : 'Digantikan'}</td></tr>)}
        </tbody></table></div></>}
        {history && <><h4>Audit trail</h4><div className="data-table-wrap" data-testid="rc-history"><table className="sf-table"><thead><tr><th>Waktu</th><th>User</th><th>Aktivitas</th><th>Keterangan</th></tr></thead><tbody>
          {history.map((h, i) => <tr key={i}><td>{new Date(h.created_at).toLocaleString('id-ID')}</td><td>{h.user_name || '-'}</td><td>{({ RESOLVE_DIFFERENCE: 'Penyelesaian selisih', FINANCE_VERIFY_SALES: 'Verifikasi Penjualan', REOPEN_SALES_VERIFICATION: 'Reopen (Accounting)' } as Record<string, string>)[h.action] || h.action}</td>
            <td className="journal-meta">{h.after_data?.reason || h.after_data?.number || h.after_data?.reasonCode || ''}</td></tr>)}
          {!history.length && <tr><td colSpan={4}>Belum ada aktivitas.</td></tr>}
        </tbody></table></div></>}
      </>}
    </section>

    {resolveFor && <div className="modal-backdrop" onMouseDown={() => setResolveFor(null)}><div className="modal-card" onMouseDown={e => e.stopPropagation()} data-testid="rc-resolve-modal">
      <div className="cb-modal-head"><div><span className="eyebrow">PENYELESAIAN SELISIH</span><h3>{resolveFor.method_name}: {rupiah(resolveFor.difference)}</h3></div></div>
      <div className="form-grid">
        <label>Alasan<select value={reason} onChange={e => setReason(e.target.value)} data-testid="rc-resolve-reason">{Object.entries(detail?.reasons || {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Catatan{reason === 'LAINNYA' ? ' (wajib)' : ''}<textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} data-testid="rc-resolve-notes"/></label>
        <label className="sf-upload"><Paperclip size={14}/> {file ? file.name : 'Lampiran (opsional, foto/PDF)'}<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => setFile(e.target.files?.[0] || null)} data-testid="rc-resolve-file"/></label>
      </div>
      <div className="helper-box">Selisih tidak dihapus: nilai POS, aktual dan selisih awal tetap tersimpan. Saat verifikasi, selisih kas dicatat otomatis ke akun Selisih Kas yang diatur Accounting.</div>
      <div className="modal-actions"><button className="secondary-button" onClick={() => setResolveFor(null)} data-testid="rc-resolve-cancel">Batal</button><button className="primary-button" disabled={busy || (reason === 'LAINNYA' && !notes.trim())} onClick={() => void submitResolve()} data-testid="rc-resolve-submit">Simpan Penyelesaian</button></div>
    </div></div>}

    {reopenOpen && <div className="modal-backdrop" onMouseDown={() => setReopenOpen(false)}><div className="modal-card" onMouseDown={e => e.stopPropagation()} data-testid="rc-reopen-modal">
      <div className="cb-modal-head"><div><span className="eyebrow">ACCOUNTING CONTROL</span><h3>Reopen Verifikasi Penjualan</h3></div></div>
      <div className="helper-box sf-warn">Transaksi penjualan, selisih dan mutasi Kas & Bank dari verifikasi ini akan di-VOID / di-reverse (histori tetap). Stok penjualan dikembalikan. Bila sudah ada settlement, batalkan settlement terlebih dahulu di menu Settlement.</div>
      <label>Alasan reopen (wajib)<textarea rows={3} value={reopenReason} onChange={e => setReopenReason(e.target.value)} data-testid="rc-reopen-reason"/></label>
      <div className="modal-actions"><button className="secondary-button" onClick={() => setReopenOpen(false)} data-testid="rc-reopen-cancel">Batal</button><button className="primary-button sf-danger-fill" disabled={busy || reopenReason.trim().length < 5} onClick={() => void reopen()} data-testid="rc-reopen-submit">Reopen</button></div>
    </div></div>}
  </div>;

  return <div className="page-content sf-page" data-testid="recon-list-page">
    <section className="section-card">
      <div className="section-title master-heading">
        <div><span className="eyebrow">FINANCE CONTROL</span><h3>Rekonsiliasi Penjualan</h3><p>Bandingkan penjualan POS dengan uang/aktual Cash Drawer per outlet & tanggal. Selesaikan selisih, lalu Verifikasi Penjualan — Kas & Bank dan Accounting Source terbentuk otomatis.</p></div>
        <div className="heading-actions">
          <select value={companyId} onChange={e => setCompanyId(e.target.value)} data-testid="rc-company-select">{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button className="secondary-button compact" onClick={() => void loadList()} data-testid="rc-refresh"><RefreshCw size={15}/></button>
        </div>
      </div>
      {bannerEl}
      <div className="cb-toolbar">
        <label className="cb-inline-label">Outlet<select value={locationId} onChange={e => setLocationId(e.target.value)} data-testid="rc-filter-location"><option value="">Semua outlet</option>{locations.filter(l => l.company_id === companyId).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label className="cb-inline-label">Dari<input type="date" value={from} onChange={e => setFrom(e.target.value)} data-testid="rc-filter-from"/></label>
        <label className="cb-inline-label">Sampai<input type="date" value={to} onChange={e => setTo(e.target.value)} data-testid="rc-filter-to"/></label>
      </div>
      <div className="data-table-wrap"><table className="sf-table" data-testid="rc-list-table"><thead><tr><th>Tanggal</th><th>Outlet</th><th className="numeric">POS</th><th className="numeric">Aktual</th><th className="numeric">Selisih</th><th>Status</th><th>No. Rekonsiliasi</th><th></th></tr></thead><tbody>
        {rows?.map(r => <tr key={`${r.location_id}-${r.date}`} data-testid={`rc-row-${r.date}-${r.location_name}`}>
          <td>{r.date}</td><td>{r.location_name}</td><td className="numeric">{rupiah(r.totals.pos)}</td><td className="numeric">{rupiah(r.totals.actual)}</td>
          <td className={`numeric ${Number(r.totals.difference) ? 'cb-text-out' : ''}`}>{rupiah(r.totals.difference)}</td>
          <td><span className={`sf-status ${statusTone[r.status] || 'muted'}`}>{r.status_label}</span></td><td>{r.reconciliation_number || '—'}</td>
          <td><button className="icon-button" onClick={() => setOpen({ locationId: r.location_id, date: r.date })} title="Buka" data-testid={`rc-open-${r.date}-${r.location_id}`}><Eye size={14}/></button></td>
        </tr>)}
      </tbody></table>
        {rows === null && <div className="empty-state"><span>Memuat...</span></div>}
        {rows?.length === 0 && <div className="empty-state" data-testid="rc-empty"><ShieldCheck size={30}/><strong>Belum ada data penjualan</strong><span>Import POS (menu Penjualan) dan Cash Drawer outlet akan muncul di sini.</span></div>}
      </div>
    </section>
  </div>;
}
