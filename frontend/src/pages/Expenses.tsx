import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, Plus, Send, Wallet, X } from 'lucide-react';
import { api, messageOf } from '../api';
import { Modal } from '../components/Modal';
import { dateID, money, todayISO } from '../format';
import { StatusBadge } from './Organization';
import type {
  BankBalance, ExpenseCategory, ExpenseDetail, ExpensePayment, ExpenseRow, Hierarchy, Permission, Session, Vendor,
} from '../types';

type Tab = 'requests' | 'approvals' | 'payments' | 'master';

const STATUS_OPTIONS = ['', 'DRAFT', 'SUBMITTED', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED'];

export function Expenses({ session }: { session: Session }) {
  const can = (permission: Permission) => session.permissions.includes(permission);

  const [tab, setTab] = useState<Tab>('requests');
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [payments, setPayments] = useState<ExpensePayment[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [balances, setBalances] = useState<BankBalance[]>([]);
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [filters, setFilters] = useState({ unitId: '', status: '', q: '', from: '', to: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    unitId: '', expenseCategoryId: '', vendorId: '', requestDate: todayISO(),
    dueDate: '', payeeName: '', description: '', amount: '', notes: '',
  });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState<ExpenseDetail | null>(null);
  const [detailError, setDetailError] = useState('');

  const [paying, setPaying] = useState<ExpenseRow | null>(null);
  const [payForm, setPayForm] = useState({
    bankAccountId: '', paymentDate: todayISO(), method: 'TRANSFER',
    referenceNumber: '', amount: '', idempotencyKey: '',
  });
  const [payError, setPayError] = useState('');

  const [categoryForm, setCategoryForm] = useState({ code: '', name: '', expenseAccountCode: '' });
  const [vendorForm, setVendorForm] = useState({ code: '', name: '', phone: '', bankName: '', bankAccountNumber: '' });

  const loadRequests = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ pageSize: '100' });
      if (filters.unitId) params.set('unitId', filters.unitId);
      if (filters.status) params.set('status', filters.status);
      if (filters.q.trim()) params.set('q', filters.q.trim());
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      const result = await api<{ rows: ExpenseRow[] }>(`/api/v1/expenses?${params.toString()}`);
      setRows(result.rows);
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  const loadSupport = useCallback(async () => {
    try {
      const [paymentRows, balanceRows] = await Promise.all([
        api<{ rows: ExpensePayment[] }>('/api/v1/expense-payments?pageSize=100'),
        api<BankBalance[]>('/api/v1/cash-bank/balances'),
      ]);
      setPayments(paymentRows.rows);
      setBalances(balanceRows);
    } catch {
      // abaikan: daftar utama tetap bisa dipakai
    }
    api<ExpenseCategory[]>('/api/v1/expense-categories').then(setCategories).catch(() => undefined);
    api<Vendor[]>('/api/v1/vendors').then(setVendors).catch(() => undefined);
    api<Hierarchy>('/api/v1/organization/hierarchy')
      .then(result => {
        setHierarchy(result);
        setForm(current => ({ ...current, unitId: current.unitId || result.units[0]?.id || '' }));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => { void loadRequests(); }, [loadRequests]);
  useEffect(() => { void loadSupport(); }, [loadSupport]);

  const units = hierarchy?.units || [];
  const pending = rows.filter(row => row.status === 'SUBMITTED');
  const payable = rows.filter(row => ['APPROVED', 'PAID'].includes(row.status) && Number(row.remaining) > 0);
  const payableAccounts = balances.filter(account =>
    account.status === 'ACTIVE' && Boolean(account.verified_at)
    && (account.disbursement_unit_ids || []).includes(paying?.unit_id || ''),
  );

  async function refresh() {
    await loadRequests();
    await loadSupport();
  }

  function openCreate() {
    setForm(current => ({
      ...current, expenseCategoryId: '', vendorId: '', description: '', amount: '', notes: '',
      dueDate: '', payeeName: '',
    }));
    setFormError('');
    setCreating(true);
  }

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      const result = await api<ExpenseDetail>('/api/v1/expenses', {
        method: 'POST',
        body: JSON.stringify({
          unitId: form.unitId,
          expenseCategoryId: form.expenseCategoryId,
          vendorId: form.vendorId || null,
          requestDate: form.requestDate,
          dueDate: form.dueDate || null,
          payeeName: form.payeeName || null,
          description: form.description,
          amount: Number(form.amount),
          notes: form.notes || null,
        }),
      });
      setNotice(`Pengajuan ${result.request_number} tersimpan sebagai draft.`);
      setCreating(false);
      await refresh();
    } catch (submitError) {
      setFormError(messageOf(submitError));
    } finally {
      setSaving(false);
    }
  }

  async function act(path: string, body: Record<string, unknown>, successMessage: string) {
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice(successMessage);
      setError('');
      await refresh();
    } catch (actionError) {
      setError(messageOf(actionError));
    }
  }

  function rejectRequest(row: ExpenseRow) {
    const reason = window.prompt(`Alasan menolak ${row.request_number} (minimal 5 karakter):`) || '';
    if (reason.trim().length < 5) { setError('Alasan minimal 5 karakter.'); return; }
    void act(`/api/v1/expenses/${row.id}/reject`, { reason }, `Pengajuan ${row.request_number} ditolak.`);
  }

  function cancelRequest(row: ExpenseRow) {
    const reason = window.prompt(`Alasan membatalkan ${row.request_number} (minimal 5 karakter):`) || '';
    if (reason.trim().length < 5) { setError('Alasan minimal 5 karakter.'); return; }
    void act(`/api/v1/expenses/${row.id}/cancel`, { reason }, `Pengajuan ${row.request_number} dibatalkan.`);
  }

  async function openDetail(row: ExpenseRow) {
    setDetailError('');
    try {
      setDetail(await api<ExpenseDetail>(`/api/v1/expenses/${row.id}`));
    } catch (loadError) {
      setDetailError(messageOf(loadError));
    }
  }

  function openPay(row: ExpenseRow) {
    setPayForm({
      bankAccountId: '', paymentDate: todayISO(), method: 'TRANSFER',
      referenceNumber: '', amount: String(Number(row.remaining)),
      idempotencyKey: crypto.randomUUID(),
    });
    setPayError('');
    setPaying(row);
  }

  async function submitPay(event: FormEvent) {
    event.preventDefault();
    if (!paying) return;
    setSaving(true);
    setPayError('');
    try {
      const result = await api<{ payment: ExpensePayment }>(`/api/v1/expenses/${paying.id}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          bankAccountId: payForm.bankAccountId,
          paymentDate: payForm.paymentDate,
          method: payForm.method,
          referenceNumber: payForm.referenceNumber || null,
          amount: Number(payForm.amount),
          idempotencyKey: payForm.idempotencyKey,
        }),
      });
      setNotice(`Pembayaran ${result.payment.payment_number} tersimpan.`);
      setPaying(null);
      await refresh();
    } catch (paymentError) {
      setPayError(messageOf(paymentError));
    } finally {
      setSaving(false);
    }
  }

  function voidPayment(payment: ExpensePayment) {
    const reason = window.prompt(`Alasan membatalkan ${payment.payment_number} (minimal 5 karakter):`) || '';
    if (reason.trim().length < 5) { setError('Alasan minimal 5 karakter.'); return; }
    void act(`/api/v1/expense-payments/${payment.id}/void`, { reason }, `Pembayaran ${payment.payment_number} dibatalkan.`);
  }

  async function createCategory(event: FormEvent) {
    event.preventDefault();
    try {
      await api('/api/v1/expense-categories', {
        method: 'POST',
        body: JSON.stringify({
          code: categoryForm.code, name: categoryForm.name,
          expenseAccountCode: categoryForm.expenseAccountCode || null,
        }),
      });
      setCategoryForm({ code: '', name: '', expenseAccountCode: '' });
      setNotice('Jenis biaya ditambahkan.');
      await refresh();
    } catch (createError) {
      setError(messageOf(createError));
    }
  }

  async function createVendor(event: FormEvent) {
    event.preventDefault();
    try {
      await api('/api/v1/vendors', {
        method: 'POST',
        body: JSON.stringify({
          code: vendorForm.code, name: vendorForm.name, phone: vendorForm.phone || null,
          bankName: vendorForm.bankName || null, bankAccountNumber: vendorForm.bankAccountNumber || null,
        }),
      });
      setVendorForm({ code: '', name: '', phone: '', bankName: '', bankAccountNumber: '' });
      setNotice('Vendor ditambahkan.');
      await refresh();
    } catch (createError) {
      setError(messageOf(createError));
    }
  }

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'requests', label: 'Pengajuan', count: rows.length },
    ...(can('expense.approve') ? [{ id: 'approvals' as Tab, label: 'Persetujuan', count: pending.length }] : []),
    { id: 'payments', label: 'Pembayaran', count: payable.length },
    ...(can('expense.manage') ? [{ id: 'master' as Tab, label: 'Master', count: categories.length }] : []),
  ];

  return (
    <div className="stack">
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="card">
        <div className="toolbar">
          {tabs.map(item => (
            <button key={item.id} type="button" className={tab === item.id ? 'primary-button' : 'ghost-button'}
              onClick={() => setTab(item.id)}>
              {item.label} <span className="cell-muted">({item.count})</span>
            </button>
          ))}
          <div className="spacer" />
          {can('expense.create') && (
            <button type="button" className="primary-button" onClick={openCreate} data-testid="expense-add">
              <Plus size={16} /> Ajukan Pengeluaran
            </button>
          )}
        </div>
      </section>

      {(tab === 'requests' || tab === 'approvals') && (
        <section className="card">
          <div className="toolbar">
            <input className="input search" placeholder="Cari nomor / uraian / penerima…" value={filters.q}
              onChange={event => setFilters({ ...filters, q: event.target.value })} />
            <select className="select" value={filters.unitId} onChange={event => setFilters({ ...filters, unitId: event.target.value })}>
              <option value="">Semua unit</option>
              {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
            </select>
            {tab === 'requests' && (
              <select className="select" value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value })}>
                {STATUS_OPTIONS.map(status => (
                  <option key={status || 'ALL'} value={status}>{status || 'Semua status'}</option>
                ))}
              </select>
            )}
            <input type="date" className="input" value={filters.from} onChange={event => setFilters({ ...filters, from: event.target.value })} />
            <input type="date" className="input" value={filters.to} onChange={event => setFilters({ ...filters, to: event.target.value })} />
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nomor</th><th>Tanggal</th><th>Uraian</th><th>Unit</th><th>Jenis</th>
                  <th style={{ textAlign: 'right' }}>Nilai</th>
                  <th style={{ textAlign: 'right' }}>Dibayar</th>
                  <th style={{ textAlign: 'right' }}>Sisa</th>
                  <th>Status</th><th style={{ textAlign: 'right' }}>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {(tab === 'approvals' ? pending : rows).map(row => (
                  <tr key={row.id}>
                    <td className="cell-muted">{row.request_number}</td>
                    <td>{dateID(row.request_date)}</td>
                    <td>
                      <strong>{row.description}</strong>
                      <div className="cell-muted">{row.payee_name || row.vendor_name || '—'}</div>
                    </td>
                    <td>{row.unit_name}</td>
                    <td className="cell-muted">{row.category_name}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.amount)}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.paid_amount)}</td>
                    <td style={{ textAlign: 'right' }}>{money(row.remaining)}</td>
                    <td><StatusBadge value={row.status} /></td>
                    <td>
                      <div className="cell-actions">
                        <button type="button" className="link-button" onClick={() => void openDetail(row)}>Detail</button>
                        {can('expense.create') && ['DRAFT', 'REJECTED'].includes(row.status) && (
                          <button type="button" className="link-button"
                            onClick={() => void act(`/api/v1/expenses/${row.id}/submit`, {}, `Pengajuan ${row.request_number} diajukan.`)}>
                            <Send size={14} /> Ajukan
                          </button>
                        )}
                        {can('expense.approve') && row.status === 'SUBMITTED' && (
                          <>
                            <button type="button" className="link-button"
                              onClick={() => void act(`/api/v1/expenses/${row.id}/approve`, {}, `Pengajuan ${row.request_number} disetujui.`)}>
                              <Check size={14} /> Setujui
                            </button>
                            <button type="button" className="link-button danger" onClick={() => rejectRequest(row)}>
                              <X size={14} /> Tolak
                            </button>
                          </>
                        )}
                        {can('expense.pay') && ['APPROVED', 'PAID'].includes(row.status) && Number(row.remaining) > 0 && (
                          <button type="button" className="link-button" onClick={() => openPay(row)}>
                            <Wallet size={14} /> Bayar
                          </button>
                        )}
                        {can('expense.create') && Number(row.paid_amount) === 0 && !['PAID', 'CANCELLED'].includes(row.status) && (
                          <button type="button" className="link-button danger" onClick={() => cancelRequest(row)}>Batalkan</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {loading && <div className="table-empty">Memuat pengajuan…</div>}
            {!loading && (tab === 'approvals' ? pending : rows).length === 0 && (
              <div className="table-empty">
                {tab === 'approvals' ? 'Tidak ada pengajuan menunggu persetujuan.' : 'Belum ada pengajuan pengeluaran.'}
              </div>
            )}
          </div>
        </section>
      )}

      {tab === 'payments' && (
        <>
          <section className="card">
            <div className="card-header">
              <div><h3>Siap dibayar</h3><p>Pengajuan berstatus APPROVED dengan sisa nilai</p></div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Nomor</th><th>Uraian</th><th>Unit</th>
                    <th style={{ textAlign: 'right' }}>Sisa</th><th style={{ textAlign: 'right' }}>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {payable.map(row => (
                    <tr key={row.id}>
                      <td className="cell-muted">{row.request_number}</td>
                      <td>{row.description}</td>
                      <td>{row.unit_name}</td>
                      <td style={{ textAlign: 'right' }}>{money(row.remaining)}</td>
                      <td>
                        <div className="cell-actions">
                          {can('expense.pay') && (
                            <button type="button" className="link-button" onClick={() => openPay(row)}>
                              <Wallet size={14} /> Bayar
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {payable.length === 0 && <div className="table-empty">Tidak ada pengajuan yang siap dibayar.</div>}
            </div>
          </section>

          <section className="card">
            <div className="card-header">
              <div><h3>Riwayat pembayaran</h3><p>Mutasi keluar otomatis tercatat di Kas &amp; Bank</p></div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Nomor</th><th>Tanggal</th><th>Pengajuan</th><th>Unit</th><th>Rekening</th>
                    <th style={{ textAlign: 'right' }}>Nominal</th><th>Status</th>
                    <th style={{ textAlign: 'right' }}>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map(payment => (
                    <tr key={payment.id}>
                      <td className="cell-muted">{payment.payment_number}</td>
                      <td>{dateID(payment.payment_date)}</td>
                      <td>{payment.request_number || '—'}</td>
                      <td>{payment.unit_name || '—'}</td>
                      <td>
                        {payment.bank_name}
                        <div className="cell-muted">{payment.account_number}</div>
                      </td>
                      <td style={{ textAlign: 'right' }}>{money(payment.amount)}</td>
                      <td><StatusBadge value={payment.status} /></td>
                      <td>
                        <div className="cell-actions">
                          {can('expense.void') && payment.status === 'POSTED' && (
                            <button type="button" className="link-button danger" onClick={() => voidPayment(payment)}>Batalkan</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {payments.length === 0 && <div className="table-empty">Belum ada pembayaran pengeluaran.</div>}
            </div>
          </section>
        </>
      )}

      {tab === 'master' && can('expense.manage') && (
        <div className="grid-2">
          <section className="card">
            <div className="card-header"><div><h3>Jenis biaya</h3><p>Wajib punya akun beban (CoA)</p></div></div>
            <form className="form-grid" onSubmit={createCategory} style={{ padding: 16 }}>
              <label className="field">Kode
                <input className="input" value={categoryForm.code}
                  onChange={event => setCategoryForm({ ...categoryForm, code: event.target.value })} required />
              </label>
              <label className="field">Nama
                <input className="input" value={categoryForm.name}
                  onChange={event => setCategoryForm({ ...categoryForm, name: event.target.value })} required />
              </label>
              <label className="field">Akun beban
                <input className="input" placeholder="5-1100" value={categoryForm.expenseAccountCode}
                  onChange={event => setCategoryForm({ ...categoryForm, expenseAccountCode: event.target.value })} />
              </label>
              <div style={{ alignSelf: 'end' }}>
                <button type="submit" className="primary-button">Tambah jenis biaya</button>
              </div>
            </form>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Kode</th><th>Nama</th><th>Akun</th><th>Status</th></tr></thead>
                <tbody>
                  {categories.map(category => (
                    <tr key={category.id}>
                      <td className="cell-muted">{category.code}</td>
                      <td>{category.name}</td>
                      <td className="cell-muted">{category.expense_account_code || '—'}</td>
                      <td><StatusBadge value={category.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <div className="card-header"><div><h3>Vendor</h3><p>Opsional; dipakai sebagai penerima pembayaran</p></div></div>
            <form className="form-grid" onSubmit={createVendor} style={{ padding: 16 }}>
              <label className="field">Kode
                <input className="input" value={vendorForm.code}
                  onChange={event => setVendorForm({ ...vendorForm, code: event.target.value })} required />
              </label>
              <label className="field">Nama
                <input className="input" value={vendorForm.name}
                  onChange={event => setVendorForm({ ...vendorForm, name: event.target.value })} required />
              </label>
              <label className="field">Telepon
                <input className="input" value={vendorForm.phone}
                  onChange={event => setVendorForm({ ...vendorForm, phone: event.target.value })} />
              </label>
              <label className="field">Bank
                <input className="input" value={vendorForm.bankName}
                  onChange={event => setVendorForm({ ...vendorForm, bankName: event.target.value })} />
              </label>
              <label className="field">No. rekening
                <input className="input" value={vendorForm.bankAccountNumber}
                  onChange={event => setVendorForm({ ...vendorForm, bankAccountNumber: event.target.value })} />
              </label>
              <div style={{ alignSelf: 'end' }}>
                <button type="submit" className="primary-button">Tambah vendor</button>
              </div>
            </form>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Kode</th><th>Nama</th><th>Telepon</th><th>Status</th></tr></thead>
                <tbody>
                  {vendors.map(vendor => (
                    <tr key={vendor.id}>
                      <td className="cell-muted">{vendor.code}</td>
                      <td>{vendor.name}</td>
                      <td className="cell-muted">{vendor.phone || '—'}</td>
                      <td><StatusBadge value={vendor.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {vendors.length === 0 && <div className="table-empty">Belum ada vendor.</div>}
            </div>
          </section>
        </div>
      )}

      {creating && (
        <Modal title="Ajukan Pengeluaran" onClose={() => setCreating(false)} maxWidth={820}>
          <form onSubmit={submitCreate}>
            <div className="form-grid">
              <label className="field">Unit penanggung beban
                <select className="select" value={form.unitId}
                  onChange={event => setForm({ ...form, unitId: event.target.value })} required>
                  <option value="">Pilih…</option>
                  {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
                </select>
              </label>
              <label className="field">Jenis biaya
                <select className="select" value={form.expenseCategoryId}
                  onChange={event => setForm({ ...form, expenseCategoryId: event.target.value })} required>
                  <option value="">Pilih…</option>
                  {categories.filter(category => category.status === 'ACTIVE').map(category => (
                    <option key={category.id} value={category.id}>{category.code} — {category.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">Tanggal pengajuan
                <input type="date" className="input" value={form.requestDate}
                  onChange={event => setForm({ ...form, requestDate: event.target.value })} required />
              </label>
              <label className="field">Jatuh tempo (opsional)
                <input type="date" className="input" value={form.dueDate}
                  onChange={event => setForm({ ...form, dueDate: event.target.value })} />
              </label>
              <label className="field">Nominal (Rp)
                <input className="input" inputMode="numeric" value={form.amount}
                  onChange={event => setForm({ ...form, amount: event.target.value })} required data-testid="expense-amount" />
              </label>
              <label className="field">Vendor (opsional)
                <select className="select" value={form.vendorId}
                  onChange={event => setForm({ ...form, vendorId: event.target.value })}>
                  <option value="">Tanpa vendor</option>
                  {vendors.filter(vendor => vendor.status === 'ACTIVE').map(vendor => (
                    <option key={vendor.id} value={vendor.id}>{vendor.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">Penerima (opsional)
                <input className="input" value={form.payeeName}
                  onChange={event => setForm({ ...form, payeeName: event.target.value })} placeholder="Nama penerima pembayaran" />
              </label>
              <label className="field">Catatan (opsional)
                <input className="input" value={form.notes}
                  onChange={event => setForm({ ...form, notes: event.target.value })} />
              </label>
            </div>
            <label className="field" style={{ marginTop: 12 }}>Uraian
              <input className="input" value={form.description}
                onChange={event => setForm({ ...form, description: event.target.value })}
                placeholder="Contoh: Honor guru bantu bulan Juli" required data-testid="expense-description" />
            </label>
            {formError && <div className="form-error" style={{ marginTop: 12 }}>{formError}</div>}
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setCreating(false)}>Batal</button>
              <button type="submit" className="primary-button" disabled={saving} data-testid="expense-save">
                {saving ? 'Menyimpan…' : 'Simpan Draft'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {paying && (
        <Modal title={`Bayar ${paying.request_number}`} onClose={() => setPaying(null)} maxWidth={680}>
          <form onSubmit={submitPay}>
            <div className="form-grid">
              <label className="field">Rekening pembayaran
                <select className="select" value={payForm.bankAccountId}
                  onChange={event => setPayForm({ ...payForm, bankAccountId: event.target.value })} required>
                  <option value="">Pilih rekening…</option>
                  {payableAccounts.map(account => (
                    <option key={account.id} value={account.id}>
                      {account.bank_name} — {account.account_number} ({account.account_usage})
                    </option>
                  ))}
                </select>
                {payableAccounts.length === 0 && (
                  <span className="cell-muted" style={{ marginTop: 4 }}>
                    Belum ada rekening berizin bayar untuk unit ini.
                  </span>
                )}
              </label>
              <label className="field">Tanggal bayar
                <input type="date" className="input" value={payForm.paymentDate}
                  onChange={event => setPayForm({ ...payForm, paymentDate: event.target.value })} required />
              </label>
              <label className="field">Nominal (Rp)
                <input className="input" inputMode="numeric" value={payForm.amount}
                  onChange={event => setPayForm({ ...payForm, amount: event.target.value })} required data-testid="expense-pay-amount" />
              </label>
              <label className="field">Metode
                <select className="select" value={payForm.method}
                  onChange={event => setPayForm({ ...payForm, method: event.target.value })}>
                  <option value="TRANSFER">Transfer</option>
                  <option value="CASH">Tunai</option>
                  <option value="QRIS">QRIS</option>
                  <option value="OTHER">Lainnya</option>
                </select>
              </label>
              <label className="field">Referensi
                <input className="input" value={payForm.referenceNumber}
                  onChange={event => setPayForm({ ...payForm, referenceNumber: event.target.value })}
                  placeholder="No. transfer / bukti" />
              </label>
            </div>
            <div className="cell-muted" style={{ marginTop: 10 }}>
              Sisa pengajuan: <strong>{money(paying.remaining)}</strong>
            </div>
            {payError && <div className="form-error" style={{ marginTop: 12 }}>{payError}</div>}
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setPaying(null)}>Batal</button>
              <button type="submit" className="primary-button" disabled={saving} data-testid="expense-pay-save">
                {saving ? 'Menyimpan…' : 'Simpan Pembayaran'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {detail && (
        <Modal title={`Pengajuan ${detail.request_number}`} onClose={() => setDetail(null)} maxWidth={760}>
          {detailError && <div className="form-error">{detailError}</div>}
          <div className="detail-grid">
            <div><span>Unit</span><strong>{detail.unit_name}</strong></div>
            <div><span>Jenis biaya</span><strong>{detail.category_name}</strong></div>
            <div><span>Tanggal</span><strong>{dateID(detail.request_date)}</strong></div>
            <div><span>Status</span><strong><StatusBadge value={detail.status} /></strong></div>
            <div><span>Nilai</span><strong>{money(detail.amount)}</strong></div>
            <div><span>Dibayar</span><strong>{money(detail.paid_amount)}</strong></div>
            <div><span>Sisa</span><strong>{money(detail.remaining)}</strong></div>
            <div><span>Akun beban</span><strong>{detail.expense_account_code || '—'}</strong></div>
            <div><span>Penerima</span><strong>{detail.payee_name || detail.vendor_name || '—'}</strong></div>
            <div><span>Diajukan oleh</span><strong>{detail.created_by_name || '—'}</strong></div>
            <div><span>Disetujui oleh</span><strong>{detail.approved_by_name || '—'}</strong></div>
            <div><span>Alasan penolakan</span><strong>{detail.rejection_reason || '—'}</strong></div>
          </div>
          <p className="cell-strong" style={{ marginTop: 12 }}>{detail.description}</p>

          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Pembayaran</th><th>Tanggal</th><th>Rekening</th>
                  <th style={{ textAlign: 'right' }}>Nominal</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.payments.map(payment => (
                  <tr key={payment.id}>
                    <td className="cell-muted">{payment.payment_number}</td>
                    <td>{dateID(payment.payment_date)}</td>
                    <td>{payment.bank_name} <span className="cell-muted">· {payment.account_number}</span></td>
                    <td style={{ textAlign: 'right' }}>{money(payment.amount)}</td>
                    <td><StatusBadge value={payment.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.payments.length === 0 && <div className="table-empty">Belum ada pembayaran.</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}
