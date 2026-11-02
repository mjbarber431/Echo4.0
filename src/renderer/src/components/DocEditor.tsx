import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { AnnotationMode, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist'
import { CalendarDays, Check, Circle, Eraser, Highlighter, Minus, MousePointer2, PenLine, Plus, Redo2, Signature, Trash2, Type, Undo2, UserRound, X } from 'lucide-react'
import { LINE_HEIGHT, glyphStrokes, glyphWidth, type ClientDocument, type DocMark, type DocPage, type FieldValue, type InkColor } from '@shared/documents'
import { signerLabel, type Signer } from '@shared/letter'
import type { DocHistory } from '@shared/types'
import { openPdf } from '../lib/pdf'
import { errorMessage } from '../lib/util'

// The document editor: the PDF drawn by pdf.js, with the form's fields as real inputs
// and everything else (text, checks, circles, ink, highlights, signatures) as marks
// laid over the page. Shared by the main window and the presentation window.

export type Tool = 'select' | 'text' | 'stamp' | 'check' | 'cross' | 'circle' | 'draw' | 'highlight' | 'sign' | 'erase'

type Markup = Pick<ClientDocument, 'marks' | 'fields'>

interface Widget {
  id: string
  name: string
  kind: 'text' | 'checkbox' | 'radio' | 'choice'
  x: number
  y: number
  w: number
  h: number
  multiline: boolean
  maxLen: number
  /** A radio button's or checkbox's "on" value. */
  onValue: string
  options: { value: string; label: string }[]
  initial: FieldValue
  readOnly: boolean
}

const INK_CSS: Record<InkColor, string> = { black: 'rgb(20 20 26)', blue: 'rgb(26 64 166)', red: 'rgb(199 31 31)' }
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 22, 28]
const id = () => crypto.randomUUID()
const markupKey = (m: Markup) => JSON.stringify([m.marks, m.fields])

const PREFS = 'echo.documentInk'
function loadPrefs(): { color: InkColor; size: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS) ?? '{}') as { color?: InkColor; size?: number }
    return { color: saved.color && saved.color in INK_CSS ? saved.color : 'black', size: SIZES.includes(saved.size ?? 0) ? saved.size! : 11 }
  } catch {
    return { color: 'black', size: 11 }
  }
}
function savePrefs(prefs: { color: InkColor; size: number }): void {
  try {
    localStorage.setItem(PREFS, JSON.stringify(prefs))
  } catch {
    // Not remembered; the default comes back next time.
  }
}

let measure: CanvasRenderingContext2D | null = null
function textWidth(text: string, size: number): number {
  measure ??= document.createElement('canvas').getContext('2d')
  if (!measure) return text.length * size * 0.55
  measure.font = `${size}px Helvetica, Arial, sans-serif`
  return Math.max(...text.split('\n').map((line) => measure!.measureText(line).width))
}

export interface DocEditorProps {
  doc: ClientDocument
  loadBytes(): Promise<Uint8Array>
  /** Called when marks, fields or the page layout change. `undoable` for the clinician's changes (not the layout). */
  onChange(patch: Pick<ClientDocument, 'marks' | 'fields' | 'layout'>, undoable: boolean): void
  /** Steps Undo and Redo can take, from the document's shared history. */
  history: DocHistory | null
  onUndo(): void
  onRedo(): void
  signers: Signer[]
  /** For the "Client's name" stamp. */
  clientName?: string
  readOnly?: boolean
  /** Bigger targets, and the page fills the window. */
  presentation?: boolean
  /** Shown at the right end of the toolbar. */
  actions?: ReactNode
  /** Shown above the pages. */
  banner?: ReactNode
  /** Hides the toolbar for a clean view; fields can still be filled in. */
  hideTools?: boolean
  /** Only these pages (one tab of a Library resource). Every page when left out. */
  pages?: { start: number; count: number }
}

export function DocEditor({ doc, loadBytes, onChange, history, onUndo, onRedo, signers, clientName, readOnly = false, presentation = false, actions, banner, hideTools = false, pages }: DocEditorProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [layout, setLayout] = useState<DocPage[] | null>(null)
  const [error, setError] = useState('')
  const [markup, setMarkup] = useState<Markup>({ marks: doc.marks, fields: doc.fields })
  const [tool, setToolState] = useState<Tool>('select')
  // Ink and size are remembered, and the same in the main and presentation windows.
  const [color, setColorState] = useState<InkColor>(() => loadPrefs().color)
  const [size, setSizeState] = useState(() => loadPrefs().size)
  const setColor = (c: InkColor) => (setColorState(c), savePrefs({ color: c, size }))
  const setSize = (n: number) => (setSizeState(n), savePrefs({ color, size: n }))
  const [stamp, setStamp] = useState('')
  const [signerId, setSignerId] = useState(signers.find((s) => s.signature)?.id ?? '')
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [width, setWidth] = useState(800)
  const scroller = useRef<HTMLDivElement>(null)

  const markupRef = useRef(markup)
  markupRef.current = markup
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const sent = useRef(markupKey(markup))
  /** Set while a drag or typing shows changes that haven't been committed yet. */
  const unsaved = useRef(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Changes from elsewhere (Undo, Redo, or the other window) replace what's shown, unless a change is in progress here.
  useEffect(() => {
    const incoming = { marks: doc.marks, fields: doc.fields }
    const key = markupKey(incoming)
    if (key === sent.current || unsaved.current) return
    sent.current = key
    setMarkup(incoming)
  }, [doc.marks, doc.fields])

  /**
   * Saves a change as one Undo step. `before` is the state it started from, for changes shown live
   * first (a drag, typing); nothing is saved if the change came to nothing.
   */
  const commit = useCallback((next: Markup, before: Markup = markupRef.current) => {
    unsaved.current = false
    setMarkup(next)
    const key = markupKey(next)
    if (key === markupKey(before) && key === sent.current) return
    sent.current = key
    onChangeRef.current({ ...next, layout: layoutRef.current }, true)
  }, [])
  /** Shows a change without saving it (while dragging or typing). */
  const live = useCallback((next: Markup) => {
    unsaved.current = true
    setMarkup(next)
  }, [])

  // Undo and Redo are kept in the main process, one history per document shared by both windows.
  const undoOnce = useCallback(() => {
    setSelected(null)
    setEditing(null)
    onUndo()
  }, [onUndo])
  const redoOnce = useCallback(() => {
    setSelected(null)
    setEditing(null)
    onRedo()
  }, [onRedo])

  // Load the PDF and measure its pages. The layout is saved with the document so marks can be placed on paper exactly.
  useEffect(() => {
    let cancelled = false
    let opened: PDFDocumentProxy | null = null
    setError('')
    loadBytes()
      .then(openPdf)
      .then(async (p) => {
        opened = p
        if (cancelled) return
        const pages: DocPage[] = []
        for (let i = 1; i <= p.numPages; i++) {
          const vp = (await p.getPage(i)).getViewport({ scale: 1 })
          pages.push({ w: vp.width, h: vp.height, t: [...vp.transform] })
        }
        if (cancelled) return
        setPdf(p)
        setLayout(pages)
        if (!readOnly && JSON.stringify(pages) !== JSON.stringify(doc.layout)) onChangeRef.current({ marks: doc.marks, fields: doc.fields, layout: pages }, false)
      })
      .catch((err) => !cancelled && setError(errorMessage(err)))
    return () => {
      cancelled = true
      void opened?.loadingTask.destroy()
    }
    // The file never changes for a document, so it's loaded once per document.
  }, [doc.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  // A new tab starts at its first page.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0
  }, [pages?.start])

  const widest = layout ? Math.max(...layout.map((p) => p.w)) : 612
  // Fits the page's width, but no larger than a comfortable reading size (bigger when presenting).
  const fit = Math.max(0.4, Math.min(presentation ? 2.2 : 1.4, (width - (presentation ? 48 : 64)) / widest))
  const scale = zoom === 'fit' ? fit : zoom
  const setZoomBy = (factor: number) => setZoom(Math.max(0.4, Math.min(4, Math.round(scale * factor * 20) / 20)))

  const setTool = (t: Tool) => {
    setToolState(t)
    setSelected(null)
    setEditing(null)
  }

  const selectedMark = markup.marks.find((m) => m.id === selected) ?? null
  const signer = signers.find((s) => s.id === signerId && s.signature)

  // Changing size or colour changes the selected mark too.
  const restyle = (patch: { size?: number; color?: InkColor }) => {
    if (patch.size) setSize(patch.size)
    if (patch.color) setColor(patch.color)
    if (!selectedMark) return
    const next = { ...selectedMark } as DocMark
    if (patch.color && 'color' in next) next.color = patch.color
    if (patch.size && (next.type === 'text' || next.type === 'check' || next.type === 'cross')) next.size = next.type === 'text' ? patch.size : patch.size * 1.3
    commit({ ...markup, marks: markup.marks.map((m) => (m.id === next.id ? next : m)) })
  }

  const removeMark = useCallback(
    (markId: string) => {
      const m = markupRef.current
      commit({ ...m, marks: m.marks.filter((x) => x.id !== markId) })
      setSelected((s) => (s === markId ? null : s))
    },
    [commit]
  )

  // Keyboard: tool letters, Delete, Undo/Redo. Not while typing.
  useEffect(() => {
    if (readOnly) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const typing = target.closest('input, textarea, select, [contenteditable="true"]')
      if (e.metaKey && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault()
        if (e.shiftKey) redoOnce()
        else undoOnce()
        return
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if ((e.key === 'Backspace' || e.key === 'Delete') && selected) {
        e.preventDefault()
        removeMark(selected)
        return
      }
      if (e.key === 'Escape') {
        if (selected) setSelected(null)
        else setTool('select')
        return
      }
      const keys: Record<string, Tool> = { v: 'select', t: 'text', c: 'check', x: 'cross', o: 'circle', d: 'draw', h: 'highlight', e: 'erase' }
      const t = keys[e.key.toLowerCase()]
      if (t) setTool(t)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [readOnly, selected, undoOnce, redoOnce, removeMark])

  const ctx: PageContext = {
    markup,
    tool: readOnly || hideTools ? 'select' : tool,
    color,
    size,
    stamp,
    signer,
    selected,
    editing,
    readOnly,
    scale,
    commit,
    live,
    setSelected,
    setEditing,
    removeMark,
    afterPlace: () => {
      // A stamp is placed once; the other tools stay on for the next answer.
      if (tool === 'stamp' || tool === 'sign') setToolState('select')
    }
  }

  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
  const tools: { tool: Tool; icon: ReactNode; label: string; key?: string }[] = [
    { tool: 'select', icon: <MousePointer2 size={16} />, label: 'Select, move and fill in fields', key: 'V' },
    { tool: 'text', icon: <Type size={16} />, label: 'Text', key: 'T' },
    { tool: 'check', icon: <Check size={16} />, label: 'Check mark', key: 'C' },
    { tool: 'cross', icon: <X size={16} />, label: 'Cross', key: 'X' },
    { tool: 'circle', icon: <Circle size={16} />, label: 'Circle an answer (click, or drag for a bigger one)', key: 'O' },
    { tool: 'draw', icon: <PenLine size={16} />, label: 'Draw', key: 'D' },
    { tool: 'highlight', icon: <Highlighter size={16} />, label: 'Highlight (drag across)', key: 'H' },
    { tool: 'erase', icon: <Eraser size={16} />, label: 'Erase marks', key: 'E' }
  ]

  return (
    <div className={`doc-editor ${presentation ? 'presenting' : ''}`}>
      {!readOnly && !hideTools && (
        <div className="doc-toolbar" role="toolbar" aria-label="Markup tools">
          <div className="doc-tools">
            {tools.map((t) => (
              <button key={t.tool} className={`doc-tool ${tool === t.tool ? 'on' : ''}`} onClick={() => setTool(t.tool)} title={t.key ? `${t.label} (${t.key})` : t.label} aria-label={t.label} aria-pressed={tool === t.tool}>
                {t.icon}
              </button>
            ))}
            <span className="doc-sep" />
            <button
              className={`doc-tool ${tool === 'stamp' && stamp === today ? 'on' : ''}`}
              onClick={() => {
                setTool('stamp')
                setStamp(today)
              }}
              title={`Today’s date (${today}): click where it goes`}
              aria-label="Stamp today’s date"
            >
              <CalendarDays size={16} />
            </button>
            {clientName && (
              <button
                className={`doc-tool ${tool === 'stamp' && stamp === clientName ? 'on' : ''}`}
                onClick={() => {
                  setTool('stamp')
                  setStamp(clientName)
                }}
                title="Client’s name: click where it goes"
                aria-label="Stamp the client’s name"
              >
                <UserRound size={16} />
              </button>
            )}
            <SignButton signers={signers} signerId={signerId} active={tool === 'sign'} onPick={(sid) => (setSignerId(sid), setTool('sign'))} />
          </div>
          <div className="doc-style">
            {(['black', 'blue', 'red'] as InkColor[]).map((c) => (
              <button key={c} className={`doc-swatch ${color === c ? 'on' : ''}`} style={{ color: INK_CSS[c] }} onClick={() => restyle({ color: c })} title={`${c[0].toUpperCase()}${c.slice(1)} ink`} aria-label={`${c} ink`}>
                <span />
              </button>
            ))}
            <select className="doc-size" value={size} onChange={(e) => restyle({ size: Number(e.target.value) })} title="Text and mark size" aria-label="Size">
              {SIZES.map((s) => (
                <option key={s} value={s}>
                  {s} pt
                </option>
              ))}
            </select>
            {selectedMark && (
              <button className="doc-tool" onClick={() => removeMark(selectedMark.id)} title="Delete (⌫)" aria-label="Delete mark">
                <Trash2 size={16} />
              </button>
            )}
            <span className="doc-sep" />
            <button className="doc-tool" onClick={undoOnce} disabled={!history?.undo} title="Undo (⌘Z)" aria-label="Undo">
              <Undo2 size={16} />
            </button>
            <button className="doc-tool" onClick={redoOnce} disabled={!history?.redo} title="Redo (⇧⌘Z)" aria-label="Redo">
              <Redo2 size={16} />
            </button>
          </div>
          <div className="doc-zoom">
            <button className="doc-tool" onClick={() => setZoomBy(1 / 1.15)} aria-label="Zoom out" title="Zoom out">
              <Minus size={15} />
            </button>
            <button className="doc-zoom-value" onClick={() => setZoom('fit')} title="Fit to width">
              {Math.round(scale * 100)}%
            </button>
            <button className="doc-tool" onClick={() => setZoomBy(1.15)} aria-label="Zoom in" title="Zoom in">
              <Plus size={15} />
            </button>
          </div>
          {actions && <div className="doc-actions">{actions}</div>}
        </div>
      )}
      {readOnly && actions && (
        <div className="doc-toolbar">
          <span className="doc-toolbar-gap" />
          <div className="doc-actions">{actions}</div>
        </div>
      )}
      {banner}
      <div
        ref={scroller}
        className={`doc-scroll tool-${readOnly ? 'none' : hideTools ? 'select' : tool}`}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) setSelected(null)
        }}
      >
        {error && <div className="doc-error">{error}</div>}
        {!error && (!pdf || !layout) && <div className="doc-loading">Opening…</div>}
        {pdf && layout && (
          <div className="doc-pages">
            {layout.map((page, i) => (!pages || (i >= pages.start && i < pages.start + pages.count) ? <PageView key={i} pdf={pdf} index={i} page={page} ctx={ctx} root={scroller} /> : null))}
          </div>
        )}
      </div>
    </div>
  )
}

function SignButton({ signers, signerId, active, onPick }: { signers: Signer[]; signerId: string; active: boolean; onPick(id: string): void }) {
  const [open, setOpen] = useState(false)
  const usable = signers.filter((s) => s.signature)
  if (!signers.length) return null
  return (
    <div className="menu-wrap">
      <button
        className={`doc-tool ${active ? 'on' : ''}`}
        onClick={() => (usable.length === 1 ? onPick(usable[0].id) : setOpen((v) => !v))}
        title={usable.length ? 'Sign: click where the signature goes' : 'Add a signature under Letterhead & signatures first'}
        aria-label="Sign"
        disabled={!usable.length}
      >
        <Signature size={16} />
      </button>
      {open && (
        <div className="menu doc-sign-menu" onMouseLeave={() => setOpen(false)}>
          {usable.map((s) => (
            <button key={s.id} className={s.id === signerId ? 'on' : ''} onClick={() => (setOpen(false), onPick(s.id))}>
              <img src={s.signature} alt="" />
              <span>{signerLabel(s)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// One page
// ---------------------------------------------------------------------------

interface PageContext {
  markup: Markup
  tool: Tool
  color: InkColor
  size: number
  stamp: string
  signer: Signer | undefined
  selected: string | null
  editing: string | null
  readOnly: boolean
  scale: number
  commit(next: Markup, before?: Markup): void
  live(next: Markup): void
  setSelected(id: string | null): void
  setEditing(id: string | null): void
  removeMark(id: string): void
  afterPlace(): void
}

/** A gesture in progress on the page: drawing, dragging out a shape, or moving a mark. */
type Gesture =
  | { kind: 'draw'; points: number[] }
  | { kind: 'box'; type: 'circle' | 'highlight'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'move'; id: string; dx: number; dy: number; before: Markup; moved: boolean }
  | { kind: 'resize'; id: string; before: Markup }
  | { kind: 'erase'; before: Markup }

function PageView({ pdf, index, page, ctx, root }: { pdf: PDFDocumentProxy; index: number; page: DocPage; ctx: PageContext; root: React.RefObject<HTMLDivElement | null> }) {
  const { scale } = ctx
  const holder = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(index < 2)
  const [proxy, setProxy] = useState<PDFPageProxy | null>(null)
  const [widgets, setWidgets] = useState<Widget[]>([])
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const gestureRef = useRef(gesture)
  gestureRef.current = gesture

  // Pages are drawn only near the screen, so long workbooks open quickly.
  useEffect(() => {
    const el = holder.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setVisible(true), { root: root.current, rootMargin: '600px 0px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [root])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    void pdf.getPage(index + 1).then(async (p) => {
      if (cancelled) return
      setProxy(p)
      setWidgets(await readWidgets(p))
    })
    return () => {
      cancelled = true
    }
  }, [visible, pdf, index])

  useEffect(() => {
    const el = canvas.current
    if (!proxy || !el) return
    const ratio = window.devicePixelRatio || 1
    const viewport = proxy.getViewport({ scale: scale * ratio })
    let task: RenderTask | null = null
    // Debounced, so pinching through zoom levels doesn't queue a render for each.
    const t = window.setTimeout(() => {
      const offscreen = document.createElement('canvas')
      offscreen.width = Math.floor(viewport.width)
      offscreen.height = Math.floor(viewport.height)
      task = proxy.render({ canvas: offscreen, viewport, annotationMode: AnnotationMode.ENABLE })
      task.promise
        .then(() => {
          el.width = offscreen.width
          el.height = offscreen.height
          el.getContext('2d')?.drawImage(offscreen, 0, 0)
        })
        .catch(() => {})
    }, 60)
    return () => {
      window.clearTimeout(t)
      task?.cancel()
    }
  }, [proxy, scale])

  const marks = ctx.markup.marks.filter((m) => m.page === index)
  const W = page.w * scale
  const H = page.h * scale

  const pointAt = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = holder.current!.getBoundingClientRect()
    return [(e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale]
  }

  const add = (mark: DocMark) => {
    ctx.commit({ ...ctx.markup, marks: [...ctx.markup.marks, mark] })
    ctx.afterPlace()
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (ctx.readOnly || e.button !== 0) return
    // Clicks on fields and marks are theirs.
    if ((e.target as HTMLElement).closest('.doc-field, .doc-mark, .doc-handle, .doc-text-edit')) return
    const [x, y] = pointAt(e)
    const { tool, color, size } = ctx
    switch (tool) {
      case 'select':
        ctx.setSelected(null)
        ctx.setEditing(null)
        return
      case 'text': {
        const mark: DocMark = { id: id(), page: index, type: 'text', x, y: y - (size * LINE_HEIGHT) / 2, size, text: '', color }
        ctx.live({ ...ctx.markup, marks: [...ctx.markup.marks, mark] })
        ctx.setEditing(mark.id)
        ctx.setSelected(mark.id)
        e.preventDefault()
        return
      }
      case 'stamp':
        if (ctx.stamp) add({ id: id(), page: index, type: 'text', x, y: y - (size * LINE_HEIGHT) / 2, size, text: ctx.stamp, color })
        return
      case 'check':
      case 'cross':
        add({ id: id(), page: index, type: tool, x, y, size: size * 1.3, color })
        return
      case 'sign': {
        const signer = ctx.signer
        if (!signer) return
        const img = new Image()
        img.onload = () => {
          const w = 150
          const h = Math.max(12, Math.min(90, (w * img.naturalHeight) / Math.max(1, img.naturalWidth)))
          add({ id: id(), page: index, type: 'signature', x: x - w / 2, y: y - h / 2, w, h, image: signer.signature, signer: signer.id })
        }
        img.src = signer.signature
        return
      }
      case 'draw':
        setGesture({ kind: 'draw', points: [round(x), round(y)] })
        break
      case 'circle':
      case 'highlight':
        setGesture({ kind: 'box', type: tool, x0: x, y0: y, x1: x, y1: y })
        break
      case 'erase':
        setGesture({ kind: 'erase', before: ctx.markup })
        break
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current
    if (!g) return
    const [x, y] = pointAt(e)
    if (g.kind === 'draw') {
      const n = g.points.length
      // Skip points closer than half a point to the last, to keep strokes small.
      if (Math.hypot(x - g.points[n - 2], y - g.points[n - 1]) >= 0.5) setGesture({ ...g, points: [...g.points, round(x), round(y)] })
    } else if (g.kind === 'box') setGesture({ ...g, x1: x, y1: y })
    else if (g.kind === 'move') {
      const m = ctx.markup.marks.find((k) => k.id === g.id)
      if (!m) return
      ctx.live({ ...ctx.markup, marks: ctx.markup.marks.map((k) => (k.id === g.id ? moveTo(k, x - g.dx, y - g.dy) : k)) })
      if (!g.moved) setGesture({ ...g, moved: true })
    } else if (g.kind === 'resize') {
      ctx.live({ ...ctx.markup, marks: ctx.markup.marks.map((k) => (k.id === g.id ? resizeTo(k, x, y) : k)) })
    } else if (g.kind === 'erase') {
      const hit = hitMark(marks, x, y, 4 / scale + 3)
      if (hit) ctx.live({ ...ctx.markup, marks: ctx.markup.marks.filter((k) => k.id !== hit.id) })
    }
  }

  const onPointerUp = () => {
    const g = gestureRef.current
    setGesture(null)
    if (!g) return
    const { color } = ctx
    if (g.kind === 'draw') {
      if (g.points.length >= 2) add({ id: id(), page: index, type: 'ink', points: g.points, width: 1.6, color })
    } else if (g.kind === 'box') {
      const x = Math.min(g.x0, g.x1)
      const y = Math.min(g.y0, g.y1)
      const w = Math.abs(g.x1 - g.x0)
      const h = Math.abs(g.y1 - g.y0)
      if (g.type === 'circle') {
        // A click circles one answer: sized to the text size, centred where it was clicked.
        if (w < 4 && h < 4) {
          const cw = ctx.size * 2.2
          const ch = ctx.size * 1.7
          add({ id: id(), page: index, type: 'circle', x: g.x0 - cw / 2, y: g.y0 - ch / 2, w: cw, h: ch, color })
        } else add({ id: id(), page: index, type: 'circle', x, y, w, h, color })
      } else if (w > 3 && h > 3) add({ id: id(), page: index, type: 'highlight', x, y, w, h })
    } else if (g.kind === 'move') {
      if (g.moved) ctx.commit(ctx.markup, g.before)
    } else if (g.kind === 'resize' || g.kind === 'erase') ctx.commit(ctx.markup, g.before)
  }

  /** A mark was pressed: select and start moving it, erase it, or edit its text. */
  const onMarkDown = (e: ReactPointerEvent, mark: DocMark) => {
    if (ctx.readOnly || e.button !== 0) return
    const { tool } = ctx
    if (tool === 'erase') {
      e.stopPropagation()
      ctx.removeMark(mark.id)
      return
    }
    if (tool !== 'select' && !(tool === 'text' && mark.type === 'text')) return
    e.stopPropagation()
    e.preventDefault()
    if (tool === 'text' && mark.type === 'text') {
      ctx.setSelected(mark.id)
      ctx.setEditing(mark.id)
      return
    }
    const [x, y] = pointAt(e)
    const [mx, my] = anchorOf(mark)
    ctx.setSelected(mark.id)
    setGesture({ kind: 'move', id: mark.id, dx: x - mx, dy: y - my, before: ctx.markup, moved: false })
    holder.current?.setPointerCapture(e.pointerId)
  }

  const g = gesture
  return (
    <div
      ref={holder}
      className="doc-page"
      style={{ width: W, height: H }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      data-page={index + 1}
    >
      <canvas ref={canvas} className="doc-canvas" style={{ width: W, height: H }} />
      <div className="doc-fields">
        {widgets.map((w) => (
          <FieldInput key={w.id} widget={w} ctx={ctx} />
        ))}
      </div>
      <svg className="doc-ink" width={W} height={H} viewBox={`0 0 ${page.w} ${page.h}`} aria-hidden>
        {marks.map((m) => (m.type === 'highlight' ? <rect key={m.id} x={m.x} y={m.y} width={m.w} height={m.h} className="doc-hl" /> : null))}
        {marks.map((m) => {
          if (m.type === 'ink') return <polyline key={m.id} points={pairs(m.points)} fill="none" stroke={INK_CSS[m.color]} strokeWidth={m.width} strokeLinecap="round" strokeLinejoin="round" />
          if (m.type === 'check' || m.type === 'cross')
            return glyphStrokes(m.type, m.x, m.y, m.size).map((pts, i) => (
              <polyline key={`${m.id}-${i}`} points={pairs(pts)} fill="none" stroke={INK_CSS[m.color]} strokeWidth={glyphWidth(m.size)} strokeLinecap="round" strokeLinejoin="round" />
            ))
          if (m.type === 'circle') return <ellipse key={m.id} cx={m.x + m.w / 2} cy={m.y + m.h / 2} rx={m.w / 2} ry={m.h / 2} fill="none" stroke={INK_CSS[m.color]} strokeWidth={1.4} />
          return null
        })}
        {g?.kind === 'draw' && <polyline points={pairs(g.points)} fill="none" stroke={INK_CSS[ctx.color]} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />}
        {g?.kind === 'box' && g.type === 'highlight' && <rect x={Math.min(g.x0, g.x1)} y={Math.min(g.y0, g.y1)} width={Math.abs(g.x1 - g.x0)} height={Math.abs(g.y1 - g.y0)} className="doc-hl" />}
        {g?.kind === 'box' && g.type === 'circle' && (
          <ellipse cx={(g.x0 + g.x1) / 2} cy={(g.y0 + g.y1) / 2} rx={Math.abs(g.x1 - g.x0) / 2} ry={Math.abs(g.y1 - g.y0) / 2} fill="none" stroke={INK_CSS[ctx.color]} strokeWidth={1.4} />
        )}
      </svg>
      {marks.map((m) =>
        m.type === 'text' && ctx.editing === m.id ? (
          <TextEditor key={m.id} mark={m} ctx={ctx} />
        ) : (
          <MarkHandle key={m.id} mark={m} scale={scale} selected={ctx.selected === m.id} onDown={(e) => onMarkDown(e, m)} onEdit={() => !ctx.readOnly && m.type === 'text' && (ctx.setSelected(m.id), ctx.setEditing(m.id))} onResize={(e) => {
            e.stopPropagation()
            e.preventDefault()
            setGesture({ kind: 'resize', id: m.id, before: ctx.markup })
            holder.current?.setPointerCapture(e.pointerId)
          }} />
        )
      )}
    </div>
  )
}

/** The clickable box for a mark (and how text and signatures are shown). Ink, checks and circles are drawn in the SVG beneath. */
function MarkHandle({ mark, scale, selected, onDown, onEdit, onResize }: { mark: DocMark; scale: number; selected: boolean; onDown(e: ReactPointerEvent): void; onEdit(): void; onResize(e: ReactPointerEvent): void }) {
  const [x, y, w, h] = boundsOf(mark)
  const pad = mark.type === 'ink' || mark.type === 'check' || mark.type === 'cross' ? 3 : 0
  const style = { left: (x - pad) * scale, top: (y - pad) * scale, width: (w + pad * 2) * scale, height: (h + pad * 2) * scale }
  const resizable = mark.type === 'circle' || mark.type === 'highlight' || mark.type === 'signature'
  return (
    <div className={`doc-mark mark-${mark.type} ${selected ? 'selected' : ''}`} style={style} onPointerDown={onDown} onDoubleClick={onEdit}>
      {mark.type === 'text' && (
        <span className="doc-text" style={{ fontSize: mark.size * scale, lineHeight: `${mark.size * LINE_HEIGHT * scale}px`, color: INK_CSS[mark.color] }}>
          {mark.text}
        </span>
      )}
      {mark.type === 'signature' && <img src={mark.image} alt="Signature" draggable={false} />}
      {selected && resizable && <span className="doc-handle" onPointerDown={onResize} />}
    </div>
  )
}

function TextEditor({ mark, ctx }: { mark: Extract<DocMark, { type: 'text' }>; ctx: PageContext }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  // What the page looked like before this edit, for one Undo step covering all the typing.
  const before = useRef<Markup>({ ...ctx.markup, marks: ctx.markup.marks.filter((m) => m.id !== mark.id || (m.type === 'text' && m.text)) })
  const latest = useRef(ctx)
  latest.current = ctx
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = () => {
    const c = latest.current
    const current = c.markup.marks.find((m) => m.id === mark.id)
    // An empty box is dropped.
    const marks = current && current.type === 'text' && current.text.trim() ? c.markup.marks : c.markup.marks.filter((m) => m.id !== mark.id)
    c.commit({ ...c.markup, marks }, before.current)
    c.setEditing(null)
  }
  const { scale } = ctx
  const lines = Math.max(1, mark.text.split('\n').length)
  return (
    <textarea
      ref={ref}
      className="doc-text-edit"
      value={mark.text}
      spellCheck
      wrap="off"
      style={{
        left: mark.x * scale,
        top: mark.y * scale,
        width: Math.max(40, textWidth(mark.text, mark.size * scale) + mark.size * scale),
        height: lines * mark.size * LINE_HEIGHT * scale + 2,
        fontSize: mark.size * scale,
        lineHeight: `${mark.size * LINE_HEIGHT * scale}px`,
        color: INK_CSS[mark.color]
      }}
      onChange={(e) => ctx.live({ ...ctx.markup, marks: ctx.markup.marks.map((m) => (m.id === mark.id ? { ...mark, text: e.target.value } : m)) })}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && e.metaKey)) {
          e.preventDefault()
          ref.current?.blur()
        }
        e.stopPropagation()
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  )
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

async function readWidgets(page: PDFPageProxy): Promise<Widget[]> {
  const vp = page.getViewport({ scale: 1 })
  const annotations = (await page.getAnnotations({ intent: 'display' })) as Record<string, unknown>[]
  const widgets: Widget[] = []
  for (const a of annotations) {
    if (a.subtype !== 'Widget' || a.hidden || !a.fieldName) continue
    const type = a.fieldType
    let kind: Widget['kind']
    if (type === 'Tx') kind = 'text'
    else if (type === 'Ch') kind = 'choice'
    else if (type === 'Btn' && a.checkBox) kind = 'checkbox'
    else if (type === 'Btn' && a.radioButton) kind = 'radio'
    else continue
    const r = a.rect as number[]
    const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]) as number[]
    const [x2, y2] = vp.convertToViewportPoint(r[2], r[3]) as number[]
    const value = a.fieldValue
    const onValue = String((kind === 'radio' ? a.buttonValue : a.exportValue) ?? 'Yes')
    widgets.push({
      id: String(a.id),
      name: String(a.fieldName),
      kind,
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1),
      multiline: !!a.multiLine,
      maxLen: typeof a.maxLen === 'number' && a.maxLen > 0 ? a.maxLen : 0,
      onValue,
      options: Array.isArray(a.options) ? (a.options as { exportValue: string; displayValue: string }[]).map((o) => ({ value: o.exportValue, label: o.displayValue })) : [],
      initial: kind === 'checkbox' ? !!value && value !== 'Off' : Array.isArray(value) ? String(value[0] ?? '') : typeof value === 'string' ? value : '',
      readOnly: !!a.readOnly
    })
  }
  // Tab moves through fields top to bottom, then left to right.
  return widgets.sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x))
}

function FieldInput({ widget: w, ctx }: { widget: Widget; ctx: PageContext }) {
  const { scale } = ctx
  const stored = ctx.markup.fields[w.name]
  const value = stored ?? w.initial
  const before = useRef<Markup | null>(null)
  const disabled = ctx.readOnly || w.readOnly
  const style = { left: w.x * scale, top: w.y * scale, width: w.w * scale, height: w.h * scale }
  const set = (v: FieldValue, liveOnly = false) => {
    const next = { ...ctx.markup, fields: { ...ctx.markup.fields, [w.name]: v } }
    if (liveOnly) ctx.live(next)
    else ctx.commit(next, before.current ?? ctx.markup)
  }
  // Only the select tool and the text tool fill in fields; the others draw over them.
  const passive = ctx.tool !== 'select' && ctx.tool !== 'text'
  const cls = `doc-field field-${w.kind} ${passive ? 'passive' : ''}`
  switch (w.kind) {
    case 'text': {
      const fontSize = (w.multiline ? Math.min(11, w.h * 0.6) : Math.max(6, Math.min(12, w.h * 0.68))) * scale
      const props = {
        className: cls,
        style: { ...style, fontSize },
        value: String(value),
        disabled,
        maxLength: w.maxLen || undefined,
        spellCheck: true,
        title: w.name,
        onFocus: () => (before.current = ctx.markup),
        onChange: (e: { target: { value: string } }) => set(e.target.value, true),
        onBlur: () => {
          if (before.current) set(String(ctx.markup.fields[w.name] ?? value))
          before.current = null
        }
      }
      return w.multiline ? <textarea {...props} /> : <input type="text" {...props} />
    }
    case 'checkbox':
      return (
        <button className={`${cls} ${value === true ? 'on' : ''}`} style={style} disabled={disabled} onClick={() => set(value !== true)} role="checkbox" aria-checked={value === true} title={w.name}>
          {value === true && <Check size={Math.max(8, Math.min(w.w, w.h) * scale * 0.8)} strokeWidth={3} />}
        </button>
      )
    case 'radio': {
      const on = value === w.onValue
      return (
        <button className={`${cls} ${on ? 'on' : ''}`} style={style} disabled={disabled} onClick={() => set(on ? '' : w.onValue)} role="radio" aria-checked={on} title={`${w.name}: ${w.onValue}`}>
          {on && <span className="dot" />}
        </button>
      )
    }
    case 'choice':
      return (
        <select className={cls} style={{ ...style, fontSize: Math.max(6, Math.min(12, w.h * 0.65)) * scale }} disabled={disabled} value={String(value)} onChange={(e) => set(e.target.value)} title={w.name}>
          <option value="" />
          {w.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
  }
}

// ---------------------------------------------------------------------------
// Mark geometry
// ---------------------------------------------------------------------------

const round = (n: number) => Math.round(n * 10) / 10
const pairs = (pts: number[]) => pts.map((v, i) => (i % 2 ? `${v} ` : `${v},`)).join('')

function boundsOf(m: DocMark): [number, number, number, number] {
  switch (m.type) {
    case 'text': {
      const lines = m.text.split('\n')
      return [m.x, m.y, Math.max(8, textWidth(m.text, m.size)), lines.length * m.size * LINE_HEIGHT]
    }
    case 'check':
    case 'cross':
      return [m.x - m.size / 2, m.y - m.size / 2, m.size, m.size]
    case 'ink': {
      const xs = m.points.filter((_, i) => i % 2 === 0)
      const ys = m.points.filter((_, i) => i % 2 === 1)
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      return [x, y, Math.max(2, Math.max(...xs) - x), Math.max(2, Math.max(...ys) - y)]
    }
    default:
      return [m.x, m.y, m.w, m.h]
  }
}

/** The point a mark is dragged by. */
function anchorOf(m: DocMark): [number, number] {
  const [x, y] = boundsOf(m)
  return m.type === 'check' || m.type === 'cross' ? [m.x, m.y] : [x, y]
}

function moveTo(m: DocMark, x: number, y: number): DocMark {
  if (m.type === 'ink') {
    const [bx, by] = boundsOf(m)
    return { ...m, points: m.points.map((v, i) => round(v + (i % 2 ? y - by : x - bx))) }
  }
  return { ...m, x: round(x), y: round(y) }
}

function resizeTo(m: DocMark, x: number, y: number): DocMark {
  if (m.type !== 'circle' && m.type !== 'highlight' && m.type !== 'signature') return m
  const w = Math.max(6, x - m.x)
  // Signatures keep their shape.
  const h = m.type === 'signature' ? (w * m.h) / m.w : Math.max(6, y - m.y)
  return { ...m, w: round(w), h: round(h) }
}

function hitMark(marks: DocMark[], x: number, y: number, slop: number): DocMark | undefined {
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i]
    if (m.type === 'ink') {
      for (let j = 0; j < m.points.length; j += 2) if (Math.hypot(m.points[j] - x, m.points[j + 1] - y) <= slop + m.width) return m
      continue
    }
    const [bx, by, bw, bh] = boundsOf(m)
    if (x >= bx - slop && x <= bx + bw + slop && y >= by - slop && y <= by + bh + slop) return m
  }
  return undefined
}

