import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeftRight, Plus, RefreshCw, Scale, Trash2 } from 'lucide-react';
import { api, messageOf } from '../api';
import { Modal } from '../components/Modal';
import { dateID, money, todayISO } from '../format';
import { StatusBadge } from './Organization';
import type {
  Account, FiscalPeriod, Hierarchy, JournalEntryDetail, JournalEntryRow, LedgerRow,
  Permission, Reconciliation, Session, TrialBalance,
} from '../types';

type Tab = 'journal' | 'ledger' | 'reconciliation' | 'periods' | 'accounts';

type DraftLine = { accountCode: string; debit: string; credit: string; description: string };

const emptyLine = (): DraftLine => ({ accountCode: '', debit: '', credit: '', description: '' });

const SOURCE_OPTIONS = ['', 'INVOICE', 'RECEIPT', 'RECEIPT_VOID', 'EXPENSE_PAYMENT', 'EXPENSE_PAYMENT_VOID', 'MANUAL'];

export function Accounting({ session }: { session: Session }) {
  const can = (permission: Permission) => session.permissions.includes(permission);

  const [tab, setTab] = useState<Tab>('journal');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<JournalEntryRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [trial, setTrial] = useState<TrialBalance | null>(null);
  const [recon, setRecon] = useState<Reconciliation | null>(null);
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);

  const [filters, setFilters] = useState({ from: '', to: '', q: '', sourceType: '', accountCode: '', unitId: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  const [detail, setDetail] = useState<JournalEntryDetail | null>(null);
  const [detailError, setDetailError] = useState('');

  const [posting, setPosting] = useState(false);
  const [manual, setManual] = useState({ entryDate: todayISO(), description: '', unitId: '' });
  const [manualLines, setManualLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);
  const [manualError, setManualError] = useState('');
  const [saving, setSaving] = useState(false);

  const [accountForm, setAccountForm] = useState({
    code: '', name: '', accountType: 'EXPENSE', normalBalance: 'DEBIT',
  });

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ pageSize: '100' });
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.q.trim()) params.set('q', filters.q.trim());
      if (filters.sourceType) params.set('sourceType', filters.sourceType);
      if (filters.unitId) params.set('unitId', filters.unitId);
      const result = await api<{ rows: JournalEntryRow[] }>(`/api/v1/journal-entries?${params.toString()}`);
      setEntries(result.rows);
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  const loadLedger = useCallback(async () => {
    try {
      const params = new URLSearchParams({ pageSize: '100' });
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.accountCode) params.set('accountCode', filters.accountCode);
      if (filters.unitId) params.set('unitId', filters.unitId);
      setLedger((await api<{ rows: LedgerRow[] }>(`/api/v1/accounting/general-ledger?${params.toString()}`)).rows);
    } catch (loadError) {
      setError(messageOf(loadError));
    }
  }, [filters]);

  const loadReports = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.unitId) params.set('unitId', filters.unitId);
      const [trialResult, reconResult] = await Promise.all([
        api<TrialBalance>(`/api/v1/accounting/trial-balance?${params.toString()}`),
        api<Reconciliation>('/api/v1/accounting/reconciliation'),
      ]);
      setTrial(trialResult);
      setRecon(reconResult);
    } catch (loadError) {
      setError(messageOf(loadError));
    }
  }, [filters]);

  const loadSupport = useCallback(async () => {
    api<Account[]>('/api/v1/accounts').then(setAccounts).catch(() => undefined);
    api<FiscalPeriod[]>('/api/v1/fiscal-periods').then(setPeriods).catch(() => undefined);
    api<Hierarchy>('/api/v1/organization/hierarchy').then(setHierarchy).catch(() => undefined);
  }, []);

  useEffect(() => { void loadSupport(); }, [loadSupport]);
  useEffect(() => { void loadEntries(); }, [loadEntries]);
  useEffect(() => { void loadLedger(); }, [loadLedger]);
  useEffect(() => { void loadReports(); }, [loadReports]);

  const units = hierarchy?.units || [];
  const postableAccounts = accounts.filter(account => account.is_postable && account.status === 'ACTIVE');
  const debitTotal = manualLines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
  const creditTotal = manualLines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
  const difference = debitTotal - creditTotal;

  async function refreshAll() {
    await Promise.all([loadEntries(), loadLedger(), loadReports(), loadSupport()]);
  }

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setManualLines(current => current.map((line, position) => (
      position === index ? { ...line, ...patch } : line
    )));
  }

  function openManual() {
    setManual({ entryDate: todayISO(), description: '', unitId: '' });
    setManualLines([emptyLine(), emptyLine()]);
    setManualError('');
    setPosting(true);
  }

  async function submitManual(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setManualError('');
    try {
      await api('/api/v1/journal-entries', {
        method: 'POST',
        body: JSON.stringify({
          entryDate: manual.entryDate,
          description: manual.description,
          unitId: manual.unitId || null,
          lines: manualLines
            .filter(line => line.accountCode)
            .map(line => ({
              accountCode: line.accountCode,
              debit: Number(line.debit || 0),
              credit: Number(line.credit || 0),
              description: line.description || null,
            })),
        }),
      });
      setNotice('Jurnal manual tersimpan.');
      setPosting(false);
      await refreshAll();
    } catch (submitError) {
      setManualError(messageOf(submitError));
    } finally {
      setSaving(false);
    }
  }

  async function act(path: string, body: Record<string, unknown>, successMessage: string) {
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice(successMessage);
      setError('');
      await refreshAll();
    } catch (actionError) {
      setError(messageOf(actionError));
    }
  }

  async function openDetail(row: JournalEntryRow) {
    setDetailError('');
    try {
      setDetail(await api<JournalEntryDetail>(`/api/v1/journal-entries/${row.id}`));
    } catch (loadError) {
      setDetailError(messageOf(loadError));
    }
  }

  function reverseEntry(row: JournalEntryRow) {
    const reason = window.prompt(`Alasan membalik ${row.entry_number} (minimal 5 karakter):`) || '';
    if (reason.trim().length < 5) { setError('Alasan minimal 5 karakter.'); return; }
    void act(`/api/v1/journal-entries/${row.id}/reverse`, { reason }, `Jurnal ${row.entry_number} dibalik.`);
  }

  function reopenPeriod(period: FiscalPeriod) {
    const reason = window.prompt(`Alasan membuka ${period.name} (minimal 5 karakter):`) || '';
    if (reason.trim().length < 5) { setError('Alasan minimal 5 karakter.'); return; }
    void act(`/api/v1/fiscal-periods/${period.id}/reopen`, { reason }, `Periode ${period.name} dibuka kembali.`);
  }

  async function createAccount(event: FormEvent) {
    event.preventDefault();
    try {
      await api('/api/v1/accounts', {
        method: 'POST',
        body: JSON.stringify({
          code: accountForm.code, name: accountForm.name,
          accountType: accountForm.accountType, normalBalance: accountForm.normalBalance,
        }),
      });
      setAccountForm({ code: '', name: '', accountType: 'EXPENSE', normalBalance: 'DEBIT' });
      setNotice('Akun CoA ditambahkan.');
      await refreshAll();
    } catch (createError) {
      setError(messageOf(createError));
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'journal', label: 'Jurnal' },
    { id: 'ledger', label: 'Buku Besar' },
    { id: 'reconciliation', label: 'Rekonsiliasi' },
    { id: 'periods', label: 'Periode' },
    { id: 'accounts', label: 'Akun (CoA)' },
  ];

  return (
    <div className="stack">
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="card">
        <div className="toolbar">
          {tabs.map(item => (
            <button key={item.id} type="button" className={tab === item.id ? 'primary-button' : 'ghost-button'}
              onClick={() => setTab(item.id)}>{item.label}</button>
          ))}
          <div className="spacer" />
          {can('journal.post') && (
            <button type="button" className="primary-button" onClick={openManual} data-testid="journal-add">
              <Plus size={16} /> Jurnal Manual
            </button>
          )}
        </div>
      </section>

      {tab !== 'reconciliation' && tab !== 'periods' && tab !== 'accounts' && (
        <section className="card">
          <div className="toolbar">
            <input className="input search" placeholder="Cari nomor / keterangan…" value={filters.q}
              onChange={event => setFilters({ ...filters, q: event.target.value })} />
            {tab === 'journal' && (
              <select className="select" value={filters.sourceType}
                onChange={event => setFilters({ ...filters, sourceType: event.target.value })}>
                {SOURCE_OPTIONS.map(source => (
                  <option key={source || 'ALL'} value={source}>{source || 'Semua sumber'}</option>
                ))}
              </select>
            )}
            {tab === 'ledger' && (
              <select className="select" value={filters.accountCode}
                onChange={event => setFilters({ ...filters, accountCode: event.target.value })}>
                <option value="">Semua akun</option>
                {postableAccounts.map(account => (
                  <option key={account.id} value={account.code}>{account.code} — {account.name}</option>
                ))}
              </select>
            )}
            <select className="select" value={filters.unitId}
              onChange={event => setFilters({ ...filters, unitId: event.target.value })}>
              <option value="">Semua unit</option>
              {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
            </select>
            <input type="date" className="input" value={filters.from}
              onChange={event => setFilters({ ...filters, from: event.target.value })} />
            <input type="date" className="input" value={filters.to}
              onChange={event => setFilters({ ...filters, to: event.target.value })} />
          </div>
        </section>
      )}

      {tab === 'journal' && (
        <section className="card">
          <div className="card-header">
            <div><h3>Jurnal umum</h3><p>Jurnal otomatis dari tagihan, penerimaan, dan pengeluaran</p></div>
            <span className="cell-muted">{entries.length} baris</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nomor</th><th>Tanggal</th><th>Keterangan</th><th>Unit</th><th>Sumber</th>
                  <th style={{ textAlign: 'right' }}>Nilai</th><th>Status</th>
                  <th style={{ textAlign: 'right' }}>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => (
                  <tr key={entry.id}>
                    <td className="cell-muted">{entry.entry_number}</td>
                    <td>{dateID(entry.entry_date)}</td>
                    <td>
                      {entry.description}
                      {entry.entry_kind === 'REVERSAL' && <span className="badge info" style={{ marginLeft: 6 }}>REVERSAL</span>}
                    </td>
                    <td>{entry.unit_name || '—'}</td>
                    <td className="cell-muted">{entry.source_type}</td>
                    <td style={{ textAlign: 'right' }}>{money(entry.total_debit)}</td>
                    <td><StatusBadge value={entry.status} /></td>
                    <td>
                      <div className="cell-actions">
                        <button type="button" className="link-button" onClick={() => void openDetail(entry)}>Detail</button>
                        {can('journal.post') && entry.status === 'POSTED' && entry.entry_kind === 'ORIGINAL' && (
                          <button type="button" className="link-button danger" onClick={() => reverseEntry(entry)}>
                            <ArrowLeftRight size={14} /> Balik
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {loading && <div className="table-empty">Memuat jurnal…</div>}
            {!loading && entries.length === 0 && <div className="table-empty">Belum ada jurnal.</div>}
          </div>
        </section>
      )}

      {tab === 'ledger' && (
        <section className="card">
          <div className="card-header"><div><h3>Buku besar</h3><p>Rincian per akun untuk rentang tanggal terpilih</p></div></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tanggal</th><th>Nomor</th><th>Akun</th><th>Keterangan</th><th>Unit</th>
                  <th style={{ textAlign: 'right' }}>Debit</th><th style={{ textAlign: 'right' }}>Kredit</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map(row => (
                  <tr key={row.id}>
                    <td>{dateID(row.entry_date)}</td>
                    <td className="cell-muted">{row.entry_number}</td>
                    <td>{row.account_code} <span className="cell-muted">· {row.account_name}</span></td>
                    <td className="cell-muted">{row.description || row.entry_description}</td>
                    <td>{row.unit_name || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{num(row.debit) ? money(row.debit) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{num(row.credit) ? money(row.credit) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ledger.length === 0 && <div className="table-empty">Tidak ada mutasi akun pada filter ini.</div>}
          </div>

          {trial && (
            <>
              <div className="card-header" style={{ marginTop: 12 }}>
                <div><h3>Neraca saldo</h3><p>{dateID(trial.from)} — {dateID(trial.to)}</p></div>
                <span className={`badge ${trial.balanced ? 'success' : 'danger'}`}>
                  {trial.balanced ? 'SEIMBANG' : 'TIDAK SEIMBANG'}
                </span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Akun</th><th>Tipe</th>
                      <th style={{ textAlign: 'right' }}>Debit</th>
                      <th style={{ textAlign: 'right' }}>Kredit</th>
                      <th style={{ textAlign: 'right' }}>Saldo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trial.items.map(item => (
                      <tr key={item.code}>
                        <td>{item.code} <span className="cell-muted">· {item.name}</span></td>
                        <td className="cell-muted">{item.account_type}</td>
                        <td style={{ textAlign: 'right' }}>{money(item.debit)}</td>
                        <td style={{ textAlign: 'right' }}>{money(item.credit)}</td>
                        <td style={{ textAlign: 'right' }} className="cell-strong">{money(item.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {tab === 'reconciliation' && recon && (
        <section className="card">
          <div className="card-header">
            <div><h3>Rekonsiliasi</h3><p>Per {dateID(recon.asOf)} — subledger vs buku besar</p></div>
            <div className="cell-muted">
              <Scale size={16} /> {recon.balanced ? 'Seimbang' : 'Ada selisih'}
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Komponen</th><th style={{ textAlign: 'right' }}>Subledger / Fisik</th><th style={{ textAlign: 'right' }}>Buku besar</th><th style={{ textAlign: 'right' }}>Selisih</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td>Piutang siswa vs tagihan</td>
                  <td style={{ textAlign: 'right' }}>{money(recon.receivable.subledger)}</td>
                  <td style={{ textAlign: 'right' }}>{money(recon.receivable.gl)}</td>
                  <td style={{ textAlign: 'right' }} className={Math.abs(recon.receivable.difference) < 0.005 ? '' : 'cell-strong'}>
                    {money(recon.receivable.difference)}
                  </td>
                </tr>
                <tr>
                  <td>Uang muka siswa vs penerimaan belum dialokasikan</td>
                  <td style={{ textAlign: 'right' }}>{money(recon.deposit.subledger)}</td>
                  <td style={{ textAlign: 'right' }}>{money(recon.deposit.gl)}</td>
                  <td style={{ textAlign: 'right' }} className={Math.abs(recon.deposit.difference) < 0.005 ? '' : 'cell-strong'}>
                    {money(recon.deposit.difference)}
                  </td>
                </tr>
                <tr>
                  <td>
                    Kas & bank vs mutasi
                    <div className="cell-muted">termasuk jurnal manual {money(recon.cash.manualAdjustments)}</div>
                  </td>
                  <td style={{ textAlign: 'right' }}>{money(recon.cash.mutations)}</td>
                  <td style={{ textAlign: 'right' }}>{money(recon.cash.gl)}</td>
                  <td style={{ textAlign: 'right' }} className={Math.abs(recon.cash.unexplained) < 0.005 ? '' : 'cell-strong'}>
                    {money(recon.cash.unexplained)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {can('journal.post') && (
            <div className="toolbar" style={{ marginTop: 12 }}>
              <div className="spacer" />
              <button type="button" className="ghost-button" data-testid="journal-backfill"
                onClick={() => {
                  if (!window.confirm('Posting jurnal untuk transaksi lama yang belum punya jurnal?')) return;
                  void act('/api/v1/accounting/backfill', {}, 'Backfill jurnal selesai.');
                }}>
                <RefreshCw size={16} /> Backfill Jurnal
              </button>
            </div>
          )}
        </section>
      )}

      {tab === 'periods' && (
        <section className="card">
          <div className="card-header"><div><h3>Periode fiskal</h3><p>Posting ke periode yang ditutup akan ditolak (ACC-03)</p></div></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Periode</th><th>Mulai</th><th>Akhir</th><th>Status</th><th>Ditutup</th>
                  <th style={{ textAlign: 'right' }}>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {periods.map(period => (
                  <tr key={period.id}>
                    <td className="cell-strong">{period.name}</td>
                    <td>{dateID(period.start_date)}</td>
                    <td>{dateID(period.end_date)}</td>
                    <td><StatusBadge value={period.status} /></td>
                    <td className="cell-muted">{period.closed_at ? `${dateID(period.closed_at.slice(0, 10))} · ${period.closed_by_name || '—'}` : '—'}</td>
                    <td>
                      <div className="cell-actions">
                        {can('period.close') && period.status === 'OPEN' && (
                          <button type="button" className="link-button"
                            onClick={() => void act(`/api/v1/fiscal-periods/${period.id}/close`, {}, `Periode ${period.name} ditutup.`)}>
                            Tutup
                          </button>
                        )}
                        {can('period.close') && period.status === 'CLOSED' && (
                          <button type="button" className="link-button danger" onClick={() => reopenPeriod(period)}>
                            Buka kembali
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {periods.length === 0 && <div className="table-empty">Belum ada periode.</div>}
          </div>
        </section>
      )}

      {tab === 'accounts' && (
        <section className="card">
          <div className="card-header"><div><h3>Bagan akun (CoA)</h3><p>Kode akun dipakai pada mapping tarif, jenis biaya, dan rekening</p></div></div>
          {can('coa.manage') && (
            <form className="form-grid" onSubmit={createAccount} style={{ padding: 16 }}>
              <label className="field">Kode
                <input className="input" placeholder="5-2200" value={accountForm.code}
                  onChange={event => setAccountForm({ ...accountForm, code: event.target.value })} required />
              </label>
              <label className="field">Nama
                <input className="input" value={accountForm.name}
                  onChange={event => setAccountForm({ ...accountForm, name: event.target.value })} required />
              </label>
              <label className="field">Tipe
                <select className="select" value={accountForm.accountType}
                  onChange={event => setAccountForm({ ...accountForm, accountType: event.target.value })}>
                  <option value="ASSET">ASSET</option>
                  <option value="LIABILITY">LIABILITY</option>
                  <option value="EQUITY">EQUITY</option>
                  <option value="REVENUE">REVENUE</option>
                  <option value="EXPENSE">EXPENSE</option>
                </select>
              </label>
              <label className="field">Saldo normal
                <select className="select" value={accountForm.normalBalance}
                  onChange={event => setAccountForm({ ...accountForm, normalBalance: event.target.value })}>
                  <option value="DEBIT">DEBIT</option>
                  <option value="CREDIT">CREDIT</option>
                </select>
              </label>
              <div style={{ alignSelf: 'end' }}>
                <button type="submit" className="primary-button">Tambah akun</button>
              </div>
            </form>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Kode</th><th>Nama</th><th>Tipe</th><th>Saldo normal</th><th>Postable</th><th>Status</th></tr>
              </thead>
              <tbody>
                {accounts.map(account => (
                  <tr key={account.id}>
                    <td className="cell-muted">{account.code}</td>
                    <td>{account.name}</td>
                    <td className="cell-muted">{account.account_type}</td>
                    <td className="cell-muted">{account.normal_balance}</td>
                    <td>{account.is_postable ? 'Ya' : 'Tidak'}</td>
                    <td><StatusBadge value={account.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {posting && (
        <Modal title="Jurnal Manual" onClose={() => setPosting(false)} maxWidth={900}>
          <form onSubmit={submitManual}>
            <div className="form-grid">
              <label className="field">Tanggal
                <input type="date" className="input" value={manual.entryDate}
                  onChange={event => setManual({ ...manual, entryDate: event.target.value })} required />
              </label>
              <label className="field">Unit (opsional)
                <select className="select" value={manual.unitId}
                  onChange={event => setManual({ ...manual, unitId: event.target.value })}>
                  <option value="">Entitas / yayasan</option>
                  {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
                </select>
              </label>
            </div>
            <label className="field" style={{ marginTop: 12 }}>Keterangan
              <input className="input" value={manual.description}
                onChange={event => setManual({ ...manual, description: event.target.value })}
                placeholder="Contoh: Koreksi beban listrik Juli" required />
            </label>

            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table>
                <thead>
                  <tr>
                    <th>Akun</th><th>Keterangan</th>
                    <th style={{ width: 130 }}>Debit</th><th style={{ width: 130 }}>Kredit</th><th />
                  </tr>
                </thead>
                <tbody>
                  {manualLines.map((line, index) => (
                    <tr key={index}>
                      <td>
                        <select className="select" value={line.accountCode}
                          onChange={event => updateLine(index, { accountCode: event.target.value })} required>
                          <option value="">Pilih akun…</option>
                          {postableAccounts.map(account => (
                            <option key={account.id} value={account.code}>{account.code} — {account.name}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input className="input" value={line.description}
                          onChange={event => updateLine(index, { description: event.target.value })} />
                      </td>
                      <td>
                        <input className="input" inputMode="numeric" value={line.debit}
                          onChange={event => updateLine(index, { debit: event.target.value, credit: '' })} />
                      </td>
                      <td>
                        <input className="input" inputMode="numeric" value={line.credit}
                          onChange={event => updateLine(index, { credit: event.target.value, debit: '' })} />
                      </td>
                      <td>
                        <button type="button" className="link-button danger"
                          disabled={manualLines.length <= 2}
                          onClick={() => setManualLines(current => current.filter((_, position) => position !== index))}>
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="toolbar" style={{ marginTop: 10 }}>
              <button type="button" className="ghost-button"
                onClick={() => setManualLines(current => [...current, emptyLine()])}>
                <Plus size={16} /> Tambah baris
              </button>
              <div className="spacer" />
              <span className="cell-muted">
                Debit {money(debitTotal)} · Kredit {money(creditTotal)} ·{' '}
                <strong className={difference === 0 ? '' : 'danger'}>
                  {difference === 0 ? 'seimbang' : `selisih ${money(Math.abs(difference))}`}
                </strong>
              </span>
            </div>

            {manualError && <div className="form-error" style={{ marginTop: 12 }}>{manualError}</div>}
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setPosting(false)}>Batal</button>
              <button type="submit" className="primary-button"
                disabled={saving || difference !== 0 || manualLines.filter(line => line.accountCode).length < 2}>
                {saving ? 'Menyimpan…' : 'Posting Jurnal'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {detail && (
        <Modal title={`Jurnal ${detail.entry_number}`} onClose={() => setDetail(null)} maxWidth={760}>
          {detailError && <div className="form-error">{detailError}</div>}
          <div className="detail-grid">
            <div><span>Tanggal</span><strong>{dateID(detail.entry_date)}</strong></div>
            <div><span>Periode</span><strong>{detail.period_name}</strong></div>
            <div><span>Unit</span><strong>{detail.unit_name || 'Yayasan'}</strong></div>
            <div><span>Status</span><strong><StatusBadge value={detail.status} /></strong></div>
            <div><span>Sumber</span><strong>{detail.source_type}</strong></div>
            <div><span>Dibuat oleh</span><strong>{detail.created_by_name || '—'}</strong></div>
          </div>
          <p className="cell-strong" style={{ marginTop: 12 }}>{detail.description}</p>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th>Akun</th><th>Keterangan</th>
                  <th style={{ textAlign: 'right' }}>Debit</th>
                  <th style={{ textAlign: 'right' }}>Kredit</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map(line => (
                  <tr key={line.id}>
                    <td>{line.account_code} <span className="cell-muted">· {line.account_name}</span></td>
                    <td className="cell-muted">{line.description || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{num(line.debit) ? money(line.debit) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{num(line.credit) ? money(line.credit) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}

function num(value: string | number) {
  return Number(value || 0);
}
