import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, CheckCircle2, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from './api';

type Company = { id: string; workspace_id: string; name: string };
type Location = { id: string; company_id: string; name: string };
type Unit = { id: string; workspace_id: string; code: string; name: string };
type Conversion = { id: string; item_id: string | null; from_unit_id: string; to_unit_id: string; multiplier: string };
type TransferItem = {
  item_id: string;
  code: string;
  name: string;
  category_name: string;
  base_unit_id: string;
  base_unit_code: string;
  base_unit_name: string;
  source_quantity: string;
  destination_quantity: string;
  setup_ready: boolean;
};
type TransferLine = { key: string; itemId: string; unitId: string; quantity: string; description: string };
type RecentRow = {
  id: string;
  transaction_number: string;
  transaction_date: string;
  notes: string | null;
  grand_total: string;
  workflow_status: string;
  accounting_status: string;
  negative_stock_override: boolean;
  source_location_name: string;
  destination_location_name: string;
  line_count: number;
};
type Shortage = {
  lineId: string;
  lineNo: number;
  itemId: string;
  itemName: string;
  baseUnitCode: string;
  available: string;
  requested: string;
  after: string;
};

const today = () => new Date().toISOString().slice(0, 10);
const numberValue = (value: string | number) => Number(value || 0);
const formatQty = (value: number) => value.toLocaleString('id-ID', { maximumFractionDigits: 3 });
const formatMoney = (value: string | number) => Number(value || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });
const makeLine = (): TransferLine => ({ key: crypto.randomUUID(), itemId: '', unitId: '', quantity: '', description: '' });

export function ClientStockTransfer({ canVerify, canOverride }: { canVerify: boolean; canOverride: boolean }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [conversions, setConversions] = useState<Conversion[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<TransferItem[]>([]);
  const [lines, setLines] = useState<TransferLine[]>([makeLine()]);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const company = companies.find(row => row.id === companyId);
  const companyLocations = locations.filter(row => row.company_id === companyId);

  useEffect(() => {
    void (async () => {
      const [companyRows, locationRows] = await Promise.all([
        api<Company[]>('/api/master/companies'),
        api<Location[]>('/api/master/locations'),
      ]);
      setCompanies(companyRows);
      setLocations(locationRows);
      if (companyRows[0]) setCompanyId(companyRows[0].id);
    })();
  }, []);

  useEffect(() => {
    if (!company) return;
    void (async () => {
      const [unitRows, conversionRows, recentRows] = await Promise.all([
        api<Unit[]>(`/api/master/units?workspaceId=${company.workspace_id}`),
        api<Conversion[]>(`/api/master/unit-conversions?workspaceId=${company.workspace_id}`),
        api<RecentRow[]>(`/api/client-transactions/stock-transfers?companyId=${company.id}`),
      ]);
      setUnits(unitRows);
      setConversions(conversionRows);
      setRecent(recentRows);

      const availableLocations = locations.filter(row => row.company_id === company.id);
      setFromLocationId(current => availableLocations.some(row => row.id === current) ? current : (availableLocations[0]?.id || ''));
      setToLocationId(current => {
        if (availableLocations.some(row => row.id === current) && current !== availableLocations[0]?.id) return current;
        return availableLocations[1]?.id || '';
      });
    })();
  }, [companyId, company?.workspace_id, locations.length]);

  useEffect(() => {
    if (!companyId || !fromLocationId || !toLocationId || fromLocationId === toLocationId) {
      setItems([]);
      return;
    }
    void refreshItems();
  }, [companyId, fromLocationId, toLocationId]);

  async function refreshItems() {
    setItems(await api<TransferItem[]>(
      `/api/client-transactions/stock-transfer-items?companyId=${companyId}&fromLocationId=${fromLocationId}&toLocationId=${toLocationId}`,
    ));
  }

  async function refreshRecent() {
    if (!companyId) return;
    setRecent(await api<RecentRow[]>(`/api/client-transactions/stock-transfers?companyId=${companyId}`));
  }

  function itemOf(line: TransferLine) {
    return items.find(item => item.item_id === line.itemId);
  }

  function allowedUnits(line: TransferLine) {
    const item = itemOf(line);
    if (!item) return [];
    const ids = new Set<string>([item.base_unit_id]);
    for (const conversion of conversions) {
      if (conversion.to_unit_id === item.base_unit_id && (conversion.item_id === item.item_id || conversion.item_id === null)) {
        ids.add(conversion.from_unit_id);
      }
    }
    return units.filter(unit => ids.has(unit.id));
  }

  function multiplier(line: TransferLine) {
    const item = itemOf(line);
    if (!item || !line.unitId) return 0;
    if (line.unitId === item.base_unit_id) return 1;
    const specific = conversions.find(conversion =>
      conversion.item_id === item.item_id && conversion.from_unit_id === line.unitId && conversion.to_unit_id === item.base_unit_id,
    );
    const general = conversions.find(conversion =>
      conversion.item_id === null && conversion.from_unit_id === line.unitId && conversion.to_unit_id === item.base_unit_id,
    );
    return numberValue((specific || general)?.multiplier || 0);
  }

  function baseTransfer(line: TransferLine) {
    return numberValue(line.quantity) * multiplier(line);
  }

  function sourceAfter(index: number) {
    const line = lines[index];
    const item = itemOf(line);
    if (!item) return 0;
    let transferred = 0;
    for (let current = 0; current <= index; current += 1) {
      if (lines[current].itemId === line.itemId) transferred += baseTransfer(lines[current]);
    }
    return numberValue(item.source_quantity) - transferred;
  }

  function destinationAfter(index: number) {
    const line = lines[index];
    const item = itemOf(line);
    if (!item) return 0;
    let transferred = 0;
    for (let current = 0; current <= index; current += 1) {
      if (lines[current].itemId === line.itemId) transferred += baseTransfer(lines[current]);
    }
    return numberValue(item.destination_quantity) + transferred;
  }

  const hasVisualShortage = useMemo(
    () => lines.some((line, index) => line.itemId && numberValue(line.quantity) > 0 && sourceAfter(index) < 0),
    [lines, items, conversions],
  );

  function updateLine(key: string, patch: Partial<TransferLine>) {
    setLines(rows => rows.map(row => row.key === key ? { ...row, ...patch } : row));
  }

  function selectItem(key: string, itemId: string) {
    const item = items.find(row => row.item_id === itemId);
    updateLine(key, { itemId, unitId: item?.base_unit_id || '' });
  }

  function reset() {
    setNotes('');
    setLines([makeLine()]);
  }

  async function saveDraft() {
    setError('');
    setSuccess('');
    if (!companyId || !fromLocationId || !toLocationId) return setError('Company, lokasi asal dan lokasi tujuan wajib dipilih.');
    if (fromLocationId === toLocationId) return setError('Lokasi asal dan lokasi tujuan harus berbeda.');
    if (lines.some(line => !line.itemId || !line.unitId || numberValue(line.quantity) <= 0)) {
      return setError('Barang, qty dan satuan wajib diisi di setiap baris.');
    }

    setSaving(true);
    try {
      const result = await api<{ id: string; transaction_number: string }>('/api/client-transactions/stock-transfers', {
        method: 'POST',
        body: JSON.stringify({
          companyId,
          fromLocationId,
          toLocationId,
          transactionDate: date,
          notes: notes || null,
          lines: lines.map(line => ({
            itemId: line.itemId,
            unitId: line.unitId,
            quantity: numberValue(line.quantity),
            description: line.description || null,
          })),
        }),
      });
      setSuccess(`${result.transaction_number} tersimpan sebagai draft. Nilai transfer akan memakai HPP moving average saat Finance Verified.`);
      reset();
      await Promise.all([refreshRecent(), refreshItems()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan transfer barang');
    } finally {
      setSaving(false);
    }
  }

  async function verify(row: RecentRow) {
    setError('');
    setSuccess('');
    setVerifying(row.id);
    try {
      const preview = await api<{ shortages: Shortage[] }>(`/api/client-transactions/stock-transfers/${row.id}/preview`);
      let allowBelowZero = false;
      if (preview.shortages.length) {
        const detail = preview.shortages
          .map(shortage => `${shortage.itemName}: tersedia ${formatQty(numberValue(shortage.available))} ${shortage.baseUnitCode}, setelah transfer ${formatQty(numberValue(shortage.after))} ${shortage.baseUnitCode}`)
          .join('\n');
        if (!canOverride) {
          setError(`Stok asal tidak cukup. Finance Manager/Akuntakita perlu menyetujui transfer yang membuat saldo minus.\n${detail}`);
          return;
        }
        allowBelowZero = window.confirm(`Ada stok asal yang akan menjadi minus:\n\n${detail}\n\nTetap Finance Verified?`);
        if (!allowBelowZero) return;
      }

      const result = await api<{ total: string; shortages: Shortage[] }>(
        `/api/client-transactions/stock-transfers/${row.id}/verify`,
        { method: 'POST', body: JSON.stringify({ allowBelowZero }) },
      );
      setSuccess(
        result.shortages?.length
          ? 'Finance Verified dengan persetujuan saldo minus. Stok asal/tujuan dan draft jurnal sudah diperbarui.'
          : 'Finance Verified. Stok asal/tujuan, HPP moving average dan draft jurnal sudah diperbarui.',
      );
      await Promise.all([refreshRecent(), refreshItems()]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal verifikasi transfer';
      setError(
        message.startsWith('MOVING_AVERAGE_NOT_AVAILABLE')
          ? 'HPP average belum tersedia untuk salah satu barang. Pastikan barang memiliki nilai persediaan di lokasi asal.'
          : message,
      );
    } finally {
      setVerifying('');
    }
  }

  return <div className="page-content stock-transfer-page">
    <section className="section-card">
      <div className="section-title master-heading">
        <div>
          <span className="eyebrow">PERSEDIAAN</span>
          <h3>Transfer Barang</h3>
          <p>Pindahkan stok antar lokasi dalam company yang sama. Client cukup memilih barang dan qty; nilai transfer memakai moving average lokasi asal.</p>
        </div>
        <button className="primary-button compact" onClick={saveDraft} disabled={saving}>
          <Save size={16}/>{saving ? 'Menyimpan...' : 'Simpan Draft'}
        </button>
      </div>

      <div className="helper-box">
        <strong>Alur:</strong> lokasi asal berkurang, lokasi tujuan bertambah, lalu sistem membuat jurnal perpindahan persediaan per lokasi tanpa client memilih akun.
      </div>
      {success && <div className="success-banner"><CheckCircle2 size={18}/><span>{success}</span></div>}
      {error && <div className="form-error stock-transfer-error">{error}</div>}

      <div className="transfer-header-grid">
        <label>Company
          <select value={companyId} onChange={event => setCompanyId(event.target.value)}>
            <option value="">Pilih company</option>
            {companies.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select>
        </label>
        <label>Dari Lokasi
          <select value={fromLocationId} onChange={event => setFromLocationId(event.target.value)}>
            <option value="">Pilih lokasi asal</option>
            {companyLocations.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select>
        </label>
        <label>Ke Lokasi
          <select value={toLocationId} onChange={event => setToLocationId(event.target.value)}>
            <option value="">Pilih lokasi tujuan</option>
            {companyLocations.filter(row => row.id !== fromLocationId).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select>
        </label>
        <label>Tanggal
          <input type="date" value={date} onChange={event => setDate(event.target.value)}/>
        </label>
        <label className="transfer-notes">Catatan
          <input value={notes} onChange={event => setNotes(event.target.value)} placeholder="Contoh: replenishment outlet Panam"/>
        </label>
      </div>

      <div className="transfer-lines-head">
        <div><strong>Rincian Barang</strong><small>Harga/HPP tidak diinput client.</small></div>
        <button type="button" className="secondary-button compact" onClick={() => setLines(rows => [...rows, makeLine()])}>
          <Plus size={15}/> Tambah Baris
        </button>
      </div>

      <div className="data-table-wrap">
        <table className="transfer-table">
          <thead><tr><th>#</th><th>Barang</th><th>Stok Asal</th><th>Qty</th><th>Satuan</th><th>Sisa Asal</th><th>Stok Tujuan</th><th>Setelah Masuk</th><th>Keterangan</th><th></th></tr></thead>
          <tbody>{lines.map((line, index) => {
            const item = itemOf(line);
            const afterSource = sourceAfter(index);
            const afterDestination = destinationAfter(index);
            const warning = Boolean(line.itemId && numberValue(line.quantity) > 0 && afterSource < 0);
            return <tr key={line.key} className={warning ? 'transfer-warning-row' : ''}>
              <td>{index + 1}</td>
              <td>
                <select value={line.itemId} onChange={event => selectItem(line.key, event.target.value)}>
                  <option value="">Pilih barang</option>
                  {items.map(row => <option key={row.item_id} value={row.item_id}>{row.name} · {row.category_name}</option>)}
                </select>
                {item && !item.setup_ready && <small className="setup-warning">Mapping persediaan oleh Akuntakita belum lengkap</small>}
              </td>
              <td>{item ? <><strong>{formatQty(numberValue(item.source_quantity))}</strong> {item.base_unit_code}</> : '—'}</td>
              <td><input className="number-input" type="number" min="0" step="0.001" value={line.quantity} onChange={event => updateLine(line.key, { quantity: event.target.value })}/></td>
              <td>
                <select value={line.unitId} onChange={event => updateLine(line.key, { unitId: event.target.value })}>
                  <option value="">—</option>
                  {allowedUnits(line).map(unit => <option key={unit.id} value={unit.id}>{unit.code}</option>)}
                </select>
              </td>
              <td className={warning ? 'transfer-negative' : ''}>
                {item ? <><strong>{formatQty(afterSource)}</strong> {item.base_unit_code}{warning && <small><AlertTriangle size={13}/> Akan minus</small>}</> : '—'}
              </td>
              <td>{item ? <><strong>{formatQty(numberValue(item.destination_quantity))}</strong> {item.base_unit_code}</> : '—'}</td>
              <td>{item ? <><strong>{formatQty(afterDestination)}</strong> {item.base_unit_code}</> : '—'}</td>
              <td><input value={line.description} onChange={event => updateLine(line.key, { description: event.target.value })} placeholder="Opsional"/></td>
              <td><button type="button" className="icon-button danger" onClick={() => setLines(rows => rows.length === 1 ? rows : rows.filter(row => row.key !== line.key))}><Trash2 size={15}/></button></td>
            </tr>;
          })}</tbody>
        </table>
      </div>

      {hasVisualShortage && <div className="transfer-warning-banner">
        <AlertTriangle size={18}/>
        <div><strong>Ada stok asal yang akan menjadi minus.</strong><span>Draft tetap bisa disimpan. Finance Verified memerlukan persetujuan Finance Manager atau Akuntakita.</span></div>
      </div>}
    </section>

    <section className="section-card">
      <div className="section-title master-heading">
        <div><span className="eyebrow">KONTROL</span><h3>Transfer Terbaru</h3><p>Nilai transfer mengikuti HPP moving average dari lokasi asal.</p></div>
      </div>
      <div className="data-table-wrap">
        <table>
          <thead><tr><th>No Dokumen</th><th>Tanggal</th><th>Dari</th><th>Ke</th><th>Baris</th><th>Status</th><th>Nilai Transfer</th><th></th></tr></thead>
          <tbody>{recent.map(row => <tr key={row.id}>
            <td><strong>{row.transaction_number}</strong>{row.negative_stock_override && <small className="override-label"><AlertTriangle size={12}/> Override saldo minus</small>}</td>
            <td>{row.transaction_date?.slice(0, 10)}</td>
            <td>{row.source_location_name}</td>
            <td>{row.destination_location_name}</td>
            <td>{row.line_count}</td>
            <td><span className={row.workflow_status === 'FINANCE_VERIFIED' ? 'status-ok' : 'status-draft'}>{row.workflow_status === 'FINANCE_VERIFIED' ? 'Finance Verified' : 'Draft'}</span></td>
            <td>{row.workflow_status === 'FINANCE_VERIFIED' ? `Rp${formatMoney(row.grand_total)}` : 'HPP otomatis'}</td>
            <td>{canVerify && row.workflow_status === 'DRAFT' && <button className="secondary-button compact" disabled={verifying === row.id} onClick={() => verify(row)}><ShieldCheck size={15}/>{verifying === row.id ? 'Memeriksa...' : 'Finance Verified'}</button>}</td>
          </tr>)}</tbody>
        </table>
        {recent.length === 0 && <div className="empty-state"><ArrowRightLeft size={34}/><strong>Belum ada transfer barang</strong><span>Input transfer pertama dari form di atas.</span></div>}
      </div>
    </section>
  </div>;
}
