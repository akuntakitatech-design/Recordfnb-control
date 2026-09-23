import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Boxes, FileClock, RefreshCw, Search } from 'lucide-react';
import { api } from './api';
import './bomProduction.css';

type Company={id:string;name:string};
type Location={id:string;company_id:string;name:string};
type ControlRow={item_id:string;code:string;name:string;category_name:string;unit_code:string;quantity_on_hand:string;average_cost:string;stock_value:string;last_movement_type:string|null;last_movement_at:string|null;status:string};
type CardRow={id:string;movement_type:string;quantity:string;unit_cost:string;movement_value:string;quantity_after:string;average_cost_after:string;created_at:string;transaction_number:string;transaction_date:string;transaction_type:string;reference_number:string|null;direction:'IN'|'OUT';signed_quantity:string};
type CardResponse={openingQuantity:string;rows:CardRow[]};

const today=()=>new Date().toISOString().slice(0,10);
const monthStart=()=>`${today().slice(0,7)}-01`;
const qty=(value:string|number)=>Number(value||0).toLocaleString('id-ID',{maximumFractionDigits:4});
const money=(value:string|number)=>Number(value||0).toLocaleString('id-ID',{maximumFractionDigits:0});
const movementLabels:Record<string,string>={
  PURCHASE_IN:'Pembelian',USAGE_OUT:'Pemakaian',TRANSFER_IN:'Transfer Masuk',TRANSFER_OUT:'Transfer Keluar',
  ADJUSTMENT_IN:'Penyesuaian +',ADJUSTMENT_OUT:'Penyesuaian -',SALE_OUT:'Penjualan',
  PRODUCTION_IN:'Hasil Produksi',PRODUCTION_OUT:'Bahan Produksi',
};
const movementLabel=(type:string)=>movementLabels[type]||type;

export function ClientInventoryControl(){
  const [companies,setCompanies]=useState<Company[]>([]);const [locations,setLocations]=useState<Location[]>([]);const [companyId,setCompanyId]=useState('');const [locationId,setLocationId]=useState('');const [rows,setRows]=useState<ControlRow[]>([]);const [search,setSearch]=useState('');const [status,setStatus]=useState('SEMUA');const [selected,setSelected]=useState<ControlRow|null>(null);const [from,setFrom]=useState(monthStart());const [to,setTo]=useState(today());const [card,setCard]=useState<CardResponse|null>(null);const [loading,setLoading]=useState(false);const [error,setError]=useState('');
  const companyLocations=locations.filter(x=>x.company_id===companyId);

  async function loadBase(){try{const [c,l]=await Promise.all([api<Company[]>('/api/master/companies'),api<Location[]>('/api/master/locations')]);setCompanies(c);setLocations(l);const cid=companyId||c[0]?.id||'';if(!companyId)setCompanyId(cid);const loc=l.find(x=>x.company_id===cid);if(!locationId&&loc)setLocationId(loc.id);}catch(e){setError(e instanceof Error?e.message:'Gagal memuat master');}}
  async function loadControl(cid=companyId,lid=locationId){if(!cid||!lid)return;setLoading(true);setError('');try{setRows(await api<ControlRow[]>(`/api/client-transactions/inventory-control?companyId=${cid}&locationId=${lid}`));}catch(e){setError(e instanceof Error?e.message:'Gagal memuat kontrol stok');}finally{setLoading(false);}}
  async function loadCard(item=selected){if(!item||!companyId||!locationId)return;setError('');try{setCard(await api<CardResponse>(`/api/client-transactions/stock-card?companyId=${companyId}&locationId=${locationId}&itemId=${item.item_id}&from=${from}&to=${to}`));}catch(e){setError(e instanceof Error?e.message:'Gagal memuat kartu stok');}}
  useEffect(()=>{void loadBase();},[]);useEffect(()=>{const valid=locations.filter(x=>x.company_id===companyId);if(valid.length&&!valid.some(x=>x.id===locationId)){setLocationId(valid[0].id);setSelected(null);setCard(null);}},[companyId,locations]);useEffect(()=>{void loadControl();},[companyId,locationId]);useEffect(()=>{if(selected)void loadCard(selected);},[from,to]);

  const filtered=useMemo(()=>{const term=search.trim().toLowerCase();return rows.filter(row=>(status==='SEMUA'||row.status===status)&&(!term||`${row.code} ${row.name} ${row.category_name}`.toLowerCase().includes(term)));},[rows,search,status]);
  const totalValue=rows.reduce((a,r)=>a+Number(r.stock_value||0),0);const minus=rows.filter(x=>x.status==='STOK MINUS').length;const empty=rows.filter(x=>x.status==='HABIS').length;

  function selectItem(row:ControlRow){setSelected(row);setCard(null);window.setTimeout(()=>void loadCard(row),0);}

  return <div className="page-content inventory-control-page">
    <section className="section-card">
      <div className="section-title master-heading"><div><span className="eyebrow">PERSEDIAAN</span><h3>Kontrol Stok</h3><p>Saldo sistem berasal langsung dari inventory ledger. Kartu stok memakai sumber transaksi yang sama sehingga tidak ada saldo ganda.</p></div><button className="secondary-button compact" onClick={()=>void loadControl()}><RefreshCw size={15}/> Refresh</button></div>
      {error&&<div className="form-error">{error}</div>}
      <div className="inventory-head-grid"><label>Company<select value={companyId} onChange={e=>setCompanyId(e.target.value)}>{companies.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>Lokasi<select value={locationId} onChange={e=>setLocationId(e.target.value)}>{companyLocations.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><div className="inventory-metric"><span>Nilai Stok</span><strong>Rp{money(totalValue)}</strong></div><div className="inventory-metric warning"><span>Stok Minus</span><strong>{minus}</strong></div><div className="inventory-metric"><span>Stok Habis</span><strong>{empty}</strong></div></div>
      <div className="table-toolbar"><div className="search-box"><Search size={16}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Cari kode, barang atau kategori..."/></div><div className="inventory-filter"><select value={status} onChange={e=>setStatus(e.target.value)}><option value="SEMUA">Semua Status</option><option value="OK">OK</option><option value="HABIS">Habis</option><option value="STOK MINUS">Stok Minus</option></select><span>{filtered.length} barang</span></div></div>
      <div className="data-table-wrap"><table><thead><tr><th>Kode</th><th>Barang</th><th>Kategori</th><th className="numeric">Qty Sistem</th><th>Satuan</th><th className="numeric">HPP Average</th><th className="numeric">Nilai Stok</th><th>Mutasi Terakhir</th><th>Status</th><th></th></tr></thead><tbody>{filtered.map(row=><tr key={row.item_id} className={row.status==='STOK MINUS'?'inventory-negative':''}><td><code>{row.code}</code></td><td><strong>{row.name}</strong></td><td>{row.category_name}</td><td className="numeric"><strong>{qty(row.quantity_on_hand)}</strong></td><td>{row.unit_code}</td><td className="numeric">Rp{money(row.average_cost)}</td><td className="numeric">Rp{money(row.stock_value)}</td><td>{row.last_movement_type?movementLabel(row.last_movement_type):'—'}{row.last_movement_at&&<small className="journal-meta">{new Date(row.last_movement_at).toLocaleString('id-ID')}</small>}</td><td><span className={row.status==='OK'?'status-ok':row.status==='STOK MINUS'?'status-error':'status-warn'}>{row.status}</span></td><td><button className="secondary-button compact" onClick={()=>selectItem(row)}><FileClock size={15}/> Kartu Stok</button></td></tr>)}</tbody></table>{!filtered.length&&!loading&&<div className="empty-state"><Boxes size={34}/><strong>Belum ada data stok</strong><span>Pilih lokasi lain atau mulai dari pembelian / saldo persediaan.</span></div>}</div>
    </section>

    {selected&&<section className="section-card stock-card-section">
      <div className="section-title master-heading"><div><span className="eyebrow">KARTU STOK</span><h3>{selected.code} — {selected.name}</h3><p>Mutasi masuk/keluar lengkap dengan nomor dokumen, biaya dan saldo setelah transaksi.</p></div><button className="secondary-button compact" onClick={()=>{setSelected(null);setCard(null);}}>Tutup</button></div>
      <div className="stock-card-filter"><label>Dari<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>Sampai<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label><div><span>Saldo sebelum periode</span><strong>{qty(card?.openingQuantity||0)} {selected.unit_code}</strong></div></div>
      <div className="data-table-wrap"><table><thead><tr><th>Tanggal</th><th>Dokumen</th><th>Sumber</th><th className="numeric">Masuk</th><th className="numeric">Keluar</th><th className="numeric">Saldo</th><th className="numeric">Biaya/@</th><th className="numeric">Nilai Mutasi</th><th className="numeric">HPP Setelah</th></tr></thead><tbody>{(card?.rows||[]).map(row=><tr key={row.id}><td>{row.transaction_date?.slice(0,10)}</td><td><strong>{row.transaction_number}</strong>{row.reference_number&&<small className="journal-meta">{row.reference_number}</small>}</td><td>{movementLabel(row.movement_type)}</td><td className="numeric">{row.direction==='IN'?qty(row.quantity):'—'}</td><td className="numeric">{row.direction==='OUT'?qty(row.quantity):'—'}</td><td className="numeric"><strong>{qty(row.quantity_after)}</strong></td><td className="numeric">Rp{money(row.unit_cost)}</td><td className="numeric">Rp{money(row.movement_value)}</td><td className="numeric">Rp{money(row.average_cost_after)}</td></tr>)}</tbody></table>{card&&card.rows.length===0&&<div className="empty-state"><FileClock size={34}/><strong>Tidak ada mutasi pada periode ini</strong><span>Ubah rentang tanggal untuk melihat histori lain.</span></div>}</div>
      {Number(selected.quantity_on_hand)<0&&<div className="stock-opname-warning"><AlertTriangle size={18}/><div><strong>Saldo item ini minus.</strong><span>Telusuri kartu stok untuk menemukan transaksi yang menyebabkan kekurangan.</span></div></div>}
    </section>}
  </div>;
}
