import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { FileUp, Plus, RefreshCw, Save, Search, ShieldCheck, Trash2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import { api } from './api';
import { isQuinosInvoiceReport, parseQuinosInvoiceReport, type QuinosParseResult } from '../shared/quinosInvoiceParser';

type Company = { id:string; workspace_id:string; name:string };
type Location = { id:string; company_id:string; name:string; location_type:string };
type Item = { id:string; code:string; name:string; base_unit_id:string; unit_code:string; track_stock:boolean; can_sell:boolean; category_name:string };
type Context = { items:Item[]; paymentMappings:Array<{ payment_code:string; label:string }>; expectedPaymentMappings:number };
type Batch = {
  id:string; company_id:string; location_id:string; batch_number:string; source_type:string; source_name:string|null;
  status:string; row_count:number; invoice_count:number; total_sales:string; total_payments:string; created_at:string; verified_at:string|null; location_name:string;
};
type BatchList = { rows:Batch[]; total:number; page:number; pageSize:number; pages:number };
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
type ImportProfile = {
  id:string; name:string; provider:string|null; file_mode:string;
  itemAliases:Array<{ external_code:string|null; external_name:string; item_id:string }>;
};
type DetectResult = { match:null|{ id:string; name:string; provider:string|null; score:number }; candidates:Array<{ id:string; name:string; score:number }> };
type ParserSummary = {
  provider:string; fileName:string; sheetName:string; invoiceCount:number; rowCount:number; warnings:string[]; profileName:string|null;
};

const EDITOR_PAGE_SIZE = 50;
const BATCH_PAGE_SIZE = 25;
const QUINOS_PROFILE_NAME = 'Quinos - Invoice Detail Report';
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
    saleDate:['TANGGAL','DATE','TRANSACTIONDATE','ORDERDATE','TRANSDATE'], invoiceNumber:['NOINVOICE','NOFAKTUR','INVOICE','INVOICENO','RECEIPTNO','BILLNO','ORDERID'], cashier:['CASHIER','KASIR'], saleType:['TYPE','TIPE','ORDERTYPE'],
    itemCode:['KODEBARANG','ITEMCODE','KODEITEM','SKU','PRODUCTCODE'], itemName:['NAMABARANG','ITEMNAME','NAMAPRODUK','PRODUCT','PRODUCTNAME','MENU'], quantity:['QTY','QUANTITY'], unitPrice:['HARGA','PRICE','UNITPRICE'],
    discountAmount:['DISKON','DISCOUNT'], lineTotal:['TOTAL','LINETOTAL','NETTOTAL','NETSALES','NETAMOUNT'], cash:['CASH','TUNAI'], qris:['QRIS','QRCODE'], transfer:['TRANSFER','BANKTRANSFER'], compliment:['COMPLIMENT','COMPLIMENTARY'],
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

export default function ClientSalesImportPage({ canVerify, canOverride }:{ canVerify:boolean; canOverride:boolean }) {
  const [companies,setCompanies]=useState<Company[]>([]); const [locations,setLocations]=useState<Location[]>([]);
  const [companyId,setCompanyId]=useState(''); const [locationId,setLocationId]=useState(''); const [context,setContext]=useState<Context|null>(null);
  const [rows,setRows]=useState<SaleRow[]>([]); const [paste,setPaste]=useState(''); const [sourceType,setSourceType]=useState<'MANUAL'|'PASTE'|'CSV'>('PASTE'); const [sourceName,setSourceName]=useState('');
  const [batches,setBatches]=useState<Batch[]>([]); const [batchTotal,setBatchTotal]=useState(0); const [batchPages,setBatchPages]=useState(1); const [batchPage,setBatchPage]=useState(1);
  const [editorPage,setEditorPage]=useState(1); const [preview,setPreview]=useState<Preview|null>(null); const [loading,setLoading]=useState(true); const [saving,setSaving]=useState(false); const [verifying,setVerifying]=useState(false); const [error,setError]=useState(''); const [message,setMessage]=useState(''); const [allowBelowZero,setAllowBelowZero]=useState(false); const [search,setSearch]=useState('');
  const [activeProfile,setActiveProfile]=useState<ImportProfile|null>(null); const [parserSummary,setParserSummary]=useState<ParserSummary|null>(null);
  const deferredSearch=useDeferredValue(search);

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
  async function loadBatches(cid=companyId,page=batchPage) {
    if(!cid) return;
    try {
      const result=await api<BatchList>(`/api/client-transactions/sales-batches?companyId=${cid}&page=${page}&pageSize=${BATCH_PAGE_SIZE}`);
      setBatches(result.rows); setBatchTotal(result.total); setBatchPages(result.pages); setBatchPage(result.page);
    } catch(e){ setError(e instanceof Error?e.message:'Gagal memuat batch penjualan'); }
  }
  useEffect(()=>{ void loadBase(); },[]);
  useEffect(()=>{
    const valid=locations.filter(x=>x.company_id===companyId); if(valid.length && !valid.some(x=>x.id===locationId)) setLocationId(valid[0].id);
    setBatchPage(1); setActiveProfile(null); setParserSummary(null); void loadBatches(companyId,1);
  },[companyId,locations]);
  useEffect(()=>{ void loadContext(); },[companyId,locationId]);

  const companyLocations=useMemo(()=>locations.filter(x=>x.company_id===companyId),[locations,companyId]);
  const itemByCode=useMemo(()=>new Map((context?.items||[]).map(x=>[x.code.toUpperCase(),x])),[context]);
  const itemByName=useMemo(()=>new Map((context?.items||[]).map(x=>[x.name.trim().toLowerCase(),x])),[context]);
  const itemById=useMemo(()=>new Map((context?.items||[]).map(x=>[x.id,x])),[context]);
  const filteredBatches=useMemo(()=>{ const term=deferredSearch.trim().toLowerCase(); return term?batches.filter(x=>JSON.stringify(x).toLowerCase().includes(term)):batches; },[batches,deferredSearch]);
  const totals=useMemo(()=>rows.reduce((a,r)=>({ sales:a.sales+Number(r.lineTotal||0), payments:a.payments+Number(r.cash||0)+Number(r.qris||0)+Number(r.transfer||0)+Number(r.compliment||0)+Number(r.gofood||0)+Number(r.grabfood||0) }),{sales:0,payments:0}),[rows]);
  const editorPages=Math.max(1,Math.ceil(rows.length/EDITOR_PAGE_SIZE));
  const editorStart=(editorPage-1)*EDITOR_PAGE_SIZE;
  const visibleRows=useMemo(()=>rows.slice(editorStart,editorStart+EDITOR_PAGE_SIZE),[rows,editorStart]);
  const unmapped=useMemo(()=>{
    const grouped=new Map<string,{code:string;name:string;count:number}>();
    for(const row of rows.filter(x=>!x.itemId)){
      const key=(row.itemCode||row.itemName).trim().toUpperCase(); if(!key)continue;
      const current=grouped.get(key)||{code:row.itemCode,name:row.itemName,count:0}; current.count+=1; grouped.set(key,current);
    }
    return [...grouped.values()];
  },[rows]);

  function mapItems(input:SaleRow[],profile:ImportProfile|null=activeProfile) {
    const aliasCode=new Map((profile?.itemAliases||[]).filter(x=>x.external_code).map(x=>[x.external_code!.trim().toUpperCase(),x.item_id]));
    const aliasName=new Map((profile?.itemAliases||[]).filter(x=>x.external_name).map(x=>[x.external_name.trim().toLowerCase(),x.item_id]));
    return input.map(r=>{
      const aliasId=aliasCode.get(r.itemCode.trim().toUpperCase())||aliasName.get(r.itemName.trim().toLowerCase());
      const item=aliasId?itemById.get(aliasId):(itemByCode.get(r.itemCode.toUpperCase())||itemByName.get(r.itemName.trim().toLowerCase()));
      return {...r,itemId:item?.id||aliasId||r.itemId};
    });
  }

  async function ensureQuinosProfile(result:QuinosParseResult){
    if(!companyId) return null;
    try{
      const detected=await api<DetectResult>('/api/client-transactions/sales-import-profiles/detect',{method:'POST',body:JSON.stringify({companyId,headers:result.headerSignature})});
      let profileId=detected.match?.id||'';
      if(!profileId){
        try{
          const created=await api<{id:string}>('/api/client-transactions/sales-import-profiles',{method:'POST',body:JSON.stringify({
            companyId,name:QUINOS_PROFILE_NAME,provider:'Quinos',status:'ACTIVE',fileMode:'REPORT',headerRow:1,delimiter:'AUTO',dateFormat:'AUTO',numberFormat:'US',
            headerSignature:result.headerSignature,columnMapping:{},settings:{version:'0.16A',parser:'QUINOS_INVOICE_DETAIL'},
          })});
          profileId=created.id;
        }catch{
          const profiles=await api<Array<{id:string;name:string}>>(`/api/client-transactions/sales-import-profiles?companyId=${companyId}`);
          profileId=profiles.find(x=>x.name===QUINOS_PROFILE_NAME)?.id||'';
        }
      }
      if(!profileId) return null;
      const profile=await api<ImportProfile>(`/api/client-transactions/sales-import-profiles/${profileId}`);
      setActiveProfile(profile); return profile;
    }catch{return null;}
  }

  function applyPaste() {
    const parsed=parseTable(paste); if(!parsed.length){setError('Data belum terbaca. Pastikan baris pertama adalah header spreadsheet.');return;}
    setRows(mapItems(parsed)); setEditorPage(1); setSourceType('PASTE'); setSourceName('Paste spreadsheet'); setParserSummary(null); setActiveProfile(null); setError('');
  }

  async function uploadFile(file:File) {
    setError(''); setMessage(''); setParserSummary(null); setActiveProfile(null);
    const lower=file.name.toLowerCase();
    try{
      if(lower.endsWith('.xls')||lower.endsWith('.xlsx')){
        const buffer=await file.arrayBuffer();
        const workbook=XLSX.read(buffer,{type:'array'});
        const sheetName=workbook.SheetNames[0];
        if(!sheetName) throw new Error('Workbook tidak memiliki sheet.');
        const sheet=workbook.Sheets[sheetName];
        const matrix=XLSX.utils.sheet_to_json(sheet,{header:1,raw:false,defval:''}) as unknown[][];
        if(isQuinosInvoiceReport(matrix)){
          const parsed=parseQuinosInvoiceReport(matrix);
          const profile=await ensureQuinosProfile(parsed);
          const mapped=mapItems(parsed.rows as SaleRow[],profile);
          setRows(mapped); setEditorPage(1); setSourceType('CSV'); setSourceName(file.name); setPaste('');
          setParserSummary({provider:'Quinos · Invoice Detail Report',fileName:file.name,sheetName,invoiceCount:parsed.invoiceCount,rowCount:parsed.rows.length,warnings:parsed.warnings,profileName:profile?.name||null});
          setMessage(`File Quinos terbaca: ${parsed.invoiceCount} invoice dan ${parsed.rows.length} baris menu.`);
          return;
        }
        const csv=XLSX.utils.sheet_to_csv(sheet);
        const parsed=parseTable(csv);
        if(!parsed.length) throw new Error('Format Excel belum dikenali. Buat Template POS atau gunakan file Quinos Invoice Detail Report.');
        setRows(mapItems(parsed)); setEditorPage(1); setSourceType('CSV'); setSourceName(file.name); setPaste('');
        setParserSummary({provider:'Excel Tabular',fileName:file.name,sheetName,invoiceCount:new Set(parsed.map(x=>`${x.saleDate}|${x.invoiceNumber}`)).size,rowCount:parsed.length,warnings:[],profileName:null});
        return;
      }
      const text=await file.text(); const parsed=parseTable(text);
      if(!parsed.length) throw new Error('CSV/TXT belum terbaca.');
      setRows(mapItems(parsed)); setEditorPage(1); setSourceType('CSV'); setSourceName(file.name); setPaste(''); setParserSummary(null);
    }catch(e){setError(e instanceof Error?e.message:'File belum dapat dibaca');}
  }

  function addRow(){ setRows(v=>[...v,blankRow()]); setEditorPage(Math.max(1,Math.ceil((rows.length+1)/EDITOR_PAGE_SIZE))); setSourceType('MANUAL'); setSourceName('Input manual'); setParserSummary(null); }
  function patchRow(index:number,patch:Partial<SaleRow>){ setRows(v=>v.map((r,i)=>i===index?{...r,...patch}:r)); }
  async function chooseItem(index:number,itemId:string){
    const selected=context?.items.find(x=>x.id===itemId); const source=rows[index]; if(!source)return;
    setRows(current=>current.map((r,i)=>{
      const same=source.itemCode?Boolean(r.itemCode&&r.itemCode.trim().toUpperCase()===source.itemCode.trim().toUpperCase()):r.itemName.trim().toLowerCase()===source.itemName.trim().toLowerCase();
      return same||i===index?{...r,itemId,itemCode:r.itemCode||selected?.code||'',itemName:r.itemName||selected?.name||''}:r;
    }));
    if(activeProfile&&itemId&&(source.itemCode||source.itemName)){
      try{await api(`/api/client-transactions/sales-import-profiles/${activeProfile.id}/item-aliases`,{method:'POST',body:JSON.stringify({externalCode:source.itemCode||null,externalName:source.itemName,itemId})});}
      catch(e){setError(e instanceof Error?`Mapping tampil sudah berubah, tetapi alias belum tersimpan: ${e.message}`:'Alias item belum tersimpan.');}
    }
  }

  async function saveBatch(){
    if(!companyId||!locationId||!rows.length) return setError('Company, lokasi dan data penjualan wajib diisi.');
    if(unmapped.length) return setError(`Masih ada ${unmapped.length} menu/kode POS yang belum dipetakan ke master item.`);
    setSaving(true); setError(''); setMessage('');
    try {
      const result=await api<{id:string;batchNumber:string}>('/api/client-transactions/sales-batches',{method:'POST',body:JSON.stringify({companyId,locationId,sourceType,sourceName,rows})});
      setMessage(`Batch ${result.batchNumber} tersimpan. Jalankan Preview sebelum Finance Verified.`); setRows([]); setEditorPage(1); setPaste(''); setParserSummary(null); await loadBatches(companyId,1);
      if(canVerify) await openPreview(result.id);
    } catch(e){ setError(e instanceof Error?e.message:'Gagal menyimpan batch penjualan'); }
    finally { setSaving(false); }
  }
  async function openPreview(id:string){ setError(''); setMessage(''); setAllowBelowZero(false); try{ setPreview(await api<Preview>(`/api/client-transactions/sales-batches/${id}/preview`)); }catch(e){setError(e instanceof Error?e.message:'Gagal preview');} }
  async function verify(){
    if(!preview) return; setVerifying(true); setError('');
    try { const r=await api<{transactionCount:number}>(`/api/client-transactions/sales-batches/${preview.batchId}/verify`,{method:'POST',body:JSON.stringify({allowBelowZero})}); setMessage(`${preview.batchNumber} Finance Verified. ${r.transactionCount||preview.invoiceCount} invoice dibuat dan masuk Accounting Review.`); setPreview(null); await loadBatches(companyId,batchPage); }
    catch(e){ setError(e instanceof Error?e.message:'Finance Verified gagal'); }
    finally{ setVerifying(false); }
  }

  if(loading) return <div className="page-content"><section className="section-card">Memuat Data Penjualan...</section></div>;
  return <div className="page-content sales-import-page">
    <section className="section-card">
      <div className="section-title master-heading"><div><span className="eyebrow">FINANCE CONTROL · PENJUALAN</span><h3>Data Penjualan / Import POS</h3><p>Upload XLS/XLSX Quinos, Excel tabular, CSV/TXT, atau paste data. Format Quinos Invoice Detail Report dikenali dan dipecah otomatis per invoice.</p></div><button className="secondary-button compact" onClick={()=>{void loadContext();void loadBatches(companyId,batchPage);}}><RefreshCw size={15}/> Refresh</button></div>
      <div className="sales-head-grid"><label>Company<select value={companyId} onChange={e=>setCompanyId(e.target.value)}>{companies.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>Outlet / Lokasi<select value={locationId} onChange={e=>setLocationId(e.target.value)}>{companyLocations.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><div className="sales-setup-status"><strong>Setup pembayaran {context?.paymentMappings.length||0}/{context?.expectedPaymentMappings||6}</strong><span>{(context?.paymentMappings.length||0)===(context?.expectedPaymentMappings||6)?'Siap untuk Finance Verified':'Akuntakita perlu melengkapi mapping pembayaran'}</span></div></div>
      <div className="helper-box"><strong>Import fleksibel:</strong> file Quinos Invoice Detail Report (.xls/.xlsx) akan dibaca sebagai blok invoice. Kode menu dicocokkan lebih dulu ke master, lalu alias yang dipilih manual disimpan pada Template POS untuk import berikutnya.</div>
      {parserSummary&&<div className="helper-box"><strong>{parserSummary.provider}</strong> · {parserSummary.fileName} · sheet {parserSummary.sheetName}<br/><span>{parserSummary.invoiceCount} invoice · {parserSummary.rowCount} baris menu · template {parserSummary.profileName||'belum tersimpan'} · {unmapped.length} kode/menu belum mapping</span>{parserSummary.warnings.length>0&&<div style={{marginTop:8}}><strong>{parserSummary.warnings.length} catatan parser:</strong>{parserSummary.warnings.slice(0,8).map((w,i)=><div key={i}>• {w}</div>)}{parserSummary.warnings.length>8&&<div>• +{parserSummary.warnings.length-8} catatan lainnya</div>}</div>}</div>}
      <div className="sales-import-tools"><div className="paste-box"><textarea value={paste} onChange={e=>setPaste(e.target.value)} placeholder="Paste tabel dari Excel / Google Sheets di sini..."/><button className="secondary-button" onClick={applyPaste}>Baca Data Paste</button></div><label className="file-drop"><FileUp size={20}/><strong>Upload XLS / XLSX / CSV / TXT</strong><span>Quinos Invoice Detail Report akan dideteksi otomatis</span><input type="file" accept=".xls,.xlsx,.csv,.txt,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain" onChange={e=>{const f=e.target.files?.[0];if(f)void uploadFile(f);}}/></label></div>
      {unmapped.length>0&&<div className="stock-opname-warning"><div><strong>{unmapped.length} kode/menu belum dipetakan.</strong><span>Pilih Item / Mapping pada salah satu baris. Semua baris dengan kode yang sama ikut terisi dan alias disimpan untuk import Quinos berikutnya.</span></div></div>}
      <div className="table-toolbar"><div><button className="secondary-button compact" onClick={addRow}><Plus size={15}/> Baris Manual</button></div><span>{rows.length} baris · Penjualan {rupiah(totals.sales)}</span></div>
      <div className="data-table-wrap sales-grid-wrap"><table className="sales-grid"><thead><tr><th>Tanggal</th><th>No Invoice</th><th>Cashier</th><th>Type</th><th>Kode</th><th>Item / Mapping</th><th>Qty</th><th>Harga</th><th>Diskon</th><th>Total</th><th>Cash</th><th>QRIS</th><th>Transfer</th><th>Compliment</th><th>GoFood</th><th>GrabFood</th><th></th></tr></thead><tbody>{visibleRows.map((r,localIndex)=>{const i=editorStart+localIndex;const mapped=itemById.get(r.itemId);return <tr key={i}><td><input type="date" value={r.saleDate} onChange={e=>patchRow(i,{saleDate:e.target.value})}/></td><td><input value={r.invoiceNumber} onChange={e=>patchRow(i,{invoiceNumber:e.target.value})}/></td><td><input value={r.cashier} onChange={e=>patchRow(i,{cashier:e.target.value})}/></td><td><input value={r.saleType} onChange={e=>patchRow(i,{saleType:e.target.value})}/></td><td><input value={r.itemCode} onChange={e=>patchRow(i,{itemCode:e.target.value,itemId:''})}/></td><td>{mapped?<div className="mapped-item"><strong>✓ {mapped.code}</strong><span>{mapped.name}</span><button type="button" onClick={()=>patchRow(i,{itemId:''})}>Ubah</button></div>:<select className="mapping-missing" value={r.itemId} onChange={e=>void chooseItem(i,e.target.value)}><option value="">{r.itemName||'Pilih item'}</option>{(context?.items||[]).map(x=><option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select>}</td>{(['quantity','unitPrice','discountAmount','lineTotal','cash','qris','transfer','compliment','gofood','grabfood'] as const).map(k=><td key={k}><input className="number-input" value={r[k]} onChange={e=>patchRow(i,{[k]:normalizedNumber(e.target.value)} as Partial<SaleRow>)}/></td>)}<td><button className="icon-button danger" onClick={()=>setRows(v=>v.filter((_,x)=>x!==i))}><Trash2 size={15}/></button></td></tr>;})}</tbody></table>{!rows.length&&<div className="empty-state"><FileUp size={34}/><strong>Belum ada data penjualan</strong><span>Upload file Quinos/Excel, paste spreadsheet, CSV/TXT, atau tambah baris manual.</span></div>}</div>
      {rows.length>EDITOR_PAGE_SIZE&&<div className="sales-pager"><button className="secondary-button compact" disabled={editorPage<=1} onClick={()=>setEditorPage(p=>p-1)}>Sebelumnya</button><span>Baris {editorStart+1}–{Math.min(editorStart+EDITOR_PAGE_SIZE,rows.length)} dari {rows.length} · Halaman {editorPage}/{editorPages}</span><button className="secondary-button compact" disabled={editorPage>=editorPages} onClick={()=>setEditorPage(p=>p+1)}>Berikutnya</button></div>}
      {error&&<div className="form-error">{error}</div>}{message&&<div className="form-success">{message}</div>}
      <div className="sales-save-row"><div><strong>{rupiah(totals.sales)}</strong><span>Total data sementara · pembayaran baris {rupiah(totals.payments)}</span></div><button className="primary-button" disabled={saving||!rows.length||unmapped.length>0} onClick={saveBatch}><Save size={16}/>{saving?'Menyimpan...':unmapped.length?`${unmapped.length} Mapping Belum Selesai`:'Simpan Batch Penjualan'}</button></div>
    </section>

    <section className="section-card"><div className="section-title"><div><span className="eyebrow">RIWAYAT IMPORT</span><h3>Batch Penjualan</h3></div></div><div className="table-toolbar"><div className="search-box"><Search size={16}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Cari pada halaman ini..."/></div><span>{batchTotal} batch</span></div><div className="data-table-wrap"><table><thead><tr><th>Batch</th><th>Lokasi</th><th>Sumber</th><th>Baris</th><th>Invoice</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>{filteredBatches.map(b=><tr key={b.id}><td><strong>{b.batch_number}</strong><br/><small>{new Date(b.created_at).toLocaleString('id-ID')}</small></td><td>{b.location_name}</td><td>{b.source_name||b.source_type}</td><td>{b.row_count}</td><td>{b.invoice_count||'—'}</td><td>{rupiah(b.total_sales)}</td><td><span className={b.status==='FINANCE_VERIFIED'?'status-ok':'status-warn'}>{b.status==='FINANCE_VERIFIED'?'Finance Verified':'Draft'}</span></td><td>{b.status==='DRAFT'&&canVerify&&<button className="secondary-button compact" onClick={()=>void openPreview(b.id)}>Preview & Verify</button>}</td></tr>)}</tbody></table></div>{batchPages>1&&<div className="sales-pager"><button className="secondary-button compact" disabled={batchPage<=1} onClick={()=>void loadBatches(companyId,batchPage-1)}>Sebelumnya</button><span>Halaman {batchPage}/{batchPages}</span><button className="secondary-button compact" disabled={batchPage>=batchPages} onClick={()=>void loadBatches(companyId,batchPage+1)}>Berikutnya</button></div>}</section>

    {preview&&<div className="modal-backdrop" onMouseDown={()=>setPreview(null)}><div className="modal-card modal-wide sales-preview" onMouseDown={e=>e.stopPropagation()}><div><span className="eyebrow">PREVIEW FINANCE VERIFIED</span><h3>{preview.batchNumber}</h3><p className="modal-caption">{preview.invoiceCount} invoice · {preview.rowCount} baris · {rupiah(preview.totalSales)}</p></div>{preview.issues.length>0&&<div className="sales-issue-list"><strong>Perlu diperbaiki sebelum verifikasi</strong>{preview.issues.slice(0,12).map((x,i)=><span key={i}>{x.message}</span>)}{preview.issues.length>12&&<small>+ {preview.issues.length-12} issue lainnya</small>}</div>}{preview.shortages.length>0&&<div className="sales-shortage-list"><strong>Stok akan minus</strong>{preview.shortages.slice(0,10).map((x,i)=><span key={i}>{x.invoiceNumber} · {x.itemName}: tersedia {Number(x.available)} {x.unitCode}, jual {Number(x.requested)}, sisa {Number(x.after)} {x.unitCode}</span>)}{canOverride&&<label><input type="checkbox" checked={allowBelowZero} onChange={e=>setAllowBelowZero(e.target.checked)}/> Izinkan saldo minus untuk batch ini</label>}</div>}<div className="sales-preview-summary"><span>Total Penjualan <strong>{rupiah(preview.totalSales)}</strong></span><span>Total Pembayaran <strong>{rupiah(preview.totalPayments)}</strong></span></div><div className="modal-actions"><button className="secondary-button" onClick={()=>setPreview(null)}>Tutup</button><button className="primary-button" disabled={verifying||preview.issues.length>0||(preview.shortages.length>0&&!allowBelowZero)} onClick={()=>void verify()}><ShieldCheck size={16}/>{verifying?'Memproses...':'Finance Verified'}</button></div></div></div>}
  </div>;
}
