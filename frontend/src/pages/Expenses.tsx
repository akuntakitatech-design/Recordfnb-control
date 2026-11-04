import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertTriangle, Check, Clock, Paperclip, Pencil, Plus, Send, Trash2, Wallet, X } from 'lucide-react';
import { api, messageOf } from '../api';
import { Modal } from '../components/Modal';
import { Attachments, uploadAttachmentFiles } from '../components/Attachments';
import { dateID, money, todayISO } from '../format';
import { StatusBadge } from './Organization';
import type {
  BankBalance, ExpenseCategory, ExpenseDetail, ExpensePayment, ExpenseRow, Hierarchy, PaymentRequestRow, Permission, Session, Vendor,
} from '../types';

type LineForm = { itemName: string; qty: string; uom: string; unitPrice: string };

type Tab = 'requests' | 'approvals' | 'payments' | 'mcm' | 'master';

const STATUS_OPTIONS = ['', 'DRAFT', 'SUBMITTED', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED'];

const PRIORITY_OPTIONS = [
  { value: 'NORMAL', label: 'Normal', hint: 'Tanpa percepatan' },
  { value: 'TINGGI', label: 'Tinggi', hint: 'Didahulukan' },
  { value: 'MENDESAK', label: 'Mendesak', hint: 'Segera diproses' },
];

const DUE_PRESETS = [
  { label: '1 jam', minutes: 60 },
  { label: '3 jam', minutes: 180 },
  { label: '24 jam', minutes: 1440 },
  { label: '3 hari', minutes: 4320 },
];

/** Format Date -> nilai untuk <input type="datetime-local"> (waktu lokal). */
function toLocalInput(when: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

function FormSection({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{
      gridColumn: '1 / -1', display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
      marginTop: 6, paddingBottom: 6, borderBottom: '1px solid var(--line)',
    }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      {hint && <span className="form-hint">{hint}</span>}
    </div>
  );
}

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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ExpenseRow | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [form, setForm] = useState({
    unitId: '', expenseCategoryId: '', vendorId: '', requestDate: todayISO(),
    dueDate: '', payeeName: '', description: '', amount: '', notes: '', shippingCost: '',
    priority: 'NORMAL', paymentDueAt: '',
    lines: [] as LineForm[],
  });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const submitIntent = useRef<'DRAFT' | 'SUBMITTED'>('DRAFT');

  const [detail, setDetail] = useState<ExpenseDetail | null>(null);
  const [detailError, setDetailError] = useState('');

  const [mcmRows, setMcmRows] = useState<PaymentRequestRow[]>([]);
  const [mcmModal, setMcmModal] = useState<ExpenseRow | null>(null);
  const [mcmForm, setMcmForm] = useState({ bankAccountId: '', requestDate: todayISO(), amount: '', notes: '' });
  const [mcmError, setMcmError] = useState('');
  const [mcmSaving, setMcmSaving] = useState(false);

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
    api<{ rows: PaymentRequestRow[] }>('/api/v1/payment-requests?pageSize=100')
      .then(result => setMcmRows(result.rows || [])).catch(() => undefined);
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

  function openMcm(row: ExpenseRow) {
    setMcmForm({ bankAccountId: '', requestDate: todayISO(), amount: String(Number(row.remaining)), notes: '' });
    setMcmError('');
    setMcmModal(row);
  }

  async function submitMcm(event: FormEvent) {
    event.preventDefault();
    if (!mcmModal) return;
    setMcmSaving(true);
    setMcmError('');
    try {
      await api('/api/v1/payment-requests', {
        method: 'POST',
        body: JSON.stringify({
          expenseRequestId: mcmModal.id,
          bankAccountId: mcmForm.bankAccountId,
          requestDate: mcmForm.requestDate,
          amount: Number(mcmForm.amount || 0),
          notes: mcmForm.notes || null,
        }),
      });
      setNotice('MCM dibuat sebagai draft. Ajukan agar disetujui Ketua Yayasan.');
      setMcmModal(null);
      await refresh();
    } catch (mcmSubmitError) {
      setMcmError(messageOf(mcmSubmitError));
    } finally {
      setMcmSaving(false);
    }
  }

  async function mcmAction(path: string, body: Record<string, unknown>, message: string) {
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice(message);
      setError('');
      await refresh();
    } catch (mcmActionError) {
      setError(messageOf(mcmActionError));
    }
  }

  function closeForm() {
    setCreating(false);
    setEditingId(null);
    setPendingFiles([]);
    submitIntent.current = 'DRAFT';
  }

  function openCreate() {
    setEditingId(null);
    setPendingFiles([]);
    submitIntent.current = 'DRAFT';
    setForm(current => ({
      ...current, expenseCategoryId: '', vendorId: '', description: '', amount: '', notes: '',
      dueDate: '', payeeName: '', shippingCost: '', lines: [],
      priority: 'NORMAL', paymentDueAt: '',
    }));
    setFormError('');
    setCreating(true);
  }

  async function openEdit(row: ExpenseRow) {
    try {
      const detail = await api<ExpenseDetail>(`/api/v1/expenses/${row.id}`);
      setPendingFiles([]);
      submitIntent.current = 'DRAFT';
      setForm({
        unitId: detail.unit_id,
        expenseCategoryId: detail.expense_category_id,
        vendorId: detail.vendor_id || '',
        requestDate: String(detail.request_date).slice(0, 10),
        dueDate: detail.due_date ? String(detail.due_date).slice(0, 10) : '',
        payeeName: detail.payee_name || '',
        description: detail.description,
        amount: String(Number(detail.amount)),
        notes: detail.notes || '',
        priority: detail.priority || 'NORMAL',
        paymentDueAt: detail.payment_due_at ? String(detail.payment_due_at).slice(0, 16).replace(' ', 'T') : '',
        shippingCost: detail.shipping_cost ? String(Number(detail.shipping_cost)) : '',
        lines: (detail.lines || []).map(line => ({
          itemName: line.item_name, qty: String(Number(line.qty)),
          uom: line.uom || '', unitPrice: String(Number(line.unit_price)),
        })),
      });
      setEditingId(row.id);
      setFormError('');
      setCreating(true);
    } catch (editError) {
      setError(messageOf(editError));
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setError('');
    try {
      await api(`/api/v1/expenses/${deleting.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ reason: deleteReason || null }),
      });
      setNotice(`Pengajuan ${deleting.request_number} dihapus permanen.`);
      setDeleting(null);
      setDeleteReason('');
      await refresh();
    } catch (deleteError) {
      setError(messageOf(deleteError));
    }
  }

  async function deleteMcm(row: PaymentRequestRow) {
    if (!window.confirm(`Hapus permanen MCM ${row.request_number}?`)) return;
    setError('');
    try {
      await api(`/api/v1/payment-requests/${row.id}`, { method: 'DELETE', body: JSON.stringify({}) });
      setNotice(`MCM ${row.request_number} dihapus.`);
      await refresh();
    } catch (mcmDeleteError) {
      setError(messageOf(mcmDeleteError));
    }
  }

  const lineTotal = (line: LineForm) => Number(line.qty || 0) * Number(line.unitPrice || 0);
  const linesTotal = form.lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const grandTotal = form.lines.length
    ? linesTotal + Number(form.shippingCost || 0)
    : Number(form.amount || 0);

  function updateLine(index: number, patch: Partial<LineForm>) {
    setForm(current => ({
      ...current,
      lines: current.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    }));
  }

  function removeLine(index: number) {
    setForm(current => ({ ...current, lines: current.lines.filter((_, i) => i !== index) }));
  }

  function deadlineInfo(iso: string | null) {
    if (!iso) return null;
    const when = new Date(String(iso).replace(' ', 'T'));
    if (Number.isNaN(when.getTime())) return null;
    return {
      label: when.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }),
      overdue: when.getTime() < Date.now(),
    };
  }

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    const submitNow = submitIntent.current === 'SUBMITTED';
    try {
      const path = editingId ? `/api/v1/expenses/${editingId}` : '/api/v1/expenses';
      const result = await api<ExpenseDetail>(path, {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify({
          unitId: form.unitId,
          expenseCategoryId: form.expenseCategoryId,
          vendorId: form.vendorId || null,
          requestDate: form.requestDate,
          dueDate: form.dueDate || null,
          payeeName: form.payeeName || null,
          description: form.description,
          amount: Number(form.amount || 0),
          shippingCost: Number(form.shippingCost || 0),
          priority: form.priority,
          paymentDueAt: form.paymentDueAt ? form.paymentDueAt.replace('T', ' ') : null,
          submit: !editingId && submitNow,
          lines: form.lines.map(line => ({
            itemName: line.itemName, qty: Number(line.qty || 0), uom: line.uom || null,
            unitPrice: Number(line.unitPrice || 0),
          })),
          notes: form.notes || null,
        }),
      });
      let uploadNote = '';
      if (pendingFiles.length > 0) {
        const uploaded = await uploadAttachmentFiles('EXPENSE_REQUEST', result.id, pendingFiles);
        uploadNote = ` ${uploaded} lampiran diunggah.`;
      }
      if (editingId && submitNow) {
        await api(`/api/v1/expenses/${editingId}/submit`, { method: 'POST', body: JSON.stringify({}) });
      }
      setNotice(editingId
        ? `Pengajuan ${result.request_number} diperbarui${submitNow ? ' dan diajukan' : ''}.${uploadNote}`
        : submitNow
          ? `Pengajuan ${result.request_number} diajukan untuk persetujuan.${uploadNote}`
          : `Pengajuan ${result.request_number} tersimpan sebagai draft.${uploadNote}`);
      closeForm();
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
    ...((can('payment_request.create') || can('payment_request.approve') || can('expense.pay'))
      ? [{
        id: 'mcm' as Tab, label: 'MCM',
        count: mcmRows.filter(row => ['DRAFT', 'SUBMITTED', 'APPROVED'].includes(row.status)).length,
      }]
      : []),
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
                    <td>
                      <StatusBadge value={row.status} />
                      <div style={{ marginTop: 4, fontSize: 12 }}>
                        <span style={{
                          fontWeight: row.priority === 'MENDESAK' ? 700 : 500,
                          color: row.priority === 'MENDESAK' ? 'var(--danger, #c0392b)' : row.priority === 'TINGGI' ? '#b7791f' : 'inherit',
                        }}>
                          {row.priority || 'NORMAL'}
                        </span>
                        {(() => {
                          const info = deadlineInfo(row.payment_due_at);
                          if (!info || ['PAID', 'CANCELLED', 'REJECTED'].includes(row.status)) return null;
                          return (
                            <div style={{ color: info.overdue ? 'var(--danger, #c0392b)' : 'inherit' }}>
                              {info.overdue ? 'Lewat batas: ' : 'Batas bayar: '}{info.label}
                            </div>
                          );
                        })()}
                      </div>
                    </td>
                    <td>
                      <div className="cell-actions">
                        <button type="button" className="link-button" onClick={() => void openDetail(row)}>Detail</button>
                        {can('expense.create') && ['DRAFT', 'REJECTED'].includes(row.status) && (
                          <button type="button" className="link-button" onClick={() => void openEdit(row)} data-testid={`expense-edit-${row.id}`}>
                            <Pencil size={14} /> Edit
                          </button>
                        )}
                        {can('transaction.delete') && (
                          <button type="button" className="link-button danger" data-testid={`expense-delete-${row.id}`}
                            onClick={() => { setDeleteReason(''); setDeleting(row); }}>
                            <Trash2 size={14} /> Hapus
                          </button>
                        )}
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
                        {can('payment_request.create') && ['APPROVED', 'PAID'].includes(row.status) && Number(row.remaining) > 0 && (
                          <button type="button" className="link-button" onClick={() => openMcm(row)} data-testid={`expense-mcm-${row.id}`}>
                            Buat MCM
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

      {tab === 'mcm' && (
        <section className="card">
          <div className="card-header">
            <div>
              <h3>MCM — Pengajuan Pembayaran</h3>
              <p>Dibuat Finance, disetujui Ketua Yayasan, lalu diposting sehingga kas keluar dan jurnal terbentuk</p>
            </div>
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
                {mcmRows.map(row => (
                  <tr key={row.id}>
                    <td className="cell-muted">{row.request_number}</td>
                    <td>{dateID(row.request_date)}</td>
                    <td>
                      {row.expense_request_number}
                      <div className="cell-muted">{row.expense_description}</div>
                    </td>
                    <td>{row.unit_name}</td>
                    <td>{row.bank_name}<div className="cell-muted">{row.account_number}</div></td>
                    <td style={{ textAlign: 'right' }}>{money(row.amount)}</td>
                    <td><StatusBadge value={row.status} /></td>
                    <td>
                      <div className="cell-actions">
                        {can('payment_request.create') && ['DRAFT', 'REJECTED'].includes(row.status) && (
                          <button type="button" className="link-button"
                            onClick={() => void mcmAction(`/api/v1/payment-requests/${row.id}/submit`, {}, `MCM ${row.request_number} diajukan.`)}>
                            <Send size={14} /> Ajukan
                          </button>
                        )}
                        {can('payment_request.approve') && row.status === 'SUBMITTED' && (
                          <>
                            <button type="button" className="link-button"
                              onClick={() => void mcmAction(`/api/v1/payment-requests/${row.id}/approve`, {}, `MCM ${row.request_number} disetujui.`)}>
                              <Check size={14} /> Setujui
                            </button>
                            <button type="button" className="link-button danger"
                              onClick={() => {
                                const reason = window.prompt(`Alasan menolak ${row.request_number} (minimal 5 karakter):`) || '';
                                if (reason.trim().length < 5) { setError('Alasan minimal 5 karakter.'); return; }
                                void mcmAction(`/api/v1/payment-requests/${row.id}/reject`, { reason }, `MCM ${row.request_number} ditolak.`);
                              }}>
                              <X size={14} /> Tolak
                            </button>
                          </>
                        )}
                        {can('expense.pay') && row.status === 'APPROVED' && (
                          <button type="button" className="link-button"
                            onClick={() => void mcmAction(`/api/v1/payment-requests/${row.id}/post`, {}, `MCM ${row.request_number} diposting ke kas keluar.`)}>
                            <Wallet size={14} /> Posting
                          </button>
                        )}
                        {can('transaction.delete') && row.status !== 'POSTED' && (
                          <button type="button" className="link-button danger" onClick={() => void deleteMcm(row)}>
                            <Trash2 size={14} /> Hapus
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {mcmRows.length === 0 && <div className="table-empty">Belum ada MCM.</div>}
          </div>
        </section>
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
        <Modal title={editingId ? 'Edit Pengajuan Pembelian' : 'Ajukan Pengeluaran'} onClose={closeForm} maxWidth={960}>
          <form onSubmit={submitCreate}>
            <div className="form-grid">
              <FormSection title="1. Unit & jenis biaya" hint="dasar pencatatan beban dan rekening yang dipakai" />
              <label className="field">Unit penanggung beban
                <select className="select" value={form.unitId} disabled={Boolean(editingId)}
                  onChange={event => setForm({ ...form, unitId: event.target.value })} required>
                  <option value="">Pilih…</option>
                  {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
                </select>
                {editingId && <span className="form-hint">Unit tidak bisa diubah saat edit.</span>}
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

              <FormSection title="2. Waktu & prioritas" hint="menentukan urutan approval dan tenggat pembayaran" />
              <label className="field">Tanggal pengajuan
                <input type="date" className="input" value={form.requestDate}
                  onChange={event => setForm({ ...form, requestDate: event.target.value })} required />
              </label>
              <label className="field">Jatuh tempo (opsional)
                <input type="date" className="input" value={form.dueDate}
                  onChange={event => setForm({ ...form, dueDate: event.target.value })} />
              </label>
              <div className="field">
                <label htmlFor="expense-priority-field">Prioritas</label>
                <select id="expense-priority-field" className="select" value={form.priority}
                  onChange={event => setForm({ ...form, priority: event.target.value })} data-testid="expense-priority">
                  {PRIORITY_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label} — {option.hint}</option>
                  ))}
                </select>
                {form.priority === 'MENDESAK' && (
                  <span className="form-hint" style={{ color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <AlertTriangle size={13} /> Pengajuan akan ditandai mendesak untuk penyetuju.
                  </span>
                )}
              </div>
              <div className="field">
                <label htmlFor="expense-payment-due-field">Batas waktu pembayaran (opsional)</label>
                <input id="expense-payment-due-field" type="datetime-local" className="input" value={form.paymentDueAt}
                  onChange={event => setForm({ ...form, paymentDueAt: event.target.value })} data-testid="expense-payment-due" />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                  {DUE_PRESETS.map(preset => (
                    <button key={preset.label} type="button" className="ghost-button"
                      style={{ padding: '2px 9px', fontSize: 12, fontWeight: 600 }}
                      onClick={() => setForm({ ...form, paymentDueAt: toLocalInput(new Date(Date.now() + preset.minutes * 60000)) })}>
                      {preset.label}
                    </button>
                  ))}
                  {form.paymentDueAt && (
                    <button type="button" className="link-button danger" onClick={() => setForm({ ...form, paymentDueAt: '' })}>
                      Hapus batas
                    </button>
                  )}
                </div>
                <span className="form-hint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Clock size={13} /> Dipakai sebagai hitung mundur di daftar pengajuan sampai dibayar.
                </span>
              </div>

              <FormSection title="3. Rincian & nilai" hint="isi rincian barang agar total dihitung server" />
              <label className="field">Biaya pengiriman (Rp)
                <input className="input" inputMode="numeric" value={form.shippingCost}
                  onChange={event => setForm({ ...form, shippingCost: event.target.value })} placeholder="0" data-testid="expense-shipping" />
              </label>
              <label className="field">Nominal (Rp)
                <input className="input" inputMode="numeric"
                  value={form.lines.length > 0 ? String(grandTotal) : form.amount}
                  disabled={form.lines.length > 0}
                  onChange={event => setForm({ ...form, amount: event.target.value })}
                  required={form.lines.length === 0} data-testid="expense-amount" />
                <span className="form-hint">
                  {form.lines.length > 0 ? 'Dihitung otomatis dari rincian + ongkir.' : 'Isi manual bila tidak memakai rincian barang.'}
                </span>
              </label>

              <FormSection title="4. Uraian & catatan" hint="muncul di daftar, detail, dan dokumen cetak" />
              <label className="field" style={{ gridColumn: '1 / -1' }}>Uraian
                <input className="input" value={form.description}
                  onChange={event => setForm({ ...form, description: event.target.value })}
                  placeholder="Contoh: Honor guru bantu bulan Juli" required data-testid="expense-description" />
              </label>
              <label className="field" style={{ gridColumn: '1 / -1' }}>Catatan (opsional)
                <input className="input" value={form.notes}
                  onChange={event => setForm({ ...form, notes: event.target.value })}
                  placeholder="Keterangan tambahan untuk penyetuju" />
              </label>
            </div>

            <div style={{ marginTop: 16 }}>
              <div className="toolbar" style={{ padding: '0 0 10px', borderBottom: '1px solid var(--line)' }}>
                <strong>Rincian barang</strong>
                <span className="cell-muted">opsional · ketik nama barang sendiri</span>
                <div className="spacer" />
                {form.lines.length > 0 && <span className="cell-muted">{form.lines.length} baris</span>}
                <button type="button" className="ghost-button" data-testid="expense-line-add"
                  onClick={() => setForm({ ...form, lines: [...form.lines, { itemName: '', qty: '1', uom: '', unitPrice: '' }] })}>
                  <Plus size={14} /> Tambah baris
                </button>
              </div>
              {form.lines.length > 0 ? (
                <div className="table-wrap">
                  <table>
                    <colgroup>
                      <col />
                      <col style={{ width: 74 }} />
                      <col style={{ width: 86 }} />
                      <col style={{ width: 130 }} />
                      <col style={{ width: 104 }} />
                      <col style={{ width: 62 }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th style={{ padding: '8px 6px' }}>Nama barang</th>
                        <th style={{ padding: '8px 6px' }}>Qty</th>
                        <th style={{ padding: '8px 6px' }}>Satuan</th>
                        <th style={{ padding: '8px 6px' }}>Harga satuan</th>
                        <th style={{ padding: '8px 6px', textAlign: 'right' }}>Subtotal</th>
                        <th style={{ padding: '8px 6px' }} />
                      </tr>
                    </thead>
                    <tbody>
                      {form.lines.map((line, index) => (
                        <tr key={index}>
                          <td style={{ padding: '6px' }}>
                            <input className="input" style={{ width: '100%', padding: '7px 8px' }} value={line.itemName}
                              data-testid={`expense-line-name-${index}`}
                              onChange={event => updateLine(index, { itemName: event.target.value })}
                              placeholder="Kertas A4 80gsm" />
                          </td>
                          <td style={{ padding: '6px' }}>
                            <input className="input" style={{ width: '100%', padding: '7px 8px' }} inputMode="decimal" value={line.qty}
                              onChange={event => updateLine(index, { qty: event.target.value })} />
                          </td>
                          <td style={{ padding: '6px' }}>
                            <input className="input" style={{ width: '100%', padding: '7px 8px' }} value={line.uom}
                              onChange={event => updateLine(index, { uom: event.target.value })} placeholder="rim" />
                          </td>
                          <td style={{ padding: '6px' }}>
                            <input className="input" style={{ width: '100%', padding: '7px 8px', textAlign: 'right' }} inputMode="numeric"
                              value={line.unitPrice}
                              onChange={event => updateLine(index, { unitPrice: event.target.value })} placeholder="55000" />
                          </td>
                          <td style={{ padding: '6px', textAlign: 'right', whiteSpace: 'nowrap' }} className="cell-muted">
                            {money(lineTotal(line))}
                          </td>
                          <td style={{ padding: '6px', textAlign: 'right' }}>
                            <button type="button" className="link-button danger" title="Hapus baris"
                              onClick={() => removeLine(index)}>
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="cell-muted" style={{ padding: '14px 0' }}>Belum ada rincian barang.</div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginTop: 12 }}>
                <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }}>
                  <div className="cell-muted">Subtotal rincian</div>
                  <strong>{money(linesTotal)}</strong>
                </div>
                <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }}>
                  <div className="cell-muted">Ongkos kirim</div>
                  <strong>{money(Number(form.shippingCost || 0))}</strong>
                </div>
                <div style={{ background: 'var(--brand-soft)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }}>
                  <div className="cell-muted">Total pengajuan</div>
                  <strong style={{ fontSize: 16 }}>{money(grandTotal)}</strong>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <FormSection title="5. Lampiran" hint="opsional · maks 10 file, 5 MB per file, total 20 MB · diunggah otomatis setelah disimpan" />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                <label className="ghost-button" style={{ cursor: 'pointer' }}>
                  <Paperclip size={14} /> Pilih file
                  <input type="file" multiple hidden data-testid="expense-file-input"
                    onChange={event => {
                      const picked = Array.from(event.target.files || []);
                      event.target.value = '';
                      if (picked.length === 0) return;
                      const oversize = picked.find(file => file.size > 5 * 1024 * 1024);
                      if (oversize) { setFormError(`${oversize.name} melebihi 5 MB.`); return; }
                      const merged = [...pendingFiles, ...picked].slice(0, 10);
                      const totalBytes = merged.reduce((sum, file) => sum + file.size, 0);
                      if (totalBytes > 20 * 1024 * 1024) { setFormError('Total lampiran maksimal 20 MB.'); return; }
                      setFormError('');
                      setPendingFiles(merged);
                    }} />
                </label>
                <span className="cell-muted">
                  {pendingFiles.length === 0 ? 'Belum ada file dipilih.' : `${pendingFiles.length} file siap diunggah.`}
                </span>
              </div>
              {pendingFiles.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                  {pendingFiles.map((file, index) => (
                    <div key={`${file.name}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                      <Paperclip size={14} />
                      <span>{file.name}</span>
                      <span className="cell-muted">{(file.size / 1024).toFixed(0)} KB</span>
                      <button type="button" className="link-button danger"
                        onClick={() => setPendingFiles(current => current.filter((_, i) => i !== index))}>
                        Hapus
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {formError && <div className="form-error" style={{ marginTop: 12 }}>{formError}</div>}
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={closeForm} disabled={saving}>Batal</button>
              <button type="submit" className="ghost-button" disabled={saving} data-testid="expense-save"
                onClick={() => { submitIntent.current = 'DRAFT'; }}>
                {saving && submitIntent.current === 'DRAFT' ? 'Menyimpan…' : 'Simpan Draft'}
              </button>
              <button type="submit" className="primary-button" disabled={saving} data-testid="expense-save-submit"
                onClick={() => { submitIntent.current = 'SUBMITTED'; }}>
                {saving && submitIntent.current === 'SUBMITTED' ? 'Mengajukan…' : 'Simpan & Ajukan'}
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

      {mcmModal && (
        <Modal title={`Buat MCM — ${mcmModal.request_number}`} onClose={() => setMcmModal(null)} maxWidth={680}>
          <form onSubmit={submitMcm}>
            <div className="form-grid">
              <label className="field">Rekening pembayaran (Bank Mandiri)
                <select className="select" value={mcmForm.bankAccountId}
                  onChange={event => setMcmForm({ ...mcmForm, bankAccountId: event.target.value })} required data-testid="mcm-bank">
                  <option value="">Pilih rekening…</option>
                  {balances.filter(account =>
                    account.status === 'ACTIVE' && Boolean(account.verified_at)
                    && (account.disbursement_unit_ids || []).includes(mcmModal.unit_id),
                  ).map(account => (
                    <option key={account.id} value={account.id}>
                      {account.bank_name} — {account.account_number} ({account.account_usage})
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">Tanggal MCM
                <input type="date" className="input" value={mcmForm.requestDate}
                  onChange={event => setMcmForm({ ...mcmForm, requestDate: event.target.value })} required />
              </label>
              <label className="field">Nominal (Rp)
                <input className="input" inputMode="numeric" value={mcmForm.amount}
                  onChange={event => setMcmForm({ ...mcmForm, amount: event.target.value })} required data-testid="mcm-amount" />
              </label>
              <label className="field">Catatan (opsional)
                <input className="input" value={mcmForm.notes}
                  onChange={event => setMcmForm({ ...mcmForm, notes: event.target.value })}
                  placeholder="DP / pelunasan" />
              </label>
            </div>
            <div className="cell-muted" style={{ marginTop: 10 }}>
              Sisa pengajuan: <strong>{money(mcmModal.remaining)}</strong> · isi sebagian untuk DP, penuh untuk pelunasan.
            </div>
            {mcmError && <div className="form-error" style={{ marginTop: 12 }}>{mcmError}</div>}
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setMcmModal(null)}>Batal</button>
              <button type="submit" className="primary-button" disabled={mcmSaving} data-testid="mcm-save">
                {mcmSaving ? 'Menyimpan…' : 'Simpan MCM'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleting && (
        <Modal title={`Hapus pengajuan ${deleting.request_number}`} onClose={() => setDeleting(null)} maxWidth={560}>
          <p>Pengajuan, rincian barang, dan lampirannya akan <strong>dihapus permanen</strong>. Tindakan ini tidak bisa dibatalkan.</p>
          <label className="field" style={{ marginTop: 12 }}>Alasan (opsional)
            <input className="input" value={deleteReason} onChange={event => setDeleteReason(event.target.value)} />
          </label>
          <div className="modal-actions">
            <button type="button" className="ghost-button" onClick={() => setDeleting(null)}>Batal</button>
            <button type="button" className="primary-button danger-button" onClick={() => void confirmDelete()} data-testid="expense-delete-confirm">
              Hapus permanen
            </button>
          </div>
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

          {(detail.lines || []).length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4>Rincian barang</h4>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Barang</th><th>Qty</th><th>Satuan</th>
                      <th style={{ textAlign: 'right' }}>Harga</th><th style={{ textAlign: 'right' }}>Subtotal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.lines || []).map(line => (
                      <tr key={line.id}>
                        <td>{line.item_name}</td>
                        <td>{line.qty}</td>
                        <td className="cell-muted">{line.uom || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{money(line.unit_price)}</td>
                        <td style={{ textAlign: 'right' }}>{money(line.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="cell-muted" style={{ marginTop: 6 }}>
                Biaya pengiriman: <strong>{money(detail.shipping_cost || 0)}</strong>
              </div>
            </div>
          )}

          <Attachments entityType="EXPENSE_REQUEST" entityId={detail.id} />

          {(detail.paymentRequests || []).length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4>MCM</h4>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Nomor</th><th>Tanggal</th><th style={{ textAlign: 'right' }}>Nominal</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {(detail.paymentRequests || []).map(row => (
                      <tr key={row.id}>
                        <td className="cell-muted">{row.request_number}</td>
                        <td>{dateID(row.request_date)}</td>
                        <td style={{ textAlign: 'right' }}>{money(row.amount)}</td>
                        <td><StatusBadge value={row.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
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
