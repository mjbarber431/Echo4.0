import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Bold,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Loader2,
  Lock,
  Mic,
  Minus,
  Plus,
  Quote,
  RemoveFormatting,
  Shuffle,
  Sparkles,
  Square,
  Strikethrough,
  Type,
  X
} from 'lucide-react'
import type { Client } from '@shared/types'
import { escapeInline, escapeLineStart, HIGHLIGHTS, highlightCss, SCRATCH_TEMPLATES, scratchToHtml, SPARKS, type Highlight } from '@shared/scratch'
import { todayISO } from '@shared/compliance'
import { domToScratch } from '../lib/scratchDom'
import { formatElapsed, useDictation } from '../lib/useDictation'
import { longDate } from '../lib/util'
import { useCommand, useStore } from '../store'

// The scratchpad is a contenteditable page whose DOM is serialized to a small
// Markdown dialect on every change (src/shared/scratch.ts). React renders the
// page once per client and then leaves its contents to the browser, so the caret
// and native undo are never disturbed by re-renders.

const BLOCK_SEL = 'p,div,h1,h2,h3,h4,h5,h6,li,blockquote,pre'
const CHECKLIST_ITEMS = 'ul[data-type="checklist"] > li'

type BlockKind = 'p' | 'h2' | 'h3' | 'blockquote'
interface Active {
  block: BlockKind | null
  list: 'ul' | 'ol' | 'todo' | null
  b: boolean
  i: boolean
  s: boolean
  hl: boolean
}
const IDLE: Active = { block: null, list: null, b: false, i: false, s: false, hl: false }

/** Markdown typed at the start of a paragraph, then a space. */
const SHORTCUTS: Record<string, BlockKind | 'ul' | 'ol' | 'todo'> = {
  '#': 'h2',
  '##': 'h2',
  '###': 'h3',
  '-': 'ul',
  '*': 'ul',
  '1.': 'ol',
  '[]': 'todo',
  '[ ]': 'todo',
  '>': 'blockquote'
}

const exec = (command: string, value?: string) => document.execCommand(command, false, value)

/** Whether the formatting tools are showing. A per-Mac preference, so it lives in the browser. */
const TOOLS_KEY = 'echo.scratchpad.tools'
const readTools = (): boolean => {
  try {
    return localStorage.getItem(TOOLS_KEY) !== 'hidden'
  } catch {
    return true
  }
}

/** Private clinician notes. Never part of the record and never sent to the AI. */
export function Scratchpad({ client }: { client: Client }) {
  const { saveClient, toast } = useStore()
  const save = useRef(saveClient)
  save.current = saveClient
  const editor = useRef<HTMLDivElement>(null)
  const draggingOut = useRef(false)
  const latest = useRef(client)
  latest.current = client
  const pending = useRef<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const lastRange = useRef<Range | null>(null)
  const [saved, setSaved] = useState(true)
  const [active, setActive] = useState<Active>(IDLE)
  const [color, setColor] = useState<Highlight>('yellow')
  const [menu, setMenu] = useState<'insert' | 'highlight' | null>(null)
  const [spark, setSpark] = useState<number | null>(null)
  const [showTools, setShowTools] = useState(readTools)
  const toolbar = useRef<HTMLDivElement>(null)
  const toggleBtn = useRef<HTMLButtonElement>(null)
  /** The toolbar floats over the page, which keeps room for it either way so the text never moves. */
  const [bar, setBar] = useState({ height: 46, clip: 'none' })
  /** The Markdown last written to the client, for dictation that finishes after the tab has closed. */
  const stored = useRef(client.scratchpad)
  const [rail, setRail] = useState(() => ({ loops: [] as { index: number; text: string }[], done: 0, outline: [] as { index: number; text: string; level: number }[], words: 0 }))

  const flush = () => {
    window.clearTimeout(timer.current)
    if (pending.current !== null && pending.current !== latest.current.scratchpad) {
      stored.current = pending.current
      save.current({ ...latest.current, scratchpad: pending.current })
    }
    pending.current = null
  }

  const readRail = () => {
    const el = editor.current
    if (!el) return
    const items = [...el.querySelectorAll<HTMLElement>(CHECKLIST_ITEMS)]
    setRail({
      loops: items.map((li, index) => ({ index, li })).filter(({ li }) => li.dataset.checked !== 'true' && li.textContent?.trim()).map(({ index, li }) => ({ index, text: li.textContent!.trim() })),
      done: items.filter((li) => li.dataset.checked === 'true').length,
      outline: [...el.querySelectorAll<HTMLElement>('h1,h2,h3,h4')].map((h, index) => ({ index, text: h.textContent?.trim() ?? '', level: h.tagName === 'H3' || h.tagName === 'H4' ? 3 : 2 })).filter((h) => h.text),
      words: (el.innerText.match(/\S+/g) ?? []).length
    })
  }

  /** Called after every change: tidy the DOM, serialize it and save shortly. */
  const sync = () => {
    const el = editor.current
    if (!el) return
    if (!el.firstChild) el.innerHTML = '<p><br></p>'
    el.querySelectorAll<HTMLElement>(CHECKLIST_ITEMS).forEach((li) => li.dataset.checked !== 'true' && (li.dataset.checked = 'false'))
    pending.current = domToScratch(el)
    setSaved(false)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      flush()
      setSaved(true)
    }, 500)
    readRail()
  }

  useLayoutEffect(() => {
    const el = editor.current
    if (!el) return
    el.innerHTML = scratchToHtml(latest.current.scratchpad)
    readRail()
  }, [client.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Collapsing clips the toolbar down to the toggle button's box, wherever wrapping has put it.
  useLayoutEffect(() => {
    const el = toolbar.current
    const t = toggleBtn.current
    if (!el || !t) return
    const measure = () => {
      const [w, h] = [el.offsetWidth, el.offsetHeight]
      setBar({ height: h, clip: `inset(${t.offsetTop}px ${w - t.offsetLeft - t.offsetWidth}px ${h - t.offsetTop - t.offsetHeight}px ${t.offsetLeft}px round 9px)` })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Leaving the tab unmounts the page, so a pending save is written rather than dropped.
  useEffect(() => () => flush(), []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    exec('defaultParagraphSeparator', 'p')
    exec('styleWithCSS', 'false')
    const onSelection = () => {
      const el = editor.current
      const sel = window.getSelection()
      if (!el || !sel?.rangeCount || !el.contains(sel.anchorNode)) return
      lastRange.current = sel.getRangeAt(0).cloneRange()
      const block = currentBlock()
      const list = block?.closest('ul,ol')
      const tag = block?.tagName.toLowerCase()
      setActive({
        block: tag === 'h1' || tag === 'h2' ? 'h2' : tag === 'h3' || tag === 'h4' ? 'h3' : tag === 'blockquote' || block?.closest('blockquote') ? 'blockquote' : tag === 'p' || tag === 'div' ? 'p' : null,
        list: !list ? null : list.tagName === 'OL' ? 'ol' : (list as HTMLElement).dataset.type === 'checklist' ? 'todo' : 'ul',
        b: document.queryCommandState('bold'),
        i: document.queryCommandState('italic'),
        s: document.queryCommandState('strikeThrough'),
        hl: !!currentHighlight()
      })
    }
    document.addEventListener('selectionchange', onSelection)
    return () => document.removeEventListener('selectionchange', onSelection)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** The innermost block holding the caret. */
  const currentBlock = (): HTMLElement | null => {
    const el = editor.current
    const node = window.getSelection()?.anchorNode
    if (!el || !node || !el.contains(node)) return null
    const start = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
    const block = start?.closest<HTMLElement>(BLOCK_SEL)
    return block && el.contains(block) && block !== el ? block : null
  }

  /** The editor's direct child holding the caret. */
  const topBlock = (): HTMLElement | null => {
    const el = editor.current
    let node = window.getSelection()?.anchorNode ?? null
    if (!el || !node || !el.contains(node) || node === el) return null
    while (node.parentNode !== el) node = node.parentNode!
    return node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : null
  }

  const currentHighlight = (): string | null => {
    const el = editor.current
    let node: Node | null = window.getSelection()?.anchorNode ?? null
    for (; node && node !== el; node = node.parentNode) {
      const bg = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement).style.backgroundColor : ''
      if (bg) return bg === 'transparent' || /,\s*0\)$/.test(bg) ? null : bg
    }
    return null
  }

  /** Make sure commands from the toolbar land where the caret last was. */
  const focusEditor = () => {
    const el = editor.current
    if (!el) return
    const sel = window.getSelection()
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) return
    el.focus()
    if (lastRange.current && el.contains(lastRange.current.startContainer)) {
      sel?.removeAllRanges()
      sel?.addRange(lastRange.current)
    } else caretToEnd(el)
  }

  const caretToEnd = (node: Node) => {
    const range = document.createRange()
    range.selectNodeContents(node)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  /** Turn the caret's block into `kind`, or back into plain text if it already is one. */
  const setBlock = (kind: BlockKind) => {
    focusEditor()
    const block = currentBlock()
    const list = block?.closest('ul,ol')
    if (list) exec(list.tagName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList')
    const now = block?.closest('blockquote') ? 'blockquote' : block?.tagName.toLowerCase().replace(/^h[1]$/, 'h2').replace(/^h[4-6]$/, 'h3')
    exec('formatBlock', !list && now === kind ? 'p' : kind)
    sync()
  }

  /** Swap a block for an empty paragraph, outside any quote, with the caret in it. */
  const toParagraph = (block: HTMLElement) => {
    const p = document.createElement('p')
    p.innerHTML = '<br>'
    const quote = block.closest('blockquote')
    if (quote && quote !== block) {
      block.remove()
      quote.after(p)
      if (!quote.textContent?.trim() && !quote.querySelector('br')) quote.remove()
    } else block.replaceWith(p)
    caretToEnd(p)
    sync()
  }

  const toggleList = (kind: 'ul' | 'ol' | 'todo') => {
    focusEditor()
    const list = currentBlock()?.closest<HTMLElement>('ul,ol')
    const isTodo = list?.tagName === 'UL' && list.dataset.type === 'checklist'
    if (kind === 'ol') exec('insertOrderedList')
    else if (kind === 'ul' && isTodo) {
      delete list!.dataset.type
      list!.querySelectorAll<HTMLElement>(':scope > li').forEach((li) => delete li.dataset.checked)
    } else if (kind === 'todo' && list?.tagName === 'UL' && !isTodo) list.dataset.type = 'checklist'
    else {
      exec('insertUnorderedList')
      const made = currentBlock()?.closest<HTMLElement>('ul')
      if (kind === 'todo' && made && !isTodo) made.dataset.type = 'checklist'
    }
    sync()
  }

  const inline = (command: 'bold' | 'italic' | 'strikeThrough' | 'removeFormat') => {
    focusEditor()
    exec(command)
    sync()
  }

  const highlight = (next: Highlight | null = currentHighlight() ? null : color) => {
    focusEditor()
    if (next) setColor(next)
    exec('hiliteColor', next ? highlightCss(next) : 'transparent')
    setMenu(null)
    sync()
  }

  const divider = () => {
    focusEditor()
    exec('insertHorizontalRule')
    sync()
  }

  /** Put whole blocks (a template, a spark) after the caret's block and land the caret inside them. */
  const insertBlocks = (md: string, caret: 'inside' | 'after' = 'inside') => {
    const el = editor.current
    if (!el) return
    focusEditor()
    const at = topBlock()
    const tpl = document.createElement('template')
    tpl.innerHTML = scratchToHtml(md) + '<p><br></p>'
    const nodes = [...tpl.content.childNodes]
    if (!at) el.append(...nodes)
    else if (!at.textContent?.trim() && !at.querySelector('hr') && at.tagName !== 'HR') at.replaceWith(...nodes)
    else at.after(...nodes)
    // First place to type: the first list item or quote, else the blank line after.
    const target = nodes.find((n): n is HTMLElement => n instanceof HTMLElement && /^(UL|OL|BLOCKQUOTE)$/.test(n.tagName))
    const spot = caret === 'after' ? nodes[nodes.length - 1] : target?.tagName === 'BLOCKQUOTE' ? target : (target?.querySelector('li') ?? nodes[nodes.length - 1])
    el.focus()
    caretToEnd(spot)
    ;(spot as HTMLElement).scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    setMenu(null)
    sync()
  }

  const toggleItem = (li: HTMLElement) => {
    li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true'
    li.classList.remove('just-checked')
    if (li.dataset.checked === 'true') {
      void li.offsetWidth
      li.classList.add('just-checked')
    }
    sync()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.shiftKey && !e.altKey) {
      const action = { KeyH: () => highlight(), KeyX: () => inline('strikeThrough'), Digit7: () => toggleList('ol'), Digit8: () => toggleList('ul'), Digit9: () => toggleList('todo') }[e.code]
      if (action) {
        e.preventDefault()
        return action()
      }
    }
    if (mod && e.altKey && !e.shiftKey) {
      const kind = ({ Digit0: 'p', Digit1: 'h2', Digit2: 'h3' } as const)[e.code as 'Digit0']
      if (kind) {
        e.preventDefault()
        return setBlock(kind)
      }
    }
    // Underline has no place in the stored format, so it isn't offered.
    if (e.key === 'Tab' || (mod && e.code === 'KeyU')) return e.preventDefault()
    const block = currentBlock()
    if (!block || mod || e.altKey) return
    const sel = window.getSelection()!
    if (e.key === ' ' && sel.isCollapsed) {
      const before = document.createRange()
      before.setStart(block, 0)
      before.setEnd(sel.anchorNode!, sel.anchorOffset)
      const typed = before.toString()
      const kind = SHORTCUTS[typed] ?? (/^\d+\.$/.test(typed) ? 'ol' : undefined)
      const inPara = block.tagName === 'P' || block.tagName === 'DIV'
      const inBullet = block.tagName === 'LI' && block.parentElement?.tagName === 'UL' && block.parentElement.dataset.type !== 'checklist'
      if (kind && (inPara || (inBullet && kind === 'todo'))) {
        e.preventDefault()
        sel.removeAllRanges()
        sel.addRange(before)
        exec('delete')
        if (kind === 'ul' || kind === 'ol' || kind === 'todo') toggleList(kind)
        else setBlock(kind)
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      const text = block.textContent ?? ''
      if (text.trim() === '---' && (block.tagName === 'P' || block.tagName === 'DIV')) {
        e.preventDefault()
        const range = document.createRange()
        range.selectNodeContents(block)
        sel.removeAllRanges()
        sel.addRange(range)
        exec('delete')
        divider()
      } else if (!text.trim() && (/^H\d$/.test(block.tagName) || block.closest('blockquote'))) {
        // An empty heading or quote line goes back to plain text instead of repeating.
        e.preventDefault()
        toParagraph(block)
      }
    }
  }

  const onInput = (e: React.FormEvent<HTMLDivElement>) => {
    // A new checklist item copies its parent's attributes, including being checked.
    if ((e.nativeEvent as InputEvent).inputType === 'insertParagraph') {
      const li = currentBlock()?.closest<HTMLElement>(CHECKLIST_ITEMS)
      if (li && !li.textContent?.trim()) li.dataset.checked = 'false'
    }
    sync()
  }

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(CHECKLIST_ITEMS)
    if (li && e.clientX - li.getBoundingClientRect().left < 26) {
      e.preventDefault()
      toggleItem(li)
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const html = e.clipboardData.getData('text/html')
    const text = e.clipboardData.getData('text/plain')
    const md = html ? domToScratch(new DOMParser().parseFromString(html, 'text/html').body) : ''
    if (md.trim()) exec('insertHTML', scratchToHtml(md))
    else if (text) exec('insertText', text)
  }

  // Moving text around the page is left to the browser; anything dropped in from outside arrives as plain text.
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (draggingOut.current) return
    e.preventDefault()
    const text = e.dataTransfer.getData('text/plain')
    const range = document.caretRangeFromPoint(e.clientX, e.clientY)
    if (!text || !range) return
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    exec('insertText', text)
  }

  const jumpTo = (selector: string, index: number) => {
    const target = editor.current?.querySelectorAll<HTMLElement>(selector)[index]
    if (!target) return
    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    target.classList.remove('flash')
    void target.offsetWidth
    target.classList.add('flash')
  }

  const toggleTools = () => {
    const next = !showTools
    setShowTools(next)
    setMenu(null)
    try {
      localStorage.setItem(TOOLS_KEY, next ? 'shown' : 'hidden')
    } catch {
      // Not remembered; it still toggles for now.
    }
  }

  // Dictation goes in at the caret, like typing. The last segment can finish transcribing
  // after the tab has closed, so then it's added to the end of the stored page instead.
  const dictation = useDictation(
    (text) => {
      const el = editor.current
      if (!el?.isConnected) {
        const base = stored.current.trimEnd()
        stored.current = (base ? `${base}\n` : '') + escapeLineStart(escapeInline(text.trim()))
        save.current({ ...latest.current, scratchpad: stored.current })
        return
      }
      focusEditor()
      const sel = window.getSelection()
      const block = currentBlock()
      let before = ''
      if (sel?.rangeCount && block) {
        const range = document.createRange()
        range.setStart(block, 0)
        range.setEnd(sel.anchorNode!, sel.anchorOffset)
        before = range.toString()
      }
      exec('insertText', (before && !/\s$/.test(before) ? ' ' : '') + text.trim())
      sync()
    },
    (message) => toast(message, 'error')
  )
  useCommand('record', dictation.toggle)

  const shuffleSpark = () => setSpark((s) => {
    let next = Math.floor(Math.random() * SPARKS.length)
    if (next === s) next = (next + 1) % SPARKS.length
    return next
  })

  return (
    <div className="scratch">
      <div className="scratch-main" style={{ '--bar': `${bar.height}px` } as CSSProperties}>
        <div
          ref={toolbar}
          className={`scratch-toolbar ${showTools ? '' : 'collapsed'}`}
          style={{ '--collapsed-clip': bar.clip } as CSSProperties}
          onMouseDown={(e) => (e.target as HTMLElement).closest('button') && e.preventDefault()}>
          <div className="tool-group" inert={!showTools}>
            <Tool label="Heading" keys="⌥⌘1" on={active.block === 'h2'} onClick={() => setBlock('h2')}>
              <Heading2 size={16} />
            </Tool>
            <Tool label="Subheading" keys="⌥⌘2" on={active.block === 'h3'} onClick={() => setBlock('h3')}>
              <Heading3 size={16} />
            </Tool>
            <Tool label="Quote" on={active.block === 'blockquote'} onClick={() => setBlock('blockquote')}>
              <Quote size={15} />
            </Tool>
            <span className="tool-sep" />
            <Tool label="Bold" keys="⌘B" on={active.b} onClick={() => inline('bold')}>
              <Bold size={15} />
            </Tool>
            <Tool label="Italic" keys="⌘I" on={active.i} onClick={() => inline('italic')}>
              <Italic size={15} />
            </Tool>
            <Tool label="Strikethrough" keys="⇧⌘X" on={active.s} onClick={() => inline('strikeThrough')}>
              <Strikethrough size={15} />
            </Tool>
            <div className="tool-split">
              <Tool label={active.hl ? 'Remove highlight' : 'Highlight'} keys="⇧⌘H" on={active.hl} onClick={() => highlight()}>
                <Highlighter size={15} />
                <span className="hl-dot" style={{ background: highlightCss(color) }} />
              </Tool>
              <button className="tool caret" onClick={() => setMenu(menu === 'highlight' ? null : 'highlight')} aria-label="Highlight color">
                <ChevronDown size={12} />
              </button>
              {menu === 'highlight' && (
                <div className="menu swatches" onMouseLeave={() => setMenu(null)}>
                  {HIGHLIGHTS.map((h) => (
                    <button key={h} className={h === color ? 'on' : ''} onClick={() => highlight(h)} title={h[0].toUpperCase() + h.slice(1)}>
                      <span style={{ background: highlightCss(h) }} />
                    </button>
                  ))}
                  <button onClick={() => highlight(null)} title="No highlight">
                    <span className="none">
                      <X size={12} />
                    </span>
                  </button>
                </div>
              )}
            </div>
            <span className="tool-sep" />
            <Tool label="Bulleted list" keys="⇧⌘8" on={active.list === 'ul'} onClick={() => toggleList('ul')}>
              <List size={16} />
            </Tool>
            <Tool label="Numbered list" keys="⇧⌘7" on={active.list === 'ol'} onClick={() => toggleList('ol')}>
              <ListOrdered size={16} />
            </Tool>
            <Tool label="Checklist" keys="⇧⌘9" on={active.list === 'todo'} onClick={() => toggleList('todo')}>
              <ListChecks size={16} />
            </Tool>
            <Tool label="Divider" keys="--- ↵" onClick={divider}>
              <Minus size={16} />
            </Tool>
            <Tool label="Clear formatting" onClick={() => (inline('removeFormat'), setBlock('p'))}>
              <RemoveFormatting size={15} />
            </Tool>
            <span className="tool-sep" />
            <div className="menu-wrap">
              <button className={`tool text ${menu === 'insert' ? 'on' : ''}`} onClick={() => setMenu(menu === 'insert' ? null : 'insert')}>
                <Plus size={14} /> Insert
              </button>
              {menu === 'insert' && (
                <div className="menu insert-menu" onMouseLeave={() => setMenu(null)}>
                  {SCRATCH_TEMPLATES.map((t) => (
                    <button key={t.id} onClick={() => insertBlocks(t.md(longDate(todayISO())))}>
                      {t.id === 'stamp' ? <CalendarDays size={14} /> : <Plus size={14} />}
                      <span>
                        <b>{t.label}</b>
                        <small>{t.hint}</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="tool-end">
              <button
                className={`tool text mic-btn ${dictation.state === 'recording' ? 'rec' : ''}`}
                onClick={dictation.toggle}
                disabled={dictation.state === 'starting'}
                title={dictation.state === 'recording' ? 'Stop dictation (⌘R)' : 'Dictate (⌘R). The audio is transcribed as with notes; the text stays here.'}
                aria-label={dictation.state === 'recording' ? 'Stop dictation' : 'Dictate'}
              >
                {dictation.state === 'recording' ? (
                  <>
                    <Square size={11} fill="currentColor" />
                    <span className="meter" aria-hidden>
                      {[0, 1, 2].map((i) => (
                        <i key={i} style={{ transform: `scaleY(${Math.max(0.2, Math.min(1, dictation.level * (1.3 - Math.abs(i - 1) * 0.35)))})` }} />
                      ))}
                    </span>
                    {formatElapsed(dictation.elapsed)}
                  </>
                ) : dictation.state === 'starting' ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <>
                    <Mic size={14} /> Dictate
                  </>
                )}
              </button>
              <button className={`tool text spark-btn ${spark !== null ? 'on' : ''}`} onClick={() => (spark === null ? shuffleSpark() : setSpark(null))} title="A question to think with">
                <Sparkles size={14} /> Spark
              </button>
            </div>
          </div>
          <button
            ref={toggleBtn}
            className={`tool tools-toggle ${dictation.state === 'recording' ? 'rec' : ''}`}
            onClick={toggleTools}
            title={showTools ? 'Hide toolbar' : 'Show toolbar'}
            aria-label={showTools ? 'Hide toolbar' : 'Show toolbar'}
            aria-expanded={showTools}
          >
            <Type size={15} />
            <ChevronUp size={11} className="tools-chevron" />
            {dictation.state === 'recording' && <span className="rec-dot" aria-label="Dictating" />}
          </button>
        </div>

        <div
          ref={editor}
          className="scratch-editor"
          contentEditable
          suppressContentEditableWarning
          spellCheck
          role="textbox"
          aria-multiline
          aria-label="Scratchpad"
          onInput={onInput}
          onKeyDown={onKeyDown}
          onMouseDown={onMouseDown}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragStart={() => (draggingOut.current = true)}
          onDragEnd={() => (draggingOut.current = false)}
          onBlur={() => {
            flush()
            setSaved(true)
          }}
        />

        <footer className="scratch-foot">
          <span>
            <Lock size={11} /> Private · not in the record · text never sent to AI
          </span>
          <span>
            {dictation.pending > 0 && (
              <>
                <Loader2 size={11} className="spin" /> Transcribing… ·{' '}
              </>
            )}
            {rail.words} {rail.words === 1 ? 'word' : 'words'} · {saved ? 'Saved' : 'Saving…'}
          </span>
        </footer>
      </div>

      <aside className="scratch-rail">
        {spark !== null && (
          <section className="spark-card">
            <header>
              <Sparkles size={13} /> Spark
              <button className="icon-btn" onClick={() => setSpark(null)} aria-label="Close spark">
                <X size={13} />
              </button>
            </header>
            <p>{SPARKS[spark]}</p>
            <div className="row gap">
              <button className="link" onClick={() => insertBlocks(`> **${SPARKS[spark]}**`, 'after')}>
                Think it through on the page
              </button>
              <button className="icon-btn" onClick={shuffleSpark} title="Another one" aria-label="Another spark">
                <Shuffle size={13} />
              </button>
            </div>
          </section>
        )}

        <section>
          <h4>
            Open loops {rail.loops.length > 0 && <span className="tab-badge">{rail.loops.length}</span>}
          </h4>
          {rail.loops.length ? (
            <ul className="loops">
              {rail.loops.map((l) => (
                <li key={l.index}>
                  <button
                    className="loop-check"
                    aria-label={`Close: ${l.text}`}
                    onClick={() => {
                      const li = editor.current?.querySelectorAll<HTMLElement>(CHECKLIST_ITEMS)[l.index]
                      if (li) toggleItem(li)
                    }}
                  >
                    <Check size={11} />
                  </button>
                  <button className="loop-text" onClick={() => jumpTo(CHECKLIST_ITEMS, l.index)}>
                    {l.text}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rail-empty">
              {rail.done ? `All ${rail.done} closed. Nice.` : 'Checklist items you leave unticked collect here, and on the tab, until you close them.'}
            </p>
          )}
        </section>

        {rail.outline.length > 0 && (
          <section>
            <h4>On this page</h4>
            <nav className="outline">
              {rail.outline.map((h) => (
                <button key={h.index} className={h.level === 3 ? 'sub' : ''} onClick={() => jumpTo('h1,h2,h3,h4', h.index)}>
                  {h.text}
                </button>
              ))}
            </nav>
          </section>
        )}

        <section className="shortcuts">
          <h4>Type to format</h4>
          <dl>
            <dt>#</dt>
            <dd>Heading</dd>
            <dt>-</dt>
            <dd>Bullet</dd>
            <dt>1.</dt>
            <dd>Numbered</dd>
            <dt>[]</dt>
            <dd>Checkbox</dd>
            <dt>&gt;</dt>
            <dd>Quote</dd>
            <dt>--- ↵</dt>
            <dd>Divider</dd>
          </dl>
          <p>Follow with a space.</p>
        </section>
      </aside>
    </div>
  )
}

function Tool({ label, keys, on, onClick, children }: { label: string; keys?: string; on?: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button className={`tool ${on ? 'on' : ''}`} onClick={onClick} title={keys ? `${label} (${keys})` : label} aria-label={label} aria-pressed={on}>
      {children}
    </button>
  )
}
