import type { Client, Goal, GoalStatus, Note, NoteSection, Objective, Settings, TreatmentPlan } from './types'
import { DEFAULT_CLIENT_SETTING, nextReviewDate, scanRisk, todayISO } from './compliance'
import { backfillDiagnoses, parseDiagnoses } from './diagnosis'
import { cleanBody } from './format'

// Import from the previous Echo app (Vertex/Gemini, ~/Documents/App). That app
// exports a password-protected .echobackup holding every client with their notes
// and treatment plan. This maps those records onto this app's model and merges
// them in by UUID, so running the import twice changes nothing.

export interface LegacySection {
  key: string
  title: string
  content: string
}

export interface LegacyNote {
  id: string
  clientId: string
  type: 'intake' | 'progress'
  date: string
  transcription: string
  sections: LegacySection[]
  version?: number
  createdFrom?: 'desktop' | 'ios'
  createdAt: string
  updatedAt: string
}

export interface LegacyGoal {
  id: string
  goal: string
  objectives: string
  targetDate?: string
  status: 'active' | 'completed' | 'discontinued'
}

export interface LegacyPlan {
  id: string
  goals: LegacyGoal[]
  diagnosis: string
  presenting_problem: string
  theoretical_orientation: string
  interventions: string
  frequency: string
  additional_notes: string
  createdAt: string
  updatedAt: string
}

export interface LegacyClient {
  id: string
  name: string
  dateOfBirth?: string
  diagnosis?: string
  referralSource?: string
  phone?: string
  email?: string
  ehrProfile?: string
  notes: LegacyNote[]
  treatmentPlan?: LegacyPlan
  createdAt: string
  updatedAt: string
}

export interface LegacyImportReport {
  clientsAdded: number
  clientsExisting: number
  notesAdded: number
  notesExisting: number
  plansAdded: number
  /** Imported clients whose name matches a different client already here. Not merged; the clinician decides. */
  nameMatches: string[]
}

export interface LegacyMerge {
  /** Clients that are new or changed (a plan was added), to upsert. */
  clients: Client[]
  /** Notes that are new. */
  notes: Note[]
  report: LegacyImportReport
}

const GOAL_STATUS: Record<LegacyGoal['status'], GoalStatus> = {
  active: 'in_progress',
  completed: 'met',
  discontinued: 'discontinued'
}

/**
 * The old app saved Gemini's JSON without checking it, so a field typed as a
 * string can hold an array, an object, a number or null. Read any of them as text.
 */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n')
  if (typeof value === 'object') return Object.values(value).map(asText).filter(Boolean).join('\n')
  return String(value)
}

/** A date of service as YYYY-MM-DD in local time. Full timestamps are converted, not sliced, so evening sessions keep their day. */
export function legacyDate(raw: string | undefined, fallback: string): string {
  for (const value of [raw, fallback]) {
    if (!value) continue
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return todayISO(d)
  }
  return todayISO()
}

function splitObjectives(text: unknown, status: GoalStatus, uid: () => string): Objective[] {
  return asText(text)
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)]|[a-z][.)]|objective\s*[\d.a-z]*\s*[:.)-])\s*/i, '').trim())
    .filter(Boolean)
    .map((text) => ({ id: uid(), text, status }))
}

export function mapPlan(plan: LegacyPlan, settings: Settings, uid: () => string): TreatmentPlan {
  const lastReviewed = legacyDate(plan.updatedAt, plan.createdAt)
  const goals: Goal[] = (plan.goals ?? []).map((g) => {
    const status = GOAL_STATUS[g.status] ?? 'in_progress'
    return {
      id: g.id,
      problem: '',
      goal: asText(g.goal),
      objectives: splitObjectives(g.objectives, status, uid),
      // The old plan listed interventions once for the whole plan; each goal carries them here.
      interventions: asText(plan.interventions),
      status,
      progress: '',
      targetDate: g.targetDate ? legacyDate(g.targetDate, '') : null,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt
    }
  })
  return {
    goals,
    frequency: asText(plan.frequency),
    modalities: asText(plan.theoretical_orientation),
    dischargeCriteria: '',
    reviewDate: nextReviewDate(lastReviewed, settings.planReviewDays),
    lastReviewed,
    updatedAt: plan.updatedAt
  }
}

/** Clinical background only. Context is sent to the AI, so contact details and DOB never go here. */
function seedContext(c: LegacyClient, uncoded: string[]): string {
  const presenting = asText(c.treatmentPlan?.presenting_problem).trim()
  const additional = asText(c.treatmentPlan?.additional_notes).trim()
  return [
    presenting && `Presenting problem: ${presenting}`,
    uncoded.length > 0 && `Diagnostic impressions: ${uncoded.join('; ')}`,
    additional && `Additional notes: ${additional}`
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Identifying details go to the scratchpad, which is never sent to the AI or copied into notes. */
function seedScratchpad(c: LegacyClient): string {
  const lines = [
    c.dateOfBirth && `- Date of birth: ${c.dateOfBirth}`,
    c.phone && `- Phone: ${c.phone}`,
    c.email && `- Email: ${c.email}`,
    c.referralSource && `- Referral source: ${c.referralSource}`,
    c.ehrProfile && c.ehrProfile !== 'default' && `- EHR: ${c.ehrProfile}`
  ].filter(Boolean)
  return lines.length ? ['## From previous Echo', ...lines].join('\n') : ''
}

export function mapClient(c: LegacyClient, settings: Settings, uid: () => string): Client {
  const { diagnoses, uncoded } = parseDiagnoses(asText(c.diagnosis), asText(c.treatmentPlan?.diagnosis))
  return {
    id: c.id,
    name: c.name,
    pronouns: '',
    setting: DEFAULT_CLIENT_SETTING,
    diagnoses,
    status: 'active',
    context: seedContext(c, uncoded),
    scratchpad: seedScratchpad(c),
    plan: c.treatmentPlan ? mapPlan(c.treatmentPlan, settings, uid) : null,
    planHistory: [],
    createdAt: c.createdAt,
    updatedAt: c.updatedAt
  }
}

/**
 * Old notes were already charted in the EHR, so they arrive finalized and copied
 * at their original time: they serve as history and never appear on Queue.
 * Echo's own notes always have generatedAt; null marks an imported one.
 */
export function mapNote(n: LegacyNote, client: Client, settings: Settings): Note {
  const type = n.type === 'intake' ? 'intake' : 'progress'
  const sections: NoteSection[] = (n.sections ?? []).map((s) => ({ heading: asText(s.title) || asText(s.key), body: cleanBody(asText(s.content)) }))
  const done = n.updatedAt || n.createdAt
  const risk = scanRisk([asText(n.transcription), ...sections.map((s) => s.body)].join('\n'))
  return {
    id: n.id,
    clientId: client.id,
    type,
    format: settings.noteFormat,
    status: 'final',
    session: {
      date: legacyDate(n.date, n.createdAt),
      // The old app didn't record a service code; leave it blank rather than guess one.
      cpt: '',
      setting: client.setting,
      participants: 'Client'
    },
    attest: { noSafetyConcerns: risk.length === 0, mseUnremarkable: true },
    dictation: asText(n.transcription),
    sections,
    reviewItems: [],
    suggestions: null,
    // Not written by this app, so it has no audit checklist.
    generatedAt: null,
    finalizedAt: done,
    copiedAt: done,
    source: n.createdFrom === 'ios' ? 'mobile' : 'desktop',
    createdAt: n.createdAt,
    updatedAt: done
  }
}

/** One row in the picker: enough to choose a client, nothing clinical. */
export interface LegacyClientSummary {
  id: string
  name: string
  noteCount: number
  /** Of noteCount, how many aren't here yet. */
  newNotes: number
  hasPlan: boolean
  lastSession: string | null
  /** Already imported (same ID here). Importing again only adds missing notes, or a plan if there's none. */
  imported: boolean
  /** A different client here has the same name. */
  nameMatch: boolean
}

export function summarizeLegacy(legacy: LegacyClient[], current: { clients: Client[]; notes: Note[] }): LegacyClientSummary[] {
  const noteIds = new Set(current.notes.map((n) => n.id))
  return legacy
    .map((c) => {
      const notes = c.notes ?? []
      const dates = notes.map((n) => legacyDate(n.date, n.createdAt)).sort()
      const imported = current.clients.some((x) => x.id === c.id)
      return {
        id: c.id,
        name: c.name,
        noteCount: notes.length,
        newNotes: notes.filter((n) => !noteIds.has(n.id)).length,
        hasPlan: !!c.treatmentPlan,
        lastSession: dates.at(-1) ?? null,
        imported,
        nameMatch: !imported && current.clients.some((x) => sameName(x.name, c.name))
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

const sameName = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ')

/** Adds what's missing: new clients, notes not already here, and a plan for clients that have none. Nothing existing is overwritten. */
export function mergeLegacy(current: { clients: Client[]; notes: Note[] }, legacy: LegacyClient[], settings: Settings, uid: () => string): LegacyMerge {
  const report: LegacyImportReport = { clientsAdded: 0, clientsExisting: 0, notesAdded: 0, notesExisting: 0, plansAdded: 0, nameMatches: [] }
  const clients: Client[] = []
  const notes: Note[] = []
  const noteIds = new Set(current.notes.map((n) => n.id))

  for (const lc of legacy) {
    let client = current.clients.find((c) => c.id === lc.id) ?? clients.find((c) => c.id === lc.id)
    if (client) {
      report.clientsExisting++
      if (!client.plan && lc.treatmentPlan) {
        client = { ...client, plan: mapPlan(lc.treatmentPlan, settings, uid) }
        clients.push(client)
        report.plansAdded++
      }
    } else {
      client = mapClient(lc, settings, uid)
      if (current.clients.some((c) => sameName(c.name, lc.name))) report.nameMatches.push(lc.name)
      clients.push(client)
      report.clientsAdded++
      if (client.plan) report.plansAdded++
    }
    for (const ln of lc.notes ?? []) {
      if (noteIds.has(ln.id)) {
        report.notesExisting++
        continue
      }
      noteIds.add(ln.id)
      notes.push(mapNote(ln, client, settings))
      report.notesAdded++
    }
  }
  // Old intakes never set a diagnosis, so a client without one takes what its intake gives.
  for (const lc of legacy) {
    const i = clients.findIndex((c) => c.id === lc.id)
    const client = i >= 0 ? clients[i] : current.clients.find((c) => c.id === lc.id)
    if (!client) continue
    const filled = backfillDiagnoses(client, [...current.notes, ...notes])
    if (filled === client) continue
    if (i >= 0) clients[i] = filled
    else clients.push(filled)
  }
  return { clients, notes, report }
}
