import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { BadgeCheck, Pencil, Plus, Power } from 'lucide-react';
import { api, messageOf } from '../api';
import { Modal } from '../components/Modal';
import { StatusBadge } from './Organization';
import type { BankAccount, Session } from '../types';

type Form = {
  bankName: string;
  accountNumber: string;
  accountHolder: string;
  accountUsage: 'CENTRAL' | 'DEDICATED';
  currency: string;
  glAccountCode: string;
};

const EMPTY: Form = { bankName: '', accountNumber: '', accountHolder: '', accountUsage: 'CENTRAL', currency: 'IDR', glAccountCode: '' };

export function BankAccounts({ session }: { session: Session }) {
  const canManage = session.permissions.includes('bank.manage');
  const [rows, setRows] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [editing, setEditing] = useState<BankAccount | 'new' | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api<BankAccount[]>('/api/v1/bank-accounts'));
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openCreate() {
    setForm(EMPTY);
    setFormError('');
    setEditing('new');
  }

  function openEdit(account: BankAccount) {
    setForm({
      bankName: account.bank_name,
      accountNumber: account.account_number,
      accountHolder: account.account_holder,
      accountUsage: account.account_usage,
      currency: account.currency,
      glAccountCode: account.gl_account_code || '',
    });
    setFormError('');
    setEditing(account);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      if (editing === 'new') {
        await api('/api/v1/bank-accounts', { method: 'POST', body: JSON.stringify(form) });
        setNotice('Rekening dibuat. Verifikasi agar bisa dipakai unit.');
      } else if (editing) {
        await api(`/api/v1/bank-accounts/${editing.id}`, { method: 'PUT', body: JSON.stringify(form) });
        setNotice('Rekening diperbarui.');
      }
      setEditing(null);
      await load();
    } catch (saveError) {
      setFormError(messageOf(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function verify(account: BankAccount) {
    try {
      await api(`/api/v1/bank-accounts/${account.id}/verify`, { method: 'POST' });
      setNotice('Rekening terverifikasi dan aktif.');
      await load();
    } catch (verifyError) {
      setError(messageOf(verifyError));
    }
  }

  async function deactivate(account: BankAccount) {
    const reason = window.prompt('Alasan menonaktifkan rekening (minimal 5 karakter):') || '';
    if (reason.trim().length < 5) {
      setError('Alasan minimal 5 karakter.');
      return;
    }
    try {
      await api(`/api/v1/bank-accounts/${account.id}/deactivate`, { method: 'POST', body: JSON.stringify({ reason }) });
      setNotice('Rekening dinonaktifkan. Unit terkait perlu konfigurasi ulang.');
      await load();
    } catch (deactivateError) {
      setError(messageOf(deactivateError));
    }
  }

  return (
    <div className="stack">
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="card">
        <div className="toolbar">
          <span className="cell-muted">{rows.length} rekening</span>
          <div className="spacer" />
          {canManage && (
            <button type="button" className="primary-button" onClick={openCreate} data-testid="bank-add">
              <Plus size={16} /> Tambah Rekening
            </button>
          )}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Bank</th>
                <th>Nomor</th>
                <th>Pemilik</th>
                <th>Jenis</th>
                <th>Dipakai unit</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(account => (
                <tr key={account.id}>
                  <td className="cell-strong">{account.bank_name}</td>
                  <td className="cell-muted">{account.account_number}</td>
                  <td>{account.account_holder}</td>
                  <td><span className={`badge ${account.account_usage === 'CENTRAL' ? 'info' : 'brand'}`}>{account.account_usage}</span></td>
                  <td>{account.unit_count} unit</td>
                  <td>
                    <StatusBadge value={account.status} />
                    {!account.verified_at && <span className="badge warning" style={{ marginLeft: 6 }}>Belum verifikasi</span>}
                  </td>
                  <td>
                    <div className="cell-actions">
                      {canManage && !account.verified_at && (
                        <button type="button" className="link-button" onClick={() => verify(account)}>
                          <BadgeCheck size={14} /> Verifikasi
                        </button>
                      )}
                      {canManage && (
                        <button type="button" className="link-button" onClick={() => openEdit(account)}>
                          <Pencil size={14} /> Edit
                        </button>
                      )}
                      {canManage && account.status === 'ACTIVE' && (
                        <button type="button" className="link-button danger" onClick={() => deactivate(account)}>
                          <Power size={14} /> Nonaktifkan
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && rows.length === 0 && <div className="table-empty">Belum ada rekening.</div>}
          {loading && <div className="table-empty">Memuat rekening…</div>}
        </div>
      </section>

      {editing && (
        <Modal title={editing === 'new' ? 'Tambah Rekening' : `Edit Rekening — ${editing.bank_name}`} onClose={() => setEditing(null)}>
          <form onSubmit={save}>
            <div className="form-grid">
              <label className="field">Nama bank
                <input className="input" value={form.bankName} onChange={event => setForm({ ...form, bankName: event.target.value })} required placeholder="Bank Central Asia" />
              </label>
              <label className="field">Nomor rekening
                <input className="input" value={form.accountNumber} onChange={event => setForm({ ...form, accountNumber: event.target.value })} required placeholder="1234567890" />
              </label>
              <label className="field full">Pemilik rekening
                <input className="input" value={form.accountHolder} onChange={event => setForm({ ...form, accountHolder: event.target.value })} required placeholder="Yayasan Pendidikan Harapan" />
              </label>
              <label className="field">Jenis rekening
                <select className="select" value={form.accountUsage} onChange={event => setForm({ ...form, accountUsage: event.target.value as Form['accountUsage'] })}>
                  <option value="CENTRAL">CENTRAL — rekening pusat</option>
                  <option value="DEDICATED">DEDICATED — rekening khusus unit</option>
                </select>
              </label>
              <label className="field">Mata uang
                <input className="input" value={form.currency} onChange={event => setForm({ ...form, currency: event.target.value.toUpperCase() })} />
              </label>
              <label className="field full">Kode akun GL
                <input className="input" value={form.glAccountCode} onChange={event => setForm({ ...form, glAccountCode: event.target.value })} placeholder="1-1100" />
              </label>
              {formError && <div className="form-error">{formError}</div>}
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setEditing(null)}>Batal</button>
              <button type="submit" className="primary-button" disabled={saving} data-testid="bank-save">
                {saving ? 'Menyimpan…' : 'Simpan'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
