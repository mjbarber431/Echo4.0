import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { hueFor, initials } from '../lib/util'
import { useStore } from '../store'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode }) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`} {...rest}>
      {icon}
      {children && <span>{children}</span>}
    </button>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function Avatar({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  const hue = hueFor(id)
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.4, background: `hsl(${hue} 38% 88%)`, color: `hsl(${hue} 35% 30%)` }}
    >
      {initials(name)}
    </span>
  )
}

export function Modal({ title, onClose, children, footer, width = 480 }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange(v: boolean): void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden>
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </label>
  )
}

/** Textarea that grows with its content. */
export function AutoTextarea({ value, minRows = 2, ref: outer, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string; minRows?: number; ref?: Ref<HTMLTextAreaElement> }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(outer, () => ref.current!, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [value])
  return <textarea ref={ref} rows={minRows} value={value} {...rest} />
}

/** Copy button with a brief checkmark confirmation. */
export function CopyButton({ text, html, label = 'Copy', size = 'sm', variant = 'ghost', onCopied, title }: {
  text: string
  html: string
  label?: string
  size?: 'sm' | 'md' | 'lg'
  variant?: Variant
  onCopied?(): void
  title?: string
}) {
  const [done, setDone] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <Button
      size={size}
      variant={variant}
      title={title}
      className={done ? 'copied' : ''}
      icon={done ? <Check size={14} /> : <Copy size={14} />}
      onClick={async () => {
        await window.echo.copy(text, html)
        setDone(true)
        onCopied?.()
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setDone(false), 1600)
      }}
    >
      {label && (done ? 'Copied' : label)}
    </Button>
  )
}

export function Toasts() {
  const { toasts, dismissToast } = useStore()
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone} ${t.action ? 'has-action' : ''}`}>
          {t.message}
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run()
                dismissToast(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children}
    </div>
  )
}
