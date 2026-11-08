import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, GitBranch } from 'lucide-react';

interface RepositoryPickerProps {
  worlds: readonly { id: string; repository: string; commit: string }[];
  worldId?: string;
  onSelect: (id: string) => void;
}

export default function RepositoryPicker({ worlds, worldId, onSelect }: RepositoryPickerProps) {
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = worlds.find(world => world.id === worldId);

  useEffect(() => {
    if (!open) return;
    const list = menu.current;
    (list?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? list?.querySelector('button'))?.focus();
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !picker.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !worlds.length) return;
    event.preventDefault();
    if (!open) {
      setOpen(true);
      return;
    }
    const options = [...(menu.current?.querySelectorAll('button') ?? [])];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  }

  return (
    <div className="repo-picker" ref={picker} onKeyDown={navigate} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button type="button" className="repo-trigger" ref={trigger} aria-label="Repository" aria-haspopup="menu"
        aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={!worlds.length}
        onClick={() => setOpen(current => !current)}>
        <span className="repo-icon"><GitBranch size={16} strokeWidth={1.8} aria-hidden="true" /></span>
        <span className="repo-name">{selected?.repository ?? 'Choose repository'}</span>
        <ChevronDown className="repo-chevron" size={16} aria-hidden="true" />
      </button>
      {open && <div className="repo-menu" role="menu" aria-label="Repositories" id={menuId} ref={menu}>
        {worlds.map(world => (
          <button key={world.id} type="button" className="repo-option" role="menuitemradio" tabIndex={-1}
            aria-checked={world.id === worldId} title={world.repository} onClick={() => {
              setOpen(false);
              trigger.current?.focus();
              if (world.id !== worldId) onSelect(world.id);
            }}>
            <span className="repo-name">{world.repository}</span>
            <span className="repo-commit">{world.commit.slice(0, 7)}</span>
            <span className="repo-check">{world.id === worldId && <Check size={15} aria-hidden="true" />}</span>
          </button>
        ))}
      </div>}
    </div>
  );
}
