import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { PlayCircle, ReceiptText, Send } from 'lucide-react';
import { api, messageOf } from '../api';
import { Modal } from '../components/Modal';
import { currentPeriod, dateID, money, todayISO } from '../format';
import { StatusBadge } from './Organization';
import type {
  BillingPreview, BillingRun, Hierarchy, InvoiceDetail, InvoiceRow, Permission, Session,
} from '../types';

type Tab = 'generate' | 'invoices' | 'runs';

export function Billing({ session }: { session: Session }) {
  const can = (permission: Permission) => session.permissions.includes(permission);

  const [tab, setTab] = useState<Tab>('generate');
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [form, setForm] = useState({
    unitId: '', academicYearId: '', periodLabel: currentPeriod(), invoiceDate: todayISO(), dueDate: '',
  });
  const [preview, setPreview] = useState<BillingPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [invoiceTotal, setInvoiceTotal] = useState(0);
  const [filters, setFilters] = useState({ unitId: '', status: '', periodLabel: '', q: '' });
  const [runs, setRuns] = useState<BillingRun[]>([]);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [detailError, setDetailError] = useState('');

  useEffect(() => {
    api<Hierarchy>('/api/v1/organization/hierarchy')
      .then(result => {
        setHierarchy(result);
        setForm(current => ({
          ...current,
          unitId: current.unitId || result.units[0]?.id || '',
          academicYearId: current.academicYearId || result.academicYears[0]?.id || '',
          dueDate: current.dueDate || addDaysISO(todayISO(), 14),
        }));
      })
      .catch(loadError => setError(messageOf(loadError)));
  }, []);

  const loadInvoices = useCallback(async () => {
    try {
      const params = new URLSearchParams({ pageSize: '100' });
      if (filters.unitId) params.set('unitId', filters.unitId);
      if (filters.status) params.set('status', filters.status);
      if (filters.periodLabel) params.set('periodLabel', filters.periodLabel);
      if (filters.q.trim()) params.set('q', filters.q.trim());
      const result = await api<{ rows: InvoiceRow[]; total: number }>(`/api/v1/invoices?${params.toString()}`);
      setInvoices(result.rows);
      setInvoiceTotal(result.total);
    } catch (loadError) { setError(messageOf(loadError)); }
  }, [filters]);

  const loadRuns = useCallback(async () => {
    try { setRuns(await api<BillingRun[]>('/api/v1/billing-runs')); } catch (loadError) { setError(messageOf(loadError)); }
  }, []);

  useEffect(() => { void loadInvoices(); }, [loadInvoices]);
  useEffect(() => { void loadRuns(); }, [loadRuns]);

  const units = hierarchy?.units || [];
  const years = hierarchy?.academicYears || [];

  async function runPreview(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setPreview(await api<BillingPreview>('/api/v1/billing-runs/preview', { method: 'POST', body: JSON.stringify(form) }));
    } catch (previewError) {
      setPreview(null);
      setError(messageOf(previewError));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ invoiceCount: number; totalAmount: number }>('/api/v1/billing-runs/generate', {
        method: 'POST', body: JSON.stringify(form),
      });
      setNotice(`Tagihan dibuat: ${result.invoiceCount} invoice, total ${money(result.totalAmount)}.`);
      setPreview(null);
      await Promise.all([loadInvoices(), loadRuns()]);
    } catch (generateError) {
      setError(messageOf(generateError));
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(invoiceId: string) {
    setDetailError('');
    try {
      setDetail(await api<InvoiceDetail>(`/api/v1/invoices/${invoiceId}`));
    } catch (detailLoadError) {
      setDetailError(messageOf(detailLoadError));
    }
  }

  async function voidInvoice(invoice: InvoiceRow) {
    const reason = window.prompt(`Alasan membatalkan ${invoice.invoice_number} (minimal 5 karakter):`) || '';
    if (reason.trim().length < 5) { setError('Alasan minimal 5 karakter.'); return; }
    try {
      await api(`/api/v1/invoices/${invoice.id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      setNotice('Tagihan dibatalkan (VOID).');
      await loadInvoices();
    } catch (voidError) {
      setError(messageOf(voidError));
    }
  }

  return (
    <div className="stack">
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'generate'} className={tab === 'generate' ? 'active' : ''} onClick={() => setTab('generate')} data-testid="billing-tab-generate">Buat Tagihan</button>
        <button type="button" role="tab" aria-selected={tab === 'invoices'} className={tab === 'invoices' ? 'active' : ''} onClick={() => setTab('invoices')} data-testid="billing-tab-invoices">Daftar Tagihan</button>
        <button type="button" role="tab" aria-selected={tab === 'runs'} className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')} data-testid="billing-tab-runs">Riwayat Generate</button>
      </div>

      {tab === 'generate' && (
        <section className="card">
          <div className="card-header">
            <div>
              <h3>Generate tagihan</h3>
              <p>Tagihan dibuat per unit + tahun ajaran + periode. Unit harus aktif dan kesiapan keuangan READY.</p>
            </div>
          </div>
          <div className="card-body">
            <form onSubmit={runPreview}>
              <div className="form-grid">
                <label className="field">Unit
                  <select className="select" value={form.unitId} onChange={event => { setForm({ ...form, unitId: event.target.value }); setPreview(null); }} required>
                    <option value="">Pilih…</option>
                    {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
                  </select>
                </label>
                <label className="field">Tahun ajaran
                  <select className="select" value={form.academicYearId} onChange={event => { setForm({ ...form, academicYearId: event.target.value }); setPreview(null); }} required>
                    <option value="">Pilih…</option>
                    {years.map(year => <option key={year.id} value={year.id}>{year.name}</option>)}
                  </select>
                </label>
                <label className="field">Periode
                  <input className="input" value={form.periodLabel} onChange={event => { setForm({ ...form, periodLabel: event.target.value }); setPreview(null); }} placeholder="2026-07" required />
                </label>
                <label className="field">Tanggal tagihan
                  <input type="date" className="input" value={form.invoiceDate} onChange={event => { setForm({ ...form, invoiceDate: event.target.value }); setPreview(null); }} required />
                </label>
                <label className="field">Jatuh tempo
                  <input type="date" className="input" value={form.dueDate} onChange={event => { setForm({ ...form, dueDate: event.target.value }); setPreview(null); }} required />
                </label>
              </div>
              <div className="modal-actions">
                <button type="submit" className="ghost-button" disabled={busy} data-testid="billing-preview">
                  <PlayCircle size={16} /> {busy ? 'Menghitung…' : 'Pratinjau'}
                </button>
                {preview && can('billing.generate') && !preview.alreadyGenerated && (
                  <button type="button" className="primary-button" onClick={generate} disabled={busy} data-testid="billing-generate">
                    <Send size={16} /> Terbitkan {preview.studentCount} Tagihan
                  </button>
                )}
              </div>
            </form>

            {preview && (
              <div className="stack" style={{ marginTop: 18 }}>
                {preview.alreadyGenerated && (
                  <div className="notice warning">Tagihan untuk unit dan periode ini sudah pernah dibuat. Generate ulang ditolak.</div>
                )}
                <div className="detail-grid">
                  <Info label="Unit" value={preview.unit.unit_name} />
                  <Info label="Periode" value={preview.periodLabel} />
                  <Info label="Siswa" value={`${preview.studentCount} siswa`} />
                  <Info label="Per siswa" value={money(preview.totalPerStudent)} />
                  <Info label="Grand total" value={money(preview.grandTotal)} />
                  <Info label="Angsuran" value={`${preview.installmentCount}×`} />
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Jenis</th><th>Nama</th><th style={{ textAlign: 'right' }}>Nominal</th><th>Frekuensi</th></tr></thead>
                    <tbody>
                      {preview.schemes.map(scheme => (
                        <tr key={scheme.feeTypeId}>
                          <td className="cell-muted">{scheme.feeCode}</td>
                          <td>{scheme.feeName}</td>
                          <td style={{ textAlign: 'right' }}>{money(scheme.amount)}</td>
                          <td>{scheme.frequency}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {tab === 'invoices' && (
        <section className="card">
          <div className="toolbar">
            <input className="input search" placeholder="Cari nomor / nama / NIS…" value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} />
            <select className="select" value={filters.unitId} onChange={event => setFilters({ ...filters, unitId: event.target.value })}>
              <option value="">Semua unit</option>
              {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
            </select>
            <select className="select" value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value })}>
              <option value="">Semua status</option>
              <option value="ISSUED">ISSUED</option>
              <option value="PARTIAL">PARTIAL</option>
              <option value="PAID">PAID</option>
            </select>
            <input className="input" placeholder="Periode" value={filters.periodLabel} onChange={event => setFilters({ ...filters, periodLabel: event.target.value })} />
            <div className="spacer" />
            <span className="cell-muted">{invoiceTotal} tagihan</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Nomor</th><th>Siswa</th><th>Unit</th><th>Periode</th><th>Jatuh tempo</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Sisa</th><th>Status</th><th style={{ textAlign: 'right' }}>Aksi</th></tr>
              </thead>
              <tbody>
                {invoices.map(invoice => (
                  <tr key={invoice.id}>
                    <td className="cell-muted">{invoice.invoice_number}</td>
                    <td>
                      <button type="button" className="link-button" onClick={() => openDetail(invoice.id)}>{invoice.full_name}</button>
                      <div className="cell-muted">{invoice.nis}</div>
                    </td>
                    <td>{invoice.unit_name}</td>
                    <td>{invoice.period_label}</td>
                    <td>{dateID(invoice.due_date)}</td>
                    <td style={{ textAlign: 'right' }}>{money(invoice.total_amount)}</td>
                    <td style={{ textAlign: 'right' }}>{money(invoice.outstanding)}</td>
                    <td><StatusBadge value={invoice.status} /></td>
                    <td>
                      <div className="cell-actions">
                        <button type="button" className="link-button" onClick={() => openDetail(invoice.id)}>
                          <ReceiptText size={14} /> Detail
                        </button>
                        {can('invoice.void') && invoice.status !== 'VOID' && Number(invoice.paid_amount) === 0 && (
                          <button type="button" className="link-button danger" onClick={() => voidInvoice(invoice)}>Batalkan</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {invoices.length === 0 && <div className="table-empty">Belum ada tagihan.</div>}
          </div>
        </section>
      )}

      {tab === 'runs' && (
        <section className="card">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Tanggal</th><th>Unit</th><th>Periode</th><th>Invoice</th><th style={{ textAlign: 'right' }}>Total</th><th>Dibuat oleh</th></tr></thead>
              <tbody>
                {runs.map(run => (
                  <tr key={run.id}>
                    <td className="cell-muted">{dateID(run.created_at.slice(0, 10))}</td>
                    <td>{run.unit_name}</td>
                    <td>{run.period_label}</td>
                    <td>{run.invoice_count}</td>
                    <td style={{ textAlign: 'right' }}>{money(run.total_amount)}</td>
                    <td className="cell-muted">{run.created_by_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {runs.length === 0 && <div className="table-empty">Belum ada riwayat generate.</div>}
          </div>
        </section>
      )}

      {detail && (
        <Modal title={`${detail.invoice_number} — ${detail.full_name}`} onClose={() => setDetail(null)} maxWidth={780}>
          {detailError && <div className="form-error" style={{ marginBottom: 12 }}>{detailError}</div>}
          <div className="stack">
            <div className="detail-grid">
              <Info label="Unit" value={detail.unit_name} />
              <Info label="Periode" value={detail.period_label} />
              <Info label="Tanggal" value={dateID(detail.invoice_date)} />
              <Info label="Jatuh tempo" value={dateID(detail.due_date)} />
              <Info label="Total" value={money(detail.total_amount)} />
              <Info label="Sisa" value={money(detail.outstanding)} />
              <Info label="Status" value={<StatusBadge value={detail.status} />} />
              <Info label="Wali" value={detail.guardian_name || '—'} />
            </div>

            <section>
              <h4 style={{ marginBottom: 8 }}>Rincian</h4>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Deskripsi</th><th style={{ textAlign: 'right' }}>Nominal</th></tr></thead>
                  <tbody>
                    {detail.lines.map(line => (
                      <tr key={line.id}>
                        <td>{line.description}</td>
                        <td style={{ textAlign: 'right' }}>{money(line.amount)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td className="cell-strong">Total</td>
                      <td style={{ textAlign: 'right' }} className="cell-strong">{money(detail.total_amount)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h4 style={{ marginBottom: 8 }}>Angsuran</h4>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>#</th><th>Jatuh tempo</th><th style={{ textAlign: 'right' }}>Nominal</th><th>Status</th></tr></thead>
                  <tbody>
                    {detail.installments.map(installment => (
                      <tr key={installment.id}>
                        <td>{installment.sequence}</td>
                        <td>{dateID(installment.due_date)}</td>
                        <td style={{ textAlign: 'right' }}>{money(installment.amount)}</td>
                        <td><StatusBadge value={installment.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {detail.status === 'VOID' && detail.void_reason && (
              <div className="form-error">Dibatalkan: {detail.void_reason}</div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="cell-muted" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 13.5, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function addDaysISO(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
