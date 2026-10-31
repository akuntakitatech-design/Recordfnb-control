import { useEffect, useState } from 'react';
import { Building2, Landmark, ShieldCheck, UsersRound } from 'lucide-react';
import { api, messageOf } from '../api';
import type { DashboardData, Session } from '../types';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Aktif',
  INACTIVE: 'Nonaktif',
  ARCHIVED: 'Arsip',
  READY: 'Siap',
  NOT_CONFIGURED: 'Belum siap',
  BLOCKED: 'Terblokir',
};

export function Dashboard({ session }: { session: Session }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<DashboardData>('/api/v1/dashboard').then(setData).catch(loadError => setError(messageOf(loadError)));
  }, []);

  if (error) return <div className="card"><div className="table-empty">{error}</div></div>;
  if (!data) return <div className="card"><div className="table-empty">Memuat ringkasan…</div></div>;

  const statusCount = (status: string) =>
    Number(data.unitsByStatus.find(row => row.status === status)?.total || 0);
  const financeCount = (status: string) =>
    Number(data.financeByStatus.find(row => row.status === status)?.total || 0);
  const readyRatio = data.unitsTotal ? Math.round((data.readyUnits / data.unitsTotal) * 100) : 0;

  return (
    <div className="stack">
      <div className="metric-grid">
        <div className="metric-card">
          <div className="metric-icon"><Building2 size={20} /></div>
          <div><strong>{data.unitsTotal}</strong><span>Unit / cabang</span></div>
        </div>
        <div className="metric-card">
          <div className="metric-icon"><ShieldCheck size={20} /></div>
          <div><strong>{statusCount('ACTIVE')}</strong><span>Aktif · {statusCount('DRAFT')} draft</span></div>
        </div>
        <div className="metric-card">
          <div className="metric-icon"><Landmark size={20} /></div>
          <div><strong>{data.counts.banks}</strong><span>Rekening aktif</span></div>
        </div>
        <div className="metric-card">
          <div className="metric-icon"><UsersRound size={20} /></div>
          <div><strong>{data.counts.users}</strong><span>Pengguna aktif</span></div>
        </div>
      </div>

      <div className="grid-2">
        <section className="card">
          <div className="card-header">
            <div>
              <h3>Kesiapan keuangan unit</h3>
              <p>{data.readyUnits} dari {data.unitsTotal} unit siap menjalankan proses finansial</p>
            </div>
            <span className="badge brand">{readyRatio}% siap</span>
          </div>
          <div className="card-body stack">
            <div className="progress"><span style={{ width: `${readyRatio}%` }} /></div>
            <div className="legend">
              <span><i className="dot HADIR" /> Siap: <strong>{financeCount('READY')}</strong></span>
              <span><i className="dot SAKIT" /> Belum siap: <strong>{financeCount('NOT_CONFIGURED')}</strong></span>
              <span><i className="dot ALPA" /> Terblokir: <strong>{financeCount('BLOCKED')}</strong></span>
            </div>
            {session.unitScope && (
              <div className="notice">
                Akses Anda dibatasi pada {session.unitScope.length} unit. Data di luar scope tidak ditampilkan.
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <div>
              <h3>Perlu konfigurasi</h3>
              <p>Unit yang belum siap secara keuangan</p>
            </div>
          </div>
          <div className="card-body stack">
            {data.needConfig.length === 0 && <div className="table-empty">Semua unit sudah siap.</div>}
            {data.needConfig.map(unit => (
              <div key={unit.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                <div>
                  <strong style={{ fontSize: 13.5 }}>{unit.unit_name}</strong>
                  <div className="cell-muted">{unit.unit_code}</div>
                </div>
                <span className={`badge ${unit.finance_status === 'BLOCKED' ? 'danger' : 'warning'}`}>
                  {STATUS_LABEL[unit.finance_status] || unit.finance_status}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-header">
          <div>
            <h3>Aktivitas terakhir</h3>
            <p>Jejak audit perubahan konfigurasi</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Waktu</th><th>Aksi</th><th>Entitas</th><th>Pengguna</th></tr>
            </thead>
            <tbody>
              {data.recentAudit.map(log => (
                <tr key={log.id}>
                  <td className="cell-muted">{formatDateTime(log.created_at)}</td>
                  <td><span className="badge neutral">{log.action}</span></td>
                  <td>{log.entity_type}</td>
                  <td>{log.user_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.recentAudit.length === 0 && <div className="table-empty">Belum ada aktivitas.</div>}
        </div>
      </section>
    </div>
  );
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}
