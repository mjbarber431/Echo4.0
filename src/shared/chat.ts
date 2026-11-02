import type { Client, Note } from './types'
import { formatDateUS, todayISO } from './compliance'
import { describePlan, describePriorNotes, redactName } from './prompts'
import { canAssign, doneLabel, type ClientDocument } from './documents'
import { describeLibrary, KIND_LABEL, LIBRARY_INSTRUCTIONS, RESOURCE_TOKEN, resourceById } from './resources'

// "Ask Claude": a consultation chat about one client, on the client's page.
//
// Each chat freezes the record it was started with (the system prompt) and is
// append-only from there. Opus and Sonnet tie their reasoning to the exact
// conversation that produced it, so an earlier message must never change: notes
// finalized after a chat starts are added to the next message, not to the record.
// Everything sent is stored exactly as sent, with the client's name removed.

/** Models offered for chat, the default first. */
export const CHAT_MODELS: { id: string; label: string; hint: string }[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'Deepest reasoning' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'Faster, about half the cost' }
]
export const DEFAULT_CHAT_MODEL = CHAT_MODELS[0].id

/** A content block exactly as the Messages API takes it. Kept loose so shared code doesn't depend on the SDK. */
export interface ChatBlock {
  type: string
  [key: string]: unknown
}

export interface ChatUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  /** What the clinician typed (with the client's name) or what Claude wrote. Shown in the app. */
  text: string
  /** The message's content exactly as sent or received, replayed verbatim on every later request. */
  content: ChatBlock[]
  /** A reply's reasoning summary, if Claude shared one. */
  thinking?: string
  /** Notes finalized after the chat started that went out with this message. */
  addedNotes?: number
  /** The client's Library documents had changed, and the current list went out with this message. */
  documentsUpdated?: boolean
  model?: string
  usage?: ChatUsage
  /** The reply was stopped before Claude finished. */
  stopped?: boolean
  at: string
}

export interface ChatThread {
  id: string
  clientId: string
  title: string
  model: string
  /** The instructions and the client's record as of when the chat started. Never changes afterwards. */
  system: string
  /** Finalized notes Claude has seen, at start or added since. */
  noteIds: string[]
  /** The client's Library documents as Claude last saw them (describeDocuments). Missing in chats from before Claude saw them. */
  documents?: string
  /** What the frozen record held, for the "Claude can see" line. */
  seen: { notes: number; plan: boolean; context: boolean; diagnoses: number; documents?: number; asOf: string }
  turns: ChatTurn[]
  createdAt: string
  updatedAt: string
}

/** A chat in the list, without its messages. */
export interface ChatSummary {
  id: string
  title: string
  model: string
  turns: number
  updatedAt: string
}

/** Streamed to the renderer while a reply is written. */
export type ChatEvent =
  | { threadId: string; type: 'thinking' | 'text'; text: string }
  | { threadId: string; type: 'done'; thread: ChatThread }
  | { threadId: string; type: 'error'; message: string; thread: ChatThread | null }

export const summarize = (t: ChatThread): ChatSummary => ({ id: t.id, title: t.title, model: t.model, turns: t.turns.length, updatedAt: t.updatedAt })

/** A chat's title: the start of its first question. */
export function chatTitle(text: string): string {
  const line = text
    .trim()
    .split('\n')[0]
    .replace(RESOURCE_TOKEN, (_m, id: string) => resourceById(id)?.title ?? 'a resource')
    .replace(/\s+/g, ' ')
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || 'New chat'
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const CHAT_SYSTEM = `You are a clinical consultant to a licensed outpatient psychotherapist, talking with them about one of their clients the way a trusted peer consultant or clinical supervisor would. The clinician knows the client and makes every clinical decision; you know only the record below.

HOW TO HELP
- Ground what you say in the record. When you draw on a session, cite its date. Keep what the record shows separate from your hypotheses, and say how confident you are.
- When the record doesn't tell you something you need, say so and ask, rather than assume.
- Offer options, considerations and questions to explore, not directives. Name specific, evidence-based models and interventions where they help, and be honest about the strength of the evidence. Never invent citations, statistics or measures.
- You may discuss diagnostic considerations and differentials for the clinician to evaluate; don't assign diagnoses.
- If the record or the question suggests risk to the client or others, address it directly and plainly, including standard-of-care steps (risk assessment, safety planning, consultation, documentation, duty-to-warn or mandated-reporting questions to check against their jurisdiction).
- Notice patterns across sessions: themes, what has and hasn't helped, progress against each goal, things that have dropped out of view. Gently name possible blind spots, including the clinician's own reactions when they raise them.

STYLE
- Conversational and concise, like talking with a colleague. Lead with the answer; no preamble or recap of the question. Short paragraphs; lists or a small table only when they make something clearer. Use Markdown for emphasis and lists.
- Write for a licensed clinician: precise clinical language, no basic explanations unless asked.

PRIVACY
- The client is called "Client" in the record because their name is removed before anything reaches you. Call them "the client" or use their pronouns. Refer to other people by role. Don't ask for names or other identifying details.
- Your replies are a private consultation, not part of the medical record.`

/**
 * The frozen part of every request: instructions, the resource library, then the client's record as it is now.
 * The library comes before the record so it reads the same for every client.
 */
export function buildChatSystem(client: Client, notes: Note[], today: string, documents: ClientDocument[] = [], library = describeLibrary()): string {
  const record = [
    `CLIENT RECORD (as of ${formatDateUS(today)})`,
    `Pronouns: ${client.pronouns.trim() || 'not specified (use "the client" and they/them)'}`,
    `Status: ${client.status === 'discharged' ? 'discharged' : 'in treatment'}`,
    `Diagnoses on file: ${client.diagnoses.length ? client.diagnoses.map((d) => `${d.code} ${d.description}`).join('; ') : 'none on file'}`,
    '',
    'TREATMENT PLAN',
    describePlan(client),
    '',
    'CLINICAL CONTEXT (rolling summary)',
    redactName(client.context.trim(), client.name) || 'None yet.',
    '',
    `FINALIZED NOTES (${notes.length}, oldest first)`,
    describePriorNotes(notes, client, true) || 'None yet.',
    '',
    'LIBRARY ITEMS GIVEN TO THE CLIENT (oldest first)',
    describeDocuments(documents, client) || 'None yet.'
  ].join('\n')
  return `${CHAT_SYSTEM}\n\n${LIBRARY_INSTRUCTIONS}\n\n${library}\n\n${record}`
}

/**
 * The Library items the client has been given, one line each: title, library id, when, whether
 * it's done, and a measure's score. Only Library items: added files and letters can carry
 * other people's names in their titles, and their contents never go to Claude.
 */
export function describeDocuments(documents: ClientDocument[], client: Client): string {
  // The day where the clinician is, not in UTC.
  const day = (iso: string) => formatDateUS(todayISO(new Date(iso)))
  return documents
    .filter((d) => d.clientId === client.id && d.origin.kind === 'library')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((d) => {
      const id = d.origin.kind === 'library' ? d.origin.resourceId : ''
      const status = d.status === 'todo' ? 'not completed yet' : doneLabel(d) === 'Completed' || d.score.trim() ? `completed ${day(d.completedAt ?? d.updatedAt)}` : 'given to keep'
      return `- ${redactName(d.title, client.name)} [library ${id}]: given ${day(d.createdAt)}, ${status}${d.score.trim() ? `, score ${redactName(d.score.trim(), client.name)}` : ''}`
    })
    .join('\n')
}

/** The client's Library documents as they are now, when they've changed since Claude last saw them. */
export function describeDocumentsUpdate(current: string): string {
  return `[Echo: the Library items given to the client have changed since you last saw them. As of now:]\n\n${current || 'None.'}`
}

/** Notes finalized since the chat started, sent ahead of the clinician's next message. */
export function describeAddedNotes(notes: Note[], client: Client): string {
  return [
    `[Echo: ${notes.length === 1 ? 'a note was' : `${notes.length} notes were`} finalized since this chat started. They're part of the record from here on.]`,
    '',
    describePriorNotes(notes, client, true)
  ].join('\n')
}

/** The clinician's message as it goes out: newly finalized notes and changed documents first, then the message, the client's name removed throughout. */
export function userContent(text: string, client: Client, added: Note[], documents?: string): ChatBlock[] {
  const blocks: ChatBlock[] = []
  if (added.length) blocks.push({ type: 'text', text: describeAddedNotes(added, client) })
  if (documents !== undefined) blocks.push({ type: 'text', text: describeDocumentsUpdate(documents) })
  blocks.push({ type: 'text', text: redactName(text.trim(), client.name) })
  return blocks
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/** US dollars per million tokens. Cache writes are the 5-minute kind. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
}

export function turnCost(turn: ChatTurn): number {
  const p = turn.model ? PRICES[turn.model] : undefined
  if (!p || !turn.usage) return 0
  const u = turn.usage
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1_000_000
}

export const threadCost = (t: ChatThread): number => t.turns.reduce((sum, turn) => sum + turnCost(turn), 0)

/** Roughly what starting a chat costs on `model`: the record is read once at the cache-write rate. */
export function startCost(system: string, model: string): number {
  const p = PRICES[model]
  if (!p) return 0
  // About four characters per token for English prose.
  return ((system.length / 4) * p.cacheWrite) / 1_000_000
}

export function formatCost(dollars: number): string {
  if (dollars < 0.01) return 'under 1¢'
  if (dollars < 1) return `${Math.round(dollars * 100)}¢`
  return `$${dollars.toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Rendering Claude's Markdown. Everything is escaped first, so a reply can
// never become markup beyond the few tags made here.
// ---------------------------------------------------------------------------

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Library ids the client already has, for the Assign buttons beside references. Left out when copying a reply. */
export type AssignState = Set<string>

/** A library reference as a link; the renderer opens it on click. With `assign`, an Assign button follows it. */
export function resourceChip(id: string, assign?: AssignState): string {
  const r = resourceById(id)
  if (!r) return '<span class="res-chip missing">resource not found</span>'
  const chip = `<button type="button" class="res-chip" data-res="${r.id}" title="${escapeHtml(r.source === 'acbs' ? 'Opens on contextualscience.org' : 'Open')}"><span class="res-kind">${KIND_LABEL[r.kind]}</span>${escapeHtml(r.title)}</button>`
  if (!assign || !canAssign(r)) return chip
  const done = assign.has(r.id)
  return `<span class="res-chip-wrap">${chip}<button type="button" class="res-assign${done ? ' done' : ''}" data-assign="${r.id}" title="${done ? 'Already given to the client: open their copy' : 'Give the client their own copy, in their documents'}">${done ? 'Assigned' : 'Assign'}</button></span>`
}

/** Text with each [[r:id]] reference split out, for showing the clinician's own messages. */
export function splitResourceTokens(text: string): ({ text: string } | { id: string })[] {
  const out: ({ text: string } | { id: string })[] = []
  let last = 0
  for (const m of text.matchAll(RESOURCE_TOKEN)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) })
    out.push({ id: m[1] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

export function chatInline(text: string, assign?: AssignState): string {
  const parts = text.split(/(`[^`\n]+`)/)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`
      return escapeHtml(part)
        .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>')
        .replace(/__(?=\S)(.+?)(?<=\S)__/g, '<b>$1</b>')
        .replace(/(^|[^*\w])\*(?=\S)(.+?)(?<=\S)\*(?!\*)/g, '$1<i>$2</i>')
        .replace(/(^|[^_\w])_(?=\S)(.+?)(?<=\S)_(?![_\w])/g, '$1<i>$2</i>')
        .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>')
        .replace(RESOURCE_TOKEN, (_m, id: string) => resourceChip(id, assign))
    })
    .join('')
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

export function chatToHtml(md: string, assign?: AssignState): string {
  const inline = (text: string) => chatInline(text, assign)
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  let list = null as { tag: 'ul' | 'ol'; items: string[] } | null
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map((p) => inline(p)).join('<br>')}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`)
    list = null
  }
  const flush = () => {
    flushPara()
    flushList()
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m: RegExpMatchArray | null
    if (line.startsWith('```')) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i])
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
    } else if (!line.trim()) {
      flush()
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flush()
      const level = Math.min(4, Math.max(3, m[1].length + 1))
      out.push(`<h${level}>${inline(m[2])}</h${level}>`)
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      out.push('<hr>')
    } else if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      flush()
      const head = cells(line)
      const rows: string[][] = []
      i++
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) rows.push(cells(lines[++i]))
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, j) => `<td>${inline(r[j] ?? '')}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`
      )
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flush()
      const quote = [m[1]]
      while (i + 1 < lines.length && (m = lines[i + 1].match(/^>\s?(.*)$/))) quote.push(m[1]), i++
      out.push(`<blockquote>${chatToHtml(quote.join('\n'))}</blockquote>`)
    } else if ((m = line.match(/^\s*(?:([-*+•])|(\d+)[.)])\s+(.*)$/))) {
      flushPara()
      const tag = m[1] ? 'ul' : 'ol'
      if (list?.tag !== tag) flushList()
      list ??= { tag, items: [] }
      list.items.push(inline(m[3]))
    } else if (list && /^\s{2,}\S/.test(line)) {
      // A wrapped or nested line continues the item above it.
      list.items[list.items.length - 1] += `<br>${inline(line.trim())}`
    } else {
      flushList()
      para.push(line)
    }
  }
  flush()
  return out.join('')
}

/** Starting points offered in an empty chat. */
export const CHAT_STARTERS: { label: string; prompt: string }[] = [
  { label: 'Case conceptualization', prompt: 'Help me build a case conceptualization for this client using the 5 Ps (presenting, predisposing, precipitating, perpetuating, protective).' },
  { label: 'Patterns across sessions', prompt: 'What patterns or themes do you notice across the sessions so far, including anything that has dropped out of view?' },
  { label: 'Progress on goals', prompt: 'Where does this client stand on each treatment plan goal, and what does the record suggest is helping or getting in the way?' },
  { label: 'Prep for next session', prompt: 'Help me prepare for the next session: what to follow up on, and a couple of directions worth considering.' },
  { label: 'What might I be missing?', prompt: 'What might I be missing with this client? Consider differentials, risk, and anything the record leaves unexplored.' },
  { label: 'Resources for next session', prompt: 'Which resources from my library (a metaphor, exercise, worksheet or measure) would fit where this client is right now? Pick two or three and say why.' },
  { label: 'Track the processes', prompt: 'Which ACT processes look most stuck for this client, and which measures would track them alongside symptom measures?' }
]
