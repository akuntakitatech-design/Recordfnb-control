import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, TrendingDown, TrendingUp, Scale } from 'lucide-react';
import { api, messageOf } from '../api';
import { dateID, money } from '../format';
import { StatusBadge } from './Organization';
import type {
  Drilldown, Hierarchy, ReportActivity, ReportCashFlow, ReportOverview, ReportPosition, Session,
} from '../types';

type Tab = 'overview' | 'position' | 'activity' | 'cashflow' | 'drilldown';

const METRICS: { id: string; label: string }[] = [
  { id: 'billed', label: 'Tagihan' },
  { id: 'collected', label: 'Penerimaan' },
  { id: 'expense', label: 'Pengeluaran' },
  { id: 'outstanding', label: 'Piutang' },
];

export function Reports({ session }: { session: Session }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<ReportOverview | null>(null);
  const [position, setPosition] = useState<ReportPosition | null>(null);
  const [activity, setActivity] = useState<ReportActivity | null>(null);
  const [cashflow, setCashflow] = useState<ReportCashFlow | null>(null);
  const [drill, setDrill] = useState<Drilldown | null>(null);
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [filters, setFilters] = useState({ from: '', to: '', unitId: '' });
  const [metric, setMetric] = useState('billed');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const params = useCallback(() => {
    const search = new URLSearchParams();
    if (filters.from) search.set('from', filters.from);
    if (filters.to) search.set('to', filters.to);
    if (filters.unitId) search.set('unitId', filters.unitId);
    return search.toString();
  }, [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = params();
      const [overviewResult, positionResult, activityResult, cashflowResult, drillResult] = await Promise.all([
        api<ReportOverview>(`/api/v1/reports/overview?${query}`),
        api<ReportPosition>(`/api/v1/reports/position?asOf=${filters.to}`),
        api<ReportActivity>(`/api/v1/reports/activity?${query}`),
        api<ReportCashFlow>(`/api/v1/reports/cash-flow?${query}`),
        api<Drilldown>(`/api/v1/reports/drilldown?${query}&metric=${metric}&pageSize=50`),
      ]);
      setOverview(overviewResult);
      setPosition(positionResult);
      setActivity(activityResult);
      setCashflow(cashflowResult);
      setDrill(drillResult);
      setFilters(current => ({
        ...current,
        from: current.from || overviewResult.from,
        to: current.to || overviewResult.to,
      }));
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [params, metric, filters.to]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<Hierarchy>('/api/v1/organization/hierarchy').then(setHierarchy).catch(() => undefined);
  }, []);

  const units = hierarchy?.units || [];
  const totals = overview?.totals;

  return (
    <div className="stack">
      {error && <div className="form-error">{error}</div>}

      <section className="card">
        <div className="toolbar">
          <select className="select" value={filters.unitId}
            onChange={event => setFilters({ ...filters, unitId: event.target.value })}>
            <option value="">Seluruh yayasan</option>
            {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
          </select>
          <input type="date" className="input" value={filters.from}
            onChange={event => setFilters({ ...filters, from: event.target.value })} />
          <input type="date" className="input" value={filters.to}
            onChange={event => setFilters({ ...filters, to: event.target.value })} />
          <div className="spacer" />
          <span className="cell-muted">Role: {session.user.role}</span>
        </div>
      </section>

      {totals && (
        <div className="metric-grid">
          <div className="metric-card">
            <div className="metric-icon"><TrendingUp size={20} /></div>
            <div><strong>{money(totals.billed)}</strong><span>Tagihan diterbitkan</span></div>
          </div>
          <div className="metric-card">
            <div><strong>{money(totals.collected)}</strong><span>Penerimaan diterima</span></div>
          </div>
          <div className="metric-card">
            <div className="metric-icon"><TrendingDown size={20} /></div>
            <div><strong>{money(totals.expenses)}</strong><span>Pengeluaran dibayar</span></div>
          </div>
          <div className="metric-card">
            <div><strong>{money(totals.surplus)}</strong><span>Surplus kas (terima − keluar)</span></div>
          </div>
          <div className="metric-card">
            <div><strong>{money(totals.outstanding)}</strong><span>Piutang berjalan</span></div>
          </div>
          <div className="metric-card">
            <div><strong>{totals.students}</strong><span>Siswa aktif</span></div>
          </div>
        </div>
      )}

      <section className="card">
        <div className="toolbar">
          {([
            ['overview', 'Ringkasan'],
            ['position', 'Posisi Keuangan'],
            ['activity', 'Aktivitas'],
            ['cashflow', 'Arus Kas'],
            ['drilldown', 'Drill-down'],
          ] as [Tab, string][]).map(([id, label]) => (
            <button key={id} type="button" className={tab === id ? 'primary-button' : 'ghost-button'}
              onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
      </section>

      {tab === 'overview' && overview && (
        <>
          <section className="card">
            <div className="card-header">
              <div><h3>Per cabang</h3><p>{dateID(overview.from)} — {dateID(overview.to)}</p></div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Cabang</th><th>Jenjang</th><th style={{ textAlign: 'right' }}>Siswa</th>
                    <th style={{ textAlign: 'right' }}>Tagihan</th>
                    <th style={{ textAlign: 'right' }}>Penerimaan</th>
                    <th style={{ textAlign: 'right' }}>Pengeluaran</th>
                    <th style={{ textAlign: 'right' }}>Surplus</th>
                    <th style={{ textAlign: 'right' }}>Piutang</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {overview.units.map(row => (
                    <tr key={row.unit_id}>
                      <td className="cell-strong">{row.unit_name}</td>
                      <td className="cell-muted">{row.level_code || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{row.students}</td>
                      <td style={{ textAlign: 'right' }}>{money(row.billed)}</td>
                      <td style={{ textAlign: 'right' }}>{money(row.collected)}</td>
                      <td style={{ textAlign: 'right' }}>{money(row.expenses)}</td>
                      <td style={{ textAlign: 'right' }}>{money(row.surplus)}</td>
                      <td style={{ textAlign: 'right' }}>{money(row.outstanding)}</td>
                      <td>
                        <button type="button" className="link-button"
                          onClick={() => {
                            setFilters({ ...filters, unitId: row.unit_id });
                            setMetric('billed');
                            setTab('drilldown');
                          }}>
                          Rinci <ChevronRight size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {overview.units.length === 0 && <div className="table-empty">Belum ada unit dalam akses Anda.</div>}
            </div>
          </section>

          <div className="grid-2">
            <section className="card">
              <div className="card-header"><div><h3>Per jenjang</h3><p>Perbandingan TK/SD</p></div></div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Jenjang</th><th style={{ textAlign: 'right' }}>Unit</th>
                      <th style={{ textAlign: 'right' }}>Penerimaan</th>
                      <th style={{ textAlign: 'right' }}>Pengeluaran</th>
                      <th style={{ textAlign: 'right' }}>Piutang</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.byLevel.map(row => (
                      <tr key={row.level_id || 'NONE'}>
                        <td className="cell-strong">{row.level_code} <span className="cell-muted">· {row.level_name}</span></td>
                        <td style={{ textAlign: 'right' }}>{row.units}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.collected)}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.expenses)}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.outstanding)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {overview.byLevel.length === 0 && <div className="table-empty">Belum ada data jenjang.</div>}
              </div>
            </section>

            <section className="card">
              <div className="card-header"><div><h3>Aging piutang</h3><p>Umur piutang berjalan</p></div></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Kelompok</th><th style={{ textAlign: 'right' }}>Nilai</th></tr></thead>
                  <tbody>
                    <tr><td>Belum jatuh tempo</td><td style={{ textAlign: 'right' }}>{money(overview.aging.CURRENT)}</td></tr>
                    <tr><td>1–30 hari</td><td style={{ textAlign: 'right' }}>{money(overview.aging.D1_30)}</td></tr>
                    <tr><td>31–60 hari</td><td style={{ textAlign: 'right' }}>{money(overview.aging.D31_60)}</td></tr>
                    <tr><td>&gt; 60 hari</td><td style={{ textAlign: 'right' }}>{money(overview.aging.D61_PLUS)}</td></tr>
                  </tbody>
                </table>
              </div>
              <div className="card-header" style={{ marginTop: 6 }}>
                <div><h3>Status closing</h3><p>Periode fiskal terakhir</p></div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Periode</th><th>Status</th></tr></thead>
                  <tbody>
                    {overview.closing.map(period => (
                      <tr key={period.name}>
                        <td className="cell-muted">{period.name}</td>
                        <td><StatusBadge value={period.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {overview.closing.length === 0 && <div className="table-empty">Belum ada periode.</div>}
              </div>
            </section>
          </div>
        </>
      )}

      {tab === 'position' && position && (
        <section className="card">
          <div className="card-header">
            <div><h3>Posisi keuangan</h3><p>Per {dateID(position.asOf)} — dari buku besar</p></div>
            <span className={`badge ${position.balanced ? 'success' : 'danger'}`}>
              <Scale size={14} /> {position.balanced ? 'SEIMBANG' : 'SELISIH'}
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Komponen</th><th style={{ textAlign: 'right' }}>Nilai</th></tr></thead>
              <tbody>
                <tr><td className="cell-strong">Aset (kas &amp; piutang)</td><td style={{ textAlign: 'right' }}>{money(position.assets)}</td></tr>
                <tr><td>Liabilitas (uang muka siswa)</td><td style={{ textAlign: 'right' }}>{money(position.liabilities)}</td></tr>
                <tr><td>Aset neto</td><td style={{ textAlign: 'right' }}>{money(position.equity)}</td></tr>
                <tr><td>Surplus periode berjalan</td><td style={{ textAlign: 'right' }}>{money(position.netIncome)}</td></tr>
                <tr><td className="cell-strong">Liabilitas + aset neto + surplus</td><td style={{ textAlign: 'right' }} className="cell-strong">{money(position.liabilitiesAndEquity)}</td></tr>
                <tr><td>Selisih</td><td style={{ textAlign: 'right' }}>{money(position.difference)}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="cell-muted" style={{ padding: 16 }}>
            Pendapatan tercatat {money(position.revenue)} dan beban {money(position.expense)}.
          </div>
        </section>
      )}

      {tab === 'activity' && activity && (
        <section className="card">
          <div className="card-header">
            <div><h3>Aktivitas (pendapatan &amp; beban)</h3><p>{dateID(activity.from)} — {dateID(activity.to)}</p></div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Akun</th><th>Tipe</th><th style={{ textAlign: 'right' }}>Nilai</th></tr>
              </thead>
              <tbody>
                {activity.items.map(row => (
                  <tr key={`${row.account_type}-${row.code}`}>
                    <td>{row.code} <span className="cell-muted">· {row.name}</span></td>
                    <td className="cell-muted">{row.account_type}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {activity.items.length === 0 && <div className="table-empty">Belum ada transaksi pada rentang ini.</div>}
          </div>
          <div className="toolbar" style={{ padding: 16 }}>
            <div className="spacer" />
            <span className="cell-muted">Pendapatan {money(activity.revenue)}</span>
            <span className="cell-muted">Beban {money(activity.expense)}</span>
            <span className="cell-strong">Surplus {money(activity.surplus)}</span>
          </div>
        </section>
      )}

      {tab === 'cashflow' && cashflow && (
        <section className="card">
          <div className="card-header">
            <div><h3>Arus kas</h3><p>{dateID(cashflow.from)} — {dateID(cashflow.to)}</p></div>
          </div>
          <div className="metric-grid" style={{ padding: 16 }}>
            <div className="metric-card"><div><strong>{money(cashflow.opening)}</strong><span>Saldo awal</span></div></div>
            <div className="metric-card"><div><strong>{money(cashflow.inflow)}</strong><span>Kas masuk</span></div></div>
            <div className="metric-card"><div><strong>{money(cashflow.outflow)}</strong><span>Kas keluar</span></div></div>
            <div className="metric-card"><div><strong>{money(cashflow.closing)}</strong><span>Saldo akhir</span></div></div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Sumber</th><th style={{ textAlign: 'right' }}>Perubahan kas</th></tr></thead>
              <tbody>
                {cashflow.movements.map(row => (
                  <tr key={row.source_type}>
                    <td>{row.label} <span className="cell-muted">· {row.source_type}</span></td>
                    <td style={{ textAlign: 'right' }}>{money(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cashflow.movements.length === 0 && <div className="table-empty">Belum ada mutasi kas pada rentang ini.</div>}
          </div>
        </section>
      )}

      {tab === 'drilldown' && (
        <section className="card">
          <div className="toolbar">
            <select className="select" value={metric} onChange={event => setMetric(event.target.value)}>
              {METRICS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <div className="spacer" />
            {drill && (
              <span className="cell-muted">
                {drill.total} dokumen · total {money(drill.sumAmount)}
              </span>
            )}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dokumen</th><th>Tanggal</th><th>Pihak</th><th>Referensi</th>
                  <th>Unit</th><th style={{ textAlign: 'right' }}>Nilai</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(drill?.rows || []).map(row => (
                  <tr key={row.id}>
                    <td className="cell-muted">{row.document_number}</td>
                    <td>{dateID(row.document_date)}</td>
                    <td>{row.party || '—'}</td>
                    <td className="cell-muted">{row.reference || '—'}</td>
                    <td>{row.unit_name}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.amount)}</td>
                    <td><StatusBadge value={row.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loading && (drill?.rows || []).length === 0 && (
              <div className="table-empty">Tidak ada dokumen pada filter ini.</div>
            )}
            {loading && <div className="table-empty">Memuat transaksi…</div>}
          </div>
        </section>
      )}
    </div>
  );
}
