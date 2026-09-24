import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Eye, FileText, Lock, ShieldCheck, Unlock, X, XCircle } from 'lucide-react';
import { api } from './api';
import {
  type CashAccount, type LedgerRow, type Payable, downloadFile, errorText, payableStatusLabel, qs, rupiah, today, typeLabel, verifyUrl, workflowLabel,
} from './cashBankShared';

type Notify = (kind: 'ok' | 'error', message: string) => void;

// ---------------------------------------------------------------------------
// Dialog konfirmasi generik (dengan alasan opsional)
// ---------------------------------------------------------------------------
export function ConfirmDialog({ title, message, confirmLabel, danger, withReason, onCancel, onConfirm }: {
  title: string; message: React.ReactNode; confirmLabel: string; danger?: boolean; withReason?: boolean; onCancel: () => void; onConfirm: (reason: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return <div className="modal-backdrop" onMouseDown={onCancel}><div className="modal-card" onMouseDown={e => e.stopPropagation()} data-testid="cb-confirm-dialog">
    <div><span className="eyebrow">KONFIRMASI</span><h3>{title}</h3></div>
    <div className={danger ? 'cb-warning' : 'helper-box'}>{message}</div>
    {withReason && <label>Alasan<input value={reason} onChange={e => setReason(e.target.value)} placeholder="Wajib diisi" data-testid="cb-confirm-reason"/></label>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel} data-testid="cb-confirm-cancel">Kembali</button>
      <button type="button" className={danger ? 'primary-button cb-danger-button' : 'primary-button'} disabled={busy || (withReason && !reason.trim())} onClick={async () => { setBusy(true); try { await onConfirm(reason); } finally { setBusy(false); } }} data-testid="cb-confirm-ok">{busy ? 'Memproses...' : confirmLabel}</button></div>
  </div></div>;
}

// ---------------------------------------------------------------------------
// Detail transaksi (sumber untuk verifikasi Finance & review Accounting)
// ---------------------------------------------------------------------------
type TxDetail = Record<string, any> & { lines: Array<Record<string, any>>; allocations: Array<Record<string, any>>; attachments: Array<Record<string, any>> };

export function TransactionDetailModal({ transactionId, onClose }: { transactionId: string; onClose: () => void }) {
  const [tx, setTx] = useState<TxDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<TxDetail>(`/api/cash-bank/transactions/${transactionId}`).then(setTx).catch(err => setError(errorText(err))); }, [transactionId]);
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal-card modal-wide cb-detail-modal" onMouseDown={e => e.stopPropagation()} data-testid="cb-detail-modal">
    <div className="cb-modal-head"><div><span className="eyebrow">DETAIL TRANSAKSI</span><h3>{tx?.transaction_number || 'Memuat...'}</h3></div><button type="button" className="icon-button" onClick={onClose} data-testid="cb-detail-close"><X size={16}/></button></div>
    {error && <div className="form-error">{error}</div>}
    {tx && <>
      <div className="cb-detail-grid">
        <div><span>Jenis</span><strong>{typeLabel[tx.transaction_type] || tx.transaction_type}{tx.cash_out_type === 'DEBT_PAYMENT' ? ' · Bayar Hutang' : tx.cash_out_type === 'OPERATIONAL_EXPENSE' ? ' · Operasional' : ''}</strong></div>
        <div><span>Tanggal</span><strong>{tx.transaction_date}</strong></div>
        <div><span>Nominal</span><strong>{rupiah(tx.grand_total)}</strong></div>
        <div><span>Kas / Bank</span><strong>{tx.financial_account_name || '—'}{tx.transfer_to_financial_account_name ? ` → ${tx.transfer_to_financial_account_name}` : ''}</strong></div>
        <div><span>Supplier / Penerima</span><strong>{tx.partner_name || tx.payee_name || tx.source_name || '—'}</strong></div>
        <div><span>Status</span><strong>{workflowLabel[tx.workflow_status] || tx.workflow_status} · {tx.accounting_status}</strong></div>
        <div><span>Referensi</span><strong>{tx.reference_number || '—'}</strong></div>
        <div><span>Jurnal</span><strong data-testid="cb-detail-journal">{tx.journal_number ? `${tx.journal_number} (${tx.journal_status})` : 'Belum terbentuk'}</strong></div>
        <div><span>Dibuat</span><strong>{tx.created_by_name || '—'}</strong></div>
      </div>
      {tx.notes && <div className="helper-box">{tx.notes}</div>}
      {tx.lines.length > 0 && <div className="data-table-wrap"><table><thead><tr><th>#</th><th>Keterangan</th><th>Kategori</th><th>Akun</th><th className="numeric">Nominal</th></tr></thead><tbody>{tx.lines.map(l => <tr key={l.id}><td>{l.line_no}</td><td>{l.description || '—'}</td><td>{l.expense_category_name || '—'}</td><td>{l.account_code ? `${l.account_code} ${l.account_name}` : <span className="muted-cell">otomatis</span>}</td><td className="numeric">{rupiah(l.line_total)}</td></tr>)}</tbody></table></div>}
      {tx.allocations.length > 0 && <div className="data-table-wrap"><table><thead><tr><th>Invoice</th><th>Invoice Supplier</th><th className="numeric">Total Invoice</th><th className="numeric">Dibayar</th><th>Status Invoice</th></tr></thead><tbody>{tx.allocations.map(a => <tr key={a.id}><td><strong>{a.invoice_number}</strong></td><td>{a.invoice_reference || '—'}</td><td className="numeric">{rupiah(a.invoice_total)}</td><td className="numeric">{rupiah(a.amount)}</td><td>{a.payment_status}</td></tr>)}</tbody></table></div>}
      <div className="cb-attachments"><strong>Bukti</strong>{tx.attachments.length === 0 ? <span className="muted-cell">Tidak ada bukti</span> : tx.attachments.map(a => <a key={a.id} href={`/api/client-transactions/${tx.id}/attachments/${a.id}/file`} target="_blank" rel="noreferrer" data-testid={`cb-detail-attachment-${a.id}`}><FileText size={14}/> {a.file_name}</a>)}</div>
    </>}
  </div></div>;
}

// ---------------------------------------------------------------------------
// Tab Hutang Supplier + histori pembayaran
// ---------------------------------------------------------------------------
export function PayablesPanel({ companyId, onPay, notify, refreshKey }: { companyId: string; onPay: (p: Payable) => void; notify: Notify; refreshKey: number }) {
  const [rows, setRows] = useState<Payable[]>([]);
  const [payments, setPayments] = useState<Array<Record<string, any>>>([]);
  const [scope, setScope] = useState<'OPEN' | 'ALL'>('OPEN');
  const [supplier, setSupplier] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailId, setDetailId] = useState('');

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api<Payable[]>(`/api/cash-bank/payables?companyId=${encodeURIComponent(companyId)}&scope=${scope}`),
      api<Array<Record<string, any>>>(`/api/cash-bank/supplier-payments?companyId=${encodeURIComponent(companyId)}`),
    ]).then(([p, h]) => { setRows(p); setPayments(h); }).catch(err => notify('error', errorText(err))).finally(() => setLoading(false));
  }, [companyId, scope, refreshKey]);

  const suppliers = useMemo(() => [...new Map(rows.map(r => [r.partner_id, r.supplier_name || '—'])).entries()], [rows]);
  const filtered = rows.filter(r => !supplier || r.partner_id === supplier);
  const totalRemaining = filtered.reduce((s, r) => s + Number(r.remaining || 0), 0);
  const overdue = filtered.filter(r => r.overdue).reduce((s, r) => s + Number(r.remaining || 0), 0);

  return <div className="cb-panel" data-testid="cb-payables-panel">
    <div className="cb-toolbar">
      <div className="tabs cb-subtabs"><button className={scope === 'OPEN' ? 'active' : ''} onClick={() => setScope('OPEN')} data-testid="cb-payables-scope-open">Belum Lunas</button><button className={scope === 'ALL' ? 'active' : ''} onClick={() => setScope('ALL')} data-testid="cb-payables-scope-all">Semua</button></div>
      <select value={supplier} onChange={e => setSupplier(e.target.value)} data-testid="cb-payables-supplier-filter"><option value="">Semua supplier</option>{suppliers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <div className="cb-toolbar-spacer"/>
      <button className="secondary-button compact" onClick={() => downloadFile(`/api/cash-bank/export/payables?${qs({ companyId, scope })}`, 'tagihan-supplier.xlsx').catch(err => notify('error', errorText(err)))} data-testid="cb-payables-export"><Download size={14}/> Export Excel</button>
    </div>
    <div className="cb-summary-strip"><div><span>Sisa hutang</span><strong data-testid="cb-payables-total">{rupiah(totalRemaining)}</strong></div><div><span>Lewat jatuh tempo</span><strong className={overdue > 0 ? 'cb-text-danger' : ''}>{rupiah(overdue)}</strong></div><div><span>Invoice</span><strong>{filtered.length}</strong></div></div>
    <div className="data-table-wrap"><table><thead><tr><th>Supplier</th><th>No Pembelian</th><th>Invoice Supplier</th><th>Tanggal</th><th>Jatuh Tempo</th><th className="numeric">Total</th><th className="numeric">Sudah Dibayar</th><th className="numeric">Menunggu Verifikasi</th><th className="numeric">Sisa</th><th>Status</th><th></th></tr></thead><tbody>
      {filtered.map(r => <tr key={r.id} data-testid={`cb-payable-row-${r.transaction_number}`}>
        <td>{r.supplier_name || '—'}</td><td><strong>{r.transaction_number}</strong></td><td>{r.reference_number || '—'}</td><td>{r.transaction_date}</td>
        <td>{r.due_date || '—'}{r.overdue && <small className="cb-overdue">Lewat jatuh tempo</small>}</td>
        <td className="numeric">{rupiah(r.grand_total)}</td><td className="numeric">{rupiah(r.paid_verified)}</td><td className="numeric">{Number(r.paid_pending) > 0 ? rupiah(r.paid_pending) : '—'}</td>
        <td className="numeric"><strong>{rupiah(r.remaining)}</strong></td>
        <td><span className={`cb-badge ${r.status}`} data-testid={`cb-payable-status-${r.transaction_number}`}>{payableStatusLabel[r.status]}</span>{r.workflow_status === 'DRAFT' && <small className="journal-meta">Invoice Draft</small>}</td>
        <td><button className="secondary-button compact" disabled={!r.payable} onClick={() => onPay(r)} data-testid={`cb-payable-pay-${r.transaction_number}`}>Bayar</button></td>
      </tr>)}
    </tbody></table>{!loading && filtered.length === 0 && <div className="empty-state"><CheckCircle2 size={30}/><strong>Tidak ada hutang {scope === 'OPEN' ? 'terbuka' : ''}</strong><span>Invoice pembelian kredit yang sudah dicatat akan tampil di sini.</span></div>}</div>

    <div className="cb-section-head"><div><span className="eyebrow">HISTORI</span><h4>Pembayaran Supplier</h4></div><button className="secondary-button compact" onClick={() => downloadFile(`/api/cash-bank/export/supplier-payments?${qs({ companyId })}`, 'histori-pembayaran.xlsx').catch(err => notify('error', errorText(err)))} data-testid="cb-payments-export"><Download size={14}/> Export Excel</button></div>
    <div className="data-table-wrap"><table><thead><tr><th>Tanggal</th><th>No Pembayaran</th><th>Supplier</th><th>Invoice Dibayar</th><th>Kas/Bank</th><th className="numeric">Nominal</th><th>Status</th><th>Jurnal</th><th></th></tr></thead><tbody>
      {payments.map(p => <tr key={p.id} data-testid={`cb-payment-row-${p.transaction_number}`}><td>{p.transaction_date}</td><td><strong>{p.transaction_number}</strong></td><td>{p.supplier_name || '—'}</td><td>{p.invoices || '—'}</td><td>{p.financial_account_name || '—'}</td><td className="numeric">{rupiah(p.grand_total)}</td>
        <td><span className={p.workflow_status === 'DRAFT' ? 'status-draft' : p.workflow_status === 'CANCELLED' ? 'cb-badge CANCELLED' : 'status-ok'}>{workflowLabel[p.workflow_status] || p.workflow_status}</span></td><td>{p.journal_number || '—'}</td>
        <td><button className="icon-button" onClick={() => setDetailId(p.id)} data-testid={`cb-payment-detail-${p.transaction_number}`}><Eye size={14}/></button></td></tr>)}
    </tbody></table>{payments.length === 0 && <div className="empty-state"><strong>Belum ada pembayaran supplier</strong></div>}</div>
    {detailId && <TransactionDetailModal transactionId={detailId} onClose={() => setDetailId('')}/>}
  </div>;
}

// ---------------------------------------------------------------------------
// Tab Antrean Verifikasi Finance (draft kas/bank)
// ---------------------------------------------------------------------------
export function VerificationPanel({ companyId, canVerify, notify, refreshKey, onChanged }: { companyId: string; canVerify: boolean; notify: Notify; refreshKey: number; onChanged: () => void }) {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [busy, setBusy] = useState('');
  const [detailId, setDetailId] = useState('');
  const [cancelRow, setCancelRow] = useState<LedgerRow | null>(null);

  async function load() {
    try {
      const ledger = await api<{ rows: LedgerRow[] }>(`/api/cash-bank/ledger?companyId=${encodeURIComponent(companyId)}`);
      const seen = new Set<string>();
      setRows(ledger.rows.filter(r => r.workflow_status === 'DRAFT' && !seen.has(r.transaction_id) && (seen.add(r.transaction_id), true)).reverse());
    } catch (err) { notify('error', errorText(err)); }
  }
  useEffect(() => { void load(); }, [companyId, refreshKey]);

  async function verify(r: LedgerRow) {
    setBusy(r.transaction_id);
    try {
      const res = await api<{ requiresAccountDirection?: boolean }>(verifyUrl(r.transaction_type, r.transaction_id), { method: 'POST' });
      notify('ok', res.requiresAccountDirection ? `${r.transaction_number} Finance Verified — diteruskan ke Accounting untuk arah akun (PERLU REVIEW).` : `${r.transaction_number} Finance Verified — jurnal otomatis terbentuk.`);
      onChanged();
    } catch (err) { notify('error', `${r.transaction_number}: ${errorText(err)}`); }
    finally { setBusy(''); }
  }

  return <div className="cb-panel" data-testid="cb-verification-panel">
    <div className="helper-box">Transaksi Draft sudah mempengaruhi saldo, tetapi jurnal baru terbentuk setelah <b>Finance Verified</b>. Draft yang salah dibatalkan (bukan dihapus) agar jejak audit tetap ada.</div>
    <div className="data-table-wrap"><table><thead><tr><th>Tanggal</th><th>No Transaksi</th><th>Jenis</th><th>Kas/Bank</th><th>Keterangan</th><th>Supplier/Penerima</th><th className="numeric">Nominal</th><th>Bukti</th><th></th></tr></thead><tbody>
      {rows.map(r => <tr key={r.transaction_id} data-testid={`cb-verify-row-${r.transaction_number}`}>
        <td>{r.transaction_date}</td><td><strong>{r.transaction_number}</strong></td><td>{r.transaction_type === 'CASH_TRANSFER' ? 'Pindah Uang' : r.kind}</td><td>{r.financial_account_name}</td><td>{r.description || '—'}{r.category_name && <small className="journal-meta">{r.category_name}</small>}</td><td>{r.counterparty || '—'}</td>
        <td className="numeric">{rupiah(Number(r.amount_in) || Number(r.amount_out))}</td><td>{r.attachment_count > 0 ? <span className="attachment-count"><FileText size={14}/>{r.attachment_count}</span> : '—'}</td>
        <td><div className="cb-row-actions">
          <button className="icon-button" onClick={() => setDetailId(r.transaction_id)} title="Detail" data-testid={`cb-verify-detail-${r.transaction_number}`}><Eye size={14}/></button>
          {canVerify && <button className="secondary-button compact verify-button" disabled={busy === r.transaction_id} onClick={() => verify(r)} data-testid={`cb-verify-btn-${r.transaction_number}`}><ShieldCheck size={14}/>{busy === r.transaction_id ? 'Memproses...' : 'Finance Verified'}</button>}
          {r.transaction_type !== 'PURCHASE_INVOICE' && <button className="secondary-button compact cb-danger-text" onClick={() => setCancelRow(r)} data-testid={`cb-cancel-btn-${r.transaction_number}`}><XCircle size={14}/> Batalkan</button>}
        </div></td>
      </tr>)}
    </tbody></table>{rows.length === 0 && <div className="empty-state"><CheckCircle2 size={30}/><strong>Antrean kosong</strong><span>Semua transaksi kas & bank sudah diverifikasi.</span></div>}</div>
    {detailId && <TransactionDetailModal transactionId={detailId} onClose={() => setDetailId('')}/>}
    {cancelRow && <ConfirmDialog title={`Batalkan ${cancelRow.transaction_number}?`} danger withReason confirmLabel="Batalkan Transaksi"
      message={<>Transaksi akan berstatus <b>Dibatalkan</b> dan tidak lagi dihitung di saldo. Data tidak dihapus.</>}
      onCancel={() => setCancelRow(null)}
      onConfirm={async reason => {
        try { await api(`/api/cash-bank/transactions/${cancelRow.transaction_id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }); notify('ok', `${cancelRow.transaction_number} dibatalkan.`); onChanged(); }
        catch (err) { notify('error', `${cancelRow.transaction_number}: ${errorText(err)}`); }
        setCancelRow(null);
      }}/>}
  </div>;
}

// ---------------------------------------------------------------------------
// Tab Accounting Control (AUTO OK / PERLU REVIEW / ERROR)
// ---------------------------------------------------------------------------
type ControlRow = Record<string, any> & { id: string; bucket: 'AUTO_OK' | 'NEEDS_REVIEW' | 'ERROR' | 'POSTED'; issue: string };
const bucketLabel: Record<string, string> = { AUTO_OK: 'AUTO OK', NEEDS_REVIEW: 'PERLU REVIEW', ERROR: 'ERROR', POSTED: 'POSTED' };

export function ControlPanel({ companyId, notify, refreshKey }: { companyId: string; notify: Notify; refreshKey: number }) {
  const [data, setData] = useState<{ counts: Record<string, number>; rows: ControlRow[] } | null>(null);
  const [bucket, setBucket] = useState('');
  const [detailId, setDetailId] = useState('');
  useEffect(() => { api<{ counts: Record<string, number>; rows: ControlRow[] }>(`/api/accounting-control/overview?companyId=${encodeURIComponent(companyId)}`).then(setData).catch(err => notify('error', errorText(err))); }, [companyId, refreshKey]);
  const rows = (data?.rows || []).filter(r => !bucket || r.bucket === bucket);
  const cards: Array<[string, string, number, React.ReactNode]> = [
    ['AUTO_OK', 'AUTO OK', data?.counts.auto_ok || 0, <CheckCircle2 size={18}/>],
    ['NEEDS_REVIEW', 'PERLU REVIEW', data?.counts.needs_review || 0, <AlertTriangle size={18}/>],
    ['ERROR', 'ERROR', data?.counts.error || 0, <XCircle size={18}/>],
    ['POSTED', 'POSTED', data?.counts.posted || 0, <Lock size={18}/>],
  ];
  return <div className="cb-panel" data-testid="cb-control-panel">
    <div className="cb-bucket-grid">
      {cards.map(([key, label, count, icon]) => <button key={key} className={`cb-bucket-card ${key} ${bucket === key ? 'active' : ''}`} onClick={() => setBucket(bucket === key ? '' : key)} data-testid={`cb-bucket-${key}`}>{icon}<div><strong>{count}</strong><span>{label}</span></div></button>)}
      <div className="cb-bucket-card DRAFT"><FileText size={18}/><div><strong data-testid="cb-bucket-draft-count">{data?.counts.draft || 0}</strong><span>Draft Finance</span></div></div>
    </div>
    <div className="data-table-wrap"><table><thead><tr><th>Tanggal</th><th>No Transaksi</th><th>Jenis</th><th>Supplier/Penerima</th><th>Kas/Bank</th><th className="numeric">Nominal</th><th>Jurnal</th><th>Klasifikasi</th><th>Catatan</th><th></th></tr></thead><tbody>
      {rows.map(r => <tr key={r.id} data-testid={`cb-control-row-${r.transaction_number}`}>
        <td>{r.transaction_date}</td><td><strong>{r.transaction_number}</strong></td><td>{r.kind}{r.categories && <small className="journal-meta">{r.categories}</small>}</td><td>{r.counterparty || '—'}</td><td>{r.financial_account_name || '—'}</td>
        <td className="numeric">{rupiah(r.grand_total)}</td><td>{r.journal_number ? <>{r.journal_number}<small className="journal-meta">{r.journal_status}</small></> : '—'}</td>
        <td><span className={`cb-badge ${r.bucket}`} data-testid={`cb-control-bucket-${r.transaction_number}`}>{bucketLabel[r.bucket]}</span></td><td className="cb-issue">{r.issue || '—'}</td>
        <td><button className="icon-button" onClick={() => setDetailId(r.id)} data-testid={`cb-control-detail-${r.transaction_number}`}><Eye size={14}/></button></td>
      </tr>)}
    </tbody></table>{data && rows.length === 0 && <div className="empty-state"><CheckCircle2 size={30}/><strong>Tidak ada transaksi</strong><span>Transaksi Finance Verified akan diklasifikasikan di sini.</span></div>}</div>
    <div className="helper-box">PERLU REVIEW diarahkan akunnya di menu <b>Control Center</b> (antrean arah akun). Transaksi di periode HARD CLOSE dikoreksi lewat jurnal reversal/adjustment di periode terbuka.</div>
    {detailId && <TransactionDetailModal transactionId={detailId} onClose={() => setDetailId('')}/>}
  </div>;
}

// ---------------------------------------------------------------------------
// Tab Rekonsiliasi (minimal): saldo sistem vs cash count / rekening koran
// ---------------------------------------------------------------------------
export function ReconciliationPanel({ companyId, accounts, canVerify, notify, refreshKey, onChanged }: { companyId: string; accounts: CashAccount[]; canVerify: boolean; notify: Notify; refreshKey: number; onChanged: () => void }) {
  const [rows, setRows] = useState<Array<Record<string, any>>>([]);
  const [accountId, setAccountId] = useState(accounts[0]?.id || '');
  const [date, setDate] = useState(today());
  const [actual, setActual] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [last, setLast] = useState<Record<string, any> | null>(null);
  async function load() { try { setRows(await api(`/api/cash-bank/reconciliations?companyId=${encodeURIComponent(companyId)}`)); } catch (err) { notify('error', errorText(err)); } }
  useEffect(() => { void load(); }, [companyId, refreshKey]);
  const account = accounts.find(a => a.id === accountId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !date || actual === '') { notify('error', errorText('RECONCILIATION_FIELDS_REQUIRED')); return; }
    setSaving(true);
    try {
      const r = await api<Record<string, any>>('/api/cash-bank/reconciliations', { method: 'POST', body: JSON.stringify({ companyId, financialAccountId: accountId, reconciliationDate: date, actualBalance: Number(actual), notes: notes || null }) });
      setLast(r); setActual(''); setNotes('');
      notify('ok', Number(r.difference) === 0 ? 'Saldo cocok — status RECONCILED.' : `Ada selisih ${rupiah(r.difference)} — status BELUM REKONSILIASI.`);
      await load(); onChanged();
    } catch (err) { notify('error', errorText(err)); }
    finally { setSaving(false); }
  }

  async function markReconciled(id: string) {
    try { await api(`/api/cash-bank/reconciliations/${id}/reconcile`, { method: 'POST', body: JSON.stringify({}) }); notify('ok', 'Rekonsiliasi ditandai selesai.'); await load(); onChanged(); }
    catch (err) { notify('error', errorText(err)); }
  }

  return <div className="cb-panel" data-testid="cb-reconciliation-panel">
    {canVerify && <form className="cb-recon-form" onSubmit={submit}>
      <label>Rekening<select value={accountId} onChange={e => setAccountId(e.target.value)} data-testid="cb-recon-account">{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label>Per Tanggal<input type="date" value={date} onChange={e => setDate(e.target.value)} data-testid="cb-recon-date"/></label>
      <label>{account?.account_kind === 'CASH' ? 'Hasil Cash Count' : 'Saldo Rekening Koran'}<input className="number-input" type="number" step="1" value={actual} onChange={e => setActual(e.target.value)} placeholder="0" data-testid="cb-recon-actual"/></label>
      <label>Catatan<input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Opsional" data-testid="cb-recon-notes"/></label>
      <button className="primary-button compact" disabled={saving} data-testid="cb-recon-submit">{saving ? 'Menghitung...' : 'Bandingkan Saldo'}</button>
    </form>}
    {last && <div className={Number(last.difference) === 0 ? 'success-banner cb-inline-banner' : 'cb-warning'} data-testid="cb-recon-result">Saldo sistem {rupiah(last.system_balance)} · aktual {rupiah(last.actual_balance)} · selisih <b>{rupiah(last.difference)}</b></div>}
    <div className="data-table-wrap"><table><thead><tr><th>Tanggal</th><th>Rekening</th><th className="numeric">Saldo Sistem</th><th className="numeric">Saldo Aktual</th><th className="numeric">Selisih</th><th>Status</th><th>Catatan</th><th></th></tr></thead><tbody>
      {rows.map(r => <tr key={r.id} data-testid={`cb-recon-row-${r.id}`}><td>{r.reconciliation_date}</td><td>{r.financial_account_name}</td><td className="numeric">{rupiah(r.system_balance)}</td><td className="numeric">{rupiah(r.actual_balance)}</td>
        <td className={`numeric ${Number(r.difference) !== 0 ? 'cb-text-danger' : ''}`}>{rupiah(r.difference)}</td>
        <td><span className={r.status === 'RECONCILED' ? 'status-ok' : 'status-draft'}>{r.status === 'RECONCILED' ? 'Reconciled' : 'Belum Rekonsiliasi'}</span></td><td>{r.notes || '—'}</td>
        <td>{canVerify && r.status !== 'RECONCILED' && <button className="secondary-button compact" onClick={() => markReconciled(r.id)} data-testid={`cb-recon-mark-${r.id}`}>Tandai Selesai</button>}</td></tr>)}
    </tbody></table>{rows.length === 0 && <div className="empty-state"><strong>Belum ada rekonsiliasi</strong><span>Bandingkan saldo sistem dengan cash count atau rekening koran.</span></div>}</div>
  </div>;
}

// ---------------------------------------------------------------------------
// Tab Periode Akuntansi (Open / Soft Close / Hard Close)
// ---------------------------------------------------------------------------
type Period = { id: string; period_start: string; period_end: string; status: 'OPEN' | 'SOFT_CLOSED' | 'HARD_CLOSED'; posted_journals: number; open_journals: number; draft_transactions: number; soft_closed_at: string | null; hard_closed_at: string | null };
const periodLabel: Record<string, string> = { OPEN: 'OPEN', SOFT_CLOSED: 'SOFT CLOSE', HARD_CLOSED: 'HARD CLOSE' };

export function PeriodPanel({ companyId, canAccounting, notify, refreshKey }: { companyId: string; canAccounting: boolean; notify: Notify; refreshKey: number }) {
  const [rows, setRows] = useState<Period[]>([]);
  const [month, setMonth] = useState(today().slice(0, 7));
  const [confirm, setConfirm] = useState<{ period: Period; status: Period['status'] } | null>(null);
  async function load() { try { setRows(await api<Period[]>(`/api/accounting-periods?companyId=${encodeURIComponent(companyId)}`)); } catch (err) { notify('error', errorText(err)); } }
  useEffect(() => { void load(); }, [companyId, refreshKey]);

  async function create() {
    try { await api('/api/accounting-periods', { method: 'POST', body: JSON.stringify({ companyId, month }) }); notify('ok', `Periode ${month} dibuat (OPEN).`); await load(); }
    catch (err) { notify('error', errorText(err)); }
  }
  async function change(period: Period, status: Period['status']) {
    try { await api(`/api/accounting-periods/${period.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); notify('ok', `Periode ${period.period_start} → ${periodLabel[status]}.`); await load(); }
    catch (err) { notify('error', errorText(err)); }
  }

  return <div className="cb-panel" data-testid="cb-period-panel">
    <div className="cb-period-legend">
      <div><span className="cb-badge OPEN">OPEN</span> Semua transaksi boleh dicatat, diverifikasi dan diposting.</div>
      <div><span className="cb-badge SOFT_CLOSED">SOFT CLOSE</span> Finance tidak bisa menambah/membatalkan; Accounting masih review & posting. Bisa dibuka kembali.</div>
      <div><span className="cb-badge HARD_CLOSED">HARD CLOSE</span> Dikunci permanen. Koreksi hanya lewat jurnal adjustment/reversal di periode terbuka.</div>
    </div>
    {canAccounting && <div className="cb-toolbar"><label className="cb-inline-label">Bulan<input type="month" value={month} onChange={e => setMonth(e.target.value)} data-testid="cb-period-month"/></label><button className="primary-button compact" onClick={create} data-testid="cb-period-create">+ Buat Periode</button></div>}
    <div className="data-table-wrap"><table><thead><tr><th>Periode</th><th>Status</th><th className="numeric">Transaksi Draft</th><th className="numeric">Jurnal Belum Posted</th><th className="numeric">Jurnal Posted</th><th></th></tr></thead><tbody>
      {rows.map(p => <tr key={p.id} data-testid={`cb-period-row-${p.period_start}`}>
        <td><strong>{p.period_start} s/d {p.period_end}</strong></td>
        <td><span className={`cb-badge ${p.status}`} data-testid={`cb-period-status-${p.period_start}`}>{periodLabel[p.status]}</span></td>
        <td className="numeric">{p.draft_transactions}</td><td className="numeric">{p.open_journals}</td><td className="numeric">{p.posted_journals}</td>
        <td>{canAccounting && <div className="cb-row-actions">
          {p.status === 'OPEN' && <button className="secondary-button compact" onClick={() => change(p, 'SOFT_CLOSED')} data-testid={`cb-period-soft-${p.period_start}`}><Lock size={14}/> Soft Close</button>}
          {p.status === 'SOFT_CLOSED' && <button className="secondary-button compact" onClick={() => change(p, 'OPEN')} data-testid={`cb-period-open-${p.period_start}`}><Unlock size={14}/> Buka Kembali</button>}
          {p.status !== 'HARD_CLOSED' && <button className="secondary-button compact cb-danger-text" onClick={() => setConfirm({ period: p, status: 'HARD_CLOSED' })} data-testid={`cb-period-hard-${p.period_start}`}><Lock size={14}/> Hard Close</button>}
          {p.status === 'HARD_CLOSED' && <span className="muted-cell">Terkunci permanen</span>}
        </div>}</td>
      </tr>)}
    </tbody></table>{rows.length === 0 && <div className="empty-state"><strong>Belum ada periode</strong><span>Tanpa periode, semua tanggal dianggap OPEN.</span></div>}</div>
    {confirm && <ConfirmDialog title={`Hard Close ${confirm.period.period_start} s/d ${confirm.period.period_end}?`} danger confirmLabel="Ya, Kunci Permanen"
      message={<>Periode akan <b>dikunci permanen</b> dan tidak bisa dibuka kembali. Transaksi baru, verifikasi dan pembatalan di periode ini akan ditolak.</>}
      onCancel={() => setConfirm(null)} onConfirm={async () => { await change(confirm.period, confirm.status); setConfirm(null); }}/>}
  </div>;
}
