import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { api } from './api';
import type { Company } from './cashBankShared';
import { ControlPanel, PeriodPanel } from './CashBankPanels';

/**
 * Halaman Accounting Control yang memakai panel existing (Kas & Bank) secara mandiri:
 *  - mode 'source' : Accounting Source / transaksi sumber (GET /api/accounting-control/overview)
 *  - mode 'period' : Accounting Period / Closing (GET/POST/PATCH /api/accounting-periods)
 * Tidak ada endpoint/engine baru.
 */
export function AccountingCompanyPage({ mode }: { mode: 'source' | 'period' }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);

  useEffect(() => {
    api<Company[]>('/api/master/companies').then(rows => { setCompanies(rows); setCompanyId(current => current || rows[0]?.id || ''); })
      .catch(err => setBanner({ kind: 'error', message: err instanceof Error ? err.message : 'Gagal memuat company' }));
  }, []);

  const notify = (kind: 'ok' | 'error', message: string) => setBanner({ kind, message });
  const title = mode === 'source' ? 'Accounting Source' : 'Periode & Closing';
  const subtitle = mode === 'source'
    ? 'Transaksi sumber dari Finance Control beserta status verifikasi, jurnal dan posting.'
    : 'Buka, soft close, dan hard close periode akuntansi per company.';

  return <div className="page-content cash-bank-page" data-testid={`accounting-${mode}-page`}>
    <section className="section-card cb-shell">
      <div className="section-title master-heading">
        <div><span className="eyebrow">ACCOUNTING CONTROL</span><h3>{title}</h3><p>{subtitle}</p></div>
        <div className="heading-actions">
          <select value={companyId} onChange={e => setCompanyId(e.target.value)} data-testid={`accounting-${mode}-company`}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button className="secondary-button compact" onClick={() => setRefreshKey(k => k + 1)} data-testid={`accounting-${mode}-refresh`}>Muat ulang</button>
        </div>
      </div>
      {banner && <div className={banner.kind === 'ok' ? 'success-banner cb-inline-banner' : 'form-error cb-inline-banner'} data-testid="accounting-page-banner">
        {banner.kind === 'ok' && <CheckCircle2 size={17}/>}<span>{banner.message}</span><button className="cb-banner-close" onClick={() => setBanner(null)}>×</button></div>}
      {companyId && mode === 'source' && <ControlPanel companyId={companyId} notify={notify} refreshKey={refreshKey}/>}
      {companyId && mode === 'period' && <PeriodPanel companyId={companyId} canAccounting notify={notify} refreshKey={refreshKey}/>}
      {!companies.length && <div className="empty-state"><strong>Belum ada company</strong><span>Company dibuat dari menu Organisasi.</span></div>}
    </section>
  </div>;
}
