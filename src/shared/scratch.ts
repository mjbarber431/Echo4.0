// The scratchpad's stored format: a small Markdown dialect, one block per line.
//
//   ## Heading            ### Subheading          --- (divider)
//   - bullet              1. numbered             > quote
//   - [ ] open loop       - [x] closed loop
//   **bold**  _italic_  ~~struck~~  ==highlight==  =={green}colored highlight==
//
// Plain text from before formatting existed is valid input, so old scratchpads
// load unchanged. Rendering escapes everything, so stored text can never become
// markup. The editor serializes its DOM back into this format (see Scratchpad.tsx).

export const HIGHLIGHTS = ['yellow', 'green', 'blue', 'pink'] as const
export type Highlight = (typeof HIGHLIGHTS)[number]

/** Background colors for highlights. Translucent so they read on both themes. */
export const HIGHLIGHT_RGBA: Record<Highlight, [number, number, number, number]> = {
  yellow: [250, 204, 21, 0.38],
  green: [74, 222, 128, 0.3],
  blue: [96, 165, 250, 0.3],
  pink: [244, 114, 182, 0.3]
}

export const highlightCss = (h: Highlight): string => `rgba(${HIGHLIGHT_RGBA[h].join(', ')})`

export type ScratchBlock =
  | { kind: 'p' | 'h2' | 'h3' | 'quote'; text: string }
  | { kind: 'bullet' | 'number'; text: string }
  | { kind: 'todo'; text: string; done: boolean }
  | { kind: 'hr' }

const TODO = /^[-*] \[( |x|X)\] ?(.*)$/

export function parseBlock(line: string): ScratchBlock {
  let m: RegExpMatchArray | null
  if (line.trim() === '---') return { kind: 'hr' }
  if ((m = line.match(/^###\s+(.*)$/))) return { kind: 'h3', text: m[1] }
  if ((m = line.match(/^##?\s+(.*)$/))) return { kind: 'h2', text: m[1] }
  if ((m = line.match(TODO))) return { kind: 'todo', text: m[2], done: m[1] !== ' ' }
  if ((m = line.match(/^[-*•] (.*)$/))) return { kind: 'bullet', text: m[1] }
  if ((m = line.match(/^\d+[.)] (.*)$/))) return { kind: 'number', text: m[1] }
  if ((m = line.match(/^> ?(.*)$/))) return { kind: 'quote', text: m[1] }
  return { kind: 'p', text: line }
}

export const parseScratch = (md: string): ScratchBlock[] => md.replace(/\r\n?/g, '\n').split('\n').map(parseBlock)

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Characters a backslash makes literal. Limited to punctuation so paths like C:\temp survive. */
const ESCAPABLE = /[\\*_~=#>\-+.!()[\]{}`|0-9]/

/** Inline Markdown to HTML. Unclosed markers stay literal. */
export function inlineToHtml(text: string): string {
  let out = ''
  let i = 0
  const closing = (marker: string, from: number): number => {
    for (let j = from; j <= text.length - marker.length; j++) {
      if (text[j] === '\\') j++
      else if (text.startsWith(marker, j)) return j
    }
    return -1
  }
  while (i < text.length) {
    const c = text[i]
    if (c === '\\' && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
      out += escapeHtml(text[i + 1])
      i += 2
      continue
    }
    const pair = text.slice(i, i + 2)
    if (pair === '**' || pair === '~~' || pair === '==') {
      let start = i + 2
      let color: Highlight = 'yellow'
      if (pair === '==') {
        const m = text.slice(start).match(/^\{(\w+)\}/)
        if (m && (HIGHLIGHTS as readonly string[]).includes(m[1])) {
          color = m[1] as Highlight
          start += m[0].length
        }
      }
      const end = closing(pair, start)
      if (end > start) {
        const inner = inlineToHtml(text.slice(start, end))
        out +=
          pair === '**' ? `<b>${inner}</b>` : pair === '~~' ? `<s>${inner}</s>` : `<span style="background-color: ${highlightCss(color)}">${inner}</span>`
        i = end + 2
        continue
      }
    }
    if (c === '_') {
      const end = closing('_', i + 1)
      if (end > i + 1) {
        out += `<i>${inlineToHtml(text.slice(i + 1, end))}</i>`
        i = end + 1
        continue
      }
    }
    out += escapeHtml(c)
    i++
  }
  return out
}

/** Markdown to the editor's HTML. Emits no whitespace between tags: the editor uses pre-wrap. */
export function scratchToHtml(md: string): string {
  const blocks = parseScratch(md)
  let html = ''
  const inline = (t: string) => inlineToHtml(t) || '<br>'
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.kind === 'bullet' || b.kind === 'number' || b.kind === 'todo') {
      const kind = b.kind
      const items: string[] = []
      for (; i < blocks.length && blocks[i].kind === kind; i++) {
        const item = blocks[i] as Extract<ScratchBlock, { text: string }>
        const done = item.kind === 'todo' ? ` data-checked="${item.done}"` : ''
        items.push(`<li${done}>${inline(item.text)}</li>`)
      }
      i--
      html += kind === 'number' ? `<ol>${items.join('')}</ol>` : `<ul${kind === 'todo' ? ' data-type="checklist"' : ''}>${items.join('')}</ul>`
    } else if (b.kind === 'hr') html += '<hr>'
    else if (b.kind === 'quote') html += `<blockquote>${inline(b.text)}</blockquote>`
    else html += `<${b.kind}>${inline(b.text)}</${b.kind}>`
  }
  return html || '<p><br></p>'
}

/** Escape literal text so it reads back exactly as typed. */
export const escapeInline = (s: string): string => s.replace(/[\\*_~=]/g, (c) => '\\' + c)

/** A paragraph that happens to start like a block marker gets its first character escaped. */
export const escapeLineStart = (line: string): string => (/^(#|[-*•] |>|\d+[.)] |---\s*$)/.test(line) ? '\\' + line : line)

/** A bullet whose text starts with "[ ]" would read back as a checklist item. */
export const escapeItemStart = (text: string): string => (/^\[( |x|X)\]/.test(text) ? '\\' + text : text)

/** Unchecked checklist items. Shown on the tab as a count of open loops. */
export const openLoopCount = (md: string): number => parseScratch(md).filter((b) => b.kind === 'todo' && !b.done).length

/** Ready-made structures for the Insert menu. */
export const SCRATCH_TEMPLATES: { id: string; label: string; hint: string; md: (today: string) => string }[] = [
  { id: 'stamp', label: 'Date stamp', hint: 'A heading for today', md: (today) => `### ${today}` },
  {
    id: 'next',
    label: 'Next session',
    hint: 'Things to ask, follow up on, try',
    md: () => '### Next session\n- [ ] Ask about: \n- [ ] Follow up on: \n- [ ] Try: '
  },
  {
    id: 'hypothesis',
    label: 'Working hypothesis',
    hint: 'A hunch, and how you’d test it',
    md: () => '### Working hypothesis\n> \n- Evidence for: \n- Evidence against: \n- How I’ll test it: '
  },
  {
    id: 'five-ps',
    label: '5 Ps formulation',
    hint: 'Presenting, predisposing, precipitating…',
    md: () => '### Formulation\n- Presenting: \n- Predisposing: \n- Precipitating: \n- Perpetuating: \n- Protective: '
  },
  { id: 'people', label: 'People in their world', hint: 'Names and roles to remember', md: () => '### People in their world\n- ' },
  {
    id: 'reactions',
    label: 'My reactions',
    hint: 'What came up for you',
    md: () => '### My reactions\n- What I felt: \n- What it might be telling me: \n- Where I got stuck: '
  },
  { id: 'consult', label: 'Bring to consultation', hint: 'Questions for supervision', md: () => '### Bring to consultation\n- [ ] ' }
]

/** Prompts for when you're stuck. Purely local; nothing here involves the AI. */
export const SPARKS = [
  'What am I not seeing yet?',
  'If they described the problem, how would they put it?',
  'What does this pattern protect them from?',
  'What changed since we started? What hasn’t?',
  'Where did I feel stuck or pulled today?',
  'What’s the function of this behavior?',
  'What would a colleague with a different orientation notice?',
  'What strength haven’t we used yet?',
  'What are they not saying?',
  'What would “better” look like to them, concretely?',
  'Whose voice is in the room that isn’t theirs?',
  'What did I do that helped? What didn’t land?',
  'Is there a rupture I haven’t named?',
  'What would I want to remember about this person in a year?',
  'What’s the smallest next step?',
  'What am I assuming that I haven’t checked?',
  'When is the problem absent or smaller?',
  'What does the relationship between us look like right now?'
]
