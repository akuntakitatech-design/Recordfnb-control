import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api, messageOf } from '../api';
import { StatusBadge } from './Organization';
import type { Readiness as ReadinessType, Session, Unit } from '../types';

export function Readiness({ session }: { session: Session }) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [checks, setChecks] = useState<Record<string, ReadinessType>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await api<{ rows: Unit[] }>('/api/v1/organization/units?pageSize=100');
        if (!active) return;
        setUnits(result.rows);
        const entries = await Promise.all(result.rows.map(async unit => {
          const readiness = await api<ReadinessType>(`/api/v1/organization/units/${unit.id}/readiness`);
          return [unit.id, readiness] as const;
        }));
        if (!active) return;
        setChecks(Object.fromEntries(entries));
      } catch (loadError) {
        if (active) setError(messageOf(loadError));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  return (
    <div className="stack">
      <div className="notice">
        Kesiapan keuangan dihitung dari kelengkapan identitas unit, mapping akun, dan rekening
        yang aktif serta terverifikasi. Role Anda: <strong>{session.user.role}</strong>.
      </div>
      {error && <div className="form-error">{error}</div>}

      <section className="card">
        <div className="card-header">
          <div>
            <h3>Checklist per unit</h3>
            <p>Klik unit untuk melihat rincian kekurangan konfigurasi.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 34 }} />
                <th>Unit</th>
                <th>Mode rekening</th>
                <th>Status</th>
                <th>Kekurangan</th>
              </tr>
            </thead>
            <tbody>
              {units.map(unit => {
                const readiness = checks[unit.id];
                const open = expanded === unit.id;
                return (
                  <Fragment key={unit.id}>
                    <tr key={unit.id} onClick={() => setExpanded(open ? null : unit.id)} style={{ cursor: 'pointer' }}>
                      <td>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
                      <td>
                        <strong>{unit.unit_name}</strong>
                        <div className="cell-muted">{unit.unit_code} · {unit.level_name}</div>
                      </td>
                      <td>{readiness?.accountMode || '—'}</td>
                      <td><StatusBadge value={readiness?.status || unit.finance_status} /></td>
                      <td className="cell-muted">{readiness ? `${readiness.missingFields.length} item` : '…'}</td>
                    </tr>
                    {open && (
                      <tr key={`${unit.id}-detail`}>
                        <td />
                        <td colSpan={4}>
                          <div className="checklist">
                            {(readiness?.checks || []).map(check => (
                              <div key={check.field} className={`checklist-item ${check.ok ? 'ok' : 'missing'}`}>
                                <span>{check.ok ? '✓' : '✕'}</span>
                                <div>
                                  <strong>{check.label}</strong>
                                  <div className="cell-muted">{check.ok ? 'Siap' : 'Belum diisi'}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {loading && <div className="table-empty">Menghitung kesiapan…</div>}
          {!loading && units.length === 0 && <div className="table-empty">Belum ada unit.</div>}
        </div>
      </section>
    </div>
  );
}
