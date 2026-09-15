import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Plus, Save, Trash2 } from 'lucide-react';
import { api } from './api';
import { SearchSelect } from './SearchSelect';
import { calculateDocument, type DocumentDiscount } from '../shared/transactionMath';

type Company = { id: string; workspace_id: string; code: string; name: string; workspace_name?: string };
type Location = { id: string; company_id: string; code: string; name: string; location_type: string };
type Item = { id: string; workspace_id: string; code: string; name: string; base_unit_id: string; unit_code: string; category_name: string };
type Unit = { id: string; workspace_id: string; code: string; name: string };
type Account = { id: string; company_id: string; code: string; name: string; account_type: string };
type FinancialAccount = { id: string; company_id: string; location_id: string | null; code: string; name: string; account_kind: string; location_name?: string };
type TaxCode = { id: string; workspace_id: string; code: string; name: string; rate: string; default_inclusive: boolean };
type Partner = { id: string; workspace_id: string; code: string; name: string; partner_type: string; payment_term_days: number };
type CostCenter = { id: string; company_id: string; code: string; name: string };
type RecentTx = { id: string; transaction_type: string; transaction_number: string; transaction_date: string; workflow_status: string; accounting_status: string; grand_total: string; partner_name?: string; location_name?: string; financial_account_name?: string };

type DiscountMode = '' | 'PERCENT' | 'AMOUNT';
type Line = {
  key: string;
  targetId: string;
  description: string;
  quantity: string;
  unitId: string;
  unitPrice: string;
  discountType: DiscountMode;
  discountValue: string;
  taxCodeId: string;
  taxIncluded: boolean;
  locationId: string;
  costCenterId: string;
};

const transactionLabels: Record<string, string> = {
  PURCHASE_INVOICE: 'Invoice Pembelian',
  CASH_OUT: 'Kas / Bank Keluar',
  CASH_IN: 'Kas / Bank Masuk',
};

const money = (value: string | number) => Number(value || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });
const today = () => new Date().toISOString().slice(0, 10);
const makeLine = (): Line => ({ key: crypto.randomUUID(), targetId: '', description: '', quantity: '1', unitId: '', unitPrice: '0', discountType: '', discountValue: '0', taxCodeId: '', taxIncluded: false, locationId: '', costCenterId: '' });

export function TransactionForm() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [financialAccounts, setFinancialAccounts] = useState<FinancialAccount[]>([]);
  const [taxes, setTaxes] = useState<TaxCode[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [recent, setRecent] = useState<RecentTx[]>([]);

  const [transactionType, setTransactionType] = useState('PURCHASE_INVOICE');
  const [companyId, setCompanyId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [financialAccountId, setFinancialAccountId] = useState('');
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [docDiscountType, setDocDiscountType] = useState<DiscountMode>('');
  const [docDiscountValue, setDocDiscountValue] = useState('0');
  const [lines, setLines] = useState<Line[]>([makeLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{ transaction_number: string; grand_total: string } | null>(null);

  const selectedCompany = companies.find(x => x.id === companyId);
  const isItemTransaction = transactionType === 'PURCHASE_INVOICE';
  const isCashTransaction = transactionType === 'CASH_OUT' || transactionType === 'CASH_IN';
  const companyLocations = locations.filter(x => x.company_id === companyId);

  async function loadCompanies() {
    const [c, l] = await Promise.all([api<Company[]>('/api/master/companies'), api<Location[]>('/api/master/locations')]);
    setCompanies(c); setLocations(l);
    if (!companyId && c[0]) setCompanyId(c[0].id);
  }

  async function loadCompanyMasters() {
    if (!selectedCompany) return;
    const wq = `?workspaceId=${encodeURIComponent(selectedCompany.workspace_id)}`;
    const cq = `?companyId=${encodeURIComponent(selectedCompany.id)}`;
    const [i, u, a, fa, t, p, cc, r] = await Promise.all([
      api<Item[]>(`/api/master/items${wq}`), api<Unit[]>(`/api/master/units${wq}`), api<Account[]>(`/api/master/accounts${cq}`),
      api<FinancialAccount[]>(`/api/master/financial-accounts${cq}`), api<TaxCode[]>(`/api/master/tax-codes${wq}`),
      api<Partner[]>(`/api/master/partners${wq}`), api<CostCenter[]>(`/api/master/cost-centers${cq}`), api<RecentTx[]>(`/api/transactions/recent${cq}`),
    ]);
    setItems(i); setUnits(u); setAccounts(a); setFinancialAccounts(fa); setTaxes(t); setPartners(p); setCostCenters(cc); setRecent(r);
    if (!locationId || !locations.some(x => x.company_id === selectedCompany.id && x.id === locationId)) {
      const first = locations.find(x => x.company_id === selectedCompany.id);
      setLocationId(first?.id || '');
    }
    setFinancialAccountId(current => fa.some(x => x.id === current) ? current : (fa[0]?.id || ''));
  }

  useEffect(() => { void loadCompanies(); }, []);
  useEffect(() => { void loadCompanyMasters(); }, [companyId, selectedCompany?.workspace_id, locations.length]);
  useEffect(() => {
    setLines([makeLine()]); setPartnerId(''); setDocDiscountType(''); setDocDiscountValue('0'); setSuccess(null); setError('');
  }, [transactionType]);

  const calculation = useMemo(() => {
    try {
      const dd: DocumentDiscount = docDiscountType ? { type: docDiscountType, value: Number(docDiscountValue || 0) } : null;
      return calculateDocument(lines.map(line => {
        const tax = taxes.find(x => x.id === line.taxCodeId);
        return {
          id: line.key,
          quantity: Number(line.quantity || 0),
          unitPrice: Number(line.unitPrice || 0),
          discountType: line.discountType || null,
          discountValue: Number(line.discountValue || 0),
          taxRate: Number(tax?.rate || 0),
          taxIncluded: line.taxIncluded,
        };
      }), dd);
    } catch { return null; }
  }, [lines, taxes, docDiscountType, docDiscountValue]);

  function updateLine(key: string, patch: Partial<Line>) {
    setLines(rows => rows.map(row => row.key === key ? { ...row, ...patch } : row));
  }

  function chooseTarget(line: Line, targetId: string) {
    if (isItemTransaction) {
      const item = items.find(x => x.id === targetId);
      updateLine(line.key, { targetId, unitId: item?.base_unit_id || '', description: item?.name || line.description });
    } else {
      const account = accounts.find(x => x.id === targetId);
      updateLine(line.key, { targetId, quantity: '1', unitId: '', description: account?.name || line.description });
    }
  }

  function chooseTax(line: Line, taxCodeId: string) {
    const tax = taxes.find(x => x.id === taxCodeId);
    updateLine(line.key, { taxCodeId, taxIncluded: Boolean(tax?.default_inclusive) });
  }

  async function saveDraft() {
    setError(''); setSuccess(null);
    if (!companyId) return setError('Pilih company terlebih dahulu.');
    if (isCashTransaction && !financialAccountId) return setError('Pilih kas/bank untuk transaksi ini.');
    if (lines.some(line => !line.targetId)) return setError(`Masih ada baris yang belum memilih ${isItemTransaction ? 'item' : 'akun'}.`);
    if (!calculation) return setError('Perhitungan transaksi belum valid. Periksa diskon, qty, harga, dan pajak.');
    setSaving(true);
    try {
      const result = await api<{ transaction_number: string; grand_total: string }>('/api/transactions/drafts', {
        method: 'POST',
        body: JSON.stringify({
          transactionType, companyId, locationId: locationId || null, partnerId: partnerId || null,
          financialAccountId: isCashTransaction ? financialAccountId : null,
          transactionDate: date, referenceNumber: reference || null, notes: notes || null,
          documentDiscountType: docDiscountType || null, documentDiscountValue: Number(docDiscountValue || 0),
          lines: lines.map(line => ({
            lineType: isItemTransaction ? 'ITEM' : 'ACCOUNT',
            itemId: isItemTransaction ? line.targetId : null,
            accountId: isItemTransaction ? null : line.targetId,
            description: line.description,
            quantity: isItemTransaction ? Number(line.quantity || 0) : 1,
            unitId: isItemTransaction ? line.unitId || null : null,
            unitPrice: Number(line.unitPrice || 0),
            discountType: line.discountType || null,
            discountValue: Number(line.discountValue || 0),
            taxCodeId: line.taxCodeId || null,
            taxIncluded: line.taxIncluded,
            locationId: line.locationId || null,
            costCenterId: line.costCenterId || null,
          })),
        }),
      });
      setSuccess(result);
      setLines([makeLine()]); setReference(''); setNotes(''); setDocDiscountType(''); setDocDiscountValue('0');
      const r = await api<RecentTx[]>(`/api/transactions/recent?companyId=${encodeURIComponent(companyId)}`); setRecent(r);
    } catch (err) { setError(err instanceof Error ? err.message : 'Gagal menyimpan transaksi'); }
    finally { setSaving(false); }
  }

  const targetOptions = isItemTransaction
    ? items.map(x => ({ id: x.id, label: `${x.code} — ${x.name}`, meta: x.category_name }))
    : accounts.map(x => ({ id: x.id, label: `${x.code} — ${x.name}`, meta: x.account_type }));

  return <div className="page-content transaction-page">
    <section className="section-card transaction-card">
      <div className="section-title transaction-title"><div><span className="eyebrow">GENERIC TRANSACTION ENGINE</span><h3>{transactionLabels[transactionType]}</h3><p>Form multi-baris: item/akun, diskon dan PPN per baris, serta location/cost center per baris.</p></div><div className="heading-actions"><select value={transactionType} onChange={e => setTransactionType(e.target.value)}><option value="PURCHASE_INVOICE">Invoice Pembelian</option><option value="CASH_OUT">Kas / Bank Keluar</option><option value="CASH_IN">Kas / Bank Masuk</option></select><button className="primary-button compact" onClick={saveDraft} disabled={saving}><Save size={16}/>{saving ? 'Menyimpan...' : 'Simpan Draft'}</button></div></div>

      {success && <div className="success-banner"><CheckCircle2 size={18}/><span><strong>{success.transaction_number}</strong> tersimpan sebagai draft · Total Rp{money(success.grand_total)}</span></div>}
      {error && <div className="form-error transaction-error">{error}</div>}

      <div className="transaction-header-grid">
        <label>Company<select value={companyId} onChange={e => setCompanyId(e.target.value)}><option value="">Pilih company</option>{companies.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Location<select value={locationId} onChange={e => setLocationId(e.target.value)}><option value="">— Company / HO —</option>{companyLocations.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Tanggal<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        {isCashTransaction && <label>{transactionType === 'CASH_OUT' ? 'Bayar dari Kas / Bank' : 'Masuk ke Kas / Bank'}<select value={financialAccountId} onChange={e => setFinancialAccountId(e.target.value)}><option value="">Pilih kas/bank</option>{financialAccounts.map(x => <option key={x.id} value={x.id}>{x.name}{x.location_name ? ` — ${x.location_name}` : ''}</option>)}</select></label>}
        <label>{isItemTransaction ? 'Supplier' : transactionType === 'CASH_OUT' ? 'Penerima / Relasi' : 'Sumber / Relasi'}<select value={partnerId} onChange={e => setPartnerId(e.target.value)}><option value="">— Opsional —</option>{partners.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Referensi<input value={reference} onChange={e => setReference(e.target.value)} placeholder="No invoice / referensi" /></label>
        <label>Catatan<input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Keterangan transaksi" /></label>
      </div>

      <div className="transaction-grid-wrap">
        <table className="transaction-grid">
          <thead><tr><th>#</th><th className="target-col">{isItemTransaction ? 'Item' : 'Akun / Keperluan'}</th><th>Keterangan</th>{isItemTransaction && <><th>Qty</th><th>Satuan</th></>}<th>{isItemTransaction ? 'Harga' : 'Nilai'}</th><th>Diskon</th><th>PPN / Pajak</th><th>Location</th><th>Cost Center</th><th className="numeric">Jumlah</th><th></th></tr></thead>
          <tbody>{lines.map((line, index) => {
            const calc = calculation?.lines[index];
            return <tr key={line.key}>
              <td className="line-number">{index + 1}</td>
              <td><SearchSelect value={line.targetId} options={targetOptions} placeholder={`Cari ${isItemTransaction ? 'item' : 'akun'}...`} onChange={id => chooseTarget(line, id)} /></td>
              <td><input value={line.description} onChange={e => updateLine(line.key, { description: e.target.value })} placeholder="Keterangan" /></td>
              {isItemTransaction && <><td><input className="number-input short" type="number" step="0.000001" min="0" value={line.quantity} onChange={e => updateLine(line.key, { quantity: e.target.value })} /></td><td><select value={line.unitId} onChange={e => updateLine(line.key, { unitId: e.target.value })}><option value="">—</option>{units.map(x => <option key={x.id} value={x.id}>{x.code}</option>)}</select></td></>}
              <td><input className="number-input" type="number" step="0.01" min="0" value={line.unitPrice} onChange={e => updateLine(line.key, { unitPrice: e.target.value })} /></td>
              <td><div className="compact-pair"><select value={line.discountType} onChange={e => updateLine(line.key, { discountType: e.target.value as DiscountMode })}><option value="">—</option><option value="PERCENT">%</option><option value="AMOUNT">Rp</option></select><input className="number-input discount-input" type="number" min="0" step="0.01" value={line.discountValue} onChange={e => updateLine(line.key, { discountValue: e.target.value })} /></div></td>
              <td><div className="tax-cell"><select value={line.taxCodeId} onChange={e => chooseTax(line, e.target.value)}><option value="">Non PPN</option>{taxes.map(x => <option key={x.id} value={x.id}>{x.code} ({Number(x.rate).toLocaleString('id-ID')}%)</option>)}</select>{line.taxCodeId && <label className="inline-check"><input type="checkbox" checked={line.taxIncluded} onChange={e => updateLine(line.key, { taxIncluded: e.target.checked })}/> Incl.</label>}</div></td>
              <td><select value={line.locationId} onChange={e => updateLine(line.key, { locationId: e.target.value })}><option value="">Default</option>{companyLocations.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></td>
              <td><select value={line.costCenterId} onChange={e => updateLine(line.key, { costCenterId: e.target.value })}><option value="">—</option>{costCenters.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></td>
              <td className="numeric line-total">Rp{money(calc?.lineTotal || 0)}</td>
              <td><button className="icon-button danger" type="button" title="Hapus baris" onClick={() => setLines(rows => rows.length === 1 ? rows : rows.filter(x => x.key !== line.key))}><Trash2 size={15}/></button></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <div className="transaction-footer">
        <button className="secondary-button" type="button" onClick={() => setLines(rows => [...rows, makeLine()])}><Plus size={16}/> Tambah Baris</button>
        <div className="document-discount"><span>Diskon Dokumen</span><select value={docDiscountType} onChange={e => setDocDiscountType(e.target.value as DiscountMode)}><option value="">Tidak ada</option><option value="PERCENT">Persen</option><option value="AMOUNT">Nominal</option></select>{docDiscountType && <input className="number-input" type="number" min="0" step="0.01" value={docDiscountValue} onChange={e => setDocDiscountValue(e.target.value)} />}</div>
        <div className="totals-box"><div><span>Subtotal</span><strong>Rp{money(calculation?.grossAmount || 0)}</strong></div><div><span>Diskon Item</span><strong>- Rp{money(calculation?.lineDiscountAmount || 0)}</strong></div><div><span>Diskon Dokumen</span><strong>- Rp{money(calculation?.documentDiscountAmount || 0)}</strong></div><div><span>DPP</span><strong>Rp{money(calculation?.dppAmount || 0)}</strong></div><div><span>PPN / Pajak</span><strong>Rp{money(calculation?.taxAmount || 0)}</strong></div><div className="grand-total"><span>Grand Total</span><strong>Rp{money(calculation?.grandTotal || 0)}</strong></div></div>
      </div>
    </section>

    <section className="section-card"><div className="section-title"><div><span className="eyebrow">DRAFT TERBARU</span><h3>Transaksi terakhir</h3><p>Satu dokumen dapat membawa banyak item atau banyak akun.</p></div></div><div className="data-table-wrap"><table><thead><tr><th>No Transaksi</th><th>Tanggal</th><th>Jenis</th><th>Location</th><th>Kas / Bank</th><th>Relasi</th><th>Status</th><th className="numeric">Total</th></tr></thead><tbody>{recent.slice(0, 10).map(x => <tr key={x.id}><td><strong>{x.transaction_number}</strong></td><td>{x.transaction_date?.slice(0,10)}</td><td>{transactionLabels[x.transaction_type] || x.transaction_type}</td><td>{x.location_name || '—'}</td><td>{x.financial_account_name || '—'}</td><td>{x.partner_name || '—'}</td><td><span className="status-draft">{x.workflow_status}</span></td><td className="numeric">Rp{money(x.grand_total)}</td></tr>)}</tbody></table>{recent.length === 0 && <div className="empty-state"><Save size={32}/><strong>Belum ada transaksi</strong><span>Simpan draft pertama dari form di atas.</span></div>}</div></section>
  </div>;
}
