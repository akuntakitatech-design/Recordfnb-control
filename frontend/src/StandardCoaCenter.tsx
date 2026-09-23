import { useEffect, useMemo, useState } from 'react';
import { BookOpenCheck, Boxes, Calculator, Landmark, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { api } from './api';

type Company = { id: string; workspace_id: string; code: string; name: string; workspace_name?: string };
type Template = { id: string; code: string; name: string; industry: string; version: number; description: string; account_count: number };
type TemplateAccount = { id: string; code: string; name: string; account_type: string; normal_balance: string; report_group: string; report_subgroup: string | null };
type Account = { id: string; code: string; name: string; account_type: string; normal_balance: string; report_group?: string | null; report_subgroup?: string | null };
type ImportantMapping = { role_code: string; account_id: string; account_code: string; account_name: string };
type ItemMapping = {
  category_id: string; category_code: string; category_name: string; category_type: string;
  inventory_account_id: string | null; inventory_account_code?: string; inventory_account_name?: string;
  cogs_account_id: string | null; cogs_account_code?: string; cogs_account_name?: string;
  sales_account_id: string | null; sales_account_code?: string; sales_account_name?: string;
  usage_account_id: string | null; usage_account_code?: string; usage_account_name?: string;
  stock_adjustment_account_id: string | null; stock_adjustment_account_code?: string; stock_adjustment_account_name?: string;
};
type AssetMapping = {
  category_id: string; category_code: string; category_name: string;
  asset_account_id: string | null; asset_account_code?: string; asset_account_name?: string;
  accumulated_depreciation_account_id: string | null; accumulated_depreciation_account_code?: string; accumulated_depreciation_account_name?: string;
  depreciation_expense_account_id: string | null; depreciation_expense_account_code?: string; depreciation_expense_account_name?: string;
};
type TaxMapping = { tax_role_code: string; label: string; account_id: string; account_code: string; account_name: string };
type MappingResponse = {
  company: Company;
  accounts: Account[];
  importantAccounts: ImportantMapping[];
  itemCategories: ItemMapping[];
  assetCategories: AssetMapping[];
  taxDefaults: TaxMapping[];
  application: null | { template_name: string; template_code: string; template_version: number; applied_at: string };
};
type Tab = 'template' | 'important' | 'items' | 'assets' | 'tax';

const importantLabels: Record<string,string> = {
  TRADE_RECEIVABLE: 'Piutang Usaha Default',
  TRADE_PAYABLE: 'Utang Usaha Default',
  PURCHASE_ADVANCE: 'Uang Muka Pembelian',
  EMPLOYEE_ADVANCE: 'Uang Muka Karyawan',
  ASSET_PURCHASE_ADVANCE: 'Uang Muka Pembelian Aset',
  CUSTOMER_ADVANCE: 'Uang Muka Pelanggan / Penjualan',
  UNBILLED_PURCHASE: 'Utang Belum Ditagih',
  ACCRUED_EXPENSE: 'Biaya Masih Harus Dibayar',
  RETAINED_EARNINGS: 'Laba Ditahan',
  CURRENT_YEAR_EARNINGS: 'Laba Rugi Tahun Berjalan',
  OPENING_BALANCE_EQUITY: 'Ekuitas Saldo Awal',
  CASH_BANK_VARIANCE: 'Selisih Kas dan Bank',
  ROUNDING: 'Selisih Pembulatan',
};

function AccountSelect({ value, accounts, onChange, allowEmpty = true }: { value: string | null | undefined; accounts: Account[]; onChange: (value: string) => void; allowEmpty?: boolean }) {
  return <select value={value || ''} onChange={e => onChange(e.target.value)}>
    {allowEmpty && <option value="">— Belum diatur —</option>}
    {accounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
  </select>;
}

export function StandardCoaCenter() {
  const [companies,setCompanies] = useState<Company[]>([]);
  const [templates,setTemplates] = useState<Template[]>([]);
  const [companyId,setCompanyId] = useState('');
  const [templateId,setTemplateId] = useState('');
  const [templateAccounts,setTemplateAccounts] = useState<TemplateAccount[]>([]);
  const [mapping,setMapping] = useState<MappingResponse | null>(null);
  const [tab,setTab] = useState<Tab>('template');
  const [search,setSearch] = useState('');
  const [loading,setLoading] = useState(true);
  const [applying,setApplying] = useState(false);
  const [message,setMessage] = useState('');
  const [error,setError] = useState('');

  async function loadBase() {
    setLoading(true); setError('');
    try {
      const [c,t] = await Promise.all([
        api<Company[]>('/api/master/companies'),
        api<Template[]>('/api/master/coa-standard/templates'),
      ]);
      setCompanies(c); setTemplates(t);
      const nextCompany = companyId || c[0]?.id || '';
      const nextTemplate = templateId || t[0]?.id || '';
      if (!companyId) setCompanyId(nextCompany);
      if (!templateId) setTemplateId(nextTemplate);
    } catch (err) { setError(err instanceof Error ? err.message : 'Gagal memuat COA Standard'); }
    finally { setLoading(false); }
  }

  async function loadTemplate(id = templateId) {
    if (!id) return;
    try { setTemplateAccounts(await api<TemplateAccount[]>(`/api/master/coa-standard/templates/${id}/accounts`)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Gagal memuat template'); }
  }

  async function loadMappings(id = companyId) {
    if (!id) return;
    try { setMapping(await api<MappingResponse>(`/api/master/coa-standard/company/${id}/mappings`)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Gagal memuat mapping akun'); }
  }

  useEffect(() => { void loadBase(); }, []);
  useEffect(() => { if (templateId) void loadTemplate(templateId); }, [templateId]);
  useEffect(() => { if (companyId) void loadMappings(companyId); }, [companyId]);

  const selectedTemplate = templates.find(t => t.id === templateId);
  const filteredTemplateAccounts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? templateAccounts.filter(x => JSON.stringify(x).toLowerCase().includes(term)) : templateAccounts;
  }, [templateAccounts, search]);

  async function applyTemplate() {
    if (!companyId || !templateId) return;
    setApplying(true); setError(''); setMessage('');
    try {
      const result = await api<{ ok: boolean; insertedAccounts: number; totalAccounts: number }>(`/api/master/coa-standard/templates/${templateId}/apply`, {
        method:'POST', body:JSON.stringify({ companyId }),
      });
      setMessage(`Template berhasil diterapkan. ${result.insertedAccounts} akun baru ditambahkan. Mapping yang pernah diedit tidak ditimpa.`);
      await loadMappings(companyId);
    } catch (err) { setError(err instanceof Error ? err.message : 'Gagal menerapkan template'); }
    finally { setApplying(false); }
  }

  async function saveImportant(roleCode: string, accountId: string) {
    if (!companyId || !accountId) return;
    await api(`/api/master/coa-standard/company/${companyId}/important/${roleCode}`, { method:'PUT', body:JSON.stringify({ accountId }) });
    await loadMappings(companyId);
  }

  async function saveItem(row: ItemMapping, patch: Partial<ItemMapping>) {
    if (!companyId) return;
    const next = { ...row, ...patch };
    await api(`/api/master/coa-standard/company/${companyId}/item-category/${row.category_id}`, {
      method:'PUT', body:JSON.stringify({
        inventoryAccountId:next.inventory_account_id || null,
        cogsAccountId:next.cogs_account_id || null,
        salesAccountId:next.sales_account_id || null,
        usageAccountId:next.usage_account_id || null,
        stockAdjustmentAccountId:next.stock_adjustment_account_id || null,
      }),
    });
    await loadMappings(companyId);
  }

  async function saveAsset(row: AssetMapping, patch: Partial<AssetMapping>) {
    if (!companyId) return;
    const next = { ...row, ...patch };
    if (!next.asset_account_id || !next.accumulated_depreciation_account_id || !next.depreciation_expense_account_id) return;
    await api(`/api/master/coa-standard/company/${companyId}/asset-category/${row.category_id}`, {
      method:'PUT', body:JSON.stringify({
        assetAccountId:next.asset_account_id,
        accumulatedDepreciationAccountId:next.accumulated_depreciation_account_id,
        depreciationExpenseAccountId:next.depreciation_expense_account_id,
      }),
    });
    await loadMappings(companyId);
  }

  async function saveTax(row: TaxMapping, accountId: string) {
    if (!companyId || !accountId) return;
    await api(`/api/master/coa-standard/company/${companyId}/tax/${row.tax_role_code}`, {
      method:'PUT', body:JSON.stringify({ accountId, label:row.label }),
    });
    await loadMappings(companyId);
  }

  if (loading) return <div className="page-content"><section className="section-card">Memuat COA Standard...</section></div>;

  return <div className="page-content coa-standard-page">
    <section className="section-card">
      <div className="section-title master-heading">
        <div>
          <span className="eyebrow">AKUNTAKITA STANDARD COA</span>
          <h3>COA Standard F&B & Mapping Akun</h3>
          <p>Template COA generik, lalu akun melekat pada master yang memang berhubungan langsung: kelompok barang, kelompok aset, pajak, kas/bank, dan akun sistem.</p>
        </div>
        <div className="heading-actions coa-heading-actions">
          <select value={companyId} onChange={e => setCompanyId(e.target.value)}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button className="secondary-button compact" onClick={() => { void loadMappings(); void loadTemplate(); }}><RefreshCw size={15}/> Refresh</button>
        </div>
      </div>

      {mapping?.application && <div className="coa-applied-banner"><ShieldCheck size={18}/><div><strong>Template sudah diterapkan</strong><span>{mapping.application.template_name} v{mapping.application.template_version} · {new Date(mapping.application.applied_at).toLocaleString('id-ID')}</span></div></div>}
      {message && <div className="form-success">{message}</div>}
      {error && <div className="form-error">{error}</div>}

      <div className="tabs master-tabs coa-tabs">
        <button className={tab === 'template' ? 'active' : ''} onClick={() => setTab('template')}><BookOpenCheck size={15}/> Template COA</button>
        <button className={tab === 'important' ? 'active' : ''} onClick={() => setTab('important')}><Landmark size={15}/> Akun Penting</button>
        <button className={tab === 'items' ? 'active' : ''} onClick={() => setTab('items')}><Boxes size={15}/> Kelompok Barang</button>
        <button className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}><Calculator size={15}/> Kelompok Aset</button>
        <button className={tab === 'tax' ? 'active' : ''} onClick={() => setTab('tax')}><ShieldCheck size={15}/> Pajak</button>
      </div>

      {tab === 'template' && <>
        <div className="coa-template-toolbar">
          <div><label>Template<select value={templateId} onChange={e => setTemplateId(e.target.value)}>{templates.map(t => <option key={t.id} value={t.id}>{t.name} v{t.version}</option>)}</select></label></div>
          <div className="template-description"><strong>{selectedTemplate?.account_count || 0} akun</strong><span>{selectedTemplate?.description}</span></div>
          <button className="primary-button" onClick={applyTemplate} disabled={applying || !companyId || !templateId}>{applying ? 'Menerapkan...' : mapping?.application ? 'Lengkapi / Terapkan Ulang' : 'Terapkan ke Company'}</button>
        </div>
        <div className="helper-box">Penerapan ulang aman: akun yang sudah ada tidak diduplikasi dan mapping yang sudah Bapak edit tidak ditimpa.</div>
        <div className="table-toolbar"><div className="search-box"><Search size={16}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cari kode, nama atau kelompok..."/></div><span>{filteredTemplateAccounts.length} akun</span></div>
        <div className="data-table-wrap"><table><thead><tr><th>Kode</th><th>Nama Akun</th><th>Kelompok Laporan</th><th>Sub Kelompok</th><th>Tipe</th><th>Normal</th></tr></thead><tbody>{filteredTemplateAccounts.map(a => <tr key={a.id}><td><code>{a.code}</code></td><td><strong>{a.name}</strong></td><td>{a.report_group}</td><td>{a.report_subgroup || '—'}</td><td>{a.account_type}</td><td>{a.normal_balance === 'DEBIT' ? 'Debit' : 'Kredit'}</td></tr>)}</tbody></table></div>
      </>}

      {tab === 'important' && <div className="mapping-list">
        <div className="mapping-intro"><strong>Akun sistem / fallback</strong><span>Hanya akun yang tidak melekat alami ke master lain. Editable per company.</span></div>
        {(mapping?.importantAccounts || []).map(row => <div className="mapping-row" key={row.role_code}><div><strong>{importantLabels[row.role_code] || row.role_code}</strong><small>{row.role_code}</small></div><AccountSelect value={row.account_id} accounts={mapping?.accounts || []} allowEmpty={false} onChange={v => void saveImportant(row.role_code,v)}/></div>)}
        {!mapping?.importantAccounts.length && <div className="empty-state"><Landmark size={32}/><strong>Belum ada mapping</strong><span>Terapkan Template COA terlebih dahulu.</span></div>}
      </div>}

      {tab === 'items' && <div className="mapping-list">
        <div className="mapping-intro"><strong>Akun melekat pada Kelompok Barang</strong><span>Persediaan, HPP, pemakaian dan selisih Stock Opname diwarisi item dari kelompoknya. Client tidak memilih akun saat transaksi.</span></div>
        {(mapping?.itemCategories || []).map(row => <div className="mapping-block" key={row.category_id}>
          <div className="mapping-block-title"><strong>{row.category_name}</strong><span>{row.category_type}</span></div>
          <div className="mapping-grid four">
            <label>Persediaan<AccountSelect value={row.inventory_account_id} accounts={(mapping?.accounts || []).filter(a => a.account_type === 'ASSET')} onChange={v => void saveItem(row,{inventory_account_id:v || null})}/></label>
            <label>HPP<AccountSelect value={row.cogs_account_id} accounts={(mapping?.accounts || []).filter(a => a.account_type === 'COGS')} onChange={v => void saveItem(row,{cogs_account_id:v || null})}/></label>
            <label>Penjualan<AccountSelect value={row.sales_account_id} accounts={(mapping?.accounts || []).filter(a => a.account_type === 'REVENUE')} onChange={v => void saveItem(row,{sales_account_id:v || null})}/></label>
            <label>Pemakaian<AccountSelect value={row.usage_account_id} accounts={(mapping?.accounts || []).filter(a => ['COGS','EXPENSE'].includes(a.account_type))} onChange={v => void saveItem(row,{usage_account_id:v || null})}/></label>
            <label>Stock Opname / Selisih<AccountSelect value={row.stock_adjustment_account_id} accounts={(mapping?.accounts || []).filter(a => ['COGS','EXPENSE','OTHER_EXPENSE'].includes(a.account_type))} onChange={v => void saveItem(row,{stock_adjustment_account_id:v || null})}/></label>
          </div>
        </div>)}
      </div>}

      {tab === 'assets' && <div className="mapping-list">
        <div className="mapping-intro"><strong>Akun melekat pada Kelompok Aset</strong><span>Harga perolehan, akumulasi penyusutan dan beban penyusutan mengikuti kelompok aset.</span></div>
        {(mapping?.assetCategories || []).map(row => <div className="mapping-block" key={row.category_id}>
          <div className="mapping-block-title"><strong>{row.category_name}</strong><span>{row.category_code}</span></div>
          <div className="mapping-grid three">
            <label>Nilai Perolehan<AccountSelect allowEmpty={false} value={row.asset_account_id} accounts={(mapping?.accounts || []).filter(a => a.account_type === 'ASSET')} onChange={v => void saveAsset(row,{asset_account_id:v})}/></label>
            <label>Akumulasi Penyusutan<AccountSelect allowEmpty={false} value={row.accumulated_depreciation_account_id} accounts={(mapping?.accounts || []).filter(a => a.account_type === 'ASSET')} onChange={v => void saveAsset(row,{accumulated_depreciation_account_id:v})}/></label>
            <label>Beban Penyusutan<AccountSelect allowEmpty={false} value={row.depreciation_expense_account_id} accounts={(mapping?.accounts || []).filter(a => ['EXPENSE','OTHER_EXPENSE'].includes(a.account_type))} onChange={v => void saveAsset(row,{depreciation_expense_account_id:v})}/></label>
          </div>
        </div>)}
      </div>}

      {tab === 'tax' && <div className="mapping-list">
        <div className="mapping-intro"><strong>Akun melekat pada Pajak</strong><span>PPN/PPh disimpan di master pajak, bukan di Akun Penting. Nilainya dapat diedit per company.</span></div>
        {(mapping?.taxDefaults || []).map(row => <div className="mapping-row" key={row.tax_role_code}><div><strong>{row.label}</strong><small>{row.tax_role_code}</small></div><AccountSelect value={row.account_id} accounts={mapping?.accounts || []} allowEmpty={false} onChange={v => void saveTax(row,v)}/></div>)}
        {!mapping?.taxDefaults.length && <div className="empty-state"><ShieldCheck size={32}/><strong>Belum ada mapping pajak</strong><span>Terapkan Template COA terlebih dahulu.</span></div>}
      </div>}
    </section>
  </div>;
}
