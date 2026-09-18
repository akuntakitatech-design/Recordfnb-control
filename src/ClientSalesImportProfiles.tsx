import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Plus, Save, Trash2 } from 'lucide-react';
import { api } from './api';

type Company={id:string;name:string};
type FileMode='WIDE'|'VERTICAL'|'REPORT';
type Profile={
  id:string;company_id:string;name:string;provider:string|null;status:'ACTIVE'|'INACTIVE';file_mode:FileMode;header_row:number;
  delimiter:string;date_format:string;number_format:string;header_signature:string[];column_mapping:Record<string,string>;settings?:Record<string,unknown>;
  item_alias_count:number;payment_alias_count:number;
};
type FieldDef={key:string;label:string;required?:boolean;wideOnly?:boolean;verticalOnly?:boolean};

const QUINOS_SIGNATURE=['Quinos Point Of Sale','Invoice Detail Report','Invoice #','Cashier','Type','Opened','Closed'];
const fields:FieldDef[]=[
  {key:'saleDate',label:'Tanggal',required:true},
  {key:'invoiceNumber',label:'No Invoice',required:true},
  {key:'cashier',label:'Kasir'},
  {key:'saleType',label:'Tipe Penjualan'},
  {key:'itemCode',label:'Kode / SKU Menu'},
  {key:'itemName',label:'Nama Menu',required:true},
  {key:'quantity',label:'Qty',required:true},
  {key:'unitPrice',label:'Harga'},
  {key:'discountAmount',label:'Diskon'},
  {key:'lineTotal',label:'Total / Net Sales',required:true},
  {key:'cash',label:'Cash',wideOnly:true},
  {key:'qris',label:'QRIS',wideOnly:true},
  {key:'transfer',label:'Transfer',wideOnly:true},
  {key:'compliment',label:'Compliment',wideOnly:true},
  {key:'gofood',label:'GoFood',wideOnly:true},
  {key:'grabfood',label:'GrabFood',wideOnly:true},
  {key:'shopeefood',label:'ShopeeFood',wideOnly:true},
  {key:'other',label:'Other / Split',wideOnly:true},
  {key:'paymentType',label:'Metode Pembayaran',verticalOnly:true},
  {key:'paymentAmount',label:'Nilai Pembayaran',verticalOnly:true},
];

function splitHeader(text:string,delimiter:string){
  const line=text.replace(/\r/g,'').split('\n').find(x=>x.trim())||'';
  const d=delimiter==='TAB'?'\t':delimiter==='SEMICOLON'?';':delimiter==='COMMA'?',':line.includes('\t')?'\t':line.includes(';')?';':',';
  return line.split(d).map(x=>x.trim().replace(/^"|"$/g,'')).filter(Boolean);
}

export function ClientSalesImportProfiles(){
  const [companies,setCompanies]=useState<Company[]>([]);
  const [companyId,setCompanyId]=useState('');
  const [profiles,setProfiles]=useState<Profile[]>([]);
  const [profileId,setProfileId]=useState('');
  const [name,setName]=useState('');
  const [provider,setProvider]=useState('');
  const [fileMode,setFileMode]=useState<FileMode>('WIDE');
  const [headerRow,setHeaderRow]=useState('1');
  const [delimiter,setDelimiter]=useState('AUTO');
  const [dateFormat,setDateFormat]=useState('AUTO');
  const [numberFormat,setNumberFormat]=useState('AUTO');
  const [headerText,setHeaderText]=useState('');
  const [mapping,setMapping]=useState<Record<string,string>>({});
  const [status,setStatus]=useState<'ACTIVE'|'INACTIVE'>('ACTIVE');
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');

  useEffect(()=>{void (async()=>{const c=await api<Company[]>('/api/master/companies');setCompanies(c);if(c[0])setCompanyId(c[0].id);})();},[]);
  useEffect(()=>{if(companyId)void loadProfiles(companyId);},[companyId]);

  async function loadProfiles(cid=companyId){
    const rows=await api<Profile[]>(`/api/client-transactions/sales-import-profiles?companyId=${cid}`);
    setProfiles(rows);
    if(profileId&&!rows.some(x=>x.id===profileId))setProfileId('');
  }

  const headers=useMemo(()=>fileMode==='REPORT'?QUINOS_SIGNATURE:splitHeader(headerText,delimiter),[headerText,delimiter,fileMode]);
  const visibleFields=useMemo(()=>fileMode==='REPORT'?[]:fields.filter(x=>fileMode==='WIDE'?!x.verticalOnly:!x.wideOnly),[fileMode]);
  const missingRequired=useMemo(()=>visibleFields.filter(x=>x.required&&!mapping[x.key]),[visibleFields,mapping]);

  function reset(){setProfileId('');setName('');setProvider('');setFileMode('WIDE');setHeaderRow('1');setDelimiter('AUTO');setDateFormat('AUTO');setNumberFormat('AUTO');setHeaderText('');setMapping({});setStatus('ACTIVE');setError('');setMessage('');}
  function edit(p:Profile){
    setProfileId(p.id);setName(p.name);setProvider(p.provider||'');setFileMode(p.file_mode);setHeaderRow(String(p.header_row));setDelimiter(p.delimiter);setDateFormat(p.date_format);setNumberFormat(p.number_format);setMapping(p.column_mapping||{});setStatus(p.status);setHeaderText(p.file_mode==='REPORT'?'':(p.header_signature||[]).join('\t'));setError('');setMessage('');
  }
  function changeFileMode(next:FileMode){
    setFileMode(next);
    if(next==='REPORT'){
      if(!name) setName('Quinos - Invoice Detail Report');
      if(!provider) setProvider('Quinos');
      setNumberFormat('US'); setMapping({});
    }
  }
  function autoSuggest(){
    const aliases:Record<string,string[]>={
      saleDate:['TANGGAL','DATE','TRANSACTIONDATE','ORDERDATE','TRANSDATE'],invoiceNumber:['NOINVOICE','INVOICE','INVOICENO','RECEIPTNO','BILLNO','ORDERID'],cashier:['CASHIER','KASIR'],saleType:['TYPE','TIPE','ORDERTYPE'],
      itemCode:['KODEBARANG','ITEMCODE','SKU','PRODUCTCODE'],itemName:['NAMABARANG','ITEMNAME','PRODUCT','PRODUCTNAME','MENU'],quantity:['QTY','QUANTITY'],unitPrice:['HARGA','PRICE','UNITPRICE'],discountAmount:['DISKON','DISCOUNT'],lineTotal:['TOTAL','NET','NETSALES','NETAMOUNT','TOTALAMOUNT'],
      cash:['CASH','TUNAI'],qris:['QRIS','QRCODE'],transfer:['TRANSFER','BANKTRANSFER'],compliment:['COMPLIMENT','COMPLIMENTARY'],gofood:['GOFOOD'],grabfood:['GRABFOOD'],shopeefood:['SHOPEEFOOD'],other:['OTHER','SPLIT'],paymentType:['PAYMENTTYPE','PAYMENTMETHOD','TENDER','TENDERNAME'],paymentAmount:['PAYMENTAMOUNT','TENDERAMOUNT','PAIDAMOUNT'],
    };
    const normalized=headers.map(h=>({raw:h,n:h.toUpperCase().replace(/[^A-Z0-9]/g,'')}));
    const next={...mapping};
    for(const field of visibleFields){if(next[field.key])continue;const hit=normalized.find(h=>aliases[field.key]?.includes(h.n));if(hit)next[field.key]=hit.raw;}
    setMapping(next);
  }

  async function save(){
    setError('');setMessage('');
    if(!companyId||!name.trim())return setError('Company dan nama template wajib diisi.');
    if(fileMode!=='REPORT'&&!headers.length)return setError('Tempel satu baris header dari file POS agar signature template tersimpan.');
    if(missingRequired.length)return setError(`Mapping wajib belum lengkap: ${missingRequired.map(x=>x.label).join(', ')}.`);
    setSaving(true);
    try{
      const settings=fileMode==='REPORT'?{version:'0.16A',parser:'QUINOS_INVOICE_DETAIL'}:{version:'0.16A'};
      const body={companyId,name:name.trim(),provider:provider.trim()||null,status,fileMode,headerRow:Number(headerRow||1),delimiter,dateFormat,numberFormat,headerSignature:headers,columnMapping:mapping,settings};
      if(profileId)await api(`/api/client-transactions/sales-import-profiles/${profileId}`,{method:'PUT',body:JSON.stringify(body)});
      else{const result=await api<{id:string}>('/api/client-transactions/sales-import-profiles',{method:'POST',body:JSON.stringify(body)});setProfileId(result.id);}
      setMessage(fileMode==='REPORT'?'Template report Quinos tersimpan. File Invoice Detail .xls/.xlsx akan dikenali otomatis.':'Template import POS tersimpan. Header yang sama nantinya dapat dikenali otomatis.');
      await loadProfiles();
    }catch(e){setError(e instanceof Error?e.message:'Gagal menyimpan template import POS');}
    finally{setSaving(false);}
  }

  async function deactivate(){
    if(!profileId)return;
    await api(`/api/client-transactions/sales-import-profiles/${profileId}`,{method:'DELETE'});
    reset();await loadProfiles();
  }

  return <div className="page-content sales-import-profile-page">
    <section className="section-card">
      <div className="section-title master-heading"><div><span className="eyebrow">IMPORT PROFILE · POS</span><h3>Template Mapping Format POS</h3><p>Satu format internal, banyak format file. Template tabular maupun report/blok disimpan per company.</p></div><button className="secondary-button compact" onClick={reset}><Plus size={15}/> Template Baru</button></div>
      {message&&<div className="success-banner"><CheckCircle2 size={18}/><span>{message}</span></div>}{error&&<div className="form-error">{error}</div>}
      <div className="sales-head-grid">
        <label>Company<select value={companyId} onChange={e=>{setCompanyId(e.target.value);reset();}}>{companies.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Template<select value={profileId} onChange={e=>{const p=profiles.find(x=>x.id===e.target.value);if(p)edit(p);else reset();}}><option value="">Template baru</option>{profiles.map(x=><option key={x.id} value={x.id}>{x.name}{x.status==='INACTIVE'?' · Nonaktif':''}</option>)}</select></label>
        <div className="sales-setup-status"><strong>{profiles.filter(x=>x.status==='ACTIVE').length} template aktif</strong><span>Item alias yang dipilih saat import akan dipakai lagi otomatis.</span></div>
      </div>
      <div className="stock-opname-header">
        <label>Nama Template<input value={name} onChange={e=>setName(e.target.value)} placeholder="Contoh: Olsera - MeatNight"/></label>
        <label>Provider<input value={provider} onChange={e=>setProvider(e.target.value)} placeholder="Quinos / Olsera / ESB / Custom"/></label>
        <label>Struktur File<select value={fileMode} onChange={e=>changeFileMode(e.target.value as FileMode)}><option value="WIDE">Tabular melebar · Cash/QRIS per kolom</option><option value="VERTICAL">Tabular vertikal · Payment Type + Amount</option><option value="REPORT">Report / blok · Quinos Invoice Detail</option></select></label>
        <label>Status<select value={status} onChange={e=>setStatus(e.target.value as 'ACTIVE'|'INACTIVE')}><option value="ACTIVE">Aktif</option><option value="INACTIVE">Nonaktif</option></select></label>
      </div>
      {fileMode==='REPORT'?<div className="helper-box"><strong>Parser: Quinos Invoice Detail Report.</strong><br/>Sistem mencari blok invoice, membaca Invoice #, Cashier, Type, Opened/Closed, kode menu, nilai item, Total, dan tender pembayaran. Kode menu yang belum cocok akan diminta mapping satu kali lalu disimpan sebagai alias.</div>:<>
        <div className="stock-opname-header">
          <label>Baris Header<input type="number" min="1" max="100" value={headerRow} onChange={e=>setHeaderRow(e.target.value)}/></label>
          <label>Delimiter<select value={delimiter} onChange={e=>setDelimiter(e.target.value)}><option value="AUTO">Auto</option><option value="TAB">Tab</option><option value="COMMA">Koma</option><option value="SEMICOLON">Titik koma</option></select></label>
          <label>Format Tanggal<select value={dateFormat} onChange={e=>setDateFormat(e.target.value)}><option value="AUTO">Auto</option><option value="DD/MM/YYYY">DD/MM/YYYY</option><option value="MM/DD/YYYY">MM/DD/YYYY</option><option value="YYYY-MM-DD">YYYY-MM-DD</option></select></label>
          <label>Format Angka<select value={numberFormat} onChange={e=>setNumberFormat(e.target.value)}><option value="AUTO">Auto</option><option value="ID">Indonesia · 1.234,56</option><option value="US">International · 1,234.56</option></select></label>
        </div>
        <label>Contoh Header File POS<textarea value={headerText} onChange={e=>setHeaderText(e.target.value)} placeholder={'Tempel satu baris header, contoh:\nTransaction Date\tReceipt No\tProduct\tQty\tNet Sales\tQRIS'}/></label>
        <div className="table-toolbar"><span>{headers.length} kolom terbaca · {missingRequired.length?`${missingRequired.length} mapping wajib belum lengkap`:'Mapping wajib lengkap'}</span><button className="secondary-button compact" type="button" onClick={autoSuggest}>Cocokkan Otomatis</button></div>
        <div className="data-table-wrap"><table><thead><tr><th>Field Sistem</th><th>Wajib</th><th>Kolom dari File POS</th></tr></thead><tbody>{visibleFields.map(field=><tr key={field.key}><td><strong>{field.label}</strong><br/><small>{field.key}</small></td><td>{field.required?'Ya':'Opsional'}</td><td><select value={mapping[field.key]||''} onChange={e=>setMapping(v=>({...v,[field.key]:e.target.value}))}><option value="">— tidak dipakai —</option>{headers.map(h=><option key={h} value={h}>{h}</option>)}</select></td></tr>)}</tbody></table></div>
      </>}
      <div className="modal-actions"><button className="primary-button" disabled={saving} onClick={()=>void save()}><Save size={16}/>{saving?'Menyimpan...':'Simpan Template'}</button>{profileId&&<button className="secondary-button" onClick={()=>void deactivate()}><Trash2 size={15}/> Nonaktifkan</button>}</div>
    </section>
  </div>;
}
