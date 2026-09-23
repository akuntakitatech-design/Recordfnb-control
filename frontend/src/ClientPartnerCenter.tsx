import { useEffect, useMemo, useState } from 'react';
import { Plus, Search, UsersRound } from 'lucide-react';
import { api } from './api';

type Company = { id:string; workspace_id:string; code:string; name:string };
type Partner = { id:string; workspace_id:string; code:string; name:string; partner_type:string; payment_term_days:number; status:string };
const partnerTypes: Record<string,string> = { SUPPLIER:'Supplier', CUSTOMER:'Customer', BOTH:'Supplier & Customer', MERCHANT:'Merchant / OJOL', OTHER:'Lainnya' };

export function ClientPartnerCenter() {
  const [companies,setCompanies] = useState<Company[]>([]);
  const [companyId,setCompanyId] = useState('');
  const [partners,setPartners] = useState<Partner[]>([]);
  const [search,setSearch] = useState('');
  const [showForm,setShowForm] = useState(false);
  const company = companies.find(x => x.id === companyId);

  async function loadCompanies() {
    const rows = await api<Company[]>('/api/master/companies');
    setCompanies(rows);
    if (!companyId && rows[0]) setCompanyId(rows[0].id);
  }
  async function loadPartners() {
    if (!company) return;
    setPartners(await api<Partner[]>(`/api/master/partners?workspaceId=${encodeURIComponent(company.workspace_id)}`));
  }
  useEffect(() => { void loadCompanies(); }, []);
  useEffect(() => { void loadPartners(); }, [companyId, company?.workspace_id]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? partners.filter(x => JSON.stringify(x).toLowerCase().includes(term)) : partners;
  }, [partners, search]);

  return <div className="page-content"><section className="section-card">
    <div className="section-title master-heading"><div><span className="eyebrow">MASTER OPERASIONAL</span><h3>Supplier & Relasi</h3><p>Relasi bisnis dapat ditambah client tanpa perlu menentukan akun accounting.</p></div><div className="heading-actions"><select value={companyId} onChange={e => setCompanyId(e.target.value)}>{companies.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select><button className="primary-button compact" onClick={() => setShowForm(true)} disabled={!company}><Plus size={16}/> Tambah Relasi</button></div></div>
    <div className="table-toolbar"><div className="search-box"><Search size={16}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cari supplier / customer..."/></div><span>{filtered.length} data</span></div>
    <div className="data-table-wrap"><table><thead><tr><th>Kode</th><th>Nama</th><th>Tipe</th><th>Termin</th><th>Status</th></tr></thead><tbody>{filtered.map(x => <tr key={x.id}><td><code>{x.code}</code></td><td><strong>{x.name}</strong></td><td>{partnerTypes[x.partner_type] || x.partner_type}</td><td>{x.payment_term_days} hari</td><td><span className="status-ok">Aktif</span></td></tr>)}</tbody></table>{filtered.length === 0 && <div className="empty-state"><UsersRound size={34}/><strong>Belum ada relasi</strong><span>Tambahkan supplier atau customer pertama.</span></div>}</div>
  </section>{showForm && company && <PartnerForm company={company} onClose={() => setShowForm(false)} onSaved={async () => { setShowForm(false); await loadPartners(); }}/>}</div>;
}

function PartnerForm({ company, onClose, onSaved }: { company:Company; onClose:()=>void; onSaved:()=>void }) {
  const [code,setCode] = useState(''); const [name,setName] = useState(''); const [partnerType,setPartnerType] = useState('SUPPLIER');
  const [term,setTerm] = useState(0); const [taxNumber,setTaxNumber] = useState(''); const [phone,setPhone] = useState('');
  const [email,setEmail] = useState(''); const [address,setAddress] = useState(''); const [saving,setSaving] = useState(false); const [error,setError] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setError('');
    try {
      await api('/api/client-master/partners', { method:'POST', body:JSON.stringify({ workspaceId:company.workspace_id, code, name, partnerType, paymentTermDays:term, taxNumber, phone, email, address }) });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Gagal menyimpan relasi'); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal-card modal-wide" onSubmit={save} onMouseDown={e => e.stopPropagation()}>
    <div><span className="eyebrow">TAMBAH RELASI</span><h3>Supplier / Customer</h3><p className="modal-caption">{company.name}</p></div>
    <div className="form-grid two"><label>Kode<input value={code} onChange={e => setCode(e.target.value)} placeholder="Kode relasi"/></label><label>Nama<input value={name} onChange={e => setName(e.target.value)} placeholder="Nama supplier / customer"/></label></div>
    <div className="form-grid two"><label>Tipe<select value={partnerType} onChange={e => setPartnerType(e.target.value)}>{Object.entries(partnerTypes).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label><label>Termin Pembayaran<input type="number" min="0" value={term} onChange={e => setTerm(Number(e.target.value))}/></label></div>
    <div className="form-grid two"><label>NPWP / Tax ID<input value={taxNumber} onChange={e => setTaxNumber(e.target.value)}/></label><label>No. Telepon<input value={phone} onChange={e => setPhone(e.target.value)}/></label></div>
    <div className="form-grid two"><label>Email<input value={email} onChange={e => setEmail(e.target.value)}/></label><label>Alamat<input value={address} onChange={e => setAddress(e.target.value)}/></label></div>
    {error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Batal</button><button className="primary-button" disabled={saving}>{saving ? 'Menyimpan...' : 'Simpan Relasi'}</button></div>
  </form></div>;
}
