import { useCallback, useEffect, useState } from 'react';
import { api, messageOf } from '../api';
import { Modal } from '../components/Modal';
import { formatDateTime } from './Dashboard';
import type { AuditLog } from '../types';

const ENTITY_TYPES = [
  'LEGAL_ENTITY', 'EDUCATION_LEVEL', 'SCHOOL_GROUP', 'OFFICIAL_SCHOOL', 'SCHOOL_LOCATION',
  'ACADEMIC_YEAR', 'ORGANIZATION_UNIT', 'UNIT_BANK_ASSIGNMENT', 'BANK_ACCOUNT', 'USER',
];

export function Audit() {
  const [rows, setRows] = useState<AuditLog[]>([]);
  const [entityType, setEntityType] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<AuditLog | null>(null);
  const [detailError, setDetailError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (entityType) params.set('entityType', entityType);
      setRows(await api<AuditLog[]>(`/api/v1/audit-logs?${params.toString()}`));
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [entityType]);

  useEffect(() => { void load(); }, [load]);

  async function openDetail(log: AuditLog) {
    setDetailError('');
    try {
      setDetail(await api<AuditLog>(`/api/v1/audit-logs/${log.id}`));
    } catch (loadError) {
      setDetailError(messageOf(loadError));
    }
  }

  return (
    <div className="stack">
      {error && <div className="form-error">{error}</div>}

      <section className="card">
        <div className="toolbar">
          <select className="select" value={entityType} onChange={event => setEntityType(event.target.value)} data-testid="audit-filter">
            <option value="">Semua entitas</option>
            {ENTITY_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
          </select>
          <div className="spacer" />
          <span className="cell-muted">{rows.length} entri terakhir</span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Waktu</th><th>Aksi</th><th>Entitas</th><th>Pengguna</th><th>Alasan</th></tr>
            </thead>
            <tbody>
              {rows.map(log => (
                <tr key={log.id} onClick={() => openDetail(log)} style={{ cursor: 'pointer' }}>
                  <td className="cell-muted">{formatDateTime(log.created_at)}</td>
                  <td><span className="badge neutral">{log.action}</span></td>
                  <td>{log.entity_type}</td>
                  <td>{log.user_name || '—'}</td>
                  <td className="cell-muted">{log.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && rows.length === 0 && <div className="table-empty">Belum ada aktivitas.</div>}
          {loading && <div className="table-empty">Memuat audit…</div>}
        </div>
      </section>

      {detail && (
        <Modal title={`Audit #${detail.id} — ${detail.action}`} onClose={() => setDetail(null)} maxWidth={820}>
          {detailError && <div className="form-error">{detailError}</div>}
          <div className="detail-grid" style={{ marginBottom: 16 }}>
            <Detail label="Waktu" value={formatDateTime(detail.created_at)} />
            <Detail label="Pengguna" value={detail.user_name || detail.user_id || '—'} />
            <Detail label="Entitas" value={`${detail.entity_type} · ${detail.entity_id}`} />
            <Detail label="Alasan" value={detail.reason || '—'} />
          </div>
          <div className="stack">
            <JsonBlock title="Sebelum" value={detail.before_data} />
            <JsonBlock title="Sesudah" value={detail.after_data} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="cell-muted" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 13.5, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="field" style={{ marginBottom: 6 }}>{title}</div>
      <pre className="json-block">{value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
