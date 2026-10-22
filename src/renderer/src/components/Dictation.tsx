import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Check, Loader2, Mic, Square } from 'lucide-react'
import { formatElapsed, useDictation, type DictationController } from '../lib/useDictation'
import { useCommand, useStore } from '../store'
import { AutoTextarea, Kbd } from './ui'

/** Records into `value`: each finished segment is appended, so clinicians can dictate in bursts, type, or both. With `live`, it's transcribed as they talk. */
export function useTranscript(value: string, onChange: (next: string) => void, live = false): DictationController {
  const { toast } = useStore()
  const latest = useRef(value)
  latest.current = value
  return useDictation(
    (text, join) => {
      const current = latest.current.trimEnd()
      const next = current ? `${current}${join === 'continue' ? ' ' : '\n\n'}${text}` : text
      latest.current = next
      onChange(next)
    },
    (message) => toast(message, 'error'),
    live
  )
}

interface DictationProps {
  value: string
  onChange(next: string): void
  placeholder: string
  autoFocusRecord?: boolean
  compact?: boolean
  dock?: ReactNode
  /** A finish action beside the surface stops the mic itself (true whenever there's a dock). */
  finishable?: boolean
  /** Live coverage says everything the note needs has been said. */
  ready?: boolean
}

/**
 * Big record button + editable transcript. With `dock`, the transcript becomes a
 * full-page writing surface and the record control sits in a sticky bar at the
 * bottom alongside the dock content. Pass `controller` (from useTranscript) when
 * the parent needs to drive the recorder, e.g. to finish and generate in one press.
 * Only one Dictation should be mounted at a time: each one answers ⌘R.
 */
export function Dictation(props: DictationProps) {
  const controller = useTranscript(props.value, props.onChange)
  return <DictationSurface {...props} controller={controller} />
}

export function DictationSurface({ value, onChange, placeholder, autoFocusRecord = false, compact = false, dock, finishable = !!dock, ready = false, controller: dictation }: DictationProps & { controller: DictationController }) {
  useCommand('record', dictation.toggle)

  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (autoFocusRecord) button.current?.focus()
  }, [autoFocusRecord])

  // The textarea grows after the browser has scrolled to the caret, and the sticky dock
  // covers the bottom of the view, so keep the line being written just above the dock.
  const text = useRef<HTMLTextAreaElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = text.current
    if (!dock || !el || !dockRef.current || document.activeElement !== el || el.selectionEnd !== el.value.length) return
    const overlap = el.getBoundingClientRect().bottom - dockRef.current.getBoundingClientRect().top + 12
    if (overlap > 0) scrollParent(el)?.scrollBy({ top: overlap })
  }, [value, dock])

  const recording = dictation.state === 'recording'
  const bars = Array.from({ length: 5 }, (_, i) => Math.max(0.15, Math.min(1, dictation.level * (1.4 - Math.abs(i - 2) * 0.3))))

  const bar = (
    <div className="dictation-bar">
      <button
        ref={button}
        className={`record-btn ${recording ? 'on' : ''}`}
        onClick={dictation.toggle}
        disabled={dictation.state === 'starting'}
        aria-label={recording ? 'Stop dictation' : 'Start dictation'}
      >
        {recording ? <Square size={dock ? 15 : 18} fill="currentColor" /> : <Mic size={dock ? 19 : 22} />}
      </button>
      <div className="dictation-status">
        {recording ? (
          <>
            <span className="meter" aria-hidden>
              {bars.map((h, i) => (
                <i key={i} style={{ transform: `scaleY(${h})` }} />
              ))}
            </span>
            <span className="rec-time">{formatElapsed(dictation.elapsed)}</span>
            {ready && (
              <span className="ready-pill" title="Everything the note needs has been covered. Keep going, or press ⌘↵.">
                <Check size={12} strokeWidth={3} /> Covered
              </span>
            )}
            {dictation.heard ? (
              <span className="live-caption" title={dictation.heard}>
                <span>{dictation.heard.slice(-160)}</span>
              </span>
            ) : finishable ? (
              <span className="muted">
                Listening… <Kbd>⌘↵</Kbd> when you’re done
              </span>
            ) : (
              <span className="muted">
                Listening… click or press <Kbd>⌘R</Kbd> to stop
              </span>
            )}
          </>
        ) : dictation.pending > 0 ? (
          <span className="muted">
            <Loader2 size={14} className="spin" /> Transcribing…
          </span>
        ) : (
          <span className="muted">
            {dock ? (
              <>
                <Kbd>⌘R</Kbd> {value ? 'to add more' : 'to dictate'}, or just type
              </>
            ) : (
              <>
                {value ? 'Add more' : 'Dictate'} with <Kbd>⌘R</Kbd>, or type below
              </>
            )}
          </span>
        )}
      </div>
    </div>
  )

  if (dock)
    return (
      <div
        className={`dictation page ${recording ? 'is-recording' : ''}`}
        // The blank space between the text and the dock belongs to the writing surface.
        onMouseDown={(e) => {
          const el = text.current
          if (e.target !== e.currentTarget || !el) return
          e.preventDefault()
          el.focus()
          el.setSelectionRange(el.value.length, el.value.length)
        }}
      >
        <AutoTextarea ref={text} className="dictation-text" value={value} minRows={10} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck />
        <div className="dictation-dock" ref={dockRef}>
          {bar}
          {dock}
        </div>
      </div>
    )

  return (
    <div className={`dictation ${recording ? 'is-recording' : ''} ${compact ? 'compact' : ''}`}>
      {bar}
      <AutoTextarea className="dictation-text" value={value} minRows={compact ? 4 : 7} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck />
    </div>
  )
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p
  return null
}
