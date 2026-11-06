import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';

export interface PwSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface PwSelectProps {
  value: string;
  options: PwSelectOption[];
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Optional accessible name when not wrapped by a visible label. */
  'aria-label'?: string;
  title?: string;
  onChange: (value: string) => void;
}

export function PwSelect({
  value,
  options,
  disabled = false,
  placeholder = '请选择',
  className = '',
  'aria-label': ariaLabel,
  title,
  onChange,
}: PwSelectProps): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const selected = useMemo(
    () => options.find((item) => item.value === value) || null,
    [options, value],
  );

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (!options.length) return;
      const enabled = options.filter((item) => !item.disabled);
      if (!enabled.length) return;
      const currentIndex = Math.max(0, enabled.findIndex((item) => item.value === value));
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const next = enabled[(currentIndex + delta + enabled.length) % enabled.length];
        if (next) onChange(next.value);
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onChange, open, options, value]);

  return (
    <div
      className={`pw-select${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
      ref={rootRef}
    >
      <button
        type="button"
        className="pw-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        title={title || selected?.description || selected?.label || placeholder}
        onClick={() => {
          if (!disabled) setOpen((prev) => !prev);
        }}
      >
        <span className={selected ? '' : 'is-placeholder'}>
          {selected?.label || placeholder}
        </span>
        <i aria-hidden>▾</i>
      </button>
      {open ? (
        <div className="pw-select-menu" role="listbox" id={listId}>
          {options.length === 0 ? (
            <p className="pw-select-empty">暂无可选项</p>
          ) : (
            options.map((item) => {
              const active = item.value === value;
              return (
                <button
                  key={item.value || '__empty__'}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={item.disabled}
                  className={`pw-select-option${active ? ' is-active' : ''}`}
                  title={item.description || item.label}
                  onClick={() => {
                    if (item.disabled) return;
                    onChange(item.value);
                    setOpen(false);
                  }}
                >
                  <em className="pw-select-check" aria-hidden>{active ? '✓' : ''}</em>
                  <span className="pw-select-option-text">
                    <strong>{item.label}</strong>
                    {item.description ? <span>{item.description}</span> : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
