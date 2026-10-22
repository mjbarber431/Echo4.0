import { escapeInline, escapeItemStart, escapeLineStart, HIGHLIGHT_RGBA, HIGHLIGHTS, type Highlight } from '@shared/scratch'

// Turns the scratchpad editor's DOM (or pasted HTML) back into the stored Markdown.
// Anything it doesn't recognise is reduced to its text, so this doubles as the
// paste sanitizer: what can't be expressed in the format isn't kept.

interface Fmt {
  b: boolean
  i: boolean
  s: boolean
  h: Highlight | null
}
interface Run {
  text: string
  f: Fmt
}

const BLOCK = /^(P|DIV|H[1-6]|UL|OL|LI|BLOCKQUOTE|HR|PRE|TABLE|THEAD|TBODY|TR|SECTION|ARTICLE|HEADER|FOOTER|ASIDE|NAV|MAIN|FIGURE|DL|DT|DD|ADDRESS)$/
const SKIP = /^(SCRIPT|STYLE|TEMPLATE|HEAD|TITLE|META|LINK|NOSCRIPT|IFRAME|OBJECT|SVG|IMG|VIDEO|AUDIO|CANVAS|INPUT|BUTTON|SELECT|TEXTAREA)$/

const isEl = (n: Node): n is HTMLElement => n.nodeType === Node.ELEMENT_NODE
const isBlock = (n: Node): boolean => isEl(n) && BLOCK.test(n.tagName)

/** Our highlight colors, matched closely so pasted page backgrounds aren't mistaken for highlights. */
function highlightOf(el: HTMLElement): Highlight | null | undefined {
  if (el.tagName === 'MARK') return 'yellow'
  const bg = el.style?.backgroundColor
  if (!bg) return undefined
  if (bg === 'transparent' || bg === 'initial' || bg === 'inherit') return null
  const m = bg.match(/rgba?\(([^)]+)\)/)
  if (!m) return undefined
  const [r, g, b, a = 1] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
  if (a === 0) return null
  return HIGHLIGHTS.find((h) => {
    const [hr, hg, hb] = HIGHLIGHT_RGBA[h]
    return Math.abs(hr - r) + Math.abs(hg - g) + Math.abs(hb - b) < 12
  })
}

function fmtOf(el: HTMLElement, f: Fmt): Fmt {
  const next = { ...f }
  const tag = el.tagName
  if (tag === 'B' || tag === 'STRONG') next.b = true
  if (tag === 'I' || tag === 'EM') next.i = true
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') next.s = true
  const st = el.style
  if (st) {
    // Google Docs wraps whole documents in <b style="font-weight:normal">, so explicit weights win.
    if (st.fontWeight) next.b = st.fontWeight === 'bold' || st.fontWeight === 'bolder' || Number(st.fontWeight) >= 600
    if (st.fontStyle) next.i = st.fontStyle === 'italic' || st.fontStyle === 'oblique'
    if (st.textDecorationLine || st.textDecoration) next.s = /line-through/.test(st.textDecorationLine || st.textDecoration)
  }
  const h = highlightOf(el)
  if (h !== undefined) next.h = h
  return next
}

const PLAIN: Fmt = { b: false, i: false, s: false, h: null }

function collect(nodes: Iterable<Node>, f: Fmt, lines: Run[][]): void {
  for (const n of nodes) {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = (n as Text).data.replace(/ /g, ' ').replace(/[​﻿]/g, '').replace(/\n/g, ' ')
      if (text) lines[lines.length - 1].push({ text, f })
    } else if (isEl(n)) {
      if (SKIP.test(n.tagName)) continue
      if (n.tagName === 'BR') lines.push([])
      else if (isBlock(n)) {
        lines.push([])
        collect(n.childNodes, f, lines)
        lines.push([])
      } else collect(n.childNodes, fmtOf(n, f), lines)
    }
  }
}

const same = (a: Fmt, b: Fmt) => a.b === b.b && a.i === b.i && a.s === b.s && a.h === b.h

function runsToMd(runs: Run[]): string {
  const merged: Run[] = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (last && same(last.f, r.f)) last.text += r.text
    else merged.push({ ...r })
  }
  return merged
    .map(({ text, f }) => {
      const body = escapeInline(text)
      // Markers around nothing but spaces would read back as literal asterisks.
      if (!text.trim()) return body
      const open = (f.h ? `==${f.h === 'yellow' ? '' : `{${f.h}}`}` : '') + (f.b ? '**' : '') + (f.i ? '_' : '') + (f.s ? '~~' : '')
      const close = (f.s ? '~~' : '') + (f.i ? '_' : '') + (f.b ? '**' : '') + (f.h ? '==' : '')
      return open + body + close
    })
    .join('')
}

/** Inline content as Markdown lines, split at line breaks. A trailing <br> is a placeholder, not a line. */
function inlineLines(nodes: Iterable<Node>): string[] {
  const lines: Run[][] = [[]]
  collect(nodes, PLAIN, lines)
  const out = lines.map(runsToMd)
  if (out.length > 1 && out[out.length - 1] === '') out.pop()
  return out
}

const oneLine = (nodes: Iterable<Node>) =>
  inlineLines(nodes)
    .filter((l) => l.trim())
    .join(' ')
    .trim()

function serializeList(list: HTMLElement, out: string[]): void {
  const todo = list.tagName === 'UL' && list.dataset.type === 'checklist'
  let n = 0
  for (const child of list.childNodes) {
    if (!isEl(child)) {
      if (child.textContent?.trim()) out.push(`- ${escapeItemStart(escapeInline(child.textContent.trim()))}`)
      continue
    }
    if (child.tagName === 'UL' || child.tagName === 'OL') {
      serializeList(child, out)
      continue
    }
    const nested = [...child.childNodes].filter((c) => isEl(c) && (c.tagName === 'UL' || c.tagName === 'OL')) as HTMLElement[]
    const text = oneLine([...child.childNodes].filter((c) => !nested.includes(c as HTMLElement)))
    n++
    if (todo) out.push(`- [${child.dataset.checked === 'true' ? 'x' : ' '}] ${text}`)
    else if (list.tagName === 'OL') out.push(`${n}. ${text}`)
    else out.push(`- ${escapeItemStart(text)}`)
    nested.forEach((l) => serializeList(l, out))
  }
}

function serializeBlocks(root: Node, out: string[]): void {
  let inline: Node[] = []
  const flush = () => {
    if (!inline.length) return
    const hasBreak = inline.some((n) => isEl(n) && n.tagName === 'BR')
    const blank = !hasBreak && inline.every((n) => !n.textContent?.trim())
    if (!blank) inlineLines(inline).forEach((l) => out.push(escapeLineStart(l)))
    inline = []
  }
  for (const n of root.childNodes) {
    if (isEl(n) && SKIP.test(n.tagName)) continue
    if (!isBlock(n)) {
      inline.push(n)
      continue
    }
    flush()
    const el = n as HTMLElement
    const tag = el.tagName
    if (tag === 'HR') out.push('---')
    else if (tag === 'H1' || tag === 'H2') out.push(`## ${oneLine(el.childNodes)}`)
    else if (/^H[3-6]$/.test(tag)) out.push(`### ${oneLine(el.childNodes)}`)
    else if (tag === 'UL' || tag === 'OL') serializeList(el, out)
    else if (tag === 'BLOCKQUOTE') {
      const inner: string[] = []
      serializeBlocks(el, inner)
      ;(inner.length ? inner : ['']).forEach((l) => out.push(`> ${l}`))
    } else if (tag === 'LI') out.push(`- ${escapeItemStart(oneLine(el.childNodes))}`)
    else if (!el.childNodes.length) out.push('')
    else serializeBlocks(el, out)
  }
  flush()
}

/** The editor's content (or a pasted document's body) as scratchpad Markdown. */
export function domToScratch(root: Node): string {
  const out: string[] = []
  serializeBlocks(root, out)
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.join('\n')
}
