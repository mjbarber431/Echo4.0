import catalog from './resources.json'

// The clinical resource library: worksheets, handouts and measures from the
// practice's ClinicalResources folder, plus ACBS member resources by link.
// Built by scripts/catalog-resources.mjs. Claude sees a compact list of it in
// Ask Claude and refers to items as [[r:<id>]], which Echo turns into links.

export type ResourceKind = 'assessment' | 'handout' | 'worksheet' | 'workbook' | 'clinician' | 'article' | 'visual' | 'audio' | 'exercise' | 'metaphor' | 'protocol' | 'video'

/** One thing the viewer can show for a resource: the document, an ACBS page's text, or one of its attachments. */
export interface ResourcePart {
  label: string
  /** Relative to the library folder. */
  file: string
  format: 'pdf' | 'html' | 'audio' | 'image' | 'office' | 'other'
  /** The original Word file a converted page came from, for opening in its app. */
  original?: string
  /** First page of a slide deck or spreadsheet, for a preview. */
  thumb?: string
}

export interface Resource {
  id: string
  title: string
  topic: string
  kind: ResourceKind
  audience: 'adults' | 'teens' | 'children' | 'parents' | 'couples' | 'family' | 'groups'
  /** File in the library folder, relative to it. */
  path?: string
  /** Page to open a compilation at. */
  page?: number
  /** The compilation a section belongs to. */
  parent?: string
  format?: string
  pages?: number
  /** ACBS resources live on contextualscience.org and open in the browser. */
  url?: string
  source?: 'acbs'
  /** Where the resource sits on the ACBS site, e.g. "Metaphors" or "Assessment and Monitoring Tools". */
  section?: string
  /** One line on what it is, where known. */
  note?: string
  /** What the viewer shows, in order. Missing for web-only links. */
  parts?: ResourcePart[]
}

/** The address the viewer loads a part from (served by the main process from the library folder). */
export const partUrl = (id: string, index: number, thumb = false): string => `echo-res://r/${id}/${index}${thumb ? '/thumb' : ''}`

/** A part's name for its tab: "Overview", or the label without its extension or underscores. */
export const partLabel = (p: ResourcePart): string => (p.label === 'Overview' ? 'Overview' : p.label.replace(/\.[a-z0-9]+$/i, '').replace(/_+/g, ' '))

export const RESOURCES: Resource[] = (catalog as { items: Resource[] }).items
const byId = new Map(RESOURCES.map((r) => [r.id, r]))

export const resourceById = (id: string): Resource | undefined => byId.get(id)

export const KIND_LABEL: Record<ResourceKind, string> = {
  assessment: 'Measure',
  handout: 'Handout',
  worksheet: 'Worksheet',
  workbook: 'Workbook',
  clinician: 'Clinician guide',
  article: 'Article',
  visual: 'Visual',
  audio: 'Audio',
  exercise: 'Exercise',
  metaphor: 'Metaphor',
  protocol: 'Protocol',
  video: 'Video'
}

/** Topics in the order the Library lists them. */
export const TOPICS = [...new Set(RESOURCES.map((r) => r.topic))].sort((a, b) => topicRank(a) - topicRank(b) || a.localeCompare(b))
function topicRank(t: string): number {
  const order = ['ACT', 'ACT Metaphors', 'ACT Exercises', 'ACT Measures', 'Anxiety', 'Depression', 'Measures', 'Protocols', 'Case Formulation', 'Trauma & PTSD', 'Safety Planning']
  const i = order.indexOf(t)
  return i < 0 ? order.length : i
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ')

const STOPWORDS = new Set(['a', 'an', 'and', 'the', 'for', 'of', 'to', 'on', 'in', 'with', 'about', 'my', 'some', 'something', 'client', 'clients', 'patient', 'resource', 'resources'])

/** Plurals and verb endings off, so "worksheets", "depressed" and "values" find "worksheet", "depression" and "value". */
function stem(w: string): string {
  if (w.length < 5) return w.length === 4 && /[^su]s$/.test(w) ? w.slice(0, -1) : w
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y'
  if (/(ing|ed)$/.test(w) && w.length > 6) return w.replace(/(ing|ed)$/, '')
  if (/[^aeiou]es$/.test(w) && !/(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -1)
  if (/(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2)
  if (/[^sui]s$/.test(w)) return w.slice(0, -1)
  return w
}

/**
 * What clinicians type, mapped to how the library words it. Each key (a stem
 * prefix) also matches any of its terms, so "suicidal teen" finds the C-SSRS and
 * safety plans for adolescents, and "kids questionnaire" finds child measures.
 */
const CONCEPTS: [RegExp, string[]][] = [
  [/^(depress|mood|sad|low|ba$|behavioral activation)/, ['depress', 'mood', 'phq', 'activation']],
  [/^(anxi|worr|nervous|gad$)/, ['anxi', 'worry', 'panic', 'phobi', 'fear', 'gad']],
  [/^(panic)/, ['panic', 'agorophobi', 'agoraphobi']],
  [/^(fear|phobi)/, ['fear', 'phobi', 'exposure']],
  [/^(social)/, ['social']],
  [/^(trauma|ptsd|abuse|assault)/, ['trauma', 'ptsd', 'pcl']],
  [/^(suicid|si$|selfharm|crisis|safety|risk)/, ['suicid', 'safety plan', 'ssrs', 'columbia', 'self harm', 'crisis', '988']],
  [/^(questionnaire|scale|measure|assess|screen|inventor|survey|test|outcome|score|rating)/, ['assessment', 'measure', 'questionnaire', 'scale', 'inventory', 'screen']],
  [/^(kid|child|pediatric|young)/, ['children', 'child', 'kid', 'youth']],
  [/^(teen|adolescen|youth|young)/, ['teens', 'teen', 'adolescen', 'youth']],
  [/^(parent|mom|dad|caregiver)/, ['parents', 'parent', 'caregiver']],
  [/^(couple|marri|partner|relationship)/, ['couples', 'couple', 'relationship', 'partner']],
  [/^(group)/, ['groups', 'group']],
  [/^(metaphor|analog|story)/, ['metaphor']],
  [/^(psychoed|handout|info)/, ['handout', 'psychoeducation']],
  [/^(homework|sheet|forms?$|logs?$|diar|record)/, ['worksheet', 'log', 'record', 'diary']],
  [/^(alcohol|drink|drug|substance|addict|cannabis|marijuana|weed|sud$)/, ['alcohol', 'substance', 'audit', 'cudit', 'cannabis', 'drug', 'addict']],
  [/^(sleep|insomnia)/, ['sleep', 'insomnia']],
  [/^(ocd|obsess|compuls)/, ['ocd', 'obsess', 'compuls']],
  [/^(grief|griev|loss|bereave)/, ['grief', 'loss', 'bereave']],
  [/^(mindful|meditat|present moment|breath)/, ['mindful', 'meditat', 'present moment', 'breath']],
  [/^(defus|fusion|thought)/, ['defus', 'fusion', 'thought']],
  [/^(accept|willing)/, ['accept', 'willing']],
  [/^(value|valu)/, ['value', 'valued']],
  [/^(compassion|kindness)/, ['compassion', 'kindness']],
  [/^(formulat|conceptuali|hexaflex|matrix)/, ['formulat', 'conceptuali', 'hexaflex', 'matrix']],
  [/^(protocol|manual|treatment plan|tx)/, ['protocol', 'manual', 'treatment plan', 'tx plan']],
  [/^(flexib|inflexib|aaq)/, ['flexib', 'aaq']],
  [/^(intro|first session|orient|consent)/, ['introduc', 'introducing', 'consent', 'first session']],
  [/^(clinician|therapist|guide)/, ['clinician', 'guide']]
]

/** Words a resource is found by, field by field, so a title hit can outrank a note hit. */
function fields(r: Resource): { title: string; facets: string; rest: string } {
  return {
    title: ` ${norm(r.title)} `,
    facets: ` ${norm(r.topic)} ${norm(KIND_LABEL[r.kind])} ${r.kind} ${r.audience} `,
    rest: ` ${norm(r.section ?? '')} ${norm(r.note ?? '')} `
  }
}

/**
 * Does `term` appear in `text`? Terms of three letters or fewer must be whole
 * words (or plurals), so "act" doesn't find "action"; longer ones may start a
 * word, and stems of five or more may sit inside one ("phobi" in "agoraphobia").
 */
function has(text: string, term: string): 'start' | 'inside' | null {
  if (term.length <= 3) return text.includes(` ${term} `) || text.includes(` ${term}s `) ? 'start' : null
  if (text.includes(` ${term}`)) return 'start'
  return term.length >= 5 && text.includes(term) ? 'inside' : null
}

/** How well one query word fits a resource: 0 when it doesn't. */
function wordScore(f: ReturnType<typeof fields>, word: string): number {
  const exact = [word, stem(word)]
  const related = CONCEPTS.flatMap(([re, terms]) => (re.test(word) ? terms : []))
  let best = 0
  for (const [terms, weight] of [[exact, 1], [related, 0.7]] as const) {
    for (const t of terms) {
      const title = has(f.title, t)
      const s = title === 'start' ? 3 : title ? 2 : has(f.facets, t) ? 1.5 : has(f.rest, t) ? 0.5 : 0
      best = Math.max(best, s * weight)
    }
  }
  return best
}

/**
 * Resources for a query in a clinician's own words, best first. Every word has
 * to fit (by title, topic, kind, audience or description, allowing for plurals
 * and synonyms). If nothing fits all of them, resources that fit all but one
 * come back instead, marked `partial`, so a stray word doesn't empty the list.
 */
export function findResources(query: string, list: Resource[] = RESOURCES): { items: Resource[]; partial: boolean } {
  const words = norm(query).split(/\s+/).filter((w) => w && !STOPWORDS.has(w))
  if (!words.length) return { items: list, partial: false }
  const phrase = words.join(' ')
  const scored = list.map((r) => {
    const f = fields(r)
    const per = words.map((w) => wordScore(f, w))
    const hits = per.filter((s) => s > 0).length
    const score = per.reduce((a, b) => a + b, 0) + (words.length > 1 && f.title.includes(phrase) ? 4 : 0)
    return { r, hits, score }
  })
  const rank = (a: { score: number; r: Resource }, b: { score: number; r: Resource }) => b.score - a.score || a.r.title.localeCompare(b.r.title)
  const all = scored.filter((s) => s.hits === words.length).sort(rank)
  if (all.length || words.length < 2) return { items: all.map((s) => s.r), partial: false }
  return { items: scored.filter((s) => s.hits === words.length - 1).sort(rank).map((s) => s.r), partial: true }
}

/** Just the resources from findResources. */
export const searchResources = (query: string, list: Resource[] = RESOURCES): Resource[] => findResources(query, list).items

/** Library topics that fit a client's diagnoses, for suggesting what to assign. */
export function topicsForDiagnoses(diagnoses: { code: string; description: string }[]): string[] {
  const out = new Set<string>()
  for (const d of diagnoses) {
    const code = d.code.toUpperCase().replace(/\s/g, '')
    const text = d.description.toLowerCase()
    if (/^F3[234]/.test(code) || /depress|dysthymi/.test(text)) out.add('Depression')
    if (/^F4[01]/.test(code) || /anxi|panic|phobi/.test(text)) out.add('Anxiety')
    if (/^F43\.1/.test(code) || /ptsd|post.?traumatic|trauma/.test(text)) out.add('Trauma & PTSD')
    if (/^(R45\.851|T14\.91)/.test(code) || /suicid/.test(text)) out.add('Safety Planning')
  }
  return TOPICS.filter((t) => out.has(t))
}

/** Where a resource comes from, for display: "ACBS", or the compilation and page. */
export function resourceWhere(r: Resource): string {
  if (r.source === 'acbs') return r.section ? `ACBS · ${r.section}` : 'ACBS'
  const parent = r.parent ? resourceById(r.parent) : undefined
  if (parent && r.page) return `${parent.title}, p. ${r.page}`
  return r.pages && r.pages > 1 ? `${r.pages} pages` : ''
}

// ---------------------------------------------------------------------------
// For Claude
// ---------------------------------------------------------------------------

export const RESOURCE_TOKEN = /\[\[r:([0-9a-z]{6,12})\]\]/g

/** The library as Claude sees it: one line per resource, grouped by topic. */
export function describeLibrary(list: Resource[] = RESOURCES): string {
  return TOPICS.map((topic) => {
    const items = list.filter((r) => r.topic === topic)
    if (!items.length) return ''
    const lines = items.map((r) => {
      const extra = [KIND_LABEL[r.kind].toLowerCase(), r.audience !== 'adults' ? r.audience : '', r.source === 'acbs' ? 'ACBS' : ''].filter(Boolean).join(', ')
      return `${r.id} ${r.title} (${extra})${r.note ? `: ${r.note}` : ''}`
    })
    return `## ${topic}\n${lines.join('\n')}`
  })
    .filter(Boolean)
    .join('\n\n')
}

export const LIBRARY_INSTRUCTIONS = `RESOURCE LIBRARY
The clinician keeps the library below: their own worksheets, handouts and measures, and ACT resources from the Association for Contextual Behavioral Science (ACBS). When one would genuinely help with what you're discussing (a measure to track a process, a worksheet or metaphor for the next session, a handout to give the client), point to it by writing its reference exactly as [[r:<id>]], for example [[r:${RESOURCES[0]?.id ?? 'a1b2c3d4'}]]. Echo shows the reference as a link that opens it, so don't repeat its title next to it. Suggest one to three well-chosen items rather than lists, say briefly why each fits this client, and only use ids that appear below. You know these by title only, not their contents; if the specifics matter, say so. You can still suggest well-known resources that aren't in the library, by name.

The client's record ends with the library items already given to them, with when, whether they're done, and a measure's score. The clinician can give the client any item you reference with one click. Don't suggest something the client already has unless repeating it is the point (re-administering a measure to track change, say), and use the scores when discussing progress.`
