import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, FileText, Plus, Save, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { api } from './api';

type Company={ id:string;workspace_id:string;name:string };
type Location={ id:string;company_id:string;name:string };
type Supplier={ id:string;workspace_id:string;name:string;partner_type:string };
type FinancialAccount={ id:string;company_id:string;location_id:string|null;name:string;account_kind:string;location_name?:string };
type CostCenter={ id:string;company_id:string;name:string };
type Payable={ id:string;transaction_number:string;transaction_date:string;reference_number:string|null;due_date:string|null;grand_total:string;outstanding:string };
type CashOutRow={ id:string;transaction_number:string;transaction_date:string;reference_number:string|null;cash_out_type:'DEBT_PAYMENT'|'OPERATIONAL_EXPENSE';payee_name:string|null;grand_total:string;workflow_status:string;accounting_status:string;supplier_name?:string;location_name?:string;financial_account_name?:string;attachment_count:number };
type ExpenseLine={ key:string;description:string;costCenterId:string;amount:string };

const today=()=>new Date().toISOString().slice(0,10);
const money=(value:string|number)=>Number(value||0).toLocaleString('id-ID',{ maximumFractionDigits:0 });
const makeExpense=():ExpenseLine=>({ key:crypto.randomUUID(),description:'',costCenterId:'',amount:'0' });

async function fileToBase64(file:File) {
  return await new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result||'').split(',')[1]||'');
    reader.onerror=()=>reject(new Error('Gagal membaca file'));
    reader.readAsDataURL(file);
  });
}

export function ClientCashOut({ canVerify }:{ canVerify:boolean }) {
  const [companies,setCompanies]=useState<Company[]>([]);
  const [locations,setLocations]=useState<Location[]>([]);
  const [companyId,setCompanyId]=useState('');
  const [financialAccounts,setFinancialAccounts]=useState<FinancialAccount[]>([]);
  const [suppliers,setSuppliers]=useState<Supplier[]>([]);
  const [costCenters,setCostCenters]=useState<CostCenter[]>([]);
  const [recent,setRecent]=useState<CashOutRow[]>([]);
  const [payables,setPayables]=useState<Payable[]>([]);

  const [cashOutType,setCashOutType]=useState<'OPERATIONAL_EXPENSE'|'DEBT_PAYMENT'>('OPERATIONAL_EXPENSE');
  const [locationId,setLocationId]=useState('');
  const [transactionDate,setTransactionDate]=useState(today());
  const [financialAccountId,setFinancialAccountId]=useState('');
  const [reference,setReference]=useState('');
  const [payeeName,setPayeeName]=useState('');
  const [supplierId,setSupplierId]=useState('');
  const [notes,setNotes]=useState('');
  const [expenseLines,setExpenseLines]=useState<ExpenseLine[]>([makeExpense()]);
  const [allocations,setAllocations]=useState<Record<string,string>>({});
  const [attachment,setAttachment]=useState<File|null>(null);
  const [saving,setSaving]=useState(false);
  const [verifyingId,setVerifyingId]=useState('');
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');

  const company=companies.find(x=>x.id===companyId);
  const companyLocations=locations.filter(x=>x.company_id===companyId);

  async function loadFoundation() {
    const [c,l]=await Promise.all([api<Company[]>('/api/master/companies'),api<Location[]>('/api/master/locations')]);
    setCompanies(c);setLocations(l);
    if (!companyId && c[0]) setCompanyId(c[0].id);
  }

  async function loadCompanyData() {
    if (!company) return;
    const cq=`?companyId=${encodeURIComponent(company.id)}`;
    const wq=`?workspaceId=${encodeURIComponent(company.workspace_id)}`;
    const [fa,p,cc,r]=await Promise.all([
      api<FinancialAccount[]>(`/api/client-transactions/financial-accounts${cq}`),
      api<Supplier[]>(`/api/master/partners${wq}`),
      api<CostCenter[]>(`/api/master/cost-centers${cq}`),
      api<CashOutRow[]>(`/api/client-transactions/cash-outs${cq}`),
    ]);
    setFinancialAccounts(fa);
    setSuppliers(p.filter(x=>x.partner_type==='SUPPLIER'||x.partner_type==='BOTH'));
    setCostCenters(cc);setRecent(r);
    setLocationId(current=>companyLocations.some(x=>x.id===current)?current:(companyLocations[0]?.id||''));
    setFinancialAccountId(current=>fa.some(x=>x.id===current)?current:(fa[0]?.id||''));
  }

  async function loadPayables() {
    if (!companyId || !supplierId || cashOutType!=='DEBT_PAYMENT') { setPayables([]);return; }
    try {
      setPayables(await api<Payable[]>(`/api/client-transactions/open-payables?companyId=${encodeURIComponent(companyId)}&supplierId=${encodeURIComponent(supplierId)}`));
    } catch { setPayables([]); }
  }

  useEffect(()=>{ void loadFoundation(); },[]);
  useEffect(()=>{ void loadCompanyData(); },[companyId,company?.workspace_id,locations.length]);
  useEffect(()=>{ setAllocations({});void loadPayables(); },[companyId,supplierId,cashOutType]);

  const operationalTotal=useMemo(()=>expenseLines.reduce((sum,line)=>sum+Number(line.amount||0),0),[expenseLines]);
  const debtTotal=useMemo(()=>Object.values(allocations).reduce((sum,value)=>sum+Number(value||0),0),[allocations]);
  const total=cashOutType==='DEBT_PAYMENT'?debtTotal:operationalTotal;

  function resetForm() {
    setReference('');setPayeeName('');setSupplierId('');setNotes('');setExpenseLines([makeExpense()]);setAllocations({});setAttachment(null);
  }

  async function saveDraft() {
    setError('');setSuccess('');
    if (!companyId||!locationId||!financialAccountId) return setError('Company, lokasi dan kas/bank wajib dipilih.');
    if (cashOutType==='DEBT_PAYMENT' && !supplierId) return setError('Pilih supplier untuk pembayaran hutang.');
    if (cashOutType==='DEBT_PAYMENT' && debtTotal<=0) return setError('Isi nominal pembayaran minimal pada satu invoice.');
    if (cashOutType==='OPERATIONAL_EXPENSE' && expenseLines.some(x=>!x.description.trim()||Number(x.amount||0)<=0)) return setError('Keperluan dan nominal setiap baris wajib diisi.');
    if (attachment && attachment.size>5*1024*1024) return setError('Bukti transaksi maksimal 5 MB.');
    setSaving(true);
    try {
      const result=await api<{ id:string;transaction_number:string }>('/api/client-transactions/cash-outs',{
        method:'POST',body:JSON.stringify({
          companyId,locationId,transactionDate,financialAccountId,cashOutType,referenceNumber:reference||null,notes:notes||null,
          payeeName:cashOutType==='OPERATIONAL_EXPENSE'?(payeeName||null):null,partnerId:cashOutType==='DEBT_PAYMENT'?supplierId:null,
          lines:cashOutType==='OPERATIONAL_EXPENSE'?expenseLines.map(x=>({ description:x.description,costCenterId:x.costCenterId||null,amount:Number(x.amount||0) })):[],
          allocations:cashOutType==='DEBT_PAYMENT'?payables.filter(x=>Number(allocations[x.id]||0)>0).map(x=>({ invoiceId:x.id,amount:Number(allocations[x.id]||0) })):[],
        }),
      });
      let attachmentNote='';
      if (attachment) {
        try {
          const dataBase64=await fileToBase64(attachment);
          await api(`/api/client-transactions/${result.id}/attachments`,{ method:'POST',body:JSON.stringify({ fileName:attachment.name,mimeType:attachment.type,dataBase64 }) });
          attachmentNote=' Bukti transaksi terunggah.';
        } catch { attachmentNote=' Transaksi tersimpan, tetapi bukti gagal diunggah.'; }
      }
      setSuccess(`${result.transaction_number} tersimpan sebagai draft.${attachmentNote}`);
      resetForm();await loadCompanyData();
    } catch (err) { setError(err instanceof Error?err.message:'Gagal menyimpan kas/bank keluar'); }
    finally { setSaving(false); }
  }

  async function verify(id:string) {
    setError('');setSuccess('');setVerifyingId(id);
    try {
      const result=await api<{ requiresAccountDirection:boolean }>(`/api/client-transactions/cash-outs/${id}/verify`,{ method:'POST' });
      setSuccess(result.requiresAccountDirection
        ? 'Finance Verified. Pengeluaran sudah diteruskan ke Akuntakita untuk diarahkan akun sebelum jurnal dibuat.'
        : 'Finance Verified. Pembayaran hutang sudah membentuk draft jurnal otomatis.');
      await loadCompanyData();
      if (supplierId) await loadPayables();
    } catch (err) { setError(err instanceof Error?err.message:'Gagal verifikasi kas/bank keluar'); }
    finally { setVerifyingId(''); }
  }

  return <div className="page-content client-cash-out-page">
    <section className="section-card cash-out-card">
      <div className="section-title master-heading"><div><span className="eyebrow">KAS & BANK</span><h3>Uang Keluar</h3><p>Client cukup mencatat kejadian bisnis. Tidak ada pilihan debit, kredit atau COA.</p></div><button className="primary-button compact" onClick={saveDraft} disabled={saving}><Save size={16}/>{saving?'Menyimpan...':'Simpan Draft'}</button></div>

      <div className="cash-out-type-switch">
        <button className={cashOutType==='OPERATIONAL_EXPENSE'?'active':''} onClick={()=>setCashOutType('OPERATIONAL_EXPENSE')} type="button"><strong>Pengeluaran Operasional</strong><span>Listrik, air, marketing, transport, kebutuhan outlet, dll.</span></button>
        <button className={cashOutType==='DEBT_PAYMENT'?'active':''} onClick={()=>setCashOutType('DEBT_PAYMENT')} type="button"><strong>Bayar Hutang</strong><span>Pilih supplier dan invoice pembelian yang akan dibayar.</span></button>
      </div>

      <div className="helper-box"><strong>Prinsip:</strong> pembayaran hutang otomatis ke Utang Usaha. Pengeluaran operasional tidak meminta client memilih akun; Akuntakita mengarahkan akun saat review accounting.</div>
      {success&&<div className="success-banner"><CheckCircle2 size={18}/><span>{success}</span></div>}
      {error&&<div className="form-error transaction-error">{error}</div>}

      <div className="cash-out-header-grid">
        <label>Company<select value={companyId} onChange={e=>setCompanyId(e.target.value)}><option value="">Pilih company</option>{companies.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Lokasi<select value={locationId} onChange={e=>setLocationId(e.target.value)}><option value="">Pilih lokasi</option>{companyLocations.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Tanggal<input type="date" value={transactionDate} onChange={e=>setTransactionDate(e.target.value)}/></label>
        <label>Keluar dari Kas / Bank<select value={financialAccountId} onChange={e=>setFinancialAccountId(e.target.value)}><option value="">Pilih kas/bank</option>{financialAccounts.map(x=><option key={x.id} value={x.id}>{x.name}{x.location_name?` — ${x.location_name}`:''}</option>)}</select></label>
        <label>No. Referensi<input value={reference} onChange={e=>setReference(e.target.value)} placeholder="Opsional"/></label>
        {cashOutType==='OPERATIONAL_EXPENSE'
          ? <label>Dibayarkan Kepada<input value={payeeName} onChange={e=>setPayeeName(e.target.value)} placeholder="Nama penerima / vendor"/></label>
          : <label>Supplier<select value={supplierId} onChange={e=>setSupplierId(e.target.value)}><option value="">Pilih supplier</option>{suppliers.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
        <label className="cash-out-notes">Catatan<input value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Keterangan tambahan"/></label>
      </div>

      {cashOutType==='OPERATIONAL_EXPENSE' ? <div className="cash-out-lines">
        <div className="cash-out-lines-head"><strong>Rincian Pengeluaran</strong><button className="secondary-button compact" type="button" onClick={()=>setExpenseLines(rows=>[...rows,makeExpense()])}><Plus size={15}/> Tambah Baris</button></div>
        <div className="data-table-wrap"><table><thead><tr><th>#</th><th>Keperluan / Keterangan</th><th>Cost Center</th><th className="numeric">Nominal</th><th></th></tr></thead><tbody>{expenseLines.map((line,index)=><tr key={line.key}><td>{index+1}</td><td><input value={line.description} onChange={e=>setExpenseLines(rows=>rows.map(x=>x.key===line.key?{...x,description:e.target.value}:x))} placeholder="Contoh: Listrik outlet September"/></td><td><select value={line.costCenterId} onChange={e=>setExpenseLines(rows=>rows.map(x=>x.key===line.key?{...x,costCenterId:e.target.value}:x))}><option value="">—</option>{costCenters.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></td><td className="numeric"><input className="number-input" type="number" min="0" step="1" value={line.amount} onChange={e=>setExpenseLines(rows=>rows.map(x=>x.key===line.key?{...x,amount:e.target.value}:x))}/></td><td><button type="button" className="icon-button danger" onClick={()=>setExpenseLines(rows=>rows.length===1?rows:rows.filter(x=>x.key!==line.key))}><Trash2 size={15}/></button></td></tr>)}</tbody></table></div>
      </div> : <div className="cash-out-lines">
        <div className="cash-out-lines-head"><div><strong>Invoice Hutang Supplier</strong><small className="journal-meta">Hanya invoice kredit yang sudah Finance Verified.</small></div><span>{payables.length} invoice terbuka</span></div>
        <div className="data-table-wrap"><table><thead><tr><th>No Pembelian</th><th>No Invoice Supplier</th><th>Tanggal</th><th>Jatuh Tempo</th><th className="numeric">Sisa Hutang</th><th className="numeric">Bayar Sekarang</th></tr></thead><tbody>{payables.map(x=><tr key={x.id}><td><strong>{x.transaction_number}</strong></td><td>{x.reference_number||'—'}</td><td>{x.transaction_date?.slice(0,10)}</td><td>{x.due_date?.slice(0,10)||'—'}</td><td className="numeric">Rp{money(x.outstanding)}</td><td className="numeric"><input className="number-input allocation-input" type="number" min="0" max={Number(x.outstanding)} step="1" value={allocations[x.id]||''} placeholder="0" onChange={e=>setAllocations(current=>({...current,[x.id]:e.target.value}))}/></td></tr>)}</tbody></table>{supplierId&&payables.length===0&&<div className="empty-state"><FileText size={32}/><strong>Tidak ada hutang terbuka</strong><span>Invoice kredit yang sudah diverifikasi akan tampil di sini.</span></div>}</div>
      </div>}

      <div className="cash-out-footer">
        <label className="attachment-box"><span><Upload size={16}/> Bukti Pembayaran / Nota</span><input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e=>setAttachment(e.target.files?.[0]||null)}/><small>{attachment?`${attachment.name} · ${(attachment.size/1024/1024).toFixed(2)} MB`:'PDF/JPG/PNG/WEBP · maks. 5 MB'}</small></label>
        <div className="cash-out-total"><span>Total Uang Keluar</span><strong>Rp{money(total)}</strong></div>
      </div>
    </section>

    <section className="section-card">
      <div className="section-title"><div><span className="eyebrow">MUTASI KAS & BANK</span><h3>Uang Keluar Terbaru</h3><p>Setelah Finance Verified, transaksi diteruskan ke Accounting Workspace Akuntakita.</p></div></div>
      <div className="data-table-wrap"><table><thead><tr><th>No Transaksi</th><th>Tanggal</th><th>Jenis</th><th>Penerima / Supplier</th><th>Kas / Bank</th><th>Status</th><th>Bukti</th><th className="numeric">Nominal</th><th></th></tr></thead><tbody>{recent.map(row=><tr key={row.id}><td><strong>{row.transaction_number}</strong></td><td>{row.transaction_date?.slice(0,10)}</td><td>{row.cash_out_type==='DEBT_PAYMENT'?'Bayar Hutang':'Operasional'}</td><td>{row.supplier_name||row.payee_name||'—'}</td><td>{row.financial_account_name||'—'}</td><td><span className={row.workflow_status==='DRAFT'?'status-draft':'status-ok'}>{row.workflow_status==='FINANCE_VERIFIED'?'Finance Verified':row.workflow_status}</span><small className="journal-meta">{row.accounting_status==='NEEDS_ACCOUNT_DIRECTION'?'Perlu Arah Akun':row.accounting_status}</small></td><td>{row.attachment_count>0?<span className="attachment-count"><FileText size={14}/>{row.attachment_count}</span>:'—'}</td><td className="numeric">Rp{money(row.grand_total)}</td><td>{canVerify&&row.workflow_status==='DRAFT'&&<button className="secondary-button compact verify-button" onClick={()=>verify(row.id)} disabled={verifyingId===row.id}><ShieldCheck size={15}/>{verifyingId===row.id?'Memproses...':'Finance Verified'}</button>}</td></tr>)}</tbody></table>{recent.length===0&&<div className="empty-state"><FileText size={34}/><strong>Belum ada uang keluar</strong><span>Catat transaksi pertama dari form di atas.</span></div>}</div>
    </section>
  </div>;
}
