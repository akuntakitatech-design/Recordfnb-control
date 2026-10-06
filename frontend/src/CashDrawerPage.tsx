import { useEffect, useMemo, useState } from 'react';
import { Camera, CheckCircle2, FileImage, History, Lock, RefreshCw, Save, Wallet } from 'lucide-react';
import { api } from './api';
import { evidenceUrl, flowError, loadOrg, qs, rupiah, today, uploadEvidence, type Company, type Location } from './salesFlowShared';
import './salesFlow.css';

type Method = { id: string; name: string; pos_payment_code: string; evidence_policy: 'REQUIRED' | 'OPTIONAL' };
type DrawerLine = { id: string; payment_method_id: string; method_name: string; actual_amount: string; evidence_id: string | null; evidence_name: string | null; evidence_count: number };
type Drawer = { id: string; business_date: string; shift_label: string; status: 'SUBMITTED' | 'LOCKED'; notes: string | null; created_by_name: string | null; updated_by_name: string | null; updated_at: string; lines: DrawerLine[] };
type Hist = { action: string; created_at: string; user_name: string | null; after_data: any };

/** Cash Drawer outlet: nominal aktual per metode pembayaran + bukti foto per metode. Terkunci setelah Verifikasi Penjualan. */
export function CashDrawerPage({ allowedLocationIds }: { allowedLocationIds: string[] | null }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [date, setDate] = useState(today());
  const [shift, setShift] = useState('');
  const [methods, setMethods] = useState<Method[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [drawers, setDrawers] = useState<Drawer[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const [history, setHistory] = useState<Hist[] | null>(null);

  useEffect(() => { loadOrg().then(o => {
    const locs = allowedLocationIds ? o.locations.filter(l => allowedLocationIds.includes(l.id)) : o.locations;
    setCompanies(o.companies.filter(c => locs.some(l => l.company_id === c.id)));
    setLocations(locs);
    const first = locs[0]; if (first) { setCompanyId(first.company_id); setLocationId(first.id); }
  }).catch(e => setBanner({ kind: 'error', message: flowError(e) })); }, [allowedLocationIds]);

  const outletOptions = useMemo(() => locations.filter(l => l.company_id === companyId), [locations, companyId]);
  const current = drawers.find(d => d.business_date.slice(0, 10) === date && (d.shift_label || '') === shift) || null;
  const dayDrawers = drawers.filter(d => d.business_date.slice(0, 10) === date);
  const locked = dayDrawers.some(d => d.status === 'LOCKED');

  async function refresh() {
    if (!companyId || !locationId) return;
    try {
      const ctx = await api<{ methods: Method[]; canWrite: boolean }>(`/api/sales-flow/cash-drawers/context?${qs({ companyId, locationId })}`);
      setMethods(ctx.methods); setCanWrite(ctx.canWrite);
      setDrawers(await api<Drawer[]>(`/api/sales-flow/cash-drawers?${qs({ companyId, locationId })}`));
    } catch (e) { setBanner({ kind: 'error', message: flowError(e) }); setMethods([]); setDrawers([]); }
  }
  useEffect(() => { void refresh(); }, [companyId, locationId]);
  useEffect(() => {
    setAmounts(Object.fromEntries(methods.map(m => [m.id, current?.lines.find(l => l.payment_method_id === m.id)?.actual_amount?.replace(/\.0+$/, '') || ''])));
    setFiles({}); setFileErrors({}); setNotes(current?.notes || ''); setHistory(null);
  }, [current?.id, methods, date, shift]);

  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});
  /** Cek awal di browser (JPG/JPEG/PNG/WEBP, ≤ 7 MB setelah kompresi). Validasi final tetap di server. */
  function pickFile(methodId: string, input: HTMLInputElement) {
    const file = input.files?.[0] || null;
    input.value = '';
    if (!file) return;
    const okType = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
    if (!okType) { setFileErrors(e => ({ ...e, [methodId]: 'Format harus JPG / JPEG / PNG / WEBP.' })); setFiles(f => ({ ...f, [methodId]: null })); return; }
    setFileErrors(e => ({ ...e, [methodId]: '' }));
    setFiles(f => ({ ...f, [methodId]: file }));
  }
  const total = methods.reduce((s, m) => s + Number(amounts[m.id] || 0), 0);
  const missingEvidence = methods.filter(m => m.evidence_policy === 'REQUIRED' && Number(amounts[m.id] || 0) > 0 && !files[m.id] && !current?.lines.find(l => l.payment_method_id === m.id)?.evidence_count);

  async function save() {
    setBusy(true); setBanner(null);
    try {
      const saved = await api<{ id: string; lines: Array<{ id: string; payment_method_id: string }> }>('/api/sales-flow/cash-drawers', { method: 'POST', body: JSON.stringify({
        companyId, locationId, businessDate: date, shiftLabel: shift, notes,
        lines: methods.map(m => ({ paymentMethodId: m.id, actualAmount: Number(amounts[m.id] || 0) })),
      }) });
      for (const [methodId, file] of Object.entries(files)) {
        const line = saved.lines.find(l => l.payment_method_id === methodId);
        if (file && line) await uploadEvidence('CASH_DRAWER_LINE', line.id, file, true);
      }
      setBanner({ kind: 'ok', message: missingEvidence.length ? `Cash Drawer tersimpan. Bukti wajib belum lengkap: ${missingEvidence.map(m => m.name).join(', ')}.` : 'Cash Drawer tersimpan. Finance akan merekonsiliasi dengan data POS.' });
      await refresh();
    } catch (e) { setBanner({ kind: 'error', message: flowError(e) }); } finally { setBusy(false); }
  }

  async function openHistory() {
    if (!current) return;
    try { setHistory(await api<Hist[]>(`/api/sales-flow/cash-drawers/${current.id}/history`)); } catch (e) { setBanner({ kind: 'error', message: flowError(e) }); }
  }

  return <div className="page-content sf-page" data-testid="cash-drawer-page">
    <section className="section-card">
      <div className="section-title master-heading">
        <div><span className="eyebrow">OUTLET · CASH DRAWER</span><h3>Cash Drawer Harian</h3><p>Isi uang/aktual yang benar-benar diterima per metode pembayaran, lalu lampirkan foto bukti. Satu tanggal bisa beberapa shift — semuanya dijumlah saat rekonsiliasi.</p></div>
        <div className="heading-actions">
          {companies.length > 1 && <select value={companyId} onChange={e => { setCompanyId(e.target.value); setLocationId(locations.find(l => l.company_id === e.target.value)?.id || ''); }} data-testid="cd-company-select">{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
          <select value={locationId} onChange={e => setLocationId(e.target.value)} data-testid="cd-location-select">{outletOptions.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <button className="secondary-button compact" onClick={() => void refresh()} title="Muat ulang" data-testid="cd-refresh"><RefreshCw size={15}/></button>
        </div>
      </div>

      {banner && <div className={banner.kind === 'ok' ? 'success-banner sf-banner' : 'form-error sf-banner'} data-testid={banner.kind === 'ok' ? 'cd-success-banner' : 'cd-error-banner'}>{banner.kind === 'ok' && <CheckCircle2 size={17}/>}<span>{banner.message}</span><button className="sf-banner-close" onClick={() => setBanner(null)} data-testid="cd-banner-close">×</button></div>}

      <div className="form-grid three sf-filter">
        <label>Tanggal Bisnis<input type="date" value={date} max={today()} onChange={e => setDate(e.target.value)} data-testid="cd-date"/></label>
        <label>Shift (opsional)<input value={shift} onChange={e => setShift(e.target.value.toUpperCase())} placeholder="Kosongkan bila 1 shift, mis. PAGI / MALAM" list="cd-shift-list" data-testid="cd-shift"/>
          <datalist id="cd-shift-list">{[...new Set(dayDrawers.map(d => d.shift_label).filter(Boolean))].map(s => <option key={s} value={s}/>)}</datalist></label>
        <div className="sf-stat"><span>Total aktual {shift ? `shift ${shift}` : ''}</span><strong data-testid="cd-total">{rupiah(total)}</strong></div>
      </div>

      {dayDrawers.length > 0 && <div className="sf-chips" data-testid="cd-shift-chips">{dayDrawers.map(d => <button key={d.id} className={`sf-chip ${(d.shift_label || '') === shift ? 'active' : ''}`} onClick={() => setShift(d.shift_label || '')} data-testid={`cd-shift-chip-${d.shift_label || 'default'}`}>{d.shift_label || 'Tanpa shift'} · {rupiah(d.lines.reduce((s, l) => s + Number(l.actual_amount), 0))}{d.status === 'LOCKED' && <Lock size={12}/>}</button>)}</div>}

      {locked && <div className="helper-box sf-locked" data-testid="cd-locked-info"><Lock size={15}/> Penjualan tanggal ini sudah diverifikasi Finance. Cash Drawer terkunci — koreksi hanya melalui Accounting (reopen).</div>}
      {!methods.length && <div className="empty-state" data-testid="cd-no-methods"><Wallet size={30}/><strong>Metode pembayaran outlet belum diatur</strong><span>Accounting perlu mengaktifkan metode pembayaran untuk outlet ini.</span></div>}

      {methods.length > 0 && <div className="sf-method-grid" data-testid="cd-method-grid">{methods.map(m => {
        const line = current?.lines.find(l => l.payment_method_id === m.id);
        const required = m.evidence_policy === 'REQUIRED';
        const missing = missingEvidence.some(x => x.id === m.id);
        return <div key={m.id} className={`sf-method-card ${missing ? 'invalid' : ''}`} data-testid={`cd-method-${m.pos_payment_code}`}>
          <div className="sf-method-head"><strong>{m.name}</strong><span className={required ? 'sf-tag warn' : 'sf-tag muted'}>{required ? 'Bukti wajib' : 'Bukti opsional'}</span></div>
          <label>Nominal aktual<input className="number-input" type="number" min="0" step="1" inputMode="numeric" value={amounts[m.id] ?? ''} disabled={!canWrite || locked} onChange={e => setAmounts(a => ({ ...a, [m.id]: e.target.value }))} placeholder="0" data-testid={`cd-amount-${m.pos_payment_code}`}/></label>
          <div className="sf-upload-row">
            {/* Kamera HP langsung (capture) + pilih file/galeri biasa — keduanya divalidasi ulang di server (tipe isi file & 7 MB). */}
            <label className={`sf-upload ${!canWrite || locked ? 'disabled' : ''}`} data-testid={`cd-evidence-camera-label-${m.pos_payment_code}`}>
              <Camera size={15}/> Kamera
              <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={!canWrite || locked} onChange={e => pickFile(m.id, e.target)} data-testid={`cd-evidence-camera-${m.pos_payment_code}`}/>
            </label>
            <label className={`sf-upload ${!canWrite || locked ? 'disabled' : ''}`} data-testid={`cd-evidence-label-${m.pos_payment_code}`}>
              <FileImage size={15}/> {line?.evidence_count ? 'Ganti file' : 'Pilih file'}
              <input type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" disabled={!canWrite || locked} onChange={e => pickFile(m.id, e.target)} data-testid={`cd-evidence-${m.pos_payment_code}`}/>
            </label>
          </div>
          {files[m.id] && <small className="journal-meta" data-testid={`cd-evidence-selected-${m.pos_payment_code}`}>Akan diunggah: {files[m.id]!.name} ({(files[m.id]!.size / 1024 / 1024).toFixed(2)} MB)</small>}
          {fileErrors[m.id] && <small className="sf-error-text" data-testid={`cd-evidence-error-${m.pos_payment_code}`}>{fileErrors[m.id]}</small>}
          {line?.evidence_id && <a className="sf-evidence-link" href={evidenceUrl(line.evidence_id)} target="_blank" rel="noreferrer" data-testid={`cd-evidence-view-${m.pos_payment_code}`}><FileImage size={13}/> {line.evidence_name} {line.evidence_count > 1 ? `(${line.evidence_count} versi)` : ''}</a>}
          {missing && <small className="sf-error-text" data-testid={`cd-evidence-missing-${m.pos_payment_code}`}>Foto bukti wajib untuk metode ini.</small>}
        </div>;
      })}</div>}

      {methods.length > 0 && <>
        <label className="sf-notes">Catatan (opsional)<textarea value={notes} disabled={!canWrite || locked} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Mis. uang kembalian kurang, EDC offline, dll." data-testid="cd-notes"/></label>
        <div className="sf-actions">
          {current && <span className="journal-meta" data-testid="cd-last-update">Terakhir diubah {current.updated_by_name || current.created_by_name || '-'} · {new Date(current.updated_at).toLocaleString('id-ID')}</span>}
          {current && <button className="secondary-button compact" onClick={() => void openHistory()} data-testid="cd-history-btn"><History size={14}/> Riwayat</button>}
          {canWrite && <button className="primary-button compact" disabled={busy || locked} onClick={() => void save()} data-testid="cd-save-btn"><Save size={15}/> {busy ? 'Menyimpan...' : current ? 'Simpan Perubahan' : 'Simpan Cash Drawer'}</button>}
          {!canWrite && <span className="sf-tag muted" data-testid="cd-readonly">Hanya lihat — Cash Drawer diisi oleh outlet</span>}
        </div>
      </>}

      {history && <div className="data-table-wrap sf-history" data-testid="cd-history"><table><thead><tr><th>Waktu</th><th>User</th><th>Aktivitas</th><th>Detail</th></tr></thead><tbody>
        {history.map((h, i) => <tr key={i}><td>{new Date(h.created_at).toLocaleString('id-ID')}</td><td>{h.user_name || '-'}</td><td>{({ CREATE_CASH_DRAWER: 'Buat', UPDATE_CASH_DRAWER: 'Ubah nominal', ADD_EVIDENCE: 'Tambah bukti', REPLACE_EVIDENCE: 'Ganti bukti' } as Record<string, string>)[h.action] || h.action}</td>
          <td className="journal-meta">{h.after_data?.lines ? h.after_data.lines.map((l: any) => `${methods.find(m => m.id === l.payment_method_id)?.name || '-'} ${rupiah(l.actual_amount)}`).join(' · ') : h.after_data?.fileName || ''}</td></tr>)}
        {!history.length && <tr><td colSpan={4}>Belum ada riwayat.</td></tr>}
      </tbody></table></div>}
    </section>
  </div>;
}
