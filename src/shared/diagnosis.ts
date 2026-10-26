import type { Client, Diagnosis, Note, NoteSection } from './types'

// Diagnoses read from the note text itself. The intake is the diagnostic
// evaluation, so what its Diagnostic Impression says (including the clinician's
// own edits) is what the client record should carry; the model's structured
// list only supplies tidier descriptions for the same codes.

// ICD-10-CM: a letter (U is reserved), two digits, and an optional decimal part.
const ICD10 = /\b([A-TV-Z]\d{2}(?:\.[0-9A-Z]{1,4})?)\b/g
/** A code mentioned without being given: a rule-out, a differential, a deferral, or criteria not met. */
const NOT_GIVEN = /\b(?:rule[ds]?[\s-]*out|r\/o|differential|deferred|does not meet|did not meet|not met|no longer meets)\b/i
const LABEL = /^(?:(?:primary|secondary|principal|provisional|working|additional|current)\b\s*)*(?:(?:diagnos[ie]s|dx|impressions?)(?:\s*#?\d+)?\b)?[\s:–—-]*/i
const DIAGNOSTIC_HEADING = /diagnos|impression/i

function describe(text: string): string {
  const cleaned = text
    .replace(/ICD-?10(?:-CM)?(?:\s+codes?)?/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/^[\s:–—,;()*•.-]+|[\s:–—,;()*•.-]+$/g, '')
    .replace(/^(?:\d+[.)]\s*|and\s+)/i, '')
    .replace(LABEL, '')
    .trim()
  // Keep the name and drop any rationale that follows it.
  const name = cleaned.split(/\s[–—-]\s|:\s|\.\s/)[0].replace(/[\s,;.]+$/, '')
  return name.length > 100 ? `${name.slice(0, 100).replace(/\s+\S*$/, '')}…` : name
}

/** ICD-10 codes found in free-text diagnoses, plus any text that carried no code. */
export function parseDiagnoses(...texts: string[]): { diagnoses: Diagnosis[]; uncoded: string[] } {
  const diagnoses: Diagnosis[] = []
  const uncoded: string[] = []
  for (const text of texts) {
    for (const segment of text.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean)) {
      const codes = [...segment.matchAll(ICD10)]
      if (codes.length === 0) {
        if (!uncoded.includes(segment)) uncoded.push(segment)
        continue
      }
      if (NOT_GIVEN.test(segment)) {
        if (!uncoded.includes(segment)) uncoded.push(segment)
        continue
      }
      // "F41.1 Generalized anxiety disorder" names follow their codes; "Generalized anxiety disorder (F41.1)" names precede them.
      const codeFirst = describe(segment.slice(0, codes[0].index)) === ''
      codes.forEach((m, i) => {
        const end = m.index + m[0].length
        const prevEnd = i > 0 ? codes[i - 1].index + codes[i - 1][0].length : 0
        const description = describe(codeFirst ? segment.slice(end, codes[i + 1]?.index ?? segment.length) : segment.slice(prevEnd, m.index))
        if (!diagnoses.some((d) => d.code === m[1])) diagnoses.push({ code: m[1], description })
      })
    }
  }
  return { diagnoses, uncoded }
}

/** Diagnoses written in a note's diagnostic sections, one sentence at a time so a code's rationale stays with it. */
export function diagnosesInSections(sections: NoteSection[]): Diagnosis[] {
  const diagnostic = sections.filter((s) => DIAGNOSTIC_HEADING.test(s.heading))
  // Notes from the previous Echo may have no diagnostic heading; there only mental-health (F) codes count.
  const fallback = diagnostic.length === 0
  const texts = (fallback ? sections : diagnostic).flatMap((s) => s.body.split(/(?<=[.!?])\s+/))
  const { diagnoses } = parseDiagnoses(...texts)
  return fallback ? diagnoses.filter((d) => d.code.startsWith('F')) : diagnoses
}

export function sameDiagnoses(a: Diagnosis[], b: Diagnosis[]): boolean {
  const codes = (ds: Diagnosis[]) => ds.map((d) => d.code.trim().toUpperCase()).sort().join('|')
  return codes(a) === codes(b)
}

/**
 * The diagnoses a note would set on the client. For an intake that's the codes its text gives
 * as it now reads, so hand edits count and nothing hinges on the model's structured list,
 * which is used only when the text has no codes. Other notes offer only what the model returned.
 */
export function noteDiagnoses(note: Note): Diagnosis[] {
  const fromModel = note.suggestions?.diagnoses ?? []
  if (note.type !== 'intake') return fromModel
  const found = diagnosesInSections(note.sections)
  if (found.length === 0) return fromModel
  const key = (code: string) => code.trim().toUpperCase()
  return found.map((d) => ({ code: d.code, description: fromModel.find((m) => key(m.code) === d.code)?.description.trim() || d.description }))
}

/**
 * A client with no diagnosis on file takes the one from its most recent finalized intake that
 * gives one. Covers intakes imported from the previous Echo and ones finalized before Echo
 * read diagnoses from the note text.
 */
export function backfillDiagnoses(client: Client, notes: Note[]): Client {
  if (client.diagnoses.length) return client
  const intakes = notes
    .filter((n) => n.clientId === client.id && n.type === 'intake' && n.status === 'final')
    .sort((a, b) => b.session.date.localeCompare(a.session.date))
  for (const intake of intakes) {
    const diagnoses = noteDiagnoses(intake)
    if (diagnoses.length) return { ...client, diagnoses }
  }
  return client
}
