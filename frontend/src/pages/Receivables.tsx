import { useCallback, useEffect, useState } from 'react';
import { api, messageOf } from '../api';
import { dateID, money } from '../format';
import { StatusBadge } from './Organization';
import type { Hierarchy, ReceivableSummary, Session } from '../types';

const BUCKET_LABEL: Record<string, string> = {
  CURRENT: 'Belum jatuh tempo',
  D1_30: '1–30 hari',
  D31_60: '31–60 hari',
  D61_PLUS: '> 60 hari',
};

export function Receivables({ session }: { session: Session }) {
  const [data, setData] = useState<ReceivableSummary | null>(null);
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [unitId, setUnitId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (unitId) params.set('unitId', unitId);
      setData(await api<ReceivableSummary>(`/api/v1/receivables?${params.toString()}`));
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [unitId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api<Hierarchy>('/api/v1/organization/hierarchy').then(setHierarchy).catch(() => undefined); }, []);

  const units = hierarchy?.units || [];

  return (
    <div className="stack">
      {error && <div className="form-error">{error}</div>}

      <section className="card">
        <div className="toolbar">
          <select className="select" value={unitId} onChange={event => setUnitId(event.target.value)}>
            <option value="">Semua unit</option>
            {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
          </select>
          <div className="spacer" />
          <span className="cell-muted">
            {data ? `${data.invoiceCount} tagihan · per ${dateID(data.today)}` : 'memuat…'}
          </span>
        </div>
        <div className="card-body">
          <div className="metric-grid">
            <div className="metric-card">
              <div><strong>{money(data?.totalOutstanding || 0)}</strong><span>Total piutang</span></div>
            </div>
            <div className="metric-card">
              <div><strong>{money(data?.aging.CURRENT || 0)}</strong><span>Belum jatuh tempo</span></div>
            </div>
            <div className="metric-card">
              <div><strong>{money(data?.aging.D1_30 || 0)}</strong><span>1–30 hari</span></div>
            </div>
            <div className="metric-card">
              <div><strong>{money((data?.aging.D31_60 || 0) + (data?.aging.D61_PLUS || 0))}</strong><span>&gt; 30 hari</span></div>
            </div>
          </div>
        </div>
      </section>

      <div className="grid-2">
        <section className="card">
          <div className="card-header"><div><h3>Piutang per unit</h3><p>Total sisa tagihan yang belum dibayar</p></div></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Unit</th><th>Tagihan</th><th style={{ textAlign: 'right' }}>Sisa</th></tr></thead>
              <tbody>
                {(data?.byUnit || []).map(row => (
                  <tr key={row.unit_id}>
                    <td className="cell-strong">{row.unit_name}</td>
                    <td>{row.invoices}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data && data.byUnit.length === 0 && <div className="table-empty">Tidak ada piutang.</div>}
          </div>
        </section>

        <section className="card">
          <div className="card-header"><div><h3>Aging</h3><p>Umur piutang berdasarkan jatuh tempo</p></div></div>
          <div className="card-body stack">
            {(['CURRENT', 'D1_30', 'D31_60', 'D61_PLUS'] as const).map(bucket => {
              const value = data?.aging[bucket] || 0;
              const percent = data?.totalOutstanding ? Math.round((value / data.totalOutstanding) * 100) : 0;
              return (
                <div key={bucket} className="stack" style={{ gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span>{BUCKET_LABEL[bucket]}</span>
                    <span className="cell-muted">{money(value)} · {percent}%</span>
                  </div>
                  <div className="progress"><span style={{ width: `${percent}%` }} /></div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-header"><div><h3>Daftar piutang</h3><p>Tagihan berstatus ISSUED / PARTIAL yang belum lunas</p></div></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Nomor</th><th>Siswa</th><th>Unit</th><th>Periode</th><th>Jatuh tempo</th><th>Umur</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Sisa</th><th>Status</th></tr>
            </thead>
            <tbody>
              {(data?.items || []).map(item => (
                <tr key={item.id}>
                  <td className="cell-muted">{item.invoice_number}</td>
                  <td>
                    <strong>{item.full_name}</strong>
                    <div className="cell-muted">{item.nis}</div>
                  </td>
                  <td>{item.unit_name}</td>
                  <td>{item.period_label}</td>
                  <td>{dateID(item.due_date)}</td>
                  <td>
                    <span className={`badge ${item.aging_bucket === 'CURRENT' ? 'success' : item.aging_bucket === 'D1_30' ? 'warning' : 'danger'}`}>
                      {item.days_overdue > 0 ? `${item.days_overdue} hari` : 'belum jatuh tempo'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{money(item.total_amount)}</td>
                  <td style={{ textAlign: 'right' }} className="cell-strong">{money(item.outstanding)}</td>
                  <td><StatusBadge value={item.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="table-empty">Memuat piutang…</div>}
          {!loading && data && data.items.length === 0 && <div className="table-empty">Tidak ada piutang pada filter ini.</div>}
        </div>
      </section>

      <div className="notice">
        Role Anda: <strong>{session.user.role}</strong>. Daftar hanya memuat unit yang menjadi kewenangan Anda.
      </div>
    </div>
  );
}
