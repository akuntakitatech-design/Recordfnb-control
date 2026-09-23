import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardCheck, RefreshCw, Save, Search, ShieldCheck } from 'lucide-react';
import { api } from './api';

type Company={id:string;workspace_id:string;name:string};
type Location={id:string;company_id:string;name:string};
type Unit={id:string;workspace_id:string;code:string;name:string};
type Conversion={id:string;item_id:string|null;from_unit_id:string;to_unit_id:string;multiplier:string};
type OpnameItem={item_id:string;code:string;name:string;category_name:string;base_unit_id:string;base_unit_code:string;base_unit_name:string;quantity_on_hand:string;average_cost:string;setup_ready:boolean};
type CountRow={itemId:string;unitId:string;physical:string;description:string};
type RecentRow={id:string;transaction_number:string;transaction_date:string;notes:string|null;grand_total:string;workflow_status:string;accounting_status:string;location_name:string;line_count:number;adjusted_line_count:number};
type StaleLine={lineId:string;lineNo:number;itemId:string;itemName:string;baseUnitCode:string;snapshot:string;current:string};

const today=()=>new Date().toISOString().slice(0,10);
const num=(value:string|number)=>Number(value||0);
const qty=(value:number)=>value.toLocaleString('id-ID',{maximumFractionDigits:3});
const money=(value:string|number)=>Number(value||0).toLocaleString('id-ID',{maximumFractionDigits:0});

export function ClientStockOpname({canVerify}:{canVerify:boolean}){
  const [companies,setCompanies]=useState<Company[]>([]);
  const [locations,setLocations]=useState<Location[]>([]);
  const [units,setUnits]=useState<Unit[]>([]);
  const [conversions,setConversions]=useState<Conversion[]>([]);
  const [companyId,setCompanyId]=useState('');
  const [locationId,setLocationId]=useState('');
  const [date,setDate]=useState(today());
  const [notes,setNotes]=useState('');
  const [items,setItems]=useState<OpnameItem[]>([]);
  const [counts,setCounts]=useState<Record<string,CountRow>>({});
  const [recent,setRecent]=useState<RecentRow[]>([]);
  const [search,setSearch]=useState('');
  const [saving,setSaving]=useState(false);
  const [verifying,setVerifying]=useState('');
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');

  const company=companies.find(x=>x.id===companyId);
  const companyLocations=locations.filter(x=>x.company_id===companyId);

  useEffect(()=>{void (async()=>{const [c,l]=await Promise.all([api<Company[]>('/api/master/companies'),api<Location[]>('/api/master/locations')]);setCompanies(c);setLocations(l);if(c[0])setCompanyId(c[0].id);})();},[]);
  useEffect(()=>{if(!company)return;void (async()=>{const [u,cv,r]=await Promise.all([api<Unit[]>(`/api/master/units?workspaceId=${company.workspace_id}`),api<Conversion[]>(`/api/master/unit-conversions?workspaceId=${company.workspace_id}`),api<RecentRow[]>(`/api/client-transactions/stock-opnames?companyId=${company.id}`)]);setUnits(u);setConversions(cv);setRecent(r);setLocationId(current=>companyLocations.some(x=>x.id===current)?current:(companyLocations[0]?.id||''));})();},[companyId,company?.workspace_id,locations.length]);
  useEffect(()=>{if(!companyId||!locationId){setItems([]);return;}void refreshItems();},[companyId,locationId]);

  async function refreshItems(){
    const data=await api<OpnameItem[]>(`/api/client-transactions/stock-opname-items?companyId=${companyId}&locationId=${locationId}`);
    setItems(data);
    setCounts(current=>{
      const next:Record<string,CountRow>={};
      for(const item of data){next[item.item_id]=current[item.item_id]||{itemId:item.item_id,unitId:item.base_unit_id,physical:'',description:''};}
      return next;
    });
  }
  async function refreshRecent(){if(companyId)setRecent(await api<RecentRow[]>(`/api/client-transactions/stock-opnames?companyId=${companyId}`));}

  function allowedUnits(item:OpnameItem){
    const ids=new Set<string>([item.base_unit_id]);
    for(const c of conversions){if(c.to_unit_id===item.base_unit_id&&(c.item_id===item.item_id||c.item_id===null))ids.add(c.from_unit_id);}
    return units.filter(u=>ids.has(u.id));
  }
  function multiplier(item:OpnameItem,row:CountRow){
    if(!row.unitId)return 0;
    if(row.unitId===item.base_unit_id)return 1;
    const specific=conversions.find(c=>c.item_id===item.item_id&&c.from_unit_id===row.unitId&&c.to_unit_id===item.base_unit_id);
    const general=conversions.find(c=>c.item_id===null&&c.from_unit_id===row.unitId&&c.to_unit_id===item.base_unit_id);
    return num((specific||general)?.multiplier||0);
  }
  function physicalBase(item:OpnameItem,row:CountRow){return row.physical===''?null:num(row.physical)*multiplier(item,row);}
  function update(itemId:string,patch:Partial<CountRow>){setCounts(current=>({...current,[itemId]:{...current[itemId],...patch}}));}

  const filtered=useMemo(()=>{const term=search.trim().toLowerCase();return term?items.filter(x=>`${x.code} ${x.name} ${x.category_name}`.toLowerCase().includes(term)):items;},[items,search]);
  const counted=useMemo(()=>items.filter(x=>counts[x.item_id]?.physical!==''),[items,counts]);
  const differences=useMemo(()=>counted.filter(item=>{const physical=physicalBase(item,counts[item.item_id]);return physical!==null&&Math.abs(physical-num(item.quantity_on_hand))>0.000001;}),[counted,counts,conversions]);

  function fillSystem(){
    setCounts(current=>{const next={...current};for(const item of filtered){next[item.item_id]={...next[item.item_id],unitId:item.base_unit_id,physical:String(num(item.quantity_on_hand))};}return next;});
  }
  function clearCounts(){setCounts(current=>{const next={...current};for(const item of items){next[item.item_id]={...next[item.item_id],physical:'',description:''};}return next;});}

  async function save(){
    setError('');setSuccess('');
    if(!companyId||!locationId)return setError('Company dan lokasi wajib dipilih.');
    if(!counted.length)return setError('Isi stok fisik minimal satu barang. Nilai 0 boleh digunakan jika stok fisik memang kosong.');
    if(counted.some(item=>!counts[item.item_id]?.unitId||physicalBase(item,counts[item.item_id])===null||Number.isNaN(physicalBase(item,counts[item.item_id]) as number)))return setError('Periksa kembali stok fisik dan satuan.');
    if(counted.some(item=>!item.setup_ready))return setError('Ada kelompok barang yang mapping Persediaan / Stock Opname-nya belum disiapkan Akuntakita.');
    setSaving(true);
    try{
      const result=await api<{id:string;transaction_number:string}>('/api/client-transactions/stock-opnames',{method:'POST',body:JSON.stringify({companyId,locationId,transactionDate:date,notes:notes||null,lines:counted.map(item=>({itemId:item.item_id,unitId:counts[item.item_id].unitId,physicalQuantity:num(counts[item.item_id].physical),description:counts[item.item_id].description||null}))})});
      setSuccess(`${result.transaction_number} tersimpan sebagai draft. Saldo sistem saat ini dikunci sebagai snapshot untuk pengecekan Finance Verified.`);
      clearCounts();
      await Promise.all([refreshRecent(),refreshItems()]);
    }catch(err){setError(err instanceof Error?err.message:'Gagal menyimpan stock opname');}
    finally{setSaving(false);}
  }

  async function verify(row:RecentRow){
    setError('');setSuccess('');setVerifying(row.id);
    try{
      const preview=await api<{stale:StaleLine[]}>(`/api/client-transactions/stock-opnames/${row.id}/preview`);
      if(preview.stale.length){const detail=preview.stale.map(x=>`${x.itemName}: snapshot ${qty(num(x.snapshot))} ${x.baseUnitCode}, saldo sekarang ${qty(num(x.current))} ${x.baseUnitCode}`).join('\n');setError(`Saldo berubah setelah draft Stock Opname dibuat. Buat ulang Stock Opname dari saldo terbaru.\n${detail}`);return;}
      const result=await api<{adjustmentValue:string;adjustedLines:number;journal:null|{journal_number:string}}>(`/api/client-transactions/stock-opnames/${row.id}/verify`,{method:'POST',body:'{}'});
      setSuccess(result.adjustedLines?`Finance Verified. ${result.adjustedLines} barang disesuaikan senilai Rp${money(result.adjustmentValue)} dan draft jurnal sudah terbentuk.`:'Finance Verified. Tidak ada selisih stok sehingga tidak diperlukan jurnal penyesuaian.');
      await Promise.all([refreshRecent(),refreshItems()]);
    }catch(err){const message=err instanceof Error?err.message:'Gagal verifikasi';setError(message.startsWith('MOVING_AVERAGE_NOT_AVAILABLE')?'HPP average belum tersedia untuk salah satu barang yang memiliki selisih. Pastikan nilai persediaan sudah terbentuk terlebih dahulu.':message);}
    finally{setVerifying('');}
  }

  return <div className="page-content stock-opname-page">
    <section className="section-card">
      <div className="section-title master-heading"><div><span className="eyebrow">PERSEDIAAN</span><h3>Stock Opname</h3><p>Bandingkan stok sistem dengan hasil hitung fisik. Client tidak memilih akun dan tidak mengisi HPP.</p></div><button className="primary-button compact" disabled={saving} onClick={save}><Save size={16}/>{saving?'Menyimpan...':'Simpan Draft'}</button></div>
      <div className="helper-box"><strong>Snapshot stok:</strong> saat draft disimpan, saldo sistem ikut disimpan. Jika ada transaksi stok setelah itu, Finance Verified akan ditahan agar penyesuaian tidak memakai saldo yang sudah berubah.</div>
      {success&&<div className="success-banner"><CheckCircle2 size={18}/><span>{success}</span></div>}{error&&<div className="form-error stock-opname-error">{error}</div>}
      <div className="stock-opname-header"><label>Company<select value={companyId} onChange={e=>setCompanyId(e.target.value)}><option value="">Pilih company</option>{companies.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>Lokasi<select value={locationId} onChange={e=>setLocationId(e.target.value)}><option value="">Pilih lokasi</option>{companyLocations.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>Tanggal<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label><label>Catatan<input value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Contoh: opname akhir bulan"/></label></div>
      <div className="table-toolbar stock-opname-toolbar"><div className="search-box"><Search size={16}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Cari barang atau kategori..."/></div><div className="stock-opname-actions"><span>{counted.length} dihitung · {differences.length} selisih</span><button className="secondary-button compact" type="button" onClick={fillSystem}><RefreshCw size={15}/> Isi Sesuai Sistem</button><button className="secondary-button compact" type="button" onClick={clearCounts}>Kosongkan</button></div></div>
      <div className="data-table-wrap"><table className="stock-opname-table"><thead><tr><th>Kode</th><th>Barang</th><th>Kategori</th><th>Stok Sistem</th><th>Stok Fisik</th><th>Satuan</th><th>Selisih</th><th>Keterangan</th></tr></thead><tbody>{filtered.map(item=>{const row=counts[item.item_id]||{itemId:item.item_id,unitId:item.base_unit_id,physical:'',description:''};const physical=physicalBase(item,row);const difference=physical===null?null:physical-num(item.quantity_on_hand);const hasDifference=difference!==null&&Math.abs(difference)>0.000001;return <tr key={item.item_id} className={hasDifference?'stock-opname-difference':''}><td><code>{item.code}</code></td><td><strong>{item.name}</strong>{!item.setup_ready&&<small className="setup-warning">Mapping Stock Opname belum lengkap</small>}</td><td>{item.category_name}</td><td><strong>{qty(num(item.quantity_on_hand))}</strong> {item.base_unit_code}</td><td><input className="number-input" type="number" min="0" step="0.001" value={row.physical} onChange={e=>update(item.item_id,{physical:e.target.value})} placeholder="Belum dihitung"/></td><td><select value={row.unitId} onChange={e=>update(item.item_id,{unitId:e.target.value})}>{allowedUnits(item).map(u=><option key={u.id} value={u.id}>{u.code}</option>)}</select></td><td className={hasDifference?'stock-opname-diff-value':''}>{difference===null?'—':<><strong>{difference>0?'+':''}{qty(difference)}</strong> {item.base_unit_code}</>}</td><td><input value={row.description} onChange={e=>update(item.item_id,{description:e.target.value})} placeholder="Opsional"/></td></tr>;})}</tbody></table>{filtered.length===0&&<div className="empty-state"><ClipboardCheck size={34}/><strong>Barang tidak ditemukan</strong><span>Ubah kata pencarian atau pilih lokasi lain.</span></div>}</div>
      {differences.length>0&&<div className="stock-opname-warning"><AlertTriangle size={18}/><div><strong>Ada {differences.length} barang dengan selisih fisik.</strong><span>Saat Finance Verified, saldo persediaan disesuaikan ke jumlah fisik dan jurnal selisih dibentuk otomatis dari mapping kategori barang.</span></div></div>}
    </section>

    <section className="section-card"><div className="section-title master-heading"><div><span className="eyebrow">KONTROL</span><h3>Stock Opname Terbaru</h3><p>Nilai penyesuaian dihitung menggunakan moving average masing-masing barang.</p></div></div><div className="data-table-wrap"><table><thead><tr><th>No Dokumen</th><th>Tanggal</th><th>Lokasi</th><th>Barang Dihitung</th><th>Selisih</th><th>Status</th><th>Nilai Penyesuaian</th><th></th></tr></thead><tbody>{recent.map(x=><tr key={x.id}><td><strong>{x.transaction_number}</strong></td><td>{x.transaction_date?.slice(0,10)}</td><td>{x.location_name}</td><td>{x.line_count}</td><td>{x.workflow_status==='FINANCE_VERIFIED'?x.adjusted_line_count:'Setelah verifikasi'}</td><td><span className={x.workflow_status==='FINANCE_VERIFIED'?'status-ok':'status-draft'}>{x.workflow_status==='FINANCE_VERIFIED'?'Finance Verified':'Draft'}</span></td><td>{x.workflow_status==='FINANCE_VERIFIED'?`Rp${money(x.grand_total)}`:'HPP otomatis'}</td><td>{canVerify&&x.workflow_status==='DRAFT'&&<button className="secondary-button compact" disabled={verifying===x.id} onClick={()=>verify(x)}><ShieldCheck size={15}/>{verifying===x.id?'Memeriksa...':'Finance Verified'}</button>}</td></tr>)}</tbody></table>{recent.length===0&&<div className="empty-state"><ClipboardCheck size={34}/><strong>Belum ada Stock Opname</strong><span>Isi stok fisik pada tabel di atas untuk membuat opname pertama.</span></div>}</div></section>
  </div>;
}
