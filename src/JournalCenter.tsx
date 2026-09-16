import { useEffect, useState } from 'react';
import { CheckCircle2, Eye, FileCheck2, Landmark, RefreshCw } from 'lucide-react';
import { api } from './api';
import { AccountingCashOutQueue } from './AccountingCashOutQueue';
import { AccountingCashInQueue } from './AccountingCashInQueue';

type Company = { id: string; name: string };
type JournalRow = {
  id: string; journal_number: string; journal_date: string; journal_type: string; status: string;
  description: string; engine_version?: string; source_transaction_number?: string; transaction_type?: string;
  total_debit: string; total_credit: string;
};
type JournalLine = {
  id: string; line_no: number; account_code: string; account_name: string; debit: string; credit: string;
  description?: string; location_name?: string; cost_center_name?: string; partner_name?: string; item_name?: string;
};
type JournalDetail = JournalRow & { lines: JournalLine[] };

const money = (value: string | number) => Number(value || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });

export function JournalCenter({ canReview, canPost }: { canReview: boolean; canPost: boolean }) {
  const [companies,setCompanies] = useState<Company[]>([]);
  const [companyId,setCompanyId] = useState('');
  const [journals,setJournals] = useState<JournalRow[]>([]);
  const [detail,setDetail] = useState<JournalDetail | null>(null);
  const [loading,setLoading] = useState(false);
  const [error,setError] = useState('');
  const [message,setMessage] = useState('');

  async function loadCompanies() {
    const rows = await api<Company[]>('/api/master/companies');
    setCompanies(rows);
    if (!companyId && rows[0]) setCompanyId(rows[0].id);
  }

  async function loadJournals(id = companyId) {
    if (!id) return;
    setLoading(true); setError('');
    try { setJournals(await api<JournalRow[]>(`/api/journals/recent?companyId=${encodeURIComponent(id)}`)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Gagal memuat jurnal'); }
    finally { setLoading(false); }
  }

  async function openJournal(id: string) {
    setError('');
    try { setDetail(await api<JournalDetail>(`/api/journals/${id}`)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Gagal membuka jurnal'); }
  }

  async function setReady(id: string) {
    setError(''); setMessage('');
    try {
      await api(`/api/journals/${id}/ready`, { method:'POST' });
      setMessage('Jurnal selesai direview dan siap diposting.');
      await loadJournals(); await openJournal(id);
    } catch (err) { setError(err instanceof Error ? err.message : 'Gagal review jurnal'); }
  }

  async function postJournal(id: string) {
    setError(''); setMessage('');
    try {
      await api(`/api/journals/${id}/post`, { method:'POST' });
      setMessage('Jurnal berhasil diposting.');
      await loadJournals(); await openJournal(id);
    } catch (err) { setError(err instanceof Error ? err.message : 'Gagal posting jurnal'); }
  }

  useEffect(() => { void loadCompanies(); }, []);
  useEffect(() => { if (companyId) { setDetail(null); void loadJournals(companyId); } }, [companyId]);

  return <div className="page-content journal-center">
    {canReview && <AccountingCashInQueue companyId={companyId} onJournalCreated={() => { setMessage('Akun penerimaan sudah diarahkan dan draft jurnal berhasil dibuat.'); void loadJournals(); }}/>} 
    {canReview && <AccountingCashOutQueue companyId={companyId} onJournalCreated={() => { setMessage('Akun pengeluaran sudah diarahkan dan draft jurnal berhasil dibuat.'); void loadJournals(); }}/>} 

    <section className="section-card">
      <div className="section-title master-heading">
        <div><span className="eyebrow">ACCOUNTING WORKSPACE</span><h3>Review Jurnal</h3><p>Finance Verified → arah akun jika perlu → draft jurnal → review Accounting → posted. Jurnal posted tidak diubah langsung.</p></div>
        <div className="heading-actions"><select value={companyId} onChange={e => setCompanyId(e.target.value)}><option value="">Pilih company</option>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><button className="secondary-button" onClick={() => loadJournals()}><RefreshCw size={15}/> Refresh</button></div>
      </div>
      {message && <div className="success-banner"><CheckCircle2 size={18}/><span>{message}</span></div>}
      {error && <div className="form-error">{error}</div>}
      <div className="data-table-wrap">
        <table><thead><tr><th>No Jurnal</th><th>Tanggal</th><th>Sumber</th><th>Status</th><th className="numeric">Debit</th><th className="numeric">Kredit</th><th></th></tr></thead>
        <tbody>{journals.map(j => <tr key={j.id}><td><strong>{j.journal_number}</strong><small className="journal-meta">Engine v{j.engine_version || '-'}</small></td><td>{j.journal_date?.slice(0,10)}</td><td>{j.source_transaction_number || 'Manual'}<small className="journal-meta">{j.transaction_type || j.journal_type}</small></td><td><span className={j.status === 'POSTED' ? 'status-ok' : 'status-draft'}>{j.status}</span></td><td className="numeric">Rp{money(j.total_debit)}</td><td className="numeric">Rp{money(j.total_credit)}</td><td><button className="icon-button" onClick={() => openJournal(j.id)} title="Lihat jurnal"><Eye size={16}/></button></td></tr>)}</tbody></table>
        {!loading && journals.length === 0 && <div className="empty-state"><Landmark size={34}/><strong>Belum ada jurnal</strong><span>Verifikasi transaksi Finance untuk menghasilkan draft jurnal.</span></div>}
      </div>
    </section>

    {detail && <section className="section-card journal-detail-card">
      <div className="section-title master-heading"><div><span className="eyebrow">DETAIL JURNAL</span><h3>{detail.journal_number}</h3><p>{detail.source_transaction_number || detail.description} · {detail.status}</p></div><div className="heading-actions">
        {canReview && detail.status === 'DRAFT' && <button className="secondary-button" onClick={() => setReady(detail.id)}><FileCheck2 size={16}/> Review Selesai</button>}
        {canPost && detail.status === 'READY' && <button className="primary-button compact" onClick={() => postJournal(detail.id)}><CheckCircle2 size={16}/> Posting</button>}
      </div></div>
      <div className="data-table-wrap"><table><thead><tr><th>#</th><th>Akun</th><th>Keterangan</th><th>Location / Cost Center</th><th className="numeric">Debit</th><th className="numeric">Kredit</th></tr></thead><tbody>{detail.lines.map(line => <tr key={line.id}><td>{line.line_no}</td><td><code>{line.account_code}</code><br/><strong>{line.account_name}</strong></td><td>{line.description || '—'}{line.item_name && <small className="journal-meta">Item: {line.item_name}</small>}</td><td>{line.location_name || '—'}{line.cost_center_name && <small className="journal-meta">{line.cost_center_name}</small>}</td><td className="numeric">{Number(line.debit) ? `Rp${money(line.debit)}` : '—'}</td><td className="numeric">{Number(line.credit) ? `Rp${money(line.credit)}` : '—'}</td></tr>)}</tbody></table></div>
    </section>}
  </div>;
}
