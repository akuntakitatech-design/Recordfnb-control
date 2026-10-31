import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { api, messageOf } from '../api';
import { Modal } from '../components/Modal';
import { dateID, money, todayISO } from '../format';
import { StatusBadge } from './Organization';
import type {
  BankBalance, Hierarchy, InvoiceRow, Permission, ReceiptDetail, ReceiptRow, Session,
} from '../types';

type Selected = {
  invoiceId: string;
  invoiceNumber: string;
  studentName: string;
  nis: string;
  unitName: string;
  outstanding: number;
  amount: string;
};

export function Receipts({ session }: { session: Session }) {
  const can = (permission: Permission) => session.permissions.includes(permission);

  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [total, setTotal] = useState(0);
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [balances, setBalances] = useState<BankBalance[]>([]);
  const [filters, setFilters] = useState({ unitId: '', from: '', to: '', q: '', status: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    unitId: '', bankAccountId: '', receiptDate: todayISO(), method: 'TRANSFER',
    referenceNumber: '', payerName: '', notes: '', totalAmount: '',
  });
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [invoiceResults, setInvoiceResults] = useState<InvoiceRow[]>([]);
  const [selected, setSelected] = useState<Selected[]>([]);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const [detail, setDetail] = useState<ReceiptDetail | null>(null);
  const [detailError, setDetailError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ pageSize: '100' });
      if (filters.unitId) params.set('unitId', filters.unitId);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.q.trim()) params.set('q', filters.q.trim());
      if (filters.status) params.set('status', filters.status);
      const result = await api<{ rows: ReceiptRow[]; total: number }>(`/api/v1/receipts?${params.toString()}`);
      setRows(result.rows);
      setTotal(result.total);
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    api<Hierarchy>('/api/v1/organization/hierarchy')
      .then(result => {
        setHierarchy(result);
        setForm(current => ({
          ...current,
          unitId: current.unitId || result.units[0]?.id || '',
        }));
      })
      .catch(() => undefined);
    api<BankBalance[]>('/api/v1/cash-bank/balances').then(setBalances).catch(() => undefined);
  }, []);

  const units = hierarchy?.units || [];
  const accounts = balances.filter(account =>
    account.status === 'ACTIVE' && Boolean(account.verified_at)
    && (!form.unitId || (account.receipt_unit_ids || []).includes(form.unitId)),
  );
  const allocated = selected.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const totalAmount = Number(form.totalAmount || 0);
  const remaining = totalAmount - allocated;

  async function searchInvoices() {
    setInvoiceResults([]);
    try {
      const params = new URLSearchParams({ pageSize: '50' });
      if (form.unitId) params.set('unitId', form.unitId);
      if (invoiceSearch.trim()) params.set('q', invoiceSearch.trim());
      const result = await api<{ rows: InvoiceRow[] }>(`/api/v1/invoices?${params.toString()}`);
      setInvoiceResults(result.rows.filter(row => Number(row.outstanding) > 0));
    } catch (searchError) {
      setFormError(messageOf(searchError));
    }
  }

  function addInvoice(invoice: InvoiceRow) {
    if (selected.some(item => item.invoiceId === invoice.id)) return;
    setSelected(current => [...current, {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      studentName: invoice.full_name,
      nis: invoice.nis,
      unitName: invoice.unit_name,
      outstanding: Number(invoice.outstanding),
      amount: String(Number(invoice.outstanding)),
    }]);
    setInvoiceResults([]);
    setInvoiceSearch('');
  }

  function updateAmount(invoiceId: string, amount: string) {
    setSelected(current => current.map(item => item.invoiceId === invoiceId ? { ...item, amount } : item));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      const result = await api<{ receipt: ReceiptDetail }>('/api/v1/receipts', {
        method: 'POST',
        body: JSON.stringify({
          unitId: form.unitId,
          bankAccountId: form.bankAccountId,
          receiptDate: form.receiptDate,
          method: form.method,
          referenceNumber: form.referenceNumber || null,
          payerName: form.payerName || null,
          notes: form.notes || null,
          totalAmount: Number(form.totalAmount),
          allocations: selected.map(item => ({ invoiceId: item.invoiceId, amount: Number(item.amount) })),
          idempotencyKey,
        }),
      });
      setNotice(`Penerimaan ${result.receipt.receipt_number} tersimpan.`);
      setCreating(false);
      setIdempotencyKey(crypto.randomUUID());
      setSelected([]);
      setForm({ ...form, totalAmount: '', referenceNumber: '', payerName: '', notes: '' });
      await load();
      api<BankBalance[]>('/api/v1/cash-bank/balances').then(setBalances).catch(() => undefined);
    } catch (submitError) {
      setFormError(messageOf(submitError));
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(receiptId: string) {
    setDetailError('');
    try {
      setDetail(await api<ReceiptDetail>(`/api/v1/receipts/${receiptId}`));
    } catch (loadError) {
      setDetailError(messageOf(loadError));
    }
  }

  async function voidReceipt(receipt: ReceiptRow) {
    const reason = window.prompt(`Alasan membatalkan ${receipt.receipt_number} (minimal 5 karakter):`) || '';
    if (reason.trim().length < 5) { setError('Alasan minimal 5 karakter.'); return; }
    try {
      await api(`/api/v1/receipts/${receipt.id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      setNotice('Penerimaan dibatalkan; saldo tagihan dipulihkan.');
      await load();
      api<BankBalance[]>('/api/v1/cash-bank/balances').then(setBalances).catch(() => undefined);
    } catch (voidError) {
      setError(messageOf(voidError));
    }
  }

  return (
    <div className="stack">
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="card">
        <div className="toolbar">
          <input className="input search" placeholder="Cari nomor / pembayar / referensi…" value={filters.q}
            onChange={event => setFilters({ ...filters, q: event.target.value })} />
          <select className="select" value={filters.unitId} onChange={event => setFilters({ ...filters, unitId: event.target.value })}>
            <option value="">Semua unit</option>
            {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
          </select>
          <input type="date" className="input" value={filters.from} onChange={event => setFilters({ ...filters, from: event.target.value })} />
          <input type="date" className="input" value={filters.to} onChange={event => setFilters({ ...filters, to: event.target.value })} />
          <div className="spacer" />
          <span className="cell-muted">{total} penerimaan</span>
          {can('receipt.create') && (
            <button type="button" className="primary-button" onClick={() => { setCreating(true); setFormError(''); setIdempotencyKey(crypto.randomUUID()); }} data-testid="receipt-add">
              <Plus size={16} /> Catat Penerimaan
            </button>
          )}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Nomor</th><th>Tanggal</th><th>Pembayar</th><th>Unit</th><th>Rekening</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Teralokasi</th><th style={{ textAlign: 'right' }}>Belum</th><th>Status</th><th style={{ textAlign: 'right' }}>Aksi</th></tr>
            </thead>
            <tbody>
              {rows.map(receipt => (
                <tr key={receipt.id}>
                  <td className="cell-muted">{receipt.receipt_number}</td>
                  <td>{dateID(receipt.receipt_date)}</td>
                  <td className="cell-strong">{receipt.payer_name || '—'}</td>
                  <td>{receipt.unit_name}</td>
                  <td className="cell-muted">{receipt.bank_name}</td>
                  <td style={{ textAlign: 'right' }}>{money(receipt.total_amount)}</td>
                  <td style={{ textAlign: 'right' }}>{money(receipt.allocated_amount)}</td>
                  <td style={{ textAlign: 'right' }}>{money(receipt.unallocated_amount)}</td>
                  <td><StatusBadge value={receipt.status} /></td>
                  <td>
                    <div className="cell-actions">
                      <button type="button" className="link-button" onClick={() => openDetail(receipt.id)}>Detail</button>
                      {can('receipt.void') && receipt.status === 'POSTED' && (
                        <button type="button" className="link-button danger" onClick={() => voidReceipt(receipt)}>Batalkan</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && rows.length === 0 && <div className="table-empty">Belum ada penerimaan.</div>}
          {loading && <div className="table-empty">Memuat penerimaan…</div>}
        </div>
      </section>

      {creating && (
        <Modal title="Catat Penerimaan" onClose={() => setCreating(false)} maxWidth={900}>
          <form onSubmit={submit}>
            <div className="form-grid">
              <label className="field">Unit penerima
                <select className="select" value={form.unitId} onChange={event => setForm({ ...form, unitId: event.target.value, bankAccountId: '' })} required>
                  <option value="">Pilih…</option>
                  {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
                </select>
              </label>
              <label className="field">Rekening
                <select className="select" value={form.bankAccountId} onChange={event => setForm({ ...form, bankAccountId: event.target.value })} required>
                  <option value="">Pilih rekening…</option>
                  {accounts.map(account => (
                    <option key={account.id} value={account.id}>{account.bank_name} — {account.account_number} ({account.account_usage})</option>
                  ))}
                </select>
                {accounts.length === 0 && (
                  <span className="cell-muted" style={{ marginTop: 4 }}>Belum ada rekening penerimaan untuk unit ini.</span>
                )}
              </label>
              <label className="field">Tanggal
                <input type="date" className="input" value={form.receiptDate} onChange={event => setForm({ ...form, receiptDate: event.target.value })} required />
              </label>
              <label className="field">Metode
                <select className="select" value={form.method} onChange={event => setForm({ ...form, method: event.target.value })}>
                  <option value="CASH">Tunai</option>
                  <option value="TRANSFER">Transfer</option>
                  <option value="QRIS">QRIS</option>
                  <option value="OTHER">Lainnya</option>
                </select>
              </label>
              <label className="field">Nominal diterima (Rp)
                <input className="input" inputMode="numeric" value={form.totalAmount} onChange={event => setForm({ ...form, totalAmount: event.target.value })} required data-testid="receipt-total" />
              </label>
              <label className="field">Referensi
                <input className="input" value={form.referenceNumber} onChange={event => setForm({ ...form, referenceNumber: event.target.value })} placeholder="No. transfer / bukti" />
              </label>
              <label className="field">Pembayar
                <input className="input" value={form.payerName} onChange={event => setForm({ ...form, payerName: event.target.value })} placeholder="Nama wali / siswa" />
              </label>
              <label className="field">Catatan
                <input className="input" value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} />
              </label>
            </div>

            <div style={{ marginTop: 18 }}>
              <div className="field" style={{ marginBottom: 8 }}>Alokasi ke tagihan</div>
              <div className="toolbar" style={{ padding: 0 }}>
                <input className="input search" placeholder="Cari nama siswa / NIS / nomor tagihan…" value={invoiceSearch}
                  onChange={event => setInvoiceSearch(event.target.value)} />
                <button type="button" className="ghost-button" onClick={searchInvoices}>
                  <Search size={16} /> Cari Tagihan
                </button>
                <div className="spacer" />
                <span className="cell-muted">Sisa belum dialokasikan: <strong>{money(remaining)}</strong></span>
              </div>

              {invoiceResults.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 10 }}>
                  <table>
                    <thead><tr><th>Tagihan</th><th>Siswa</th><th>Unit</th><th style={{ textAlign: 'right' }}>Sisa</th><th /></tr></thead>
                    <tbody>
                      {invoiceResults.map(invoice => (
                        <tr key={invoice.id}>
                          <td className="cell-muted">{invoice.invoice_number}</td>
                          <td>{invoice.full_name} <span className="cell-muted">· {invoice.nis}</span></td>
                          <td>{invoice.unit_name}</td>
                          <td style={{ textAlign: 'right' }}>{money(invoice.outstanding)}</td>
                          <td><button type="button" className="link-button" onClick={() => addInvoice(invoice)}>Tambah</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {selected.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 10 }}>
                  <table>
                    <thead><tr><th>Tagihan</th><th>Siswa</th><th style={{ textAlign: 'right' }}>Sisa</th><th>Alokasi</th><th /></tr></thead>
                    <tbody>
                      {selected.map(item => (
                        <tr key={item.invoiceId}>
                          <td className="cell-muted">{item.invoiceNumber}</td>
                          <td>{item.studentName} <span className="cell-muted">· {item.nis}</span></td>
                          <td style={{ textAlign: 'right' }}>{money(item.outstanding)}</td>
                          <td>
                            <input className="input score-input" inputMode="numeric" value={item.amount}
                              onChange={event => updateAmount(item.invoiceId, event.target.value)} />
                          </td>
                          <td>
                            <button type="button" className="icon-button" aria-label="Hapus alokasi"
                              onClick={() => setSelected(current => current.filter(row => row.invoiceId !== item.invoiceId))}>
                              <Trash2 size={16} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="cell-muted" style={{ marginTop: 8 }}>
                Teralokasi {money(allocated)} dari {money(totalAmount)}. Sisa akan tercatat sebagai uang belum dialokasikan.
              </div>
            </div>

            {formError && <div className="form-error" style={{ marginTop: 12 }}>{formError}</div>}
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setCreating(false)}>Batal</button>
              <button type="submit" className="primary-button" disabled={saving} data-testid="receipt-save">
                {saving ? 'Menyimpan…' : 'Simpan Penerimaan'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {detail && (
        <Modal title={`${detail.receipt_number} — ${detail.payer_name || 'Penerimaan'}`} onClose={() => setDetail(null)} maxWidth={820}>
          {detailError && <div className="form-error" style={{ marginBottom: 12 }}>{detailError}</div>}
          <div className="stack">
            <div className="detail-grid">
              <Info label="Tanggal" value={dateID(detail.receipt_date)} />
              <Info label="Unit" value={detail.unit_name} />
              <Info label="Rekening" value={detail.bank_name} />
              <Info label="Metode" value={detail.method} />
              <Info label="Total" value={money(detail.total_amount)} />
              <Info label="Belum dialokasikan" value={money(detail.unallocated_amount)} />
              <Info label="Status" value={<StatusBadge value={detail.status} />} />
              <Info label="Dicatat oleh" value={detail.created_by_name || '—'} />
            </div>

            <section>
              <h4 style={{ marginBottom: 8 }}>Alokasi</h4>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Tagihan</th><th>Siswa</th><th>Unit</th><th style={{ textAlign: 'right' }}>Nominal</th><th>Status tagihan</th></tr></thead>
                  <tbody>
                    {detail.allocations.map(allocation => (
                      <tr key={allocation.id}>
                        <td className="cell-muted">{allocation.invoice_number}</td>
                        <td>{allocation.full_name} <span className="cell-muted">· {allocation.nis}</span></td>
                        <td>{allocation.unit_name}</td>
                        <td style={{ textAlign: 'right' }}>{money(allocation.amount)}</td>
                        <td><StatusBadge value={allocation.invoice_status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detail.allocations.length === 0 && <div className="table-empty">Belum ada alokasi (uang belum teralokasi).</div>}
              </div>
            </section>

            {detail.status === 'VOID' && detail.void_reason && <div className="form-error">Dibatalkan: {detail.void_reason}</div>}
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
