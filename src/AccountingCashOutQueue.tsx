import { useEffect, useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { api } from './api';

type Account={ id:string;code:string;name:string;account_type:string };
type PendingLine={ id:string;line_no:number;description:string;amount:string;location_name?:string;cost_center_name?:string };
type PendingCashOut={ id:string;transaction_number:string;transaction_date:string;reference_number:string|null;payee_name:string|null;notes:string|null;grand_total:string;location_name?:string;financial_account_name?:string;attachment_count:number;lines:PendingLine[] };
const money=(value:string|number)=>Number(value||0).toLocaleString('id-ID',{ maximumFractionDigits:0 });

export function AccountingCashOutQueue({ companyId,onJournalCreated }:{ companyId:string;onJournalCreated:()=>void }) {
  const [pending,setPending]=useState<PendingCashOut[]>([]);
  const [accounts,setAccounts]=useState<Account[]>([]);
  const [assignments,setAssignments]=useState<Record<string,string>>({});
  const [savingId,setSavingId]=useState('');
  const [error,setError]=useState('');

  async function load() {
    if (!companyId) { setPending([]);setAccounts([]);return; }
    setError('');
    try {
      const [p,a]=await Promise.all([
        api<PendingCashOut[]>(`/api/accounting-cash-outs/pending?companyId=${encodeURIComponent(companyId)}`),
        api<Account[]>(`/api/master/accounts?companyId=${encodeURIComponent(companyId)}`),
      ]);
      setPending(p);setAccounts(a);
    } catch (err) { setError(err instanceof Error?err.message:'Gagal memuat antrean arah akun'); }
  }

  useEffect(()=>{ setAssignments({});void load(); },[companyId]);

  async function direct(tx:PendingCashOut) {
    const txAssignments=tx.lines.map(line=>({ lineId:line.id,accountId:assignments[line.id]||'' }));
    if (txAssignments.some(x=>!x.accountId)) return setError('Pilih akun untuk seluruh baris pengeluaran sebelum membuat jurnal.');
    setSavingId(tx.id);setError('');
    try {
      await api(`/api/accounting-cash-outs/${tx.id}/direct`,{ method:'POST',body:JSON.stringify({ assignments:txAssignments }) });
      setAssignments(current=>{ const next={...current};tx.lines.forEach(line=>delete next[line.id]);return next; });
      await load();onJournalCreated();
    } catch (err) { setError(err instanceof Error?err.message:'Gagal mengarahkan akun'); }
    finally { setSavingId(''); }
  }

  if (!companyId) return null;
  return <section className="section-card account-direction-box">
    <div className="account-direction-head"><div><span className="eyebrow">PERLU JUDGEMENT ACCOUNTING</span><h3>Pengeluaran Operasional Belum Diarahkan Akun</h3><p>Client tidak memilih COA. Tim Akuntakita memilih akun per baris, lalu sistem membentuk draft jurnal.</p></div><button className="secondary-button compact" onClick={()=>load()}><RefreshCw size={15}/> Refresh</button></div>
    {error&&<div className="form-error">{error}</div>}
    {pending.map(tx=><div className="section-card" key={tx.id}>
      <div className="account-direction-head"><div><span className="pending-account-badge">PERLU ARAH AKUN</span><h3>{tx.transaction_number}</h3><p>{tx.transaction_date?.slice(0,10)} · {tx.payee_name||'Tanpa penerima'} · {tx.financial_account_name||'Kas/Bank'} · {tx.location_name||'—'}</p></div><div className="cash-out-total"><span>Total</span><strong>Rp{money(tx.grand_total)}</strong></div></div>
      <div className="data-table-wrap"><table className="account-direction-table"><thead><tr><th>#</th><th>Keperluan</th><th>Location / Cost Center</th><th className="numeric">Nominal</th><th>Arahkan ke Akun</th></tr></thead><tbody>{tx.lines.map(line=><tr key={line.id}><td>{line.line_no}</td><td><strong>{line.description}</strong></td><td>{line.location_name||tx.location_name||'—'}{line.cost_center_name&&<small className="journal-meta">{line.cost_center_name}</small>}</td><td className="numeric">Rp{money(line.amount)}</td><td><select value={assignments[line.id]||''} onChange={e=>setAssignments(current=>({...current,[line.id]:e.target.value}))}><option value="">Pilih akun...</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.code} — {a.name} [{a.account_type}]</option>)}</select></td></tr>)}</tbody></table></div>
      <div className="modal-actions"><button className="primary-button compact" disabled={savingId===tx.id} onClick={()=>direct(tx)}>{savingId===tx.id?'Membuat jurnal...':<>Arahkan Akun & Buat Draft Jurnal <ArrowRight size={15}/></>}</button></div>
    </div>)}
    {pending.length===0&&!error&&<div className="empty-state"><strong>Tidak ada transaksi yang menunggu arah akun</strong><span>Pengeluaran operasional Finance Verified akan muncul di sini.</span></div>}
  </section>;
}
