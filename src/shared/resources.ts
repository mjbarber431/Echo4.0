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

/** Resources matching every word of the query, best title matches first. */
export function searchResources(query: string, list: Resource[] = RESOURCES): Resource[] {
  const words = norm(query).split(/\s+/).filter(Boolean)
  if (!words.length) return list
  const scored = list.flatMap((r) => {
    const title = norm(r.title)
    const hay = `${title} ${norm(r.topic)} ${norm(KIND_LABEL[r.kind])} ${norm(r.section ?? '')} ${norm(r.note ?? '')}`
    if (!words.every((w) => hay.includes(w))) return []
    const score = words.reduce((s, w) => s + (title.startsWith(w) ? 3 : title.includes(` ${w}`) ? 2 : title.includes(w) ? 1 : 0), 0)
    return [{ r, score }]
  })
  return scored.sort((a, b) => b.score - a.score).map((s) => s.r)
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
The clinician keeps the library below: their own worksheets, handouts and measures, and ACT resources from the Association for Contextual Behavioral Science (ACBS). When one would genuinely help with what you're discussing (a measure to track a process, a worksheet or metaphor for the next session, a handout to give the client), point to it by writing its reference exactly as [[r:<id>]], for example [[r:${RESOURCES[0]?.id ?? 'a1b2c3d4'}]]. Echo shows the reference as a link that opens it, so don't repeat its title next to it. Suggest one to three well-chosen items rather than lists, say briefly why each fits this client, and only use ids that appear below. You know these by title only, not their contents; if the specifics matter, say so. You can still suggest well-known resources that aren't in the library, by name.`
