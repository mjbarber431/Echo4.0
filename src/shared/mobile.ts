import type { Client, MobileMemo, Note, NoteType, Settings } from './types'
import { defaultAttestations, defaultSession } from './compliance'

// Recordings from the iPhone arrive without a client. The clinician says the
// client's name, usually at the start ("This is for Jane…"), so Echo suggests a
// client by reading the transcript forward until it hears a client's name, and
// the clinician confirms it. Other people mentioned later in the session are not
// suggested. Speech models often misspell names (Kaitlyn → Caitlin) and names
// are sometimes entered differently, so the match is fuzzy and is never applied
// without confirmation.

/** A name part heard this closely ends the search. Also the bar for preselecting. */
const CONFIDENT = 0.9

/** Words past the first confident name part still searched, to hear the rest of the name ("Jon Park"). */
const NAME_TAIL = 3

export interface ClientMatch {
  clientId: string
  /** 0–1, higher is closer. */
  score: number
  /** Close enough, and far enough ahead of the next client, to preselect. */
  likely: boolean
  /** What was heard for each name part that matched, so it can be corrected to the name as entered. */
  heard: { heard: string; part: string }[]
}

interface Word {
  text: string
  norm: string
  key: string
  capitalized: boolean
}

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
}

/**
 * The transcript's words in order. Each position holds the word there and that
 * word joined with the next ("Mary Ann" for "Maryann").
 */
function transcriptWords(transcript: string): Omit<Word, 'key'>[][] {
  const raw = transcript.split(/[^\p{L}'’-]+/u).filter(Boolean)
  const singles = raw.map((text) => ({ text: text.replace(/['’]s$/u, ''), capitalized: /^\p{Lu}/u.test(text) }))
  return singles.map((w, i) => {
    const forms = i + 1 < singles.length ? [w, { text: `${w.text} ${singles[i + 1].text}`, capitalized: w.capitalized }] : [w]
    return forms.map((f) => ({ ...f, norm: normalize(f.text) })).filter((f) => f.norm.length >= 2)
  })
}

/** Name parts as entered, e.g. "Mary-Kate O'Neil" → Mary-Kate, O'Neil. */
function nameParts(name: string): string[] {
  return name
    .split(/\s+/)
    .map((p) => p.replace(/[^\p{L}'’-]/gu, ''))
    .filter((p) => normalize(p).length >= 2)
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1
  if (!a.length || !b.length) return 0
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aHit = new Array<boolean>(a.length).fill(false)
  const bHit = new Array<boolean>(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bHit[j] || a[i] !== b[j]) continue
      aHit[i] = bHit[j] = true
      matches++
      break
    }
  }
  if (!matches) return 0
  let k = 0
  let transpositions = 0
  for (let i = 0; i < a.length; i++) {
    if (!aHit[i]) continue
    while (!bHit[k]) k++
    if (a[i] !== b[k++]) transpositions++
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3
  let prefix = 0
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++
  return jaro + prefix * 0.1 * (1 - jaro)
}

/**
 * A rough sound-alike key: Kaitlyn and Caitlin, Jon and John, Steven and Stephen,
 * Sean and Shawn all share one. Consonants after the first letter, with common
 * spellings of the same sound folded together.
 */
export function soundKey(word: string): string {
  let s = normalize(word)
  if (!s) return ''
  s = s
    .replace(/^(k|g|p)n/, 'n')
    .replace(/^wr/, 'r')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/[cq]/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/v/g, 'f')
    .replace(/dg/g, 'j')
  const head = /[aeiouy]/.test(s[0]) ? 'a' : s[0]
  return (head + s.slice(1).replace(/[aeiouyhw]/g, '')).replace(/(.)\1+/g, '$1')
}

function similarity(heard: Word, part: { norm: string; key: string }): number {
  let score = jaroWinkler(heard.norm, part.norm)
  if (part.key.length >= 2 && part.key === heard.key) score = Math.max(score, 0.9)
  // Names are capitalized in the transcript; "will" or "hope" in lowercase is probably just a word.
  if (!heard.capitalized) score *= 0.8
  return score
}

/** Lowest similarity that counts as hearing a name part. Short names need to be closer. */
function threshold(part: string): number {
  return normalize(part).length <= 3 ? 0.92 : 0.85
}

/**
 * Clients whose name is heard in the transcript, best first. Reading stops a few
 * words after the first confident name part, so later names don't compete.
 */
export function matchClients(transcript: string, clients: Client[]): ClientMatch[] {
  const targets = clients.map((c) =>
    nameParts(c.name).map((part) => {
      const norm = normalize(part)
      return { part, norm, key: soundKey(norm), min: threshold(part) }
    })
  )
  const tops = clients.map(() => [] as ({ heard: string; score: number } | undefined)[])
  // A session repeats words often, so each distinct word is only compared once.
  const hitsByWord = new Map<string, { c: number; p: number; score: number }[]>()
  const positions = transcriptWords(transcript)
  let stop = Infinity
  for (let i = 0; i < positions.length && i <= stop; i++) {
    for (const form of positions[i]) {
      const id = `${form.capitalized ? 'C' : 'l'}${form.text}`
      let hits = hitsByWord.get(id)
      if (!hits) {
        const word = { ...form, key: soundKey(form.norm) }
        hits = []
        targets.forEach((parts, c) =>
          parts.forEach((t, p) => {
            const score = similarity(word, t)
            if (score >= t.min) hits!.push({ c, p, score })
          })
        )
        hitsByWord.set(id, hits)
      }
      for (const { c, p, score } of hits) {
        if (!tops[c][p] || score > tops[c][p]!.score) tops[c][p] = { heard: form.text, score }
        if (score >= CONFIDENT && stop === Infinity) stop = i + NAME_TAIL
      }
    }
  }
  const matches: ClientMatch[] = []
  clients.forEach((client, c) => {
    const heard: ClientMatch['heard'] = []
    let best = 0
    targets[c].forEach((t, p) => {
      const top = tops[c][p]
      if (!top) return
      best = Math.max(best, top.score)
      heard.push({ heard: top.heard, part: t.part })
    })
    if (!heard.length) return
    // Hearing the last name as well as the first separates two clients who share one.
    let score = Math.min(1, best + 0.08 * (heard.length - 1))
    if (client.status === 'discharged') score *= 0.9
    matches.push({ clientId: client.id, score, likely: false, heard })
  })
  matches.sort((a, b) => b.score - a.score)
  if (matches[0] && matches[0].score >= CONFIDENT && (!matches[1] || matches[0].score - matches[1].score >= 0.05)) matches[0].likely = true
  return matches
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Respell a misheard name the way it was entered, so the name is removed before
 * anything is sent to Claude (redactName only knows the name as entered). Only
 * capitalized occurrences are changed, so ordinary words stay as they are.
 */
export function correctHeardName(text: string, heard: ClientMatch['heard']): string {
  let out = text
  for (const { heard: word, part } of heard) {
    if (normalize(word) === normalize(part) && !word.includes(' ')) continue
    const forms = [...new Set([word, word.toUpperCase()])].filter((f) => /^\p{Lu}/u.test(f)).map(escapeRegExp)
    if (!forms.length) continue
    const re = new RegExp(`(?<![\\p{L}])(?:${forms.join('|').replace(/ /g, '\\s+')})(?![\\p{L}])`, 'gu')
    out = out.replace(re, part)
  }
  return out
}

/** The kind of note a client's next session gets: an intake until they have any history. */
export function nextNoteType(client: Client, notes: Note[]): NoteType {
  const hasHistory = notes.some((n) => n.clientId === client.id) || (client.plan?.goals.length ?? 0) > 0
  return hasHistory ? 'progress' : 'intake'
}

/**
 * Turn a recording into the client's draft. An untouched draft the clinician
 * already started is filled in rather than duplicated. The date of service is
 * the day it was recorded, not the day it arrived.
 */
export function memoToNote(memo: MobileMemo, client: Client, notes: Note[], settings: Settings, heard: ClientMatch['heard'], now: string): Note {
  const dictation = correctHeardName(memo.transcript.trim(), heard)
  const blank = notes.find((n) => n.clientId === client.id && n.status === 'draft' && !n.dictation.trim() && !n.sections.length)
  const recorded = new Date(memo.recordedAt)
  if (blank) {
    return { ...blank, dictation, session: { ...blank.session, date: defaultSession(blank.type, settings, client.setting, recorded).date }, source: 'mobile', updatedAt: now }
  }
  const type = nextNoteType(client, notes)
  return {
    id: memo.id,
    clientId: client.id,
    type,
    format: settings.noteFormat,
    status: 'draft',
    session: defaultSession(type, settings, client.setting, recorded),
    attest: defaultAttestations(),
    dictation,
    sections: [],
    reviewItems: [],
    suggestions: null,
    generatedAt: null,
    finalizedAt: null,
    copiedAt: null,
    source: 'mobile',
    createdAt: now,
    updatedAt: now
  }
}
