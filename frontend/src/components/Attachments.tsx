import { useCallback, useEffect, useRef, useState } from 'react';
import { Paperclip, Trash2 } from 'lucide-react';
import { api, messageOf } from '../api';

type AttachmentRow = {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  uploaded_by_name: string | null;
};

function sizeLabel(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Lampiran dokumen — dipakai di detail semua transaksi.
 * Mendukung banyak file sekaligus (maks 10 file, 5 MB per file).
 */
export function Attachments({ entityType, entityId }: { entityType: string; entityId: string }) {
  const [rows, setRows] = useState<AttachmentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<AttachmentRow[]>(`/api/v1/attachments?entityType=${entityType}&entityId=${entityId}`);
      setRows(result || []);
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError));
    }
  }, [entityType, entityId]);

  useEffect(() => { void load(); }, [load]);

  async function upload(selected: FileList | null) {
    if (!selected || selected.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const files = await Promise.all(Array.from(selected).map(file => new Promise<Record<string, string>>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result);
          resolve({
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            dataBase64: result.split(',')[1] || '',
          });
        };
        reader.onerror = () => reject(new Error('Gagal membaca file'));
        reader.readAsDataURL(file);
      })));
      await api('/api/v1/attachments', {
        method: 'POST',
        body: JSON.stringify({ entityType, entityId, files }),
      });
      if (inputRef.current) inputRef.current.value = '';
      await load();
    } catch (uploadError) {
      setError(messageOf(uploadError));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: AttachmentRow) {
    if (!window.confirm(`Hapus lampiran "${row.file_name}"?`)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/v1/attachments/${row.id}`, { method: 'DELETE', body: JSON.stringify({}) });
      await load();
    } catch (deleteError) {
      setError(messageOf(deleteError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div className="toolbar">
        <strong>Lampiran</strong>
        <span className="cell-muted">bisa banyak file · maks 5 MB/file</span>
        <div className="spacer" />
        <label className={busy ? 'ghost-button' : 'ghost-button'} style={{ cursor: busy ? 'default' : 'pointer' }}>
          <Paperclip size={14} /> {busy ? 'Mengunggah…' : 'Unggah file'}
          <input ref={inputRef} type="file" multiple hidden disabled={busy}
            onChange={event => void upload(event.target.files)} data-testid="attachment-input" />
        </label>
      </div>
      {error && <div className="form-error">{error}</div>}
      {rows.length === 0 ? (
        <div className="cell-muted" style={{ marginTop: 6 }}>Belum ada lampiran.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>File</th><th>Ukuran</th><th>Diunggah</th><th style={{ textAlign: 'right' }}>Aksi</th></tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id}>
                  <td>
                    <a href={`/api/v1/attachments/${row.id}/download`} target="_blank" rel="noreferrer">{row.file_name}</a>
                  </td>
                  <td className="cell-muted">{sizeLabel(row.size_bytes)}</td>
                  <td className="cell-muted">{row.uploaded_by_name || '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button type="button" className="link-button danger" disabled={busy} onClick={() => void remove(row)}>
                      <Trash2 size={14} /> Hapus
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
