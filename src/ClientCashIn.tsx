import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, FileText, Plus, Save, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { api } from './api';

type Company={ id:string;workspace_id:string;name:string };
type Location={ id:string;company_id:string;name:string };
type FinancialAccount={ id:string;company_id:string;location_id:string|null;name:string;account_kind:string;location_name?:string };
type CostCenter={ id:string;company_id:string;name:string };
type CashInRow={ id:string;transaction_number:string;transaction_date:string;reference_number:string|null;cash_in_type:'BUSINESS_RECEIPT'|'OTHER_RECEIPT';source_name:string|null;grand_total:string;workflow_status:string;accounting_status:string;location_name?:string;financial_account_name?:string;attachment_count:number };
type ReceiptLine={ key:string;description:string;costCenterId:string;amount:string };

const today=()=>new Date().toISOString().slice(0,10);
const money=(value:string|number)=>Number(value||0).toLocaleString('id-ID',{ maximumFractionDigits:0 });
const makeLine=():ReceiptLine=>({ key:crypto.randomUUID(),description:'',costCenterId:'',amount:'0' });

async function fileToBase64(file:File) {
  return await new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result||'').split(',')[1]||'');
    reader.onerror=()=>reject(new Error('Gagal membaca file'));
    reader.readAsDataURL(file);
  });
}

export function ClientCashIn({ canVerify }:{ canVerify:boolean }) {
  const [companies,setCompanies]=useState<Company[]>([]);
  const [locations,setLocations]=useState<Location[]>([]);
  const [companyId,setCompanyId]=useState('');
  const [financialAccounts,setFinancialAccounts]=useState<FinancialAccount[]>([]);
  const [costCenters,setCostCenters]=useState<CostCenter[]>([]);
  const [recent,setRecent]=useState<CashInRow[]>([]);

  const [cashInType,setCashInType]=useState<'BUSINESS_RECEIPT'|'OTHER_RECEIPT'>('BUSINESS_RECEIPT');
  const [locationId,setLocationId]=useState('');
  const [transactionDate,setTransactionDate]=useState(today());
  const [financialAccountId,setFinancialAccountId]=useState('');
  const [reference,setReference]=useState('');
  const [sourceName,setSourceName]=useState('');
  const [notes,setNotes]=useState('');
  const [lines,setLines]=useState<ReceiptLine[]>([makeLine()]);
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
    const [fa,cc,r]=await Promise.all([
      api<FinancialAccount[]>(`/api/client-transactions/financial-accounts${cq}`),
      api<CostCenter[]>(`/api/master/cost-centers${cq}`),
      api<CashInRow[]>(`/api/client-transactions/cash-ins${cq}`),
    ]);
    setFinancialAccounts(fa);setCostCenters(cc);setRecent(r);
    setLocationId(current=>companyLocations.some(x=>x.id===current)?current:(companyLocations[0]?.id||''));
    setFinancialAccountId(current=>fa.some(x=>x.id===current)?current:(fa[0]?.id||''));
  }

  useEffect(()=>{ void loadFoundation(); },[]);
  useEffect(()=>{ void loadCompanyData(); },[companyId,company?.workspace_id,locations.length]);

  const total=useMemo(()=>lines.reduce((sum,line)=>sum+Number(line.amount||0),0),[lines]);

  function resetForm() {
    setReference('');setSourceName('');setNotes('');setLines([makeLine()]);setAttachment(null);
  }

  async function saveDraft() {
    setError('');setSuccess('');
    if (!companyId||!locationId||!financialAccountId) return setError('Company, lokasi dan kas/bank wajib dipilih.');
    if (!sourceName.trim()) return setError('Isi sumber dana / diterima dari.');
    if (lines.some(x=>!x.description.trim()||Number(x.amount||0)<=0)) return setError('Keterangan dan nominal setiap baris wajib diisi.');
    if (attachment && attachment.size>5*1024*1024) return setError('Bukti transaksi maksimal 5 MB.');
    setSaving(true);
    try {
      const result=await api<{ id:string;transaction_number:string }>('/api/client-transactions/cash-ins',{
        method:'POST',body:JSON.stringify({
          companyId,locationId,transactionDate,financialAccountId,cashInType,referenceNumber:reference||null,
          sourceName:sourceName||null,notes:notes||null,
          lines:lines.map(x=>({ description:x.description,costCenterId:x.costCenterId||null,amount:Number(x.amount||0) })),
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
    } catch (err) { setError(err instanceof Error?err.message:'Gagal menyimpan kas/bank masuk'); }
    finally { setSaving(false); }
  }

  async function verify(id:string) {
    setError('');setSuccess('');setVerifyingId(id);
    try {
      await api(`/api/client-transactions/cash-ins/${id}/verify`,{ method:'POST' });
      setSuccess('Finance Verified. Penerimaan sudah diteruskan ke Akuntakita untuk diarahkan akun sebelum jurnal dibuat.');
      await loadCompanyData();
    } catch (err) { setError(err instanceof Error?err.message:'Gagal verifikasi kas/bank masuk'); }
    finally { setVerifyingId(''); }
  }

  return <div className="page-content client-cash-out-page cash-in-page">
    <section className="section-card cash-out-card">
      <div className="section-title master-heading"><div><span className="eyebrow">KAS & BANK</span><h3>Uang Masuk</h3><p>Client mencatat dari mana uang diterima. Akun lawan tetap ditentukan Accounting Akuntakita.</p></div><button className="primary-button compact" onClick={saveDraft} disabled={saving}><Save size={16}/>{saving?'Menyimpan...':'Simpan Draft'}</button></div>

      <div className="cash-out-type-switch">
        <button className={cashInType==='BUSINESS_RECEIPT'?'active':''} onClick={()=>setCashInType('BUSINESS_RECEIPT')} type="button"><strong>Penerimaan Usaha</strong><span>Setoran penjualan, settlement, refund usaha, penerimaan aktivitas bisnis, dll.</span></button>
        <button className={cashInType==='OTHER_RECEIPT'?'active':''} onClick={()=>setCashInType('OTHER_RECEIPT')} type="button"><strong>Penerimaan Lainnya</strong><span>Setoran modal, pinjaman owner, pengembalian uang, dan penerimaan non-operasional.</span></button>
      </div>

      <div className="helper-box"><strong>Prinsip:</strong> client tidak memilih COA. Kas/Bank yang menerima uang sudah diketahui; Akuntakita menentukan akun sumber dana pada saat review.</div>
      {success&&<div className="success-banner"><CheckCircle2 size={18}/><span>{success}</span></div>}
      {error&&<div className="form-error transaction-error">{error}</div>}

      <div className="cash-out-header-grid">
        <label>Company<select value={companyId} onChange={e=>setCompanyId(e.target.value)}><option value="">Pilih company</option>{companies.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Lokasi<select value={locationId} onChange={e=>setLocationId(e.target.value)}><option value="">Pilih lokasi</option>{companyLocations.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Tanggal<input type="date" value={transactionDate} onChange={e=>setTransactionDate(e.target.value)}/></label>
        <label>Masuk ke Kas / Bank<select value={financialAccountId} onChange={e=>setFinancialAccountId(e.target.value)}><option value="">Pilih kas/bank</option>{financialAccounts.map(x=><option key={x.id} value={x.id}>{x.name}{x.location_name?` — ${x.location_name}`:''}</option>)}</select></label>
        <label>No. Referensi<input value={reference} onChange={e=>setReference(e.target.value)} placeholder="Opsional"/></label>
        <label>Diterima Dari / Sumber Dana<input value={sourceName} onChange={e=>setSourceName(e.target.value)} placeholder={cashInType==='BUSINESS_RECEIPT'?'Contoh: Settlement QRIS September':'Contoh: Setoran modal owner'}/></label>
        <label className="cash-out-notes">Catatan<input value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Keterangan tambahan"/></label>
      </div>

      <div className="cash-out-lines">
        <div className="cash-out-lines-head"><strong>Rincian Penerimaan</strong><button className="secondary-button compact" type="button" onClick={()=>setLines(rows=>[...rows,makeLine()])}><Plus size={15}/> Tambah Baris</button></div>
        <div className="data-table-wrap"><table><thead><tr><th>#</th><th>Sumber / Keterangan</th><th>Cost Center</th><th className="numeric">Nominal</th><th></th></tr></thead><tbody>{lines.map((line,index)=><tr key={line.key}><td>{index+1}</td><td><input value={line.description} onChange={e=>setLines(rows=>rows.map(x=>x.key===line.key?{...x,description:e.target.value}:x))} placeholder="Contoh: Setoran penjualan harian"/></td><td><select value={line.costCenterId} onChange={e=>setLines(rows=>rows.map(x=>x.key===line.key?{...x,costCenterId:e.target.value}:x))}><option value="">—</option>{costCenters.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></td><td className="numeric"><input className="number-input" type="number" min="0" step="1" value={line.amount} onChange={e=>setLines(rows=>rows.map(x=>x.key===line.key?{...x,amount:e.target.value}:x))}/></td><td><button type="button" className="icon-button danger" onClick={()=>setLines(rows=>rows.length===1?rows:rows.filter(x=>x.key!==line.key))}><Trash2 size={15}/></button></td></tr>)}</tbody></table></div>
      </div>

      <div className="cash-out-footer">
        <label className="attachment-box"><span><Upload size={16}/> Bukti Penerimaan / Dokumen</span><input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e=>setAttachment(e.target.files?.[0]||null)}/><small>{attachment?`${attachment.name} · ${(attachment.size/1024/1024).toFixed(2)} MB`:'PDF/JPG/PNG/WEBP · maks. 5 MB'}</small></label>
        <div className="cash-out-total"><span>Total Uang Masuk</span><strong>Rp{money(total)}</strong></div>
      </div>
    </section>

    <section className="section-card">
      <div className="section-title"><div><span className="eyebrow">DAFTAR PENERIMAAN</span><h3>Kas / Bank Masuk Terbaru</h3><p>Finance Verified akan masuk ke antrean Accounting untuk diarahkan akun sumber dana.</p></div></div>
      <div className="data-table-wrap"><table><thead><tr><th>No Transaksi</th><th>Tanggal</th><th>Jenis</th><th>Sumber Dana</th><th>Lokasi</th><th>Kas / Bank</th><th>Status</th><th>Bukti</th><th className="numeric">Total</th><th></th></tr></thead><tbody>{recent.map(row=><tr key={row.id}>
        <td><strong>{row.transaction_number}</strong></td><td>{row.transaction_date?.slice(0,10)}</td><td>{row.cash_in_type==='BUSINESS_RECEIPT'?'Penerimaan Usaha':'Penerimaan Lainnya'}</td><td>{row.source_name||'—'}</td><td>{row.location_name||'—'}</td><td>{row.financial_account_name||'—'}</td>
        <td><span className={row.workflow_status==='DRAFT'?'status-draft':'status-ok'}>{row.workflow_status==='FINANCE_VERIFIED'?'Finance Verified':row.workflow_status}</span><small className="journal-meta">{row.accounting_status==='NEEDS_ACCOUNT_DIRECTION'?'Perlu Arah Akun':row.accounting_status}</small></td>
        <td>{row.attachment_count>0?<span className="attachment-count"><FileText size={14}/>{row.attachment_count}</span>:'—'}</td><td className="numeric">Rp{money(row.grand_total)}</td>
        <td>{canVerify&&row.workflow_status==='DRAFT'&&<button className="secondary-button compact verify-button" onClick={()=>verify(row.id)} disabled={verifyingId===row.id}><ShieldCheck size={15}/>{verifyingId===row.id?'Memproses...':'Finance Verified'}</button>}</td>
      </tr>)}</tbody></table>{recent.length===0&&<div className="empty-state"><FileText size={34}/><strong>Belum ada kas/bank masuk</strong><span>Catat penerimaan pertama dari form di atas.</span></div>}</div>
    </section>
  </div>;
}
