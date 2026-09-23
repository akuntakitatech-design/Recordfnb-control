import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';

type Option = { id: string; label: string; meta?: string };

export function SearchSelect({ value, options, placeholder = 'Cari...', onChange }: { value: string; options: Option[]; placeholder?: string; onChange: (id: string) => void }) {
  const selected = options.find(x => x.id === value);
  const [query, setQuery] = useState(selected?.label || '');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(selected?.label || ''); }, [value, selected?.label]);

  useEffect(() => {
    function close(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term || selected?.label === query) return options.slice(0, 30);
    return options.filter(x => `${x.label} ${x.meta || ''}`.toLowerCase().includes(term)).slice(0, 30);
  }, [query, options, selected?.label]);

  function choose(option: Option) { onChange(option.id); setQuery(option.label); setOpen(false); }

  return <div className="search-select" ref={boxRef}>
    <div className="search-select-input"><Search size={14}/><input value={query} placeholder={placeholder} onFocus={() => setOpen(true)} onChange={e => { setQuery(e.target.value); setOpen(true); if (!e.target.value) onChange(''); }} /></div>
    {open && <div className="search-select-menu">
      {filtered.map(option => <button type="button" key={option.id} onMouseDown={e => e.preventDefault()} onClick={() => choose(option)}><span>{option.label}</span>{option.meta && <small>{option.meta}</small>}</button>)}
      {filtered.length === 0 && <div className="search-select-empty">Tidak ada data yang cocok</div>}
    </div>}
  </div>;
}
