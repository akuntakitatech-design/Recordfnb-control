import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Pencil, Plus, UserRoundSearch } from 'lucide-react';
import { api, messageOf } from '../api';
import { Modal } from '../components/Modal';
import { dateID, money, todayISO } from '../format';
import { StatusBadge } from './Organization';
import type {
  Hierarchy, InvoiceRow, Permission, Session, StudentDetail, StudentRow,
} from '../types';

type StudentForm = {
  nis: string;
  nisn: string;
  fullName: string;
  gender: '' | 'L' | 'P';
  birthDate: string;
  guardianName: string;
  guardianPhone: string;
  address: string;
  unitId: string;
  academicYearId: string;
  classLabel: string;
  effectiveStart: string;
};

const EMPTY: StudentForm = {
  nis: '', nisn: '', fullName: '', gender: '', birthDate: '', guardianName: '', guardianPhone: '',
  address: '', unitId: '', academicYearId: '', classLabel: '', effectiveStart: todayISO(),
};

export function Students({ session }: { session: Session }) {
  const can = (permission: Permission) => session.permissions.includes(permission);

  const [rows, setRows] = useState<StudentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [search, setSearch] = useState('');
  const [unitId, setUnitId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [editing, setEditing] = useState<StudentRow | 'new' | null>(null);
  const [form, setForm] = useState<StudentForm>(EMPTY);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState<StudentDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [move, setMove] = useState({ unitId: '', academicYearId: '', classLabel: '', effectiveStart: todayISO(), reason: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ pageSize: '100' });
      if (search.trim()) params.set('q', search.trim());
      if (unitId) params.set('unitId', unitId);
      const result = await api<{ rows: StudentRow[]; total: number }>(`/api/v1/students?${params.toString()}`);
      setRows(result.rows);
      setTotal(result.total);
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [search, unitId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<Hierarchy>('/api/v1/organization/hierarchy').then(setHierarchy).catch(() => undefined);
  }, []);

  const units = hierarchy?.units || [];
  const years = hierarchy?.academicYears || [];

  function openCreate() {
    setForm({
      ...EMPTY,
      unitId: units[0]?.id || '',
      academicYearId: years[0]?.id || '',
    });
    setFormError('');
    setEditing('new');
  }

  function openEdit(student: StudentRow) {
    setForm({
      nis: student.nis,
      nisn: student.nisn || '',
      fullName: student.full_name,
      gender: student.gender || '',
      birthDate: student.birth_date || '',
      guardianName: student.guardian_name || '',
      guardianPhone: student.guardian_phone || '',
      address: student.address || '',
      unitId: '',
      academicYearId: '',
      classLabel: '',
      effectiveStart: '',
    });
    setFormError('');
    setEditing(student);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      if (editing === 'new') {
        await api('/api/v1/students', {
          method: 'POST',
          body: JSON.stringify({
            nis: form.nis,
            nisn: form.nisn || null,
            fullName: form.fullName,
            gender: form.gender || null,
            birthDate: form.birthDate || null,
            guardianName: form.guardianName || null,
            guardianPhone: form.guardianPhone || null,
            address: form.address || null,
            unitId: form.unitId,
            academicYearId: form.academicYearId,
            classLabel: form.classLabel || null,
            effectiveStart: form.effectiveStart,
          }),
        });
        setNotice('Siswa dan penempatan unit tersimpan.');
      } else if (editing) {
        await api(`/api/v1/students/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            nisn: form.nisn || null,
            fullName: form.fullName,
            gender: form.gender || null,
            birthDate: form.birthDate || null,
            guardianName: form.guardianName || null,
            guardianPhone: form.guardianPhone || null,
            address: form.address || null,
          }),
        });
        setNotice('Data siswa diperbarui.');
      }
      setEditing(null);
      await load();
    } catch (saveError) {
      setFormError(messageOf(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(studentId: string) {
    setDetailError('');
    try {
      const result = await api<StudentDetail>(`/api/v1/students/${studentId}`);
      setDetail(result);
      setMove({
        unitId: result.enrollment?.unit_id || '',
        academicYearId: result.enrollment?.academic_year_id || '',
        classLabel: result.enrollment?.class_label || '',
        effectiveStart: todayISO(),
        reason: '',
      });
    } catch (loadError) {
      setDetailError(messageOf(loadError));
    }
  }

  async function submitMove(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    setDetailError('');
    try {
      await api(`/api/v1/students/${detail.student.id}/enrollments`, {
        method: 'POST',
        body: JSON.stringify({
          unitId: move.unitId,
          academicYearId: move.academicYearId,
          classLabel: move.classLabel || null,
          effectiveStart: move.effectiveStart,
          reason: move.reason || null,
        }),
      });
      await openDetail(detail.student.id);
      await load();
    } catch (moveError) {
      setDetailError(messageOf(moveError));
    }
  }

  return (
    <div className="stack">
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="card">
        <div className="toolbar">
          <input
            className="input search"
            placeholder="Cari nama atau NIS…"
            value={search}
            onChange={event => setSearch(event.target.value)}
            data-testid="student-search"
          />
          <select className="select" value={unitId} onChange={event => setUnitId(event.target.value)}>
            <option value="">Semua unit</option>
            {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
          </select>
          <div className="spacer" />
          <span className="cell-muted">{total} siswa</span>
          {can('student.manage') && (
            <button type="button" className="primary-button" onClick={openCreate} data-testid="student-add">
              <Plus size={16} /> Tambah Siswa
            </button>
          )}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>NIS</th><th>Nama</th><th>Unit</th><th>Kelas</th><th>Tahun ajaran</th><th>Wali</th><th style={{ textAlign: 'right' }}>Aksi</th></tr>
            </thead>
            <tbody>
              {rows.map(student => (
                <tr key={student.id}>
                  <td className="cell-muted">{student.nis}</td>
                  <td className="cell-strong">{student.full_name}</td>
                  <td>{student.unit_name}</td>
                  <td>{student.class_label || '—'}</td>
                  <td className="cell-muted">{student.academic_year_name}</td>
                  <td className="cell-muted">{student.guardian_name || '—'}</td>
                  <td>
                    <div className="cell-actions">
                      {can('student.manage') && (
                        <button type="button" className="link-button" onClick={() => openEdit(student)}>
                          <Pencil size={14} /> Edit
                        </button>
                      )}
                      <button type="button" className="link-button" onClick={() => openDetail(student.id)}>
                        <UserRoundSearch size={14} /> Detail
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && rows.length === 0 && <div className="table-empty">Belum ada siswa.</div>}
          {loading && <div className="table-empty">Memuat siswa…</div>}
        </div>
      </section>

      {editing && (
        <Modal
          title={editing === 'new' ? 'Tambah Siswa' : `Edit Siswa — ${editing.full_name}`}
          onClose={() => setEditing(null)}
          maxWidth={720}
        >
          <form onSubmit={save}>
            <div className="form-grid">
              <label className="field">NIS
                <input className="input" value={form.nis} onChange={event => setForm({ ...form, nis: event.target.value })} required disabled={editing !== 'new'} />
              </label>
              <label className="field">NISN
                <input className="input" value={form.nisn} onChange={event => setForm({ ...form, nisn: event.target.value })} />
              </label>
              <label className="field full">Nama lengkap
                <input className="input" value={form.fullName} onChange={event => setForm({ ...form, fullName: event.target.value })} required />
              </label>
              <label className="field">Jenis kelamin
                <select className="select" value={form.gender} onChange={event => setForm({ ...form, gender: event.target.value as StudentForm['gender'] })}>
                  <option value="">—</option><option value="L">Laki-laki</option><option value="P">Perempuan</option>
                </select>
              </label>
              <label className="field">Tanggal lahir
                <input type="date" className="input" value={form.birthDate} onChange={event => setForm({ ...form, birthDate: event.target.value })} />
              </label>
              <label className="field">Nama wali
                <input className="input" value={form.guardianName} onChange={event => setForm({ ...form, guardianName: event.target.value })} />
              </label>
              <label className="field">Telepon wali
                <input className="input" value={form.guardianPhone} onChange={event => setForm({ ...form, guardianPhone: event.target.value })} />
              </label>
              <label className="field full">Alamat
                <input className="input" value={form.address} onChange={event => setForm({ ...form, address: event.target.value })} />
              </label>

              {editing === 'new' && (
                <>
                  <label className="field">Unit / cabang
                    <select className="select" value={form.unitId} onChange={event => setForm({ ...form, unitId: event.target.value })} required>
                      <option value="">Pilih…</option>
                      {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
                    </select>
                  </label>
                  <label className="field">Tahun ajaran
                    <select className="select" value={form.academicYearId} onChange={event => setForm({ ...form, academicYearId: event.target.value })} required>
                      <option value="">Pilih…</option>
                      {years.map(year => <option key={year.id} value={year.id}>{year.name}</option>)}
                    </select>
                  </label>
                  <label className="field">Kelas / kelompok
                    <input className="input" value={form.classLabel} onChange={event => setForm({ ...form, classLabel: event.target.value })} placeholder="TK A / Kelas 1" />
                  </label>
                  <label className="field">Mulai efektif
                    <input type="date" className="input" value={form.effectiveStart} onChange={event => setForm({ ...form, effectiveStart: event.target.value })} required />
                  </label>
                </>
              )}

              {formError && <div className="form-error">{formError}</div>}
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setEditing(null)}>Batal</button>
              <button type="submit" className="primary-button" disabled={saving} data-testid="student-save">
                {saving ? 'Menyimpan…' : 'Simpan'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {detail && (
        <Modal title={`${detail.student.full_name} — ${detail.student.nis}`} onClose={() => setDetail(null)} maxWidth={860}>
          {detailError && <div className="form-error" style={{ marginBottom: 12 }}>{detailError}</div>}
          <div className="stack">
            <div className="detail-grid">
              <Info label="Unit" value={detail.enrollment?.unit_name || '—'} />
              <Info label="Kelas" value={detail.enrollment?.class_label || '—'} />
              <Info label="Tahun ajaran" value={detail.enrollment?.academic_year_name || '—'} />
              <Info label="Wali" value={detail.student.guardian_name || '—'} />
              <Info label="Telepon" value={detail.student.guardian_phone || '—'} />
              <Info label="Status" value={<StatusBadge value={detail.student.status} />} />
            </div>

            <section>
              <h4 style={{ marginBottom: 8 }}>Riwayat penempatan</h4>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Unit</th><th>Kelas</th><th>Tahun</th><th>Periode</th><th>Status</th></tr></thead>
                  <tbody>
                    {detail.enrollments.map(enrollment => (
                      <tr key={enrollment.id}>
                        <td>{enrollment.unit_name}</td>
                        <td>{enrollment.class_label || '—'}</td>
                        <td>{enrollment.academic_year_name}</td>
                        <td className="cell-muted">{dateID(enrollment.effective_start)} → {enrollment.effective_end ? dateID(enrollment.effective_end) : 'sekarang'}</td>
                        <td><StatusBadge value={enrollment.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h4 style={{ marginBottom: 8 }}>Tagihan terakhir</h4>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Nomor</th><th>Periode</th><th>Jatuh tempo</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Sisa</th><th>Status</th></tr></thead>
                  <tbody>
                    {detail.invoices.map((invoice: InvoiceRow) => (
                      <tr key={invoice.id}>
                        <td className="cell-muted">{invoice.invoice_number}</td>
                        <td>{invoice.period_label}</td>
                        <td>{dateID(invoice.due_date)}</td>
                        <td style={{ textAlign: 'right' }}>{money(invoice.total_amount)}</td>
                        <td style={{ textAlign: 'right' }}>{money(invoice.outstanding)}</td>
                        <td><StatusBadge value={invoice.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detail.invoices.length === 0 && <div className="table-empty">Belum ada tagihan.</div>}
              </div>
            </section>

            {can('student.manage') && (
              <section>
                <h4 style={{ marginBottom: 8 }}>Pindah unit / tahun ajaran</h4>
                <form onSubmit={submitMove}>
                  <div className="form-grid">
                    <label className="field">Unit baru
                      <select className="select" value={move.unitId} onChange={event => setMove({ ...move, unitId: event.target.value })} required>
                        <option value="">Pilih…</option>
                        {units.map(unit => <option key={unit.id} value={unit.id}>{unit.unit_name}</option>)}
                      </select>
                    </label>
                    <label className="field">Tahun ajaran
                      <select className="select" value={move.academicYearId} onChange={event => setMove({ ...move, academicYearId: event.target.value })} required>
                        <option value="">Pilih…</option>
                        {years.map(year => <option key={year.id} value={year.id}>{year.name}</option>)}
                      </select>
                    </label>
                    <label className="field">Kelas
                      <input className="input" value={move.classLabel} onChange={event => setMove({ ...move, classLabel: event.target.value })} />
                    </label>
                    <label className="field">Mulai efektif
                      <input type="date" className="input" value={move.effectiveStart} onChange={event => setMove({ ...move, effectiveStart: event.target.value })} required />
                    </label>
                    <label className="field full">Alasan
                      <input className="input" value={move.reason} onChange={event => setMove({ ...move, reason: event.target.value })} placeholder="Opsional" />
                    </label>
                  </div>
                  <div className="modal-actions">
                    <button type="submit" className="ghost-button">Simpan Penempatan</button>
                  </div>
                </form>
              </section>
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
