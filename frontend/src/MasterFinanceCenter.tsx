import { useEffect, useMemo, useState } from 'react';
import { Landmark, Network, ReceiptText, Search, Tags, UsersRound } from 'lucide-react';
import { api } from './api';

type Company = { id: string; workspace_id: string; code: string; name: string };
type Location = { id: string; company_id: string; code: string; name: string };
type Partner = { id: string; workspace_id: string; code: string; name: string; partner_type: string; payment_term_days: number; status: string };
type Account = { id: string; company_id: string; code: string; name: string; account_type: string; normal_balance: string; status: string };
type FinancialAccount = { id: string; company_id: string; location_id: string | null; code: string; name: string; account_kind: string; coa_account_id: string; coa_code: string; coa_name: string; location_name?: string; status: string };
type CostCenter = { id: string; company_id: string; code: string; name: string; status: string };
type TaxCode = { id: string; workspace_id: string; code: string; name: string; tax_type: string; rate: string; default_inclusive: boolean; status: string };
type Tab = 'partner' | 'coa' | 'financial' | 'cost-center' | 'tax';

const accountTypes = ['ASSET','LIABILITY','EQUITY','REVENUE','COGS','EXPENSE','OTHER_INCOME','OTHER_EXPENSE'];
const financialKinds: Record<string,string> = { CASH:'Kas', BANK:'Bank', SETTLEMENT:'Dana Belum Cair', EWALLET:'E-Wallet', CLEARING:'Clearing', OTHER:'Lainnya' };
const partnerTypes: Record<string,string> = { SUPPLIER:'Supplier', CUSTOMER:'Customer', BOTH:'Supplier & Customer', MERCHANT:'Merchant / OJOL', OTHER:'Lainnya' };

export function MasterFinanceCenter() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [partners, setPartners] = useState<Partner[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [financialAccounts, setFinancialAccounts] = useState<FinancialAccount[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [taxCodes, setTaxCodes] = useState<TaxCode[]>([]);
  const [tab, setTab] = useState<Tab>('partner');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);

  const selectedCompany = companies.find(x => x.id === companyId);
  const companyLocations = locations.filter(x => x.company_id === companyId);

  async function loadFoundation() {
    const [c,l] = await Promise.all([api<Company[]>('/api/master/companies'), api<Location[]>('/api/master/locations')]);
    setCompanies(c); setLocations(l);
    if (!companyId && c[0]) setCompanyId(c[0].id);
  }

  async function loadData() {
    if (!selectedCompany) return;
    const cq = `?companyId=${encodeURIComponent(selectedCompany.id)}`;
    const wq = `?workspaceId=${encodeURIComponent(selectedCompany.workspace_id)}`;
    const [p,a,f,cc,t] = await Promise.all([
      api<Partner[]>(`/api/master/partners${wq}`), api<Account[]>(`/api/master/accounts${cq}`),
      api<FinancialAccount[]>(`/api/master/financial-accounts${cq}`), api<CostCenter[]>(`/api/master/cost-centers${cq}`),
      api<TaxCode[]>(`/api/master/tax-codes${wq}`),
    ]);
    setPartners(p); setAccounts(a); setFinancialAccounts(f); setCostCenters(cc); setTaxCodes(t);
  }

  useEffect(() => { void loadFoundation(); }, []);
  useEffect(() => { void loadData(); }, [companyId, selectedCompany?.workspace_id]);

  const raw = tab === 'partner' ? partners : tab === 'coa' ? accounts : tab === 'financial' ? financialAccounts : tab === 'cost-center' ? costCenters : taxCodes;
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? raw.filter(x => JSON.stringify(x).toLowerCase().includes(term)) : raw;
  }, [raw, search]);

  return <div className="page-content">
    <section className="section-card">
      <div className="section-title master-heading">
        <div><span className="eyebrow">MASTER DATA CENTER</span><h3>Finance & Accounting</h3><p>Relasi bisnis, COA, kas/bank, cost center, dan tax code tersusun per client/company.</p></div>
        <div className="heading-actions"><select value={companyId} onChange={e => setCompanyId(e.target.value)}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><button className="primary-button compact" onClick={() => setShowForm(true)}>+ Tambah</button></div>
      </div>
      <div className="tabs master-tabs finance-tabs">
        <button className={tab === 'partner' ? 'active' : ''} onClick={() => setTab('partner')}><UsersRound size={15}/> Supplier & Relasi</button>
        <button className={tab === 'coa' ? 'active' : ''} onClick={() => setTab('coa')}><Network size={15}/> COA</button>
        <button className={tab === 'financial' ? 'active' : ''} onClick={() => setTab('financial')}><Landmark size={15}/> Kas, Bank & Settlement</button>
        <button className={tab === 'cost-center' ? 'active' : ''} onClick={() => setTab('cost-center')}><Tags size={15}/> Cost Center</button>
        <button className={tab === 'tax' ? 'active' : ''} onClick={() => setTab('tax')}><ReceiptText size={15}/> Pajak</button>
      </div>
      <div className="table-toolbar"><div className="search-box"><Search size={16}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cari kode atau nama..." /></div><span>{filtered.length} data</span></div>
      <div className="data-table-wrap">
        {tab === 'partner' && <table><thead><tr><th>Kode</th><th>Nama</th><th>Tipe</th><th>Termin</th><th>Status</th></tr></thead><tbody>{(filtered as Partner[]).map(x => <tr key={x.id}><td><code>{x.code}</code></td><td><strong>{x.name}</strong></td><td>{partnerTypes[x.partner_type] || x.partner_type}</td><td>{x.payment_term_days} hari</td><td><span className="status-ok">Aktif</span></td></tr>)}</tbody></table>}
        {tab === 'coa' && <table><thead><tr><th>Kode</th><th>Nama Akun</th><th>Kelompok</th><th>Saldo Normal</th></tr></thead><tbody>{(filtered as Account[]).map(x => <tr key={x.id}><td><code>{x.code}</code></td><td><strong>{x.name}</strong></td><td>{x.account_type}</td><td>{x.normal_balance === 'DEBIT' ? 'Debit' : 'Kredit'}</td></tr>)}</tbody></table>}
        {tab === 'financial' && <table><thead><tr><th>Kode</th><th>Nama</th><th>Jenis</th><th>Location</th><th>Terhubung COA</th></tr></thead><tbody>{(filtered as FinancialAccount[]).map(x => <tr key={x.id}><td><code>{x.code}</code></td><td><strong>{x.name}</strong></td><td>{financialKinds[x.account_kind] || x.account_kind}</td><td>{x.location_name || 'Company'}</td><td><code>{x.coa_code}</code> {x.coa_name}</td></tr>)}</tbody></table>}
        {tab === 'cost-center' && <table><thead><tr><th>Kode</th><th>Cost Center</th><th>Status</th></tr></thead><tbody>{(filtered as CostCenter[]).map(x => <tr key={x.id}><td><code>{x.code}</code></td><td><strong>{x.name}</strong></td><td><span className="status-ok">Aktif</span></td></tr>)}</tbody></table>}
        {tab === 'tax' && <table><thead><tr><th>Kode</th><th>Nama Pajak</th><th>Tipe</th><th>Tarif</th><th>Default</th></tr></thead><tbody>{(filtered as TaxCode[]).map(x => <tr key={x.id}><td><code>{x.code}</code></td><td><strong>{x.name}</strong></td><td>{x.tax_type}</td><td>{Number(x.rate).toLocaleString('id-ID')}%</td><td>{x.default_inclusive ? 'Inclusive' : 'Exclusive'}</td></tr>)}</tbody></table>}
        {filtered.length === 0 && <div className="empty-state"><Landmark size={34}/><strong>Belum ada data</strong><span>Tambahkan master pertama untuk company ini.</span></div>}
      </div>
    </section>
    {showForm && selectedCompany && <FinanceMasterForm tab={tab} company={selectedCompany} locations={companyLocations} accounts={accounts} onClose={() => setShowForm(false)} onSaved={async () => { setShowForm(false); await loadData(); }} />}
  </div>;
}

function FinanceMasterForm({ tab, company, locations, accounts, onClose, onSaved }: { tab: Tab; company: Company; locations: Location[]; accounts: Account[]; onClose: () => void; onSaved: () => void }) {
  const [code,setCode] = useState(''); const [name,setName] = useState(''); const [saving,setSaving] = useState(false); const [error,setError] = useState('');
  const [partnerType,setPartnerType] = useState('SUPPLIER'); const [term,setTerm] = useState(0); const [taxNumber,setTaxNumber] = useState(''); const [phone,setPhone] = useState('');
  const [accountType,setAccountType] = useState('EXPENSE'); const [normalBalance,setNormalBalance] = useState('DEBIT'); const [parentId,setParentId] = useState('');
  const [accountKind,setAccountKind] = useState('BANK'); const [coaAccountId,setCoaAccountId] = useState(accounts[0]?.id || ''); const [locationId,setLocationId] = useState('');
  const [taxType,setTaxType] = useState('VAT'); const [rate,setRate] = useState('0'); const [inclusive,setInclusive] = useState(false); const [effectiveFrom,setEffectiveFrom] = useState(new Date().toISOString().slice(0,10));

  useEffect(() => {
    if (['LIABILITY','EQUITY','REVENUE','OTHER_INCOME'].includes(accountType)) setNormalBalance('CREDIT'); else setNormalBalance('DEBIT');
  }, [accountType]);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setError('');
    try {
      if (tab === 'partner') await api('/api/master/partners', { method:'POST', body:JSON.stringify({ workspaceId:company.workspace_id, code, name, partnerType, paymentTermDays:term, taxNumber, phone }) });
      if (tab === 'coa') await api('/api/master/accounts', { method:'POST', body:JSON.stringify({ companyId:company.id, code, name, accountType, normalBalance, parentId:parentId || null }) });
      if (tab === 'financial') await api('/api/master/financial-accounts', { method:'POST', body:JSON.stringify({ companyId:company.id, code, name, accountKind, coaAccountId, locationId:locationId || null }) });
      if (tab === 'cost-center') await api('/api/master/cost-centers', { method:'POST', body:JSON.stringify({ companyId:company.id, code, name }) });
      if (tab === 'tax') await api('/api/master/tax-codes', { method:'POST', body:JSON.stringify({ workspaceId:company.workspace_id, code, name, taxType, rate:Number(rate), defaultInclusive:inclusive, effectiveFrom }) });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Gagal menyimpan'); }
    finally { setSaving(false); }
  }

  const title = tab === 'partner' ? 'Supplier / Relasi' : tab === 'coa' ? 'Chart of Account' : tab === 'financial' ? 'Kas / Bank / Settlement' : tab === 'cost-center' ? 'Cost Center' : 'Tax Code';
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal-card modal-wide" onSubmit={save} onMouseDown={e => e.stopPropagation()}>
    <div><span className="eyebrow">TAMBAH MASTER</span><h3>{title}</h3><p className="modal-caption">{company.name}</p></div>
    <div className="form-grid two"><label>Kode<input value={code} onChange={e => setCode(e.target.value)} placeholder="Kode" /></label><label>Nama<input value={name} onChange={e => setName(e.target.value)} placeholder="Nama" /></label></div>
    {tab === 'partner' && <><div className="form-grid two"><label>Tipe<select value={partnerType} onChange={e => setPartnerType(e.target.value)}>{Object.entries(partnerTypes).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label><label>Termin Pembayaran (hari)<input type="number" min="0" value={term} onChange={e => setTerm(Number(e.target.value))} /></label></div><div className="form-grid two"><label>NPWP / Tax ID<input value={taxNumber} onChange={e => setTaxNumber(e.target.value)} /></label><label>No. Telepon<input value={phone} onChange={e => setPhone(e.target.value)} /></label></div></>}
    {tab === 'coa' && <><div className="form-grid two"><label>Kelompok Akun<select value={accountType} onChange={e => setAccountType(e.target.value)}>{accountTypes.map(x => <option key={x} value={x}>{x}</option>)}</select></label><label>Saldo Normal<select value={normalBalance} onChange={e => setNormalBalance(e.target.value)}><option value="DEBIT">Debit</option><option value="CREDIT">Kredit</option></select></label></div><label>Parent Akun (opsional)<select value={parentId} onChange={e => setParentId(e.target.value)}><option value="">— Tanpa Parent —</option>{accounts.map(x => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></label></>}
    {tab === 'financial' && <><div className="form-grid two"><label>Jenis<select value={accountKind} onChange={e => setAccountKind(e.target.value)}>{Object.entries(financialKinds).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label><label>Location<select value={locationId} onChange={e => setLocationId(e.target.value)}><option value="">Company / HO</option>{locations.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label></div><label>Hubungkan ke COA<select value={coaAccountId} onChange={e => setCoaAccountId(e.target.value)}><option value="">Pilih akun</option>{accounts.filter(x => x.account_type === 'ASSET').map(x => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></label><div className="helper-box">QRIS/OJOL yang belum cair gunakan jenis <strong>Dana Belum Cair</strong>, bukan Bank.</div></>}
    {tab === 'tax' && <><div className="form-grid three"><label>Tipe<select value={taxType} onChange={e => setTaxType(e.target.value)}><option value="VAT">PPN / VAT</option><option value="WITHHOLDING">Withholding</option><option value="NONE">Non Pajak</option><option value="OTHER">Lainnya</option></select></label><label>Tarif (%)<input type="number" min="0" step="0.000001" value={rate} onChange={e => setRate(e.target.value)} /></label><label>Berlaku Mulai<input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} /></label></div><label className="inline-check standalone"><input type="checkbox" checked={inclusive} onChange={e => setInclusive(e.target.checked)} /> Harga termasuk pajak secara default</label></>}
    {error && <div className="form-error">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Batal</button><button className="primary-button" disabled={saving}>{saving ? 'Menyimpan...' : 'Simpan'}</button></div>
  </form></div>;
}
