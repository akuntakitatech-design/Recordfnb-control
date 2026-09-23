import { useEffect, useMemo, useState } from 'react';
import { Boxes, Ruler, Search, Tags, Workflow } from 'lucide-react';
import { api } from './api';

type Workspace = { id: string; code: string; name: string };
type Unit = { id: string; workspace_id: string; code: string; name: string; decimal_precision: number; workspace_name?: string };
type Category = { id: string; workspace_id: string; parent_id: string | null; code: string; name: string; category_type: string; parent_name?: string; workspace_name?: string };
type Item = { id: string; workspace_id: string; code: string; name: string; category_id: string; base_unit_id: string; category_name: string; category_type: string; unit_code: string; unit_name: string; track_stock: boolean; can_purchase: boolean; can_sell: boolean; can_produce: boolean; can_use_in_recipe: boolean; valuation_method: string; workspace_name?: string };
type Conversion = { id: string; workspace_id: string; item_id: string | null; from_unit_id: string; to_unit_id: string; multiplier: string; item_name?: string; from_unit_code: string; to_unit_code: string; workspace_name?: string };
type Tab = 'category' | 'unit' | 'conversion' | 'item';

const categoryTypes: Record<string, string> = {
  RAW_MATERIAL: 'Bahan Baku', SEMI_FINISHED: 'Semi Finished', FINISHED_GOOD: 'Barang Jadi',
  PACKAGING: 'Packaging', SUPPLIES: 'Supplies', NON_INVENTORY: 'Non Inventory', SERVICE: 'Jasa',
  ASSET_CANDIDATE: 'Kandidat Aset', OTHER: 'Lainnya',
};

export function MasterItemCenter() {
  const [tab, setTab] = useState<Tab>('item');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [units, setUnits] = useState<Unit[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [conversions, setConversions] = useState<Conversion[]>([]);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);

  async function loadWorkspaces() {
    const rows = await api<Workspace[]>('/api/master/workspaces');
    setWorkspaces(rows);
    if (!workspaceId && rows[0]) setWorkspaceId(rows[0].id);
  }

  async function loadMasters(ws = workspaceId) {
    if (!ws) return;
    const q = `?workspaceId=${encodeURIComponent(ws)}`;
    const [u, c, i, cv] = await Promise.all([
      api<Unit[]>(`/api/master/units${q}`), api<Category[]>(`/api/master/item-categories${q}`),
      api<Item[]>(`/api/master/items${q}`), api<Conversion[]>(`/api/master/unit-conversions${q}`),
    ]);
    setUnits(u); setCategories(c); setItems(i); setConversions(cv);
  }

  useEffect(() => { void loadWorkspaces(); }, []);
  useEffect(() => { void loadMasters(); }, [workspaceId]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows = tab === 'item' ? items : tab === 'category' ? categories : tab === 'unit' ? units : conversions;
    if (!term) return rows;
    return rows.filter(row => JSON.stringify(row).toLowerCase().includes(term));
  }, [tab, search, items, categories, units, conversions]);

  return <div className="page-content">
    <section className="section-card">
      <div className="section-title master-heading">
        <div><span className="eyebrow">MASTER DATA CENTER</span><h3>Barang & Inventory</h3><p>Kategori → satuan → konversi → item. Semua tersusun per client/workspace.</p></div>
        <div className="heading-actions">
          <select value={workspaceId} onChange={e => setWorkspaceId(e.target.value)}>{workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          <button className="primary-button compact" onClick={() => setShowForm(true)}>+ Tambah</button>
        </div>
      </div>
      <div className="tabs master-tabs">
        <button className={tab === 'item' ? 'active' : ''} onClick={() => setTab('item')}><Boxes size={15}/> Item</button>
        <button className={tab === 'category' ? 'active' : ''} onClick={() => setTab('category')}><Tags size={15}/> Kategori</button>
        <button className={tab === 'unit' ? 'active' : ''} onClick={() => setTab('unit')}><Ruler size={15}/> Satuan</button>
        <button className={tab === 'conversion' ? 'active' : ''} onClick={() => setTab('conversion')}><Workflow size={15}/> Konversi</button>
      </div>
      <div className="table-toolbar"><div className="search-box"><Search size={16}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cari kode, nama, kategori..." /></div><span>{filtered.length} data</span></div>
      <div className="data-table-wrap">
        {tab === 'item' && <table><thead><tr><th>Kode</th><th>Nama Item</th><th>Kategori</th><th>Satuan Dasar</th><th>Fungsi</th><th>Valuasi</th></tr></thead><tbody>{(filtered as Item[]).map(x => <tr key={x.id}><td><code>{x.code}</code></td><td><strong>{x.name}</strong></td><td><span className="subtle-label">{categoryTypes[x.category_type] || x.category_type}</span><br/>{x.category_name}</td><td>{x.unit_code}</td><td><div className="flag-row">{x.track_stock && <span>Stok</span>}{x.can_purchase && <span>Beli</span>}{x.can_sell && <span>Jual</span>}{x.can_produce && <span>Produksi</span>}{x.can_use_in_recipe && <span>Recipe</span>}</div></td><td>{x.valuation_method === 'MOVING_AVERAGE' ? 'Average' : x.valuation_method}</td></tr>)}</tbody></table>}
        {tab === 'category' && <table><thead><tr><th>Kode</th><th>Kategori</th><th>Kelompok</th><th>Parent</th></tr></thead><tbody>{(filtered as Category[]).map(x => <tr key={x.id}><td><code>{x.code}</code></td><td><strong>{x.name}</strong></td><td>{categoryTypes[x.category_type] || x.category_type}</td><td>{x.parent_name || '—'}</td></tr>)}</tbody></table>}
        {tab === 'unit' && <table><thead><tr><th>Kode</th><th>Satuan</th><th>Presisi Desimal</th></tr></thead><tbody>{(filtered as Unit[]).map(x => <tr key={x.id}><td><code>{x.code}</code></td><td><strong>{x.name}</strong></td><td>{x.decimal_precision}</td></tr>)}</tbody></table>}
        {tab === 'conversion' && <table><thead><tr><th>Item</th><th>Dari</th><th>Ke</th><th>Pengali</th></tr></thead><tbody>{(filtered as Conversion[]).map(x => <tr key={x.id}><td>{x.item_name || <span className="subtle-label">Umum</span>}</td><td><code>{x.from_unit_code}</code></td><td><code>{x.to_unit_code}</code></td><td>{Number(x.multiplier).toLocaleString('id-ID', { maximumFractionDigits: 8 })}</td></tr>)}</tbody></table>}
        {filtered.length === 0 && <div className="empty-state"><Boxes size={34}/><strong>Belum ada data</strong><span>Tambahkan master pertama untuk workspace ini.</span></div>}
      </div>
    </section>
    {showForm && <MasterItemForm tab={tab} workspaceId={workspaceId} units={units} categories={categories} items={items} onClose={() => setShowForm(false)} onSaved={async () => { setShowForm(false); await loadMasters(); }} />}
  </div>;
}

function MasterItemForm({ tab, workspaceId, units, categories, items, onClose, onSaved }: { tab: Tab; workspaceId: string; units: Unit[]; categories: Category[]; items: Item[]; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const [categoryType, setCategoryType] = useState('RAW_MATERIAL'); const [parentId, setParentId] = useState('');
  const [precision, setPrecision] = useState(3);
  const [categoryId, setCategoryId] = useState(categories[0]?.id || ''); const [baseUnitId, setBaseUnitId] = useState(units[0]?.id || '');
  const [trackStock, setTrackStock] = useState(true); const [canPurchase, setCanPurchase] = useState(true); const [canSell, setCanSell] = useState(false); const [canProduce, setCanProduce] = useState(false); const [canRecipe, setCanRecipe] = useState(true); const [valuation, setValuation] = useState('MOVING_AVERAGE');
  const [itemId, setItemId] = useState(''); const [fromUnitId, setFromUnitId] = useState(units[0]?.id || ''); const [toUnitId, setToUnitId] = useState(units[1]?.id || ''); const [multiplier, setMultiplier] = useState('1');

  async function save(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setError('');
    try {
      if (tab === 'unit') await api('/api/master/units', { method: 'POST', body: JSON.stringify({ workspaceId, code, name, decimalPrecision: precision }) });
      if (tab === 'category') await api('/api/master/item-categories', { method: 'POST', body: JSON.stringify({ workspaceId, code, name, categoryType, parentId: parentId || null }) });
      if (tab === 'item') await api('/api/master/items', { method: 'POST', body: JSON.stringify({ workspaceId, code, name, categoryId, baseUnitId, trackStock, canPurchase, canSell, canProduce, canUseInRecipe: canRecipe, valuationMethod: valuation }) });
      if (tab === 'conversion') await api('/api/master/unit-conversions', { method: 'POST', body: JSON.stringify({ workspaceId, itemId: itemId || null, fromUnitId, toUnitId, multiplier: Number(multiplier) }) });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Gagal menyimpan'); }
    finally { setSaving(false); }
  }

  const title = tab === 'item' ? 'Item' : tab === 'category' ? 'Kategori Item' : tab === 'unit' ? 'Satuan' : 'Konversi Satuan';
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal-card modal-wide" onSubmit={save} onMouseDown={e => e.stopPropagation()}>
    <div><span className="eyebrow">TAMBAH MASTER</span><h3>{title}</h3></div>
    {tab !== 'conversion' && <div className="form-grid two"><label>Kode<input value={code} onChange={e => setCode(e.target.value)} placeholder="Kode singkat" /></label><label>Nama<input value={name} onChange={e => setName(e.target.value)} placeholder={`Nama ${title.toLowerCase()}`} /></label></div>}
    {tab === 'unit' && <label>Presisi Desimal<select value={precision} onChange={e => setPrecision(Number(e.target.value))}>{[0,1,2,3,4,5,6].map(x => <option key={x} value={x}>{x}</option>)}</select></label>}
    {tab === 'category' && <div className="form-grid two"><label>Kelompok<select value={categoryType} onChange={e => setCategoryType(e.target.value)}>{Object.entries(categoryTypes).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label><label>Parent (opsional)<select value={parentId} onChange={e => setParentId(e.target.value)}><option value="">— Tanpa Parent —</option>{categories.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label></div>}
    {tab === 'item' && <><div className="form-grid two"><label>Kategori<select value={categoryId} onChange={e => setCategoryId(e.target.value)}><option value="">Pilih kategori</option>{categories.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>Satuan Dasar<select value={baseUnitId} onChange={e => setBaseUnitId(e.target.value)}><option value="">Pilih satuan</option>{units.map(x => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></label></div><label>Metode Valuasi<select value={valuation} onChange={e => setValuation(e.target.value)}><option value="MOVING_AVERAGE">Moving Average</option><option value="STANDARD">Standard Cost</option><option value="NONE">Tidak Dinilai</option></select></label><div className="check-grid"><label><input type="checkbox" checked={trackStock} onChange={e => setTrackStock(e.target.checked)}/> Tracking Stok</label><label><input type="checkbox" checked={canPurchase} onChange={e => setCanPurchase(e.target.checked)}/> Bisa Dibeli</label><label><input type="checkbox" checked={canSell} onChange={e => setCanSell(e.target.checked)}/> Bisa Dijual</label><label><input type="checkbox" checked={canProduce} onChange={e => setCanProduce(e.target.checked)}/> Bisa Diproduksi</label><label><input type="checkbox" checked={canRecipe} onChange={e => setCanRecipe(e.target.checked)}/> Bisa Dipakai Recipe</label></div></>}
    {tab === 'conversion' && <><label>Item (opsional — kosong berarti konversi umum)<select value={itemId} onChange={e => setItemId(e.target.value)}><option value="">Umum</option>{items.map(x => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></label><div className="form-grid three"><label>Dari<select value={fromUnitId} onChange={e => setFromUnitId(e.target.value)}>{units.map(x => <option key={x.id} value={x.id}>{x.code}</option>)}</select></label><label>Ke<select value={toUnitId} onChange={e => setToUnitId(e.target.value)}>{units.map(x => <option key={x.id} value={x.id}>{x.code}</option>)}</select></label><label>Pengali<input type="number" step="0.00000001" value={multiplier} onChange={e => setMultiplier(e.target.value)} /></label></div><div className="helper-box">Contoh: 1 KG = 1.000 GR → Dari KG, Ke GR, Pengali 1000.</div></>}
    {error && <div className="form-error">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Batal</button><button className="primary-button" disabled={saving}>{saving ? 'Menyimpan...' : 'Simpan'}</button></div>
  </form></div>;
}
