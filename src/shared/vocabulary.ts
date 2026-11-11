import clinical from '../../vocabulary/clinical.json'

// The vocabulary the transcriber checks recordings against, on the Mac and the
// phone (see vocabulary/VocabularyChecker.swift). The built-in list is
// vocabulary/clinical.json; the clinician's own terms come from Settings and
// travel to the phone in the paired link's sealed reply.

export interface VocabularyEntry {
  text: string
  aliases?: string[]
}

/** The most terms a clinician can add. FluidAudio was tested up to a few hundred in all. */
export const MAX_CUSTOM_TERMS = 150

function fromJson(root: Record<string, unknown>): VocabularyEntry[] {
  return Object.values(root).flatMap((items) =>
    Array.isArray(items)
      ? items.flatMap((item): VocabularyEntry[] => {
          if (typeof item === 'string') return [{ text: item }]
          if (item && typeof item === 'object' && typeof (item as VocabularyEntry).text === 'string') {
            const { text, aliases } = item as VocabularyEntry
            return [{ text, ...(Array.isArray(aliases) ? { aliases: aliases.filter((a) => typeof a === 'string') } : {}) }]
          }
          return []
        })
      : []
  )
}

export const BUILT_IN_VOCABULARY: VocabularyEntry[] = fromJson(clinical as Record<string, unknown>)

/**
 * The Settings box: one term per line, optionally followed by "=" and the ways
 * it gets misheard, comma-separated. "Klonopin = clonopin, clono pin".
 */
export function parseCustomVocabulary(text: string): VocabularyEntry[] {
  const entries: VocabularyEntry[] = []
  for (const line of text.split('\n')) {
    const [term, misheard = ''] = line.split('=', 2)
    const clean = term.trim()
    if (clean.length < 3 || clean.length > 80) continue
    const aliases = misheard
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a.length >= 2 && a.length <= 80)
    entries.push(aliases.length ? { text: clean, aliases } : { text: clean })
    if (entries.length >= MAX_CUSTOM_TERMS) break
  }
  return entries
}

/** Everything the transcriber should check for. Repeats are merged on the Swift side. */
export function vocabularyTerms(custom: string | undefined): VocabularyEntry[] {
  return [...BUILT_IN_VOCABULARY, ...parseCustomVocabulary(custom ?? '')]
}
