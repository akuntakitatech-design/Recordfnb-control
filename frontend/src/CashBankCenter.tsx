import { useEffect, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, Download, Eye, FileText, Landmark, Plus, RefreshCw, Wallet } from 'lucide-react';
import { api } from './api';
import {
  type CashAccount, type Company, type Ledger, type Location, type Payable, type Totals,
  accountKindLabel, downloadFile, errorText, qs, rupiah, workflowLabel,
} from './cashBankShared';
import { CashBankEntryModal, type EntryPreset } from './CashBankEntryModal';
import { ControlPanel, PayablesPanel, PeriodPanel, ReconciliationPanel, TransactionDetailModal, VerificationPanel } from './CashBankPanels';

type Tab = 'ledger' | 'payables' | 'verification' | 'control' | 'reconciliation' | 'period';

export function CashBankCenter({ canVerify, canAccounting }: { canVerify: boolean; canAccounting: boolean }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [tab, setTab] = useState<Tab>('ledger');
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [entry, setEntry] = useState<EntryPreset | null>(null);
  const [detailId, setDetailId] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);

  const company = companies.find(c => c.id === companyId);
  const companyLocations = locations.filter(l => l.company_id === companyId);
  const notify = (kind: 'ok' | 'error', message: string) => {
    setBanner({ kind, message });
    // Pastikan banner terlihat walau halaman sedang di-scroll.
    requestAnimationFrame(() => document.querySelector('[data-testid="cb-banner"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };
  const refresh = () => setRefreshKey(k => k + 1);

  useEffect(() => {
    Promise.all([api<Company[]>('/api/master/companies'), api<Location[]>('/api/master/locations')])
      .then(([c, l]) => { setCompanies(c); setLocations(l); if (c[0]) setCompanyId(cur => cur || c[0].id); })
      .catch(err => notify('error', errorText(err)));
  }, []);

  useEffect(() => {
    if (!companyId) return;
    api<{ accounts: CashAccount[]; totals: Totals }>(`/api/cash-bank/accounts?companyId=${encodeURIComponent(companyId)}`)
      .then(r => { setAccounts(r.accounts); setTotals(r.totals); setAccountId(cur => (r.accounts.some(a => a.id === cur) ? cur : '')); })
      .catch(err => notify('error', errorText(err)));
  }, [companyId, refreshKey]);

  const ledgerQuery = qs({ companyId, accountId, from, to });
  useEffect(() => {
    if (!companyId) return;
    setLoading(true);
    api<Ledger>(`/api/cash-bank/ledger?${ledgerQuery}`).then(setLedger).catch(err => notify('error', errorText(err))).finally(() => setLoading(false));
  }, [ledgerQuery, refreshKey]);

  // Draft unik per transaksi (transfer punya 2 baris mutasi tetapi 1 transaksi).
  const [draftCount, setDraftCount] = useState(0);
  useEffect(() => {
    if (!companyId) return;
    api<Ledger>(`/api/cash-bank/ledger?companyId=${encodeURIComponent(companyId)}`)
      .then(r => setDraftCount(new Set(r.rows.filter(x => x.workflow_status === 'DRAFT').map(x => x.transaction_id)).size))
      .catch(() => setDraftCount(0));
  }, [companyId, refreshKey]);
  const selectedAccount = accounts.find(a => a.id === accountId);

  const tabs: Array<[Tab, string, boolean]> = [
    ['ledger', 'Mutasi', true], ['payables', 'Hutang Supplier', true], ['verification', `Verifikasi Finance${draftCount ? ` (${draftCount})` : ''}`, true],
    ['control', 'Accounting Control', canAccounting], ['reconciliation', 'Rekonsiliasi', true], ['period', 'Periode', canAccounting],
  ];

  return <div className="page-content cash-bank-page" data-testid="cash-bank-page">
    <section className="section-card cb-shell">
      <div className="section-title master-heading">
        <div><span className="eyebrow">KAS & BANK</span><h3>Kas & Bank</h3><p>Saldo, mutasi, pembayaran, pindah uang dan kontrol verifikasi dalam satu halaman. Tanpa memilih akun/COA.</p></div>
        <div className="heading-actions">
          <select value={companyId} onChange={e => setCompanyId(e.target.value)} data-testid="cb-company-select">{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button className="secondary-button compact" onClick={refresh} title="Muat ulang" data-testid="cb-refresh"><RefreshCw size={15}/></button>
          <button className="secondary-button compact" onClick={() => setEntry({ mode: 'TRANSFER' })} disabled={accounts.length < 2} data-testid="cb-open-transfer"><ArrowRightLeft size={15}/> Pindahkan Uang</button>
          <button className="primary-button compact" onClick={() => setEntry({ mode: 'PAY' })} disabled={!accounts.length} data-testid="cb-open-entry"><Plus size={15}/> Catat Transaksi</button>
        </div>
      </div>

      {banner && <div data-testid="cb-banner"><div className={banner.kind === 'ok' ? 'success-banner cb-inline-banner' : 'form-error cb-inline-banner'} data-testid={banner.kind === 'ok' ? 'cb-success-banner' : 'cb-error-banner'}>
        {banner.kind === 'ok' && <CheckCircle2 size={17}/>}<span>{banner.message}</span><button className="cb-banner-close" onClick={() => setBanner(null)} data-testid="cb-banner-close">×</button></div></div>}

      <div className="cb-balance-grid" data-testid="cb-balance-cards">
        <button className={`cb-balance-card total ${accountId === '' ? 'active' : ''}`} onClick={() => setAccountId('')} data-testid="cb-card-total">
          <span className="cb-card-label"><Landmark size={15}/> Total Kas & Bank</span><strong data-testid="cb-total-balance">{rupiah(totals?.total)}</strong>
          <small>Kas {rupiah(totals?.cash)} · Bank {rupiah(totals?.bank)}{Number(totals?.ewallet || 0) ? ` · E-Wallet ${rupiah(totals?.ewallet)}` : ''}</small>
        </button>
        {accounts.map(a => <button key={a.id} className={`cb-balance-card ${accountId === a.id ? 'active' : ''}`} onClick={() => setAccountId(accountId === a.id ? '' : a.id)} data-testid={`cb-card-${a.code}`}>
          <span className="cb-card-label"><Wallet size={15}/> {a.name}<em>{accountKindLabel[a.account_kind]}</em></span>
          <strong data-testid={`cb-balance-${a.code}`}>{rupiah(a.balance)}</strong>
          <small>{a.mutation_count} mutasi{a.draft_count ? ` · ${a.draft_count} draft` : ''}{a.last_reconciliation_status ? ` · rekon ${a.last_reconciliation_date}` : ''}</small>
        </button>)}
        {accounts.length === 0 && <div className="empty-state cb-empty-accounts"><Landmark size={30}/><strong>Belum ada rekening kas/bank</strong><span>Accounting perlu menambahkan rekening di Finance Master.</span></div>}
      </div>

      <div className="tabs finance-tabs cb-tabs">{tabs.filter(t => t[2]).map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)} data-testid={`cb-tab-${key}`}>{label}</button>)}</div>

      {tab === 'ledger' && <div className="cb-panel" data-testid="cb-ledger-panel">
        <div className="cb-toolbar">
          <label className="cb-inline-label">Rekening<select value={accountId} onChange={e => setAccountId(e.target.value)} data-testid="cb-filter-account"><option value="">Semua Kas & Bank</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label className="cb-inline-label">Dari<input type="date" value={from} onChange={e => setFrom(e.target.value)} data-testid="cb-filter-from"/></label>
          <label className="cb-inline-label">Sampai<input type="date" value={to} onChange={e => setTo(e.target.value)} data-testid="cb-filter-to"/></label>
          {(accountId || from || to) && <button className="secondary-button compact" onClick={() => { setAccountId(''); setFrom(''); setTo(''); }} data-testid="cb-filter-reset">Reset</button>}
          <div className="cb-toolbar-spacer"/>
          <button className="secondary-button compact" onClick={() => downloadFile(`/api/cash-bank/export/ledger?${ledgerQuery}`, 'kas-bank-mutasi.xlsx').catch(err => notify('error', errorText(err)))} data-testid="cb-export-ledger"><Download size={14}/> Export Excel</button>
        </div>
        <div className="cb-summary-strip">
          <div><span>Saldo Awal{from ? ` (${from})` : ''}</span><strong data-testid="cb-opening">{rupiah(ledger?.opening_balance)}</strong></div>
          <div><span>Masuk</span><strong className="cb-text-in" data-testid="cb-total-in">{rupiah(ledger?.total_in)}</strong></div>
          <div><span>Keluar</span><strong className="cb-text-out" data-testid="cb-total-out">{rupiah(ledger?.total_out)}</strong></div>
          <div><span>Saldo Akhir{selectedAccount ? ` · ${selectedAccount.name}` : ''}</span><strong data-testid="cb-closing">{rupiah(ledger?.closing_balance)}</strong></div>
        </div>
        <div className="data-table-wrap"><table className="cb-ledger-table"><thead><tr><th>Tanggal</th><th>No Transaksi</th><th>Kas/Bank</th><th>Jenis</th><th>Keterangan</th><th>Supplier/Penerima</th><th className="numeric">Masuk</th><th className="numeric">Keluar</th><th className="numeric">Saldo</th><th>Status</th><th></th></tr></thead><tbody>
          {from && ledger && <tr className="cb-opening-row"><td>{from}</td><td colSpan={5}><strong>Saldo Awal</strong></td><td/><td/><td className="numeric"><strong>{rupiah(ledger.opening_balance)}</strong></td><td/><td/></tr>}
          {ledger?.rows.map(r => <tr key={r.id} data-testid={`cb-ledger-row-${r.transaction_number}`}>
            <td>{r.transaction_date}</td><td><strong>{r.transaction_number}</strong>{r.reference_number && <small className="journal-meta">{r.reference_number}</small>}</td>
            <td>{r.financial_account_name}</td><td>{r.kind}</td>
            <td>{r.description || '—'}{r.category_name && <small className="journal-meta">{r.category_name}</small>}</td><td>{r.counterparty || '—'}</td>
            <td className="numeric cb-text-in">{Number(r.amount_in) ? rupiah(r.amount_in) : ''}</td><td className="numeric cb-text-out">{Number(r.amount_out) ? rupiah(r.amount_out) : ''}</td>
            <td className="numeric"><strong>{rupiah(r.balance)}</strong></td>
            <td><span className={r.workflow_status === 'DRAFT' ? 'status-draft' : 'status-ok'}>{workflowLabel[r.workflow_status] || r.workflow_status}</span>{r.attachment_count > 0 && <span className="attachment-count cb-att"><FileText size={12}/>{r.attachment_count}</span>}</td>
            <td><button className="icon-button" onClick={() => setDetailId(r.transaction_id)} data-testid={`cb-ledger-detail-${r.transaction_number}`}><Eye size={14}/></button></td>
          </tr>)}
        </tbody></table>{!loading && ledger && ledger.rows.length === 0 && <div className="empty-state"><FileText size={30}/><strong>Belum ada mutasi</strong><span>Tidak ada transaksi pada filter ini.</span></div>}{loading && <div className="empty-state"><span>Memuat mutasi...</span></div>}</div>
        <div className="helper-box">Saldo berjalan dihitung {accountId ? 'per rekening terpilih' : 'gabungan seluruh Kas & Bank'}. Transaksi Draft ikut dihitung; transaksi Dibatalkan tidak.</div>
      </div>}

      {company && tab === 'payables' && <PayablesPanel companyId={companyId} notify={notify} refreshKey={refreshKey} onPay={(p: Payable) => setEntry({ mode: 'PAY', payType: 'DEBT_PAYMENT', supplierId: p.partner_id, invoiceId: p.id })}/>}
      {company && tab === 'verification' && <VerificationPanel companyId={companyId} canVerify={canVerify} notify={notify} refreshKey={refreshKey} onChanged={refresh}/>}
      {company && tab === 'control' && canAccounting && <ControlPanel companyId={companyId} notify={notify} refreshKey={refreshKey}/>}
      {company && tab === 'reconciliation' && <ReconciliationPanel companyId={companyId} accounts={accounts} canVerify={canVerify} notify={notify} refreshKey={refreshKey} onChanged={refresh}/>}
      {company && tab === 'period' && canAccounting && <PeriodPanel companyId={companyId} canAccounting={canAccounting} notify={notify} refreshKey={refreshKey}/>}
    </section>

    {entry && company && <CashBankEntryModal key={JSON.stringify(entry)} companyId={companyId} workspaceId={company.workspace_id} locations={companyLocations} accounts={accounts} canVerify={canVerify} preset={entry}
      onClose={() => setEntry(null)} onSaved={message => { setEntry(null); notify('ok', message); refresh(); }}/>}
    {detailId && <TransactionDetailModal transactionId={detailId} onClose={() => setDetailId('')}/>}
  </div>;
}
