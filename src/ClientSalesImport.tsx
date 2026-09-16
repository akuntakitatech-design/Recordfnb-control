import { useEffect, useMemo, useState } from 'react';
import { FileUp, Plus, RefreshCw, Save, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from './api';

type Company = { id:string; workspace_id:string; name:string };
type Location = { id:string; company_id:string; name:string; location_type:string };
type Item = { id:string; code:string; name:string; base_unit_id:string; unit_code:string; track_stock:boolean; can_sell:boolean; category_name:string };
type Context = { items:Item[]; paymentMappings:Array<{ payment_code:string; label:string }>; expectedPaymentMappings:number };
type Batch = {
  id:string; company_id:string; location_id:string; batch_number:string; source_type:string; source_name:string|null;
  status:string; row_count:number; invoice_count:number; total_sales:string; total_payments:string; created_at:string; verified_at:string|null; location_name:string;
};
type Preview = {
  batchId:string; batchNumber:string; invoiceCount:number; rowCount:number; totalSales:string; totalPayments:string;
  issues:Array<{ code:string; message:string; invoiceNumber?:string; rowNo?:number }>;
  shortages:Array<{ itemName:string; invoiceNumber:string; rowNo:number; available:string; requested:string; after:string; unitCode:string }>;
};
type SaleRow = {
  saleDate:string; invoiceNumber:string; cashier:string; saleType:string; itemCode:string; itemName:string; itemId:string;
  quantity:string; unitPrice:string; discountAmount:string; lineTotal:string;
  cash:string; qris:string; transfer:string; compliment:string; gofood:string; grabfood:string;
};

const blankRow = ():SaleRow => ({ saleDate:new Date().toISOString().slice(0,10), invoiceNumber:'', cashier:'', saleType:'', itemCode:'', itemName:'', itemId:'', quantity:'1', unitPrice:'0', discountAmount:'0', lineTotal:'0', cash:'0', qris:'0', transfer:'0', compliment:'0', gofood:'0', grabfood:'0' });
const rupiah = (value:string|number) => new Intl.NumberFormat('id-ID',{ style:'currency', currency:'IDR', maximumFractionDigits:0 }).format(Number(value||0));

function normalizeHeader(value:string) { return value.trim().toUpperCase().replace(/[^A-Z0-9]/g,''); }
function toIsoDate(value:string) {
  const v=value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m=v.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return v;
}
function normalizedNumber(value:string) {
  let v=value.trim().replace(/\s/g,'').replace(/^Rp/i,'');
  if (!v) return '0';
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(v)) v=v.replace(/\./g,'').replace(',','.');
  else if (v.includes(',') && !v.includes('.')) v=v.replace(',','.');
  else if (v.includes(',') && v.includes('.')) v=v.replace(/\./g,'').replace(',','.');
  const n=Number(v);
  return Number.isFinite(n) ? String(n) : '0';
}
function splitLine(line:string, delimiter:string) {
  const out:string[]=[]; let current=''; let quoted=false;
  for (let i=0;i<line.length;i+=1) {
    const ch=line[i];
    if (ch==='"') {
      if (quoted && line[i+1]==='"') { current+='"'; i+=1; }
      else quoted=!quoted;
    } else if (ch===delimiter && !quoted) { out.push(current); current=''; }
    else current+=ch;
  }
  out.push(current); return out;
}
function parseTable(text:string) {
  const lines=text.replace(/\r/g,'').split('\n').filter(x=>x.trim());
  if (lines.length<2) return [] as SaleRow[];
  const delimiter=lines[0].includes('\t')?'\t':lines[0].includes(';')?';':',';
  const headers=splitLine(lines[0],delimiter).map(normalizeHeader);
  const aliases:Record<string,string[]>={
    saleDate:['TANGGAL','DATE'], invoiceNumber:['NOINVOICE','NOFAKTUR','INVOICE','INVOICENO'], cashier:['CASHIER','KASIR'], saleType:['TYPE','TIPE'],
    itemCode:['KODEBARANG','ITEMCODE','KODEITEM'], itemName:['NAMABARANG','ITEMNAME','NAMAPRODUK'], quantity:['QTY','QUANTITY'], unitPrice:['HARGA','PRICE','UNITPRICE'],
    discountAmount:['DISKON','DISCOUNT'], lineTotal:['TOTAL','LINETOTAL','NETTOTAL'], cash:['CASH'], qris:['QRIS'], transfer:['TRANSFER'], compliment:['COMPLIMENT'],
    gofood:['GOFOOD'], grabfood:['GRABFOOD'],
  };
  const idx=(key:string)=>headers.findIndex(h=>aliases[key]?.includes(h));
  const index=Object.fromEntries(Object.keys(aliases).map(key=>[key,idx(key)]));
  return lines.slice(1).map(line=>{
    const c=splitLine(line,delimiter); const get=(key:string)=>index[key]>=0?(c[index[key]]||'').trim():'';
    return {
      saleDate:toIsoDate(get('saleDate')), invoiceNumber:get('invoiceNumber'), cashier:get('cashier'), saleType:get('saleType'), itemCode:get('itemCode'), itemName:get('itemName'), itemId:'',
      quantity:normalizedNumber(get('quantity')||'1'), unitPrice:normalizedNumber(get('unitPrice')), discountAmount:normalizedNumber(get('discountAmount')),
      lineTotal:normalizedNumber(get('lineTotal')), cash:normalizedNumber(get('cash')), qris:normalizedNumber(get('qris')), transfer:normalizedNumber(get('transfer')),
      compliment:normalizedNumber(get('compliment')), gofood:normalizedNumber(get('gofood')), grabfood:normalizedNumber(get('grabfood')),
    } satisfies SaleRow;
  });
}

export function ClientSalesImport({ canVerify, canOverride }:{ canVerify:boolean; canOverride:boolean }) {
  const [companies,setCompanies]=useState<Company[]>([]); const [locations,setLocations]=useState<Location[]>([]);
  const [companyId,setCompanyId]=useState(''); const [locationId,setLocationId]=useState(''); const [context,setContext]=useState<Context|null>(null);
  const [rows,setRows]=useState<SaleRow[]>([]); const [paste,setPaste]=useState(''); const [sourceType,setSourceType]=useState<'MANUAL'|'PASTE'|'CSV'>('PASTE'); const [sourceName,setSourceName]=useState('');
  const [batches,setBatches]=useState<Batch[]>([]); const [preview,setPreview]=useState<Preview|null>(null); const [loading,setLoading]=useState(true); const [saving,setSaving]=useState(false); const [verifying,setVerifying]=useState(false); const [error,setError]=useState(''); const [message,setMessage]=useState(''); const [allowBelowZero,setAllowBelowZero]=useState(false); const [search,setSearch]=useState('');

  async function loadBase() {
    setLoading(true); setError('');
    try {
      const [c,l]=await Promise.all([api<Company[]>('/api/master/companies'),api<Location[]>('/api/master/locations')]);
      setCompanies(c); setLocations(l);
      const cid=companyId||c[0]?.id||''; if(!companyId) setCompanyId(cid);
      const loc=l.find(x=>x.company_id===cid); if(!locationId && loc) setLocationId(loc.id);
    } catch(e){ setError(e instanceof Error?e.message:'Gagal memuat data penjualan'); }
    finally { setLoading(false); }
  }
  async function loadContext(cid=companyId,lid=locationId) {
    if(!cid||!lid) return;
    try { setContext(await api<Context>(`/api/client-transactions/sales-context?companyId=${cid}&locationId=${lid}`)); }
    catch(e){ setContext(null); setError(e instanceof Error?e.message:'Gagal memuat setup penjualan'); }
  }
  async function loadBatches(cid=companyId) {
    if(!cid) return;
    try { setBatches(await api<Batch[]>(`/api/client-transactions/sales-batches?companyId=${cid}`)); }
    catch(e){ setError(e instanceof Error?e.message:'Gagal memuat batch penjualan'); }
  }
  useEffect(()=>{ void loadBase(); },[]);
  useEffect(()=>{
    const valid=locations.filter(x=>x.company_id===companyId); if(valid.length && !valid.some(x=>x.id===locationId)) setLocationId(valid[0].id);
    void loadBatches(companyId);
  },[companyId,locations]);
  useEffect(()=>{ void loadContext(); },[companyId,locationId]);

  const companyLocations=useMemo(()=>locations.filter(x=>x.company_id===companyId),[locations,companyId]);
  const itemByCode=useMemo(()=>new Map((context?.items||[]).map(x=>[x.code.toUpperCase(),x])),[context]);
  const itemByName=useMemo(()=>new Map((context?.items||[]).map(x=>[x.name.trim().toLowerCase(),x])),[context]);
  const filteredBatches=useMemo(()=>{ const term=search.trim().toLowerCase(); return term?batches.filter(x=>JSON.stringify(x).toLowerCase().includes(term)):batches; },[batches,search]);
  const totals=useMemo(()=>rows.reduce((a,r)=>({ sales:a.sales+Number(r.lineTotal||0), payments:a.payments+Number(r.cash||0)+Number(r.qris||0)+Number(r.transfer||0)+Number(r.compliment||0)+Number(r.gofood||0)+Number(r.grabfood||0) }),{sales:0,payments:0}),[rows]);

  function mapItems(input:SaleRow[]) { return input.map(r=>{ const item=itemByCode.get(r.itemCode.toUpperCase())||itemByName.get(r.itemName.trim().toLowerCase()); return {...r,itemId:item?.id||r.itemId}; }); }
  function applyPaste() { const parsed=parseTable(paste); if(!parsed.length){setError('Data belum terbaca. Pastikan baris pertama adalah header spreadsheet.');return;} setRows(mapItems(parsed)); setSourceType('PASTE'); setSourceName('Paste spreadsheet'); setError(''); }
  async function uploadFile(file:File) { const text=await file.text(); const parsed=parseTable(text); if(!parsed.length){setError('CSV/TXT belum terbaca.');return;} setRows(mapItems(parsed)); setSourceType('CSV'); setSourceName(file.name); setPaste(''); setError(''); }
  function addRow(){ setRows(v=>[...v,blankRow()]); setSourceType('MANUAL'); setSourceName('Input manual'); }
  function patchRow(index:number,patch:Partial<SaleRow>){ setRows(v=>v.map((r,i)=>i===index?{...r,...patch}:r)); }
  function chooseItem(index:number,itemId:string){ const item=context?.items.find(x=>x.id===itemId); patchRow(index,{ itemId,itemCode:item?.code||rows[index].itemCode,itemName:item?.name||rows[index].itemName }); }

  async function saveBatch(){
    if(!companyId||!locationId||!rows.length) return setError('Company, lokasi dan data penjualan wajib diisi.');
    setSaving(true); setError(''); setMessage('');
    try {
      const result=await api<{id:string;batchNumber:string}>('/api/client-transactions/sales-batches',{method:'POST',body:JSON.stringify({companyId,locationId,sourceType,sourceName,rows})});
      setMessage(`Batch ${result.batchNumber} tersimpan. Jalankan Preview sebelum Finance Verified.`); setRows([]); setPaste(''); await loadBatches();
      if(canVerify) await openPreview(result.id);
    } catch(e){ setError(e instanceof Error?e.message:'Gagal menyimpan batch penjualan'); }
    finally { setSaving(false); }
  }
  async function openPreview(id:string){ setError(''); setMessage(''); setAllowBelowZero(false); try{ setPreview(await api<Preview>(`/api/client-transactions/sales-batches/${id}/preview`)); }catch(e){setError(e instanceof Error?e.message:'Gagal preview');} }
  async function verify(){
    if(!preview) return; setVerifying(true); setError('');
    try { const r=await api<{transactionCount:number}>(`/api/client-transactions/sales-batches/${preview.batchId}/verify`,{method:'POST',body:JSON.stringify({allowBelowZero})}); setMessage(`${preview.batchNumber} Finance Verified. ${r.transactionCount||preview.invoiceCount} invoice dibuat dan masuk Accounting Review.`); setPreview(null); await loadBatches(); }
    catch(e){ setError(e instanceof Error?e.message:'Finance Verified gagal'); }
    finally{ setVerifying(false); }
  }

  if(loading) return <div className="page-content"><section className="section-card">Memuat Data Penjualan...</section></div>;
  return <div className="page-content sales-import-page">
    <section className="section-card">
      <div className="section-title master-heading"><div><span className="eyebrow">FINANCE CONTROL · PENJUALAN</span><h3>Data Penjualan / Import POS</h3><p>Tempel data dari Excel/Google Sheets atau upload CSV/TXT. Client tidak memilih COA; pembayaran dan akun penjualan mengikuti mapping Akuntakita.</p></div><button className="secondary-button compact" onClick={()=>{void loadContext();void loadBatches();}}><RefreshCw size={15}/> Refresh</button></div>
      <div className="sales-head-grid"><label>Company<select value={companyId} onChange={e=>setCompanyId(e.target.value)}>{companies.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>Outlet / Lokasi<select value={locationId} onChange={e=>setLocationId(e.target.value)}>{companyLocations.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><div className="sales-setup-status"><strong>Setup pembayaran {context?.paymentMappings.length||0}/{context?.expectedPaymentMappings||6}</strong><span>{(context?.paymentMappings.length||0)===(context?.expectedPaymentMappings||6)?'Siap untuk Finance Verified':'Akuntakita perlu melengkapi mapping pembayaran'}</span></div></div>
      <div className="helper-box">Header yang dikenali: TANGGAL, NO INVOICE, CASHIER, TYPE, KODE BARANG, NAMA BARANG, QTY, HARGA, DISKON, TOTAL, CASH, QRIS, TRANSFER, COMPLIMENT, GO FOOD, GRAB FOOD. Nilai pembayaran boleh hanya di baris pertama invoice atau diulang sama pada semua baris invoice.</div>
      <div className="sales-import-tools"><div className="paste-box"><textarea value={paste} onChange={e=>setPaste(e.target.value)} placeholder="Paste tabel dari Excel / Google Sheets di sini..."/><button className="secondary-button" onClick={applyPaste}>Baca Data Paste</button></div><label className="file-drop"><FileUp size={20}/><strong>Upload CSV / TXT</strong><span>Format kolom sama dengan spreadsheet</span><input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={e=>{const f=e.target.files?.[0];if(f)void uploadFile(f);}}/></label></div>
      <div className="table-toolbar"><div><button className="secondary-button compact" onClick={addRow}><Plus size={15}/> Baris Manual</button></div><span>{rows.length} baris · Penjualan {rupiah(totals.sales)}</span></div>
      <div className="data-table-wrap sales-grid-wrap"><table className="sales-grid"><thead><tr><th>Tanggal</th><th>No Invoice</th><th>Cashier</th><th>Type</th><th>Kode</th><th>Item / Mapping</th><th>Qty</th><th>Harga</th><th>Diskon</th><th>Total</th><th>Cash</th><th>QRIS</th><th>Transfer</th><th>Compliment</th><th>GoFood</th><th>GrabFood</th><th></th></tr></thead><tbody>{rows.map((r,i)=><tr key={i}><td><input type="date" value={r.saleDate} onChange={e=>patchRow(i,{saleDate:e.target.value})}/></td><td><input value={r.invoiceNumber} onChange={e=>patchRow(i,{invoiceNumber:e.target.value})}/></td><td><input value={r.cashier} onChange={e=>patchRow(i,{cashier:e.target.value})}/></td><td><input value={r.saleType} onChange={e=>patchRow(i,{saleType:e.target.value})}/></td><td><input value={r.itemCode} onChange={e=>patchRow(i,{itemCode:e.target.value})}/></td><td><select className={!r.itemId?'mapping-missing':''} value={r.itemId} onChange={e=>chooseItem(i,e.target.value)}><option value="">{r.itemName||'Pilih item'}</option>{(context?.items||[]).map(x=><option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></td>{(['quantity','unitPrice','discountAmount','lineTotal','cash','qris','transfer','compliment','gofood','grabfood'] as const).map(k=><td key={k}><input className="number-input" value={r[k]} onChange={e=>patchRow(i,{[k]:normalizedNumber(e.target.value)} as Partial<SaleRow>)}/></td>)}<td><button className="icon-button danger" onClick={()=>setRows(v=>v.filter((_,x)=>x!==i))}><Trash2 size={15}/></button></td></tr>)}</tbody></table>{!rows.length&&<div className="empty-state"><FileUp size={34}/><strong>Belum ada data penjualan</strong><span>Paste spreadsheet, upload CSV/TXT, atau tambah baris manual.</span></div>}</div>
      {error&&<div className="form-error">{error}</div>}{message&&<div className="form-success">{message}</div>}
      <div className="sales-save-row"><div><strong>{rupiah(totals.sales)}</strong><span>Total data sementara · pembayaran baris {rupiah(totals.payments)}</span></div><button className="primary-button" disabled={saving||!rows.length} onClick={saveBatch}><Save size={16}/>{saving?'Menyimpan...':'Simpan Batch Penjualan'}</button></div>
    </section>

    <section className="section-card"><div className="section-title"><div><span className="eyebrow">RIWAYAT IMPORT</span><h3>Batch Penjualan</h3></div></div><div className="table-toolbar"><div className="search-box"><Search size={16}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Cari batch / lokasi..."/></div><span>{filteredBatches.length} batch</span></div><div className="data-table-wrap"><table><thead><tr><th>Batch</th><th>Lokasi</th><th>Sumber</th><th>Baris</th><th>Invoice</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>{filteredBatches.map(b=><tr key={b.id}><td><strong>{b.batch_number}</strong><br/><small>{new Date(b.created_at).toLocaleString('id-ID')}</small></td><td>{b.location_name}</td><td>{b.source_name||b.source_type}</td><td>{b.row_count}</td><td>{b.invoice_count||'—'}</td><td>{rupiah(b.total_sales)}</td><td><span className={b.status==='FINANCE_VERIFIED'?'status-ok':'status-warn'}>{b.status==='FINANCE_VERIFIED'?'Finance Verified':'Draft'}</span></td><td>{b.status==='DRAFT'&&canVerify&&<button className="secondary-button compact" onClick={()=>void openPreview(b.id)}>Preview & Verify</button>}</td></tr>)}</tbody></table></div></section>

    {preview&&<div className="modal-backdrop" onMouseDown={()=>setPreview(null)}><div className="modal-card modal-wide sales-preview" onMouseDown={e=>e.stopPropagation()}><div><span className="eyebrow">PREVIEW FINANCE VERIFIED</span><h3>{preview.batchNumber}</h3><p className="modal-caption">{preview.invoiceCount} invoice · {preview.rowCount} baris · {rupiah(preview.totalSales)}</p></div>{preview.issues.length>0&&<div className="sales-issue-list"><strong>Perlu diperbaiki sebelum verifikasi</strong>{preview.issues.slice(0,12).map((x,i)=><span key={i}>{x.message}</span>)}{preview.issues.length>12&&<small>+ {preview.issues.length-12} issue lainnya</small>}</div>}{preview.shortages.length>0&&<div className="sales-shortage-list"><strong>Stok akan minus</strong>{preview.shortages.slice(0,10).map((x,i)=><span key={i}>{x.invoiceNumber} · {x.itemName}: tersedia {Number(x.available)} {x.unitCode}, jual {Number(x.requested)}, sisa {Number(x.after)}</span>)}{canOverride&&<label><input type="checkbox" checked={allowBelowZero} onChange={e=>setAllowBelowZero(e.target.checked)}/> Izinkan saldo minus untuk batch ini</label>}</div>}<div className="sales-preview-summary"><span>Total Penjualan <strong>{rupiah(preview.totalSales)}</strong></span><span>Total Pembayaran <strong>{rupiah(preview.totalPayments)}</strong></span></div><div className="modal-actions"><button className="secondary-button" onClick={()=>setPreview(null)}>Tutup</button><button className="primary-button" disabled={verifying||preview.issues.length>0||(preview.shortages.length>0&&!allowBelowZero)} onClick={()=>void verify()}><ShieldCheck size={16}/>{verifying?'Memproses...':'Finance Verified'}</button></div></div></div>}
  </div>;
}
