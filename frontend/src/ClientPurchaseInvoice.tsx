import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, FileText, Plus, Save, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { api } from './api';
import { SearchSelect } from './SearchSelect';
import { calculateDocument, type DocumentDiscount } from '../shared/transactionMath';

type Company = { id:string; workspace_id:string; code:string; name:string };
type Location = { id:string; company_id:string; code:string; name:string; location_type:string };
type Item = { id:string; workspace_id:string; code:string; name:string; base_unit_id:string; unit_code:string; category_name:string; can_purchase:boolean };
type Unit = { id:string; workspace_id:string; code:string; name:string };
type Supplier = { id:string; workspace_id:string; code:string; name:string; partner_type:string; payment_term_days:number };
type FinancialAccount = { id:string; company_id:string; code:string; name:string; account_kind:string; location_id:string|null; location_name?:string };
type TaxCode = { id:string; workspace_id:string; code:string; name:string; rate:string; default_inclusive:boolean };
type PurchaseRow = {
  id:string; transaction_number:string; transaction_date:string; reference_number:string|null; payment_type:'CASH'|'CREDIT'|null;
  payment_status:string; due_date:string|null; grand_total:string; workflow_status:string; accounting_status:string;
  supplier_name?:string; location_name?:string; financial_account_name?:string; attachment_count:number;
};
type DiscountMode = ''|'PERCENT'|'AMOUNT';
type PurchaseLine = {
  key:string; itemId:string; description:string; quantity:string; unitId:string; unitPrice:string;
  discountType:DiscountMode; discountValue:string; taxCodeId:string; taxIncluded:boolean;
};

type CreateResult = { id:string; transaction_number:string; grand_total:string; workflow_status:string };

const money = (value:string|number) => Number(value || 0).toLocaleString('id-ID', { maximumFractionDigits:0 });
const today = () => new Date().toISOString().slice(0,10);
const makeLine = ():PurchaseLine => ({ key:crypto.randomUUID(), itemId:'', description:'', quantity:'1', unitId:'', unitPrice:'0', discountType:'', discountValue:'0', taxCodeId:'', taxIncluded:false });

function addDays(dateText:string, days:number) {
  const d = new Date(`${dateText}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}

async function fileToBase64(file:File) {
  return await new Promise<string>((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error('Gagal membaca file'));
    reader.readAsDataURL(file);
  });
}

export function ClientPurchaseInvoice({ canVerify }:{ canVerify:boolean }) {
  const [companies,setCompanies] = useState<Company[]>([]);
  const [locations,setLocations] = useState<Location[]>([]);
  const [companyId,setCompanyId] = useState('');
  const [items,setItems] = useState<Item[]>([]);
  const [units,setUnits] = useState<Unit[]>([]);
  const [suppliers,setSuppliers] = useState<Supplier[]>([]);
  const [financialAccounts,setFinancialAccounts] = useState<FinancialAccount[]>([]);
  const [taxes,setTaxes] = useState<TaxCode[]>([]);
  const [recent,setRecent] = useState<PurchaseRow[]>([]);

  const [locationId,setLocationId] = useState('');
  const [supplierId,setSupplierId] = useState('');
  const [invoiceDate,setInvoiceDate] = useState(today());
  const [reference,setReference] = useState('');
  const [paymentType,setPaymentType] = useState<'CASH'|'CREDIT'>('CREDIT');
  const [financialAccountId,setFinancialAccountId] = useState('');
  const [dueDate,setDueDate] = useState(today());
  const [notes,setNotes] = useState('');
  const [docDiscountType,setDocDiscountType] = useState<DiscountMode>('');
  const [docDiscountValue,setDocDiscountValue] = useState('0');
  const [lines,setLines] = useState<PurchaseLine[]>([makeLine()]);
  const [attachment,setAttachment] = useState<File|null>(null);
  const [saving,setSaving] = useState(false);
  const [verifyingId,setVerifyingId] = useState('');
  const [error,setError] = useState('');
  const [success,setSuccess] = useState('');

  const company = companies.find(x => x.id === companyId);
  const companyLocations = locations.filter(x => x.company_id === companyId);
  const supplier = suppliers.find(x => x.id === supplierId);

  async function loadFoundation() {
    const [c,l] = await Promise.all([api<Company[]>('/api/master/companies'), api<Location[]>('/api/master/locations')]);
    setCompanies(c); setLocations(l);
    if (!companyId && c[0]) setCompanyId(c[0].id);
  }

  async function loadCompanyData() {
    if (!company) return;
    const cq = `?companyId=${encodeURIComponent(company.id)}`;
    const wq = `?workspaceId=${encodeURIComponent(company.workspace_id)}`;
    const [i,u,p,fa,t,r] = await Promise.all([
      api<Item[]>(`/api/master/items${wq}`), api<Unit[]>(`/api/master/units${wq}`), api<Supplier[]>(`/api/master/partners${wq}`),
      api<FinancialAccount[]>(`/api/master/financial-accounts${cq}`), api<TaxCode[]>(`/api/master/tax-codes${wq}`),
      api<PurchaseRow[]>(`/api/client-transactions/purchase-invoices${cq}`),
    ]);
    setItems(i.filter(x => x.can_purchase !== false)); setUnits(u);
    setSuppliers(p.filter(x => x.partner_type === 'SUPPLIER' || x.partner_type === 'BOTH'));
    setFinancialAccounts(fa.filter(x => ['CASH','BANK','EWALLET'].includes(x.account_kind)));
    setTaxes(t); setRecent(r);
    setLocationId(current => companyLocations.some(x => x.id === current) ? current : (companyLocations[0]?.id || ''));
    setFinancialAccountId(current => fa.some(x => x.id === current && ['CASH','BANK','EWALLET'].includes(x.account_kind)) ? current : (fa.find(x => ['CASH','BANK','EWALLET'].includes(x.account_kind))?.id || ''));
  }

  useEffect(() => { void loadFoundation(); }, []);
  useEffect(() => { void loadCompanyData(); }, [companyId, company?.workspace_id, locations.length]);
  useEffect(() => {
    if (paymentType === 'CREDIT') setDueDate(addDays(invoiceDate, Number(supplier?.payment_term_days || 0)));
  }, [paymentType, invoiceDate, supplierId, supplier?.payment_term_days]);

  const calculation = useMemo(() => {
    try {
      const dd:DocumentDiscount = docDiscountType ? { type:docDiscountType, value:Number(docDiscountValue || 0) } : null;
      return calculateDocument(lines.map(line => {
        const tax = taxes.find(x => x.id === line.taxCodeId);
        return {
          id:line.key, quantity:Number(line.quantity || 0), unitPrice:Number(line.unitPrice || 0),
          discountType:line.discountType || null, discountValue:Number(line.discountValue || 0),
          taxRate:Number(tax?.rate || 0), taxIncluded:line.taxIncluded,
        };
      }), dd);
    } catch { return null; }
  }, [lines,taxes,docDiscountType,docDiscountValue]);

  function updateLine(key:string, patch:Partial<PurchaseLine>) {
    setLines(rows => rows.map(row => row.key === key ? { ...row, ...patch } : row));
  }

  function chooseItem(line:PurchaseLine,itemId:string) {
    const item = items.find(x => x.id === itemId);
    updateLine(line.key,{ itemId, unitId:item?.base_unit_id || '', description:item?.name || line.description });
  }

  function chooseTax(line:PurchaseLine,taxCodeId:string) {
    const tax = taxes.find(x => x.id === taxCodeId);
    updateLine(line.key,{ taxCodeId, taxIncluded:Boolean(tax?.default_inclusive) });
  }

  function resetForm() {
    setReference(''); setNotes(''); setLines([makeLine()]); setAttachment(null);
    setDocDiscountType(''); setDocDiscountValue('0');
  }

  async function saveDraft() {
    setError(''); setSuccess('');
    if (!companyId || !locationId || !supplierId) return setError('Company, lokasi dan supplier wajib dipilih.');
    if (paymentType === 'CASH' && !financialAccountId) return setError('Pilih kas/bank untuk pembelian tunai.');
    if (paymentType === 'CREDIT' && !dueDate) return setError('Tanggal jatuh tempo wajib diisi untuk pembelian kredit.');
    if (lines.some(x => !x.itemId)) return setError('Masih ada baris yang belum memilih barang.');
    if (!calculation) return setError('Perhitungan belum valid. Periksa qty, harga, diskon dan pajak.');
    if (attachment && attachment.size > 5 * 1024 * 1024) return setError('Bukti transaksi maksimal 5 MB.');

    setSaving(true);
    try {
      const result = await api<CreateResult>('/api/client-transactions/purchase-invoices', {
        method:'POST', body:JSON.stringify({
          companyId, locationId, partnerId:supplierId, transactionDate:invoiceDate, referenceNumber:reference || null,
          paymentType, financialAccountId:paymentType === 'CASH' ? financialAccountId : null,
          dueDate:paymentType === 'CREDIT' ? dueDate : null, notes:notes || null,
          documentDiscountType:docDiscountType || null, documentDiscountValue:Number(docDiscountValue || 0),
          lines:lines.map(line => ({
            itemId:line.itemId, description:line.description, quantity:Number(line.quantity || 0), unitId:line.unitId || null,
            unitPrice:Number(line.unitPrice || 0), discountType:line.discountType || null,
            discountValue:Number(line.discountValue || 0), taxCodeId:line.taxCodeId || null, taxIncluded:line.taxIncluded,
          })),
        }),
      });

      let attachmentNote = '';
      if (attachment) {
        try {
          const dataBase64 = await fileToBase64(attachment);
          await api(`/api/client-transactions/${result.id}/attachments`, {
            method:'POST', body:JSON.stringify({ fileName:attachment.name, mimeType:attachment.type, dataBase64 }),
          });
          attachmentNote = ' Bukti transaksi terunggah.';
        } catch {
          attachmentNote = ' Invoice tersimpan, tetapi bukti transaksi gagal diunggah.';
        }
      }
      setSuccess(`${result.transaction_number} tersimpan sebagai draft.${attachmentNote}`);
      resetForm();
      await loadCompanyData();
    } catch (err) { setError(err instanceof Error ? err.message : 'Gagal menyimpan invoice pembelian'); }
    finally { setSaving(false); }
  }

  async function verify(id:string) {
    setError(''); setSuccess(''); setVerifyingId(id);
    try {
      await api(`/api/transactions/${id}/verify`, { method:'POST' });
      setSuccess('Finance Verified berhasil. Stok/HPP average diperbarui dan draft jurnal dikirim ke Accounting Akuntakita.');
      await loadCompanyData();
    } catch (err) { setError(err instanceof Error ? err.message : 'Gagal verifikasi invoice'); }
    finally { setVerifyingId(''); }
  }

  const itemOptions = items.map(x => ({ id:x.id, label:`${x.code} — ${x.name}`, meta:x.category_name }));

  return <div className="page-content client-purchase-page">
    <section className="section-card purchase-entry-card">
      <div className="section-title master-heading">
        <div><span className="eyebrow">PEMBELIAN</span><h3>Invoice Pembelian</h3><p>Catat invoice supplier seperti spreadsheet. Client tidak memilih akun atau jurnal.</p></div>
        <button className="primary-button compact" onClick={saveDraft} disabled={saving}><Save size={16}/>{saving ? 'Menyimpan...' : 'Simpan Draft'}</button>
      </div>

      <div className="helper-box purchase-helper"><strong>Yang dicatat client:</strong> supplier, barang, jumlah, harga dan cara bayar. Mapping persediaan, hutang, pajak dan jurnal tetap dikelola Akuntakita.</div>
      {success && <div className="success-banner"><CheckCircle2 size={18}/><span>{success}</span></div>}
      {error && <div className="form-error transaction-error">{error}</div>}

      <div className="purchase-header-grid">
        <label>Company<select value={companyId} onChange={e => setCompanyId(e.target.value)}><option value="">Pilih company</option>{companies.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Lokasi Penerimaan<select value={locationId} onChange={e => setLocationId(e.target.value)}><option value="">Pilih lokasi</option>{companyLocations.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Tanggal Invoice<input type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)}/></label>
        <label>Supplier<select value={supplierId} onChange={e => setSupplierId(e.target.value)}><option value="">Pilih supplier</option>{suppliers.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>No. Invoice Supplier<input value={reference} onChange={e => setReference(e.target.value)} placeholder="Contoh: INV-00921"/></label>
        <label>Cara Bayar<select value={paymentType} onChange={e => setPaymentType(e.target.value as 'CASH'|'CREDIT')}><option value="CREDIT">Kredit / Hutang</option><option value="CASH">Tunai / Langsung Bayar</option></select></label>
        {paymentType === 'CASH' ? <label>Bayar dari Kas / Bank<select value={financialAccountId} onChange={e => setFinancialAccountId(e.target.value)}><option value="">Pilih kas/bank</option>{financialAccounts.map(x => <option key={x.id} value={x.id}>{x.name}{x.location_name ? ` — ${x.location_name}` : ''}</option>)}</select></label> : <label>Jatuh Tempo<input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}/><small>{supplier ? `Termin supplier: ${supplier.payment_term_days} hari` : 'Mengikuti termin supplier'}</small></label>}
        <label className="purchase-notes">Catatan<input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Keterangan tambahan"/></label>
      </div>

      <div className="transaction-grid-wrap">
        <table className="transaction-grid purchase-grid">
          <thead><tr><th>#</th><th className="target-col">Barang</th><th>Keterangan</th><th>Qty</th><th>Satuan</th><th>Harga</th><th>Diskon</th><th>Pajak</th><th className="numeric">Jumlah</th><th></th></tr></thead>
          <tbody>{lines.map((line,index) => {
            const calc = calculation?.lines[index];
            return <tr key={line.key}>
              <td className="line-number">{index + 1}</td>
              <td><SearchSelect value={line.itemId} options={itemOptions} placeholder="Cari barang..." onChange={id => chooseItem(line,id)}/></td>
              <td><input value={line.description} onChange={e => updateLine(line.key,{ description:e.target.value })} placeholder="Keterangan"/></td>
              <td><input className="number-input short" type="number" min="0" step="0.000001" value={line.quantity} onChange={e => updateLine(line.key,{ quantity:e.target.value })}/></td>
              <td><select value={line.unitId} onChange={e => updateLine(line.key,{ unitId:e.target.value })}><option value="">—</option>{units.map(x => <option key={x.id} value={x.id}>{x.code}</option>)}</select></td>
              <td><input className="number-input" type="number" min="0" step="0.01" value={line.unitPrice} onChange={e => updateLine(line.key,{ unitPrice:e.target.value })}/></td>
              <td><div className="compact-pair"><select value={line.discountType} onChange={e => updateLine(line.key,{ discountType:e.target.value as DiscountMode })}><option value="">—</option><option value="PERCENT">%</option><option value="AMOUNT">Rp</option></select><input className="number-input discount-input" type="number" min="0" step="0.01" value={line.discountValue} onChange={e => updateLine(line.key,{ discountValue:e.target.value })}/></div></td>
              <td><div className="tax-cell"><select value={line.taxCodeId} onChange={e => chooseTax(line,e.target.value)}><option value="">Non Pajak</option>{taxes.map(x => <option key={x.id} value={x.id}>{x.code} ({Number(x.rate).toLocaleString('id-ID')}%)</option>)}</select>{line.taxCodeId && <label className="inline-check"><input type="checkbox" checked={line.taxIncluded} onChange={e => updateLine(line.key,{ taxIncluded:e.target.checked })}/> Incl.</label>}</div></td>
              <td className="numeric line-total">Rp{money(calc?.lineTotal || 0)}</td>
              <td><button className="icon-button danger" type="button" title="Hapus baris" onClick={() => setLines(rows => rows.length === 1 ? rows : rows.filter(x => x.key !== line.key))}><Trash2 size={15}/></button></td>
            </tr>;
          })}</tbody>
        </table>
      </div>

      <div className="purchase-footer">
        <div className="purchase-footer-left">
          <button className="secondary-button" type="button" onClick={() => setLines(rows => [...rows,makeLine()])}><Plus size={16}/> Tambah Baris</button>
          <div className="document-discount"><span>Diskon Invoice</span><select value={docDiscountType} onChange={e => setDocDiscountType(e.target.value as DiscountMode)}><option value="">Tidak ada</option><option value="PERCENT">Persen</option><option value="AMOUNT">Nominal</option></select>{docDiscountType && <input className="number-input" type="number" min="0" step="0.01" value={docDiscountValue} onChange={e => setDocDiscountValue(e.target.value)}/>}</div>
          <label className="attachment-box"><span><Upload size={16}/> Bukti Invoice / Nota</span><input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e => setAttachment(e.target.files?.[0] || null)}/><small>{attachment ? `${attachment.name} · ${(attachment.size/1024/1024).toFixed(2)} MB` : 'PDF/JPG/PNG/WEBP · maks. 5 MB'}</small></label>
        </div>
        <div className="totals-box"><div><span>Subtotal</span><strong>Rp{money(calculation?.grossAmount || 0)}</strong></div><div><span>Diskon</span><strong>- Rp{money(Number(calculation?.lineDiscountAmount || 0) + Number(calculation?.documentDiscountAmount || 0))}</strong></div><div><span>DPP</span><strong>Rp{money(calculation?.dppAmount || 0)}</strong></div><div><span>Pajak</span><strong>Rp{money(calculation?.taxAmount || 0)}</strong></div><div className="grand-total"><span>Total Invoice</span><strong>Rp{money(calculation?.grandTotal || 0)}</strong></div></div>
      </div>
    </section>

    <section className="section-card">
      <div className="section-title"><div><span className="eyebrow">DAFTAR PEMBELIAN</span><h3>Invoice Pembelian Terbaru</h3><p>Finance Verified akan memperbarui stok/HPP average dan meneruskan draft jurnal ke Akuntakita.</p></div></div>
      <div className="data-table-wrap"><table><thead><tr><th>No Transaksi</th><th>Tanggal</th><th>Supplier</th><th>No Invoice</th><th>Lokasi</th><th>Pembayaran</th><th>Status</th><th>Bukti</th><th className="numeric">Total</th><th></th></tr></thead><tbody>{recent.map(row => <tr key={row.id}>
        <td><strong>{row.transaction_number}</strong></td><td>{row.transaction_date?.slice(0,10)}</td><td>{row.supplier_name || '—'}</td><td>{row.reference_number || '—'}</td><td>{row.location_name || '—'}</td>
        <td>{row.payment_type === 'CASH' ? <><strong>Tunai</strong><small className="journal-meta">{row.financial_account_name || 'Kas/Bank'}</small></> : <><strong>Kredit</strong><small className="journal-meta">JT {row.due_date?.slice(0,10) || '—'}</small></>}</td>
        <td><span className={row.workflow_status === 'DRAFT' ? 'status-draft' : 'status-ok'}>{row.workflow_status === 'FINANCE_VERIFIED' ? 'Finance Verified' : row.workflow_status}</span><small className="journal-meta">{row.accounting_status}</small></td>
        <td>{row.attachment_count > 0 ? <span className="attachment-count"><FileText size={14}/>{row.attachment_count}</span> : '—'}</td>
        <td className="numeric">Rp{money(row.grand_total)}</td>
        <td>{canVerify && row.workflow_status === 'DRAFT' && <button className="secondary-button compact verify-button" onClick={() => verify(row.id)} disabled={verifyingId === row.id}><ShieldCheck size={15}/>{verifyingId === row.id ? 'Memproses...' : 'Finance Verified'}</button>}</td>
      </tr>)}</tbody></table>{recent.length === 0 && <div className="empty-state"><FileText size={34}/><strong>Belum ada invoice pembelian</strong><span>Input invoice supplier pertama dari form di atas.</span></div>}</div>
    </section>
  </div>;
}
