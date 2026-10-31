import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({
  title,
  onClose,
  children,
  maxWidth,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: number;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" style={maxWidth ? { maxWidth } : undefined} onClick={event => event.stopPropagation()} role="dialog" aria-modal="true">
        <header>
          <h3>{title}</h3>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Tutup">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
