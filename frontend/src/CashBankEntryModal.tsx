import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Plus, Trash2, Upload, Wallet, X } from 'lucide-react';
import { api } from './api';
import {
  type CashAccount, type ExpenseCategory, type Location, type Payable, type Supplier,
  errorText, fileToBase64, money, payableStatusLabel, rupiah, today, verifyUrl,
} from './cashBankShared';

export type EntryPreset = { mode: 'PAY' | 'TRANSFER'; payType?: 'OPERATIONAL_EXPENSE' | 'DEBT_PAYMENT'; supplierId?: string; invoiceId?: string };
type ExpenseLine = { key: string; categoryId: string; description: string; amount: string };
const makeLine = (): ExpenseLine => ({ key: crypto.randomUUID(), categoryId: '', description: '', amount: '' });

export function CashBankEntryModal({ companyId, workspaceId, locations, accounts, canVerify, preset, onClose, onSaved }: {
  companyId: string; workspaceId: string; locations: Location[]; accounts: CashAccount[]; canVerify: boolean; preset: EntryPreset;
  onClose: () => void; onSaved: (message: string) => void;
}) {
  const [mode, setMode] = useState<'PAY' | 'TRANSFER'>(preset.mode);
  const [payType, setPayType] = useState<'OPERATIONAL_EXPENSE' | 'DEBT_PAYMENT'>(preset.payType || 'OPERATIONAL_EXPENSE');
  const [transactionDate, setTransactionDate] = useState(today());
  const [locationId, setLocationId] = useState(locations[0]?.id || '');
  const [fromAccountId, setFromAccountId] = useState(accounts.find(a => a.account_kind === 'BANK')?.id || accounts[0]?.id || '');
  const [toAccountId, setToAccountId] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [payeeName, setPayeeName] = useState('');
  const [lines, setLines] = useState<ExpenseLine[]>([makeLine()]);
  const [transferAmount, setTransferAmount] = useState('');
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState(preset.supplierId || '');
  const [payables, setPayables] = useState<Payable[]>([]);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [attachment, setAttachment] = useState<File | null>(null);
  const [verifyNow, setVerifyNow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api<ExpenseCategory[]>(`/api/master/expense-categories?companyId=${encodeURIComponent(companyId)}`).then(rows => setCategories(rows.filter(x => x.status === 'ACTIVE'))).catch(() => setCategories([]));
    void api<Supplier[]>(`/api/master/partners?workspaceId=${encodeURIComponent(workspaceId)}`).then(rows => setSuppliers(rows.filter(x => x.partner_type === 'SUPPLIER' || x.partner_type === 'BOTH'))).catch(() => setSuppliers([]));
    void api<Payable[]>(`/api/cash-bank/payables?companyId=${encodeURIComponent(companyId)}&scope=ALL`).then(setPayables).catch(() => setPayables([]));
  }, [companyId, workspaceId]);

  useEffect(() => {
    if (preset.invoiceId) {
      const inv = payables.find(p => p.id === preset.invoiceId);
      if (inv && inv.payable) setAllocations(cur => (cur[inv.id] ? cur : { ...cur, [inv.id]: String(Math.round(Number(inv.remaining))) }));
    }
  }, [payables, preset.invoiceId]);

  const supplierInvoices = useMemo(() => payables.filter(p => p.partner_id === supplierId), [payables, supplierId]);
  const fromAccount = accounts.find(a => a.id === fromAccountId);
  const operationalTotal = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const debtTotal = supplierInvoices.reduce((s, p) => s + Number(allocations[p.id] || 0), 0);
  const total = mode === 'TRANSFER' ? Number(transferAmount || 0) : payType === 'DEBT_PAYMENT' ? debtTotal : operationalTotal;
  const overBalance = Boolean(fromAccount) && total > Number(fromAccount?.balance || 0);
  const unmappedSelected = mode === 'PAY' && payType === 'OPERATIONAL_EXPENSE' && lines.some(l => categories.find(c => c.id === l.categoryId && !c.account_id));

  function validate(): string {
    if (!fromAccountId) return 'Pilih rekening kas/bank.';
    if (!transactionDate) return 'Tanggal wajib diisi.';
    if (attachment && attachment.size > 5 * 1024 * 1024) return 'Bukti transaksi maksimal 5 MB.';
    if (mode === 'TRANSFER') {
      if (!toAccountId) return 'Pilih rekening tujuan.';
      if (toAccountId === fromAccountId) return 'Rekening asal dan tujuan harus berbeda.';
      if (!(Number(transferAmount) > 0)) return 'Nominal pindah uang harus lebih dari 0.';
      return '';
    }
    if (!locationId) return 'Pilih lokasi/outlet.';
    if (payType === 'OPERATIONAL_EXPENSE') {
      if (lines.some(l => !l.categoryId)) return 'Pilih kategori pengeluaran di setiap baris.';
      if (lines.some(l => !(Number(l.amount) > 0))) return 'Nominal setiap baris harus lebih dari 0.';
      return '';
    }
    if (!supplierId) return 'Pilih supplier.';
    if (debtTotal <= 0) return 'Isi nominal bayar minimal pada satu invoice.';
    for (const p of supplierInvoices) {
      const v = Number(allocations[p.id] || 0);
      if (v > 0 && !p.payable) return `Invoice ${p.transaction_number} tidak bisa dibayar (${p.status === 'LUNAS' ? 'sudah LUNAS' : 'belum Finance Verified'}).`;
      if (v > Number(p.remaining) + 0.0001) return `Nominal untuk ${p.transaction_number} melebihi sisa hutang ${rupiah(p.remaining)}.`;
    }
    return '';
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const problem = validate();
    if (problem) { setError(problem); return; }
    setSaving(true); setError(''); setStage('Menyimpan...');
    try {
      let created: { id: string; transaction_number: string };
      let type: string;
      if (mode === 'TRANSFER') {
        created = await api('/api/cash-bank/transfers', { method: 'POST', body: JSON.stringify({
          companyId, transactionDate, fromAccountId, toAccountId, amount: Number(transferAmount), referenceNumber: reference || null, notes: notes || null, locationId: locationId || null,
        }) });
        type = 'CASH_TRANSFER';
      } else {
        created = await api('/api/client-transactions/cash-outs', { method: 'POST', body: JSON.stringify({
          companyId, locationId, transactionDate, financialAccountId: fromAccountId, cashOutType: payType, referenceNumber: reference || null, notes: notes || null,
          payeeName: payType === 'OPERATIONAL_EXPENSE' ? (payeeName || null) : null,
          partnerId: payType === 'DEBT_PAYMENT' ? supplierId : null,
          lines: payType === 'OPERATIONAL_EXPENSE' ? lines.map(l => ({ expenseCategoryId: l.categoryId, description: l.description || categories.find(c => c.id === l.categoryId)?.name || '', amount: Number(l.amount) })) : [],
          allocations: payType === 'DEBT_PAYMENT' ? supplierInvoices.filter(p => Number(allocations[p.id] || 0) > 0).map(p => ({ invoiceId: p.id, amount: Number(allocations[p.id]) })) : [],
        }) });
        type = 'CASH_OUT';
      }
      const notesOut: string[] = [`${created.transaction_number} tersimpan sebagai Draft.`];
      if (attachment) {
        setStage('Mengunggah bukti...');
        try {
          const dataBase64 = await fileToBase64(attachment);
          await api(`/api/client-transactions/${created.id}/attachments`, { method: 'POST', body: JSON.stringify({ fileName: attachment.name, mimeType: attachment.type, dataBase64 }) });
          notesOut.push('Bukti terunggah ke storage.');
        } catch (err) { notesOut.push(`Bukti gagal diunggah: ${errorText(err)}`); }
      }
      if (verifyNow && canVerify) {
        setStage('Memverifikasi & membentuk jurnal...');
        try { await api(verifyUrl(type, created.id), { method: 'POST' }); notesOut[0] = `${created.transaction_number} tersimpan & Finance Verified.`; }
        catch (err) { notesOut.push(`Verifikasi gagal: ${errorText(err)}`); }
      }
      onSaved(notesOut.join(' '));
    } catch (err) { setError(errorText(err)); }
    finally { setSaving(false); setStage(''); }
  }

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <form className="modal-card cb-entry-modal" onSubmit={save} noValidate onMouseDown={e => e.stopPropagation()} data-testid="cb-entry-modal">
      <div className="cb-modal-head"><div><span className="eyebrow">KAS & BANK</span><h3>Catat Transaksi</h3></div><button type="button" className="icon-button" onClick={onClose} data-testid="cb-entry-close"><X size={16}/></button></div>

      <div className="cash-out-type-switch">
        <button type="button" className={mode === 'PAY' ? 'active' : ''} onClick={() => setMode('PAY')} data-testid="cb-mode-pay"><strong><Wallet size={15}/> Bayar</strong><span>Pengeluaran operasional atau bayar hutang supplier.</span></button>
        <button type="button" className={mode === 'TRANSFER' ? 'active' : ''} onClick={() => setMode('TRANSFER')} data-testid="cb-mode-transfer"><strong><ArrowRightLeft size={15}/> Pindahkan Uang</strong><span>Antar rekening kas/bank sendiri — total saldo tidak berubah.</span></button>
      </div>

      {mode === 'PAY' && <div className="tabs cb-subtabs">
        <button type="button" className={payType === 'OPERATIONAL_EXPENSE' ? 'active' : ''} onClick={() => setPayType('OPERATIONAL_EXPENSE')} data-testid="cb-paytype-operational">Pengeluaran Operasional</button>
        <button type="button" className={payType === 'DEBT_PAYMENT' ? 'active' : ''} onClick={() => setPayType('DEBT_PAYMENT')} data-testid="cb-paytype-debt">Bayar Hutang Supplier</button>
      </div>}

      <div className="form-grid three">
        <label>Tanggal<input type="date" value={transactionDate} onChange={e => setTransactionDate(e.target.value)} data-testid="cb-entry-date"/></label>
        <label>{mode === 'TRANSFER' ? 'Dari Rekening' : 'Bayar dari Kas / Bank'}<select value={fromAccountId} onChange={e => { setFromAccountId(e.target.value); if (e.target.value === toAccountId) setToAccountId(''); }} data-testid="cb-entry-from-account"><option value="">Pilih rekening</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>{fromAccount && <small className="cb-field-hint" data-testid="cb-entry-from-balance">Saldo: {rupiah(fromAccount.balance)}</small>}</label>
        {mode === 'TRANSFER'
          ? <label>Ke Rekening<select value={toAccountId} onChange={e => setToAccountId(e.target.value)} data-testid="cb-entry-to-account"><option value="">Pilih rekening tujuan</option>{accounts.filter(a => a.id !== fromAccountId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>{toAccountId && <small className="cb-field-hint" data-testid="cb-entry-to-balance">Saldo: {rupiah(accounts.find(a => a.id === toAccountId)?.balance)}</small>}</label>
          : <label>Lokasi / Outlet<select value={locationId} onChange={e => setLocationId(e.target.value)} data-testid="cb-entry-location"><option value="">Pilih lokasi</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
        {mode === 'TRANSFER' && <label>Nominal<input className="number-input" type="number" min="0" step="1" value={transferAmount} onChange={e => setTransferAmount(e.target.value)} placeholder="0" data-testid="cb-transfer-amount"/></label>}
        {mode === 'PAY' && payType === 'OPERATIONAL_EXPENSE' && <label>Dibayarkan Kepada<input value={payeeName} onChange={e => setPayeeName(e.target.value)} placeholder="Nama penerima / vendor" data-testid="cb-entry-payee"/></label>}
        {mode === 'PAY' && payType === 'DEBT_PAYMENT' && <label>Supplier<select value={supplierId} onChange={e => { setSupplierId(e.target.value); setAllocations({}); }} data-testid="cb-entry-supplier"><option value="">Pilih supplier</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
        <label>No. Referensi<input value={reference} onChange={e => setReference(e.target.value)} placeholder="Opsional" data-testid="cb-entry-reference"/></label>
        <label className={mode === 'TRANSFER' ? '' : 'cb-span-2'}>Catatan<input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Keterangan tambahan" data-testid="cb-entry-notes"/></label>
      </div>

      {mode === 'TRANSFER' && <div className="helper-box" data-testid="cb-transfer-help">Satu input membentuk satu nomor referensi <b>TF-</b> dengan dua mutasi: keluar di rekening asal dan masuk di rekening tujuan. Total Kas & Bank tidak berubah.</div>}

      {mode === 'PAY' && payType === 'OPERATIONAL_EXPENSE' && <div className="cash-out-lines">
        <div className="cash-out-lines-head"><strong>Rincian Pengeluaran</strong><button type="button" className="secondary-button compact" onClick={() => setLines(r => [...r, makeLine()])} data-testid="cb-add-line"><Plus size={14}/> Tambah Baris</button></div>
        <div className="data-table-wrap"><table><thead><tr><th>#</th><th>Kategori</th><th>Keterangan</th><th className="numeric">Nominal</th><th></th></tr></thead><tbody>
          {lines.map((l, i) => <tr key={l.key}><td>{i + 1}</td>
            <td><select value={l.categoryId} onChange={e => setLines(r => r.map(x => x.key === l.key ? { ...x, categoryId: e.target.value } : x))} data-testid={`cb-line-category-${i}`}><option value="">Pilih kategori</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}{c.account_id || /belum dipetakan/i.test(c.name) ? '' : ' (belum dipetakan)'}</option>)}</select></td>
            <td><input value={l.description} onChange={e => setLines(r => r.map(x => x.key === l.key ? { ...x, description: e.target.value } : x))} placeholder="Contoh: Listrik outlet September" data-testid={`cb-line-description-${i}`}/></td>
            <td className="numeric"><input className="number-input" type="number" min="0" step="1" value={l.amount} onChange={e => setLines(r => r.map(x => x.key === l.key ? { ...x, amount: e.target.value } : x))} placeholder="0" data-testid={`cb-line-amount-${i}`}/></td>
            <td><button type="button" className="icon-button danger" onClick={() => setLines(r => r.length === 1 ? r : r.filter(x => x.key !== l.key))} data-testid={`cb-line-remove-${i}`}><Trash2 size={14}/></button></td></tr>)}
        </tbody></table>{categories.length === 0 && <div className="empty-state"><strong>Belum ada kategori pengeluaran</strong><span>Accounting perlu menambahkan kategori di Finance Master.</span></div>}</div>
        {unmappedSelected && <div className="cb-warning" data-testid="cb-unmapped-warning">Kategori belum dipetakan ke akun. Transaksi tetap bisa disimpan; setelah Finance Verified akan masuk antrean <b>PERLU REVIEW</b> Accounting.</div>}
      </div>}

      {mode === 'PAY' && payType === 'DEBT_PAYMENT' && <div className="cash-out-lines">
        <div className="cash-out-lines-head"><div><strong>Invoice Supplier</strong><small className="journal-meta">Nominal bayar tidak boleh melebihi sisa hutang. Invoice LUNAS tidak bisa dipilih.</small></div><span>{supplierInvoices.filter(p => p.payable).length} invoice bisa dibayar</span></div>
        <div className="data-table-wrap"><table><thead><tr><th>No Pembelian</th><th>Invoice Supplier</th><th>Jatuh Tempo</th><th className="numeric">Total</th><th className="numeric">Sisa Hutang</th><th>Status</th><th className="numeric">Bayar Sekarang</th></tr></thead><tbody>
          {supplierInvoices.map(p => {
            const disabled = !p.payable;
            const value = allocations[p.id] || '';
            const exceed = Number(value || 0) > Number(p.remaining) + 0.0001;
            return <tr key={p.id} className={disabled ? 'cb-row-disabled' : ''} data-testid={`cb-invoice-row-${p.transaction_number}`}>
              <td><strong>{p.transaction_number}</strong></td><td>{p.reference_number || '—'}</td>
              <td>{p.due_date?.slice(0, 10) || '—'}{p.overdue && <small className="cb-overdue">Lewat jatuh tempo</small>}</td>
              <td className="numeric">{rupiah(p.grand_total)}</td><td className="numeric"><strong>{rupiah(p.remaining)}</strong></td>
              <td><span className={`cb-badge ${p.status}`} data-testid={`cb-invoice-status-${p.transaction_number}`}>{payableStatusLabel[p.status]}</span>{p.workflow_status === 'DRAFT' && <small className="journal-meta">Belum Finance Verified</small>}</td>
              <td className="numeric"><div className="cb-alloc"><input className={`number-input allocation-input ${exceed ? 'cb-invalid' : ''}`} type="number" min="0" max={Number(p.remaining)} step="1" value={value} disabled={disabled} placeholder="0" onChange={e => setAllocations(cur => ({ ...cur, [p.id]: e.target.value }))} data-testid={`cb-invoice-amount-${p.transaction_number}`}/>
                {!disabled && <button type="button" className="secondary-button compact" onClick={() => setAllocations(cur => ({ ...cur, [p.id]: String(Math.round(Number(p.remaining))) }))} data-testid={`cb-invoice-full-${p.transaction_number}`}>Lunasi</button>}</div>
                {exceed && <small className="cb-overdue">Melebihi sisa</small>}</td>
            </tr>;
          })}
        </tbody></table>{supplierId && supplierInvoices.length === 0 && <div className="empty-state"><strong>Tidak ada invoice kredit</strong><span>Invoice pembelian kredit supplier ini akan tampil di sini.</span></div>}{!supplierId && <div className="empty-state"><strong>Pilih supplier</strong><span>Daftar invoice hutang akan muncul setelah supplier dipilih.</span></div>}</div>
      </div>}

      <div className="cash-out-footer">
        <label className="attachment-box"><span><Upload size={16}/> Bukti / Nota</span><input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e => setAttachment(e.target.files?.[0] || null)} data-testid="cb-entry-attachment"/><small>{attachment ? `${attachment.name} · ${(attachment.size / 1024 / 1024).toFixed(2)} MB` : 'PDF/JPG/PNG/WEBP · maks. 5 MB'}</small></label>
        <div className="cash-out-total"><span>{mode === 'TRANSFER' ? 'Total Dipindahkan' : 'Total Dibayar'}</span><strong data-testid="cb-entry-total">Rp{money(total)}</strong>{overBalance && <small className="cb-overdue" data-testid="cb-over-balance">Melebihi saldo {fromAccount?.name} ({rupiah(fromAccount?.balance)})</small>}</div>
      </div>

      {canVerify && <label className="inline-check standalone"><input type="checkbox" checked={verifyNow} onChange={e => setVerifyNow(e.target.checked)} data-testid="cb-entry-verify-now"/> Langsung Finance Verified setelah disimpan (membentuk jurnal otomatis)</label>}
      {error && <div className="form-error" data-testid="cb-entry-error">{error}</div>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} data-testid="cb-entry-cancel">Batal</button><button className="primary-button" disabled={saving} data-testid="cb-entry-submit">{saving ? stage || 'Menyimpan...' : mode === 'TRANSFER' ? 'Simpan Pindah Uang' : 'Simpan Pembayaran'}</button></div>
    </form>
  </div>;
}
