import { useEffect, useMemo, useState } from 'react';
import { Boxes, Plus, Search } from 'lucide-react';
import { api } from './api';

type Workspace = { id: string; code: string; name: string };
type Category = { id: string; workspace_id: string; code: string; name: string; category_type: string };
type Unit = { id: string; workspace_id: string; code: string; name: string };
type Item = { id: string; workspace_id: string; code: string; name: string; category_id: string; category_name: string; category_type: string; unit_code: string; track_stock: boolean; can_purchase: boolean; can_sell: boolean };

const categoryTypes: Record<string,string> = {
  RAW_MATERIAL:'Bahan Baku', SEMI_FINISHED:'Semi Finished', FINISHED_GOOD:'Barang Jadi',
  PACKAGING:'Packaging', SUPPLIES:'Supplies', NON_INVENTORY:'Non Inventory', SERVICE:'Jasa',
  ASSET_CANDIDATE:'Kandidat Aset', OTHER:'Lainnya',
};

export function ClientItemCenter() {
  const [workspaces,setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId,setWorkspaceId] = useState('');
  const [categories,setCategories] = useState<Category[]>([]);
  const [units,setUnits] = useState<Unit[]>([]);
  const [items,setItems] = useState<Item[]>([]);
  const [search,setSearch] = useState('');
  const [showForm,setShowForm] = useState(false);

  async function loadWorkspaces() {
    const rows = await api<Workspace[]>('/api/master/workspaces');
    setWorkspaces(rows);
    if (!workspaceId && rows[0]) setWorkspaceId(rows[0].id);
  }

  async function loadData(ws = workspaceId) {
    if (!ws) return;
    const q = `?workspaceId=${encodeURIComponent(ws)}`;
    const [c,u,i] = await Promise.all([
      api<Category[]>(`/api/master/item-categories${q}`),
      api<Unit[]>(`/api/master/units${q}`),
      api<Item[]>(`/api/master/items${q}`),
    ]);
    setCategories(c); setUnits(u); setItems(i);
  }

  useEffect(() => { void loadWorkspaces(); }, []);
  useEffect(() => { void loadData(); }, [workspaceId]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? items.filter(x => JSON.stringify(x).toLowerCase().includes(term)) : items;
  }, [items, search]);

  return <div className="page-content"><section className="section-card">
    <div className="section-title master-heading">
      <div><span className="eyebrow">MASTER OPERASIONAL</span><h3>Barang / Item</h3><p>Client dapat menambah item, tetapi kategori dan aturan accounting disiapkan oleh Akuntakita.</p></div>
      <div className="heading-actions"><select value={workspaceId} onChange={e => setWorkspaceId(e.target.value)}>{workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select><button className="primary-button compact" onClick={() => setShowForm(true)}><Plus size={16}/> Tambah Item</button></div>
    </div>
    <div className="helper-box">Kategori barang tidak dapat ditambah dari portal client. Jika kategori yang dibutuhkan belum tersedia, hubungi tim Akuntakita.</div>
    <div className="table-toolbar"><div className="search-box"><Search size={16}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cari item..."/></div><span>{filtered.length} item</span></div>
    <div className="data-table-wrap"><table><thead><tr><th>Kode</th><th>Nama Item</th><th>Kategori</th><th>Satuan</th><th>Fungsi</th></tr></thead><tbody>{filtered.map(x => <tr key={x.id}><td><code>{x.code}</code></td><td><strong>{x.name}</strong></td><td><span className="subtle-label">{categoryTypes[x.category_type] || x.category_type}</span><br/>{x.category_name}</td><td>{x.unit_code}</td><td><div className="flag-row">{x.track_stock && <span>Stok</span>}{x.can_purchase && <span>Beli</span>}{x.can_sell && <span>Jual</span>}</div></td></tr>)}</tbody></table>{filtered.length === 0 && <div className="empty-state"><Boxes size={34}/><strong>Belum ada item</strong><span>Tambahkan item menggunakan kategori yang sudah disiapkan Akuntakita.</span></div>}</div>
  </section>{showForm && <ClientItemForm workspaceId={workspaceId} categories={categories} units={units} onClose={() => setShowForm(false)} onSaved={async () => { setShowForm(false); await loadData(); }}/>}</div>;
}

function ClientItemForm({ workspaceId, categories, units, onClose, onSaved }: { workspaceId:string; categories:Category[]; units:Unit[]; onClose:()=>void; onSaved:()=>void }) {
  const [code,setCode] = useState(''); const [name,setName] = useState('');
  const [categoryId,setCategoryId] = useState(categories[0]?.id || ''); const [baseUnitId,setBaseUnitId] = useState(units[0]?.id || '');
  const [trackStock,setTrackStock] = useState(true); const [canPurchase,setCanPurchase] = useState(true); const [canSell,setCanSell] = useState(false);
  const [saving,setSaving] = useState(false); const [error,setError] = useState('');

  async function save(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setError('');
    try {
      await api('/api/client-master/items', { method:'POST', body:JSON.stringify({ workspaceId, code, name, categoryId, baseUnitId, trackStock, canPurchase, canSell }) });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Gagal menyimpan item'); }
    finally { setSaving(false); }
  }

  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal-card modal-wide" onSubmit={save} onMouseDown={e => e.stopPropagation()}>
    <div><span className="eyebrow">TAMBAH ITEM</span><h3>Barang / Item Baru</h3><p className="modal-caption">Kategori dan mapping akun sudah ditentukan Akuntakita.</p></div>
    <div className="form-grid two"><label>Kode<input value={code} onChange={e => setCode(e.target.value)} placeholder="Contoh: BB-DAGING"/></label><label>Nama Item<input value={name} onChange={e => setName(e.target.value)} placeholder="Nama barang"/></label></div>
    <div className="form-grid two"><label>Kategori<select value={categoryId} onChange={e => setCategoryId(e.target.value)}><option value="">Pilih kategori</option>{categories.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>Satuan Dasar<select value={baseUnitId} onChange={e => setBaseUnitId(e.target.value)}><option value="">Pilih satuan</option>{units.map(x => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></label></div>
    <div className="check-grid"><label><input type="checkbox" checked={trackStock} onChange={e => setTrackStock(e.target.checked)}/> Tracking Stok</label><label><input type="checkbox" checked={canPurchase} onChange={e => setCanPurchase(e.target.checked)}/> Bisa Dibeli</label><label><input type="checkbox" checked={canSell} onChange={e => setCanSell(e.target.checked)}/> Bisa Dijual</label></div>
    {error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Batal</button><button className="primary-button" disabled={saving}>{saving ? 'Menyimpan...' : 'Simpan Item'}</button></div>
  </form></div>;
}
