import { useCallback, useEffect, useState } from 'react';
import { Landmark } from 'lucide-react';
import { api, messageOf } from '../api';
import { dateID, money } from '../format';
import { StatusBadge } from './Organization';
import type { BankBalance, BankMutation, Hierarchy, Session } from '../types';

export function CashBank({ session }: { session: Session }) {
  const [balances, setBalances] = useState<BankBalance[]>([]);
  const [mutations, setMutations] = useState<BankMutation[]>([]);
  const [totals, setTotals] = useState({ in: 0, out: 0 });
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [filters, setFilters] = useState({ bankAccountId: '', from: '', to: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const loadBalances = useCallback(async () => {
    try { setBalances(await api<BankBalance[]>('/api/v1/cash-bank/balances')); } catch (loadError) { setError(messageOf(loadError)); }
  }, []);

  const loadMutations = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ pageSize: '100' });
      if (filters.bankAccountId) params.set('bankAccountId', filters.bankAccountId);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      const result = await api<{ rows: BankMutation[]; totals: { in: number; out: number } }>(`/api/v1/cash-bank/mutations?${params.toString()}`);
      setMutations(result.rows);
      setTotals(result.totals);
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { void loadBalances(); }, [loadBalances]);
  useEffect(() => { void loadMutations(); }, [loadMutations]);
  useEffect(() => { api<Hierarchy>('/api/v1/organization/hierarchy').then(setHierarchy).catch(() => undefined); }, []);

  const totalBalance = balances.reduce((sum, account) => sum + account.balance, 0);

  return (
    <div className="stack">
      {error && <div className="form-error">{error}</div>}

      <div className="metric-grid">
        <div className="metric-card">
          <div className="metric-icon"><Landmark size={20} /></div>
          <div><strong>{money(totalBalance)}</strong><span>Total saldo kas & bank</span></div>
        </div>
        <div className="metric-card">
          <div><strong>{money(totals.in)}</strong><span>Mutasi masuk (terfilter)</span></div>
        </div>
        <div className="metric-card">
          <div><strong>{money(totals.out)}</strong><span>Mutasi keluar (terfilter)</span></div>
        </div>
        <div className="metric-card">
          <div><strong>{balances.length}</strong><span>Rekening</span></div>
        </div>
      </div>

      <section className="card">
        <div className="card-header"><div><h3>Saldo per rekening</h3><p>Dihitung dari mutasi penerimaan dan pembatalan</p></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Bank</th><th>Nomor</th><th>Pemilik</th><th>Jenis</th><th>Status</th><th style={{ textAlign: 'right' }}>Masuk</th><th style={{ textAlign: 'right' }}>Keluar</th><th style={{ textAlign: 'right' }}>Saldo</th></tr></thead>
            <tbody>
              {balances.map(account => (
                <tr key={account.id}>
                  <td className="cell-strong">{account.bank_name}</td>
                  <td className="cell-muted">{account.account_number}</td>
                  <td>{account.account_holder}</td>
                  <td><span className={`badge ${account.account_usage === 'CENTRAL' ? 'info' : 'brand'}`}>{account.account_usage}</span></td>
                  <td><StatusBadge value={account.status} /></td>
                  <td style={{ textAlign: 'right' }}>{money(account.total_in)}</td>
                  <td style={{ textAlign: 'right' }}>{money(account.total_out)}</td>
                  <td style={{ textAlign: 'right' }} className="cell-strong">{money(account.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {balances.length === 0 && <div className="table-empty">Belum ada rekening.</div>}
        </div>
      </section>

      <section className="card">
        <div className="toolbar">
          <select className="select" value={filters.bankAccountId} onChange={event => setFilters({ ...filters, bankAccountId: event.target.value })}>
            <option value="">Semua rekening</option>
            {balances.map(account => <option key={account.id} value={account.id}>{account.bank_name} — {account.account_number}</option>)}
          </select>
          <input type="date" className="input" value={filters.from} onChange={event => setFilters({ ...filters, from: event.target.value })} />
          <input type="date" className="input" value={filters.to} onChange={event => setFilters({ ...filters, to: event.target.value })} />
          <div className="spacer" />
          <span className="cell-muted">{mutations.length} mutasi</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Tanggal</th><th>Rekening</th><th>Unit</th><th>Arah</th><th style={{ textAlign: 'right' }}>Nominal</th><th>Sumber</th><th>Keterangan</th></tr></thead>
            <tbody>
              {mutations.map(mutation => (
                <tr key={mutation.id}>
                  <td>{dateID(mutation.mutation_date)}</td>
                  <td>
                    <strong>{mutation.bank_name}</strong>
                    <div className="cell-muted">{mutation.account_number}</div>
                  </td>
                  <td>{mutation.unit_name || '—'}</td>
                  <td>
                    <span className={`badge ${mutation.direction === 'IN' ? 'success' : 'danger'}`}>
                      {mutation.direction === 'IN' ? 'Masuk' : 'Keluar'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{money(mutation.amount)}</td>
                  <td className="cell-muted">{mutation.source_type}</td>
                  <td className="cell-muted">{mutation.description || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="table-empty">Memuat mutasi…</div>}
          {!loading && mutations.length === 0 && <div className="table-empty">Belum ada mutasi pada filter ini.</div>}
        </div>
      </section>

      <div className="notice">
        Role Anda: <strong>{session.user.role}</strong>. Saldo bersumber dari mutasi penerimaan; modul pengeluaran menyusul.
      </div>
    </div>
  );
}
