import { WRITING_MODELS, type Client, type Note } from './types'
import { todayISO } from './compliance'

// Notes are written in the background so the clinician can move on to the next
// session while the last one is still being drafted. This sorts every note that
// still needs something into the queue shown on the home screen and in Activity.

export type JobKind = 'write' | 'amend'

export interface NoteJob {
  kind: JobKind
  stage: 'transcribing' | 'writing'
  startedAt: number
  /** Set when the job failed. The note is unchanged; the job stays so it can be retried. */
  error?: string
  /** For a follow-up: what was dictated and what it answered, so a retry doesn't lose it. */
  followUp?: string
  flagged?: string[]
}

export interface Queue {
  /** Being transcribed or written right now. */
  writing: Note[]
  failed: Note[]
  /** Written and waiting for review, oldest first: the first one done is the first one to check. */
  ready: Note[]
  /** Drafts that haven't been written yet. */
  unwritten: Note[]
  /** Finalized but never copied to the EHR. */
  uncopied: Note[]
  /** Finalized and copied today, most recent first. */
  finished: Note[]
}

export function buildQueue(notes: Note[], clients: Client[], jobs: Record<string, NoteJob>, today = todayISO()): Queue {
  const known = new Set(clients.map((c) => c.id))
  const q: Queue = { writing: [], failed: [], ready: [], unwritten: [], uncopied: [], finished: [] }
  for (const n of notes) {
    if (!known.has(n.clientId)) continue
    const job = jobs[n.id]
    if (job && n.status === 'draft') (job.error ? q.failed : q.writing).push(n)
    else if (n.status === 'draft') (n.sections.length ? q.ready : q.unwritten).push(n)
    else if (!n.copiedAt) q.uncopied.push(n)
    else if (n.finalizedAt && todayISO(new Date(n.finalizedAt)) === today) q.finished.push(n)
  }
  const started = (n: Note) => jobs[n.id]?.startedAt ?? 0
  q.writing.sort((a, b) => started(a) - started(b))
  q.failed.sort((a, b) => started(a) - started(b))
  q.ready.sort((a, b) => (a.generatedAt ?? '').localeCompare(b.generatedAt ?? ''))
  q.unwritten.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  q.uncopied.sort((a, b) => (a.finalizedAt ?? '').localeCompare(b.finalizedAt ?? ''))
  q.finished.sort((a, b) => (b.finalizedAt ?? '').localeCompare(a.finalizedAt ?? ''))
  return q
}

/** What still needs the clinician: the count shown beside Queue. Work in progress shows in Activity instead. */
export function queueCount(q: Queue, plans?: PlanQueue): number {
  return q.failed.length + q.ready.length + q.uncopied.length + (plans ? plans.failed.length + plans.ready.length : 0)
}

// ---------------------------------------------------------------------------
// Treatment plans are drafted in the background too, one per client at a time,
// and wait in the queue for review the way a written note does.
// ---------------------------------------------------------------------------

export interface PlanJob {
  stage: 'transcribing' | 'writing'
  startedAt: number
  /** Whether the client already had a plan, so this updates it rather than drafting one. */
  updating: boolean
  /** What was dictated, once transcribed, so a retry doesn't lose it. Empty means draft from the record. */
  dictation?: string
  /** Set when the job failed. The plan is unchanged; the job stays so it can be retried. */
  error?: string
}

/** A plan Echo drafted that the clinician hasn't signed off on yet. */
export interface PlanDraft {
  reviewItems: string[]
  updated: boolean
  finishedAt: number
  /** Finished in the background and not opened since. */
  unseen: boolean
}

export interface PlanQueue {
  writing: Client[]
  failed: Client[]
  /** Drafted and waiting for review, oldest first. */
  ready: Client[]
}

export function buildPlanQueue(clients: Client[], jobs: Record<string, PlanJob>, drafts: Record<string, PlanDraft>): PlanQueue {
  const q: PlanQueue = { writing: [], failed: [], ready: [] }
  for (const c of clients) {
    const job = jobs[c.id]
    if (job) (job.error ? q.failed : q.writing).push(c)
    else if (drafts[c.id]) q.ready.push(c)
  }
  const started = (c: Client) => jobs[c.id]?.startedAt ?? 0
  q.writing.sort((a, b) => started(a) - started(b))
  q.failed.sort((a, b) => started(a) - started(b))
  q.ready.sort((a, b) => drafts[a.id].finishedAt - drafts[b.id].finishedAt)
  return q
}

// ---------------------------------------------------------------------------
// Suggesting a stronger model. When the clinician keeps rewriting the same note
// (Regenerate, or Try again after the model declined or cut off), Echo offers
// the next model up for that note.
// ---------------------------------------------------------------------------

/** Rewrites of one note, on one model, before Echo suggests a stronger one. */
export const RETRIES_BEFORE_SUGGESTING = 2

/** Failures a different model might not repeat. Network, key and rate-limit errors aren't among them. */
export const MODEL_FAILURE = {
  declined: 'Claude declined to write this',
  cutOff: 'The response was cut off.',
  empty: 'The model returned an empty response.'
}

export function isModelFailure(error: string): boolean {
  return Object.values(MODEL_FAILURE).some((m) => error.includes(m))
}

/** The next model up from `model`, or null if it's already the strongest (or not one Echo lists). */
export function nextModelUp(model: string): string | null {
  const i = WRITING_MODELS.findIndex((m) => m.id === model)
  return i >= 0 && i < WRITING_MODELS.length - 1 ? WRITING_MODELS[i + 1].id : null
}

/** The model to suggest after `retries` rewrites on `model`, if any. */
export function suggestModel(model: string, retries: number): string | null {
  return retries >= RETRIES_BEFORE_SUGGESTING ? nextModelUp(model) : null
}

// ---------------------------------------------------------------------------
// Charting: going through the notes written since the last batch, one after
// another, getting each into the EHR without hunting for it on client pages.
// ---------------------------------------------------------------------------

/** Where a note is in charting: still to review, finalized but not copied, or in the clipboard (so presumably the EHR). */
export type ChartStatus = 'review' | 'copy' | 'done'

export function chartStatus(note: Note): ChartStatus {
  if (note.status === 'draft') return 'review'
  return note.copiedAt ? 'done' : 'copy'
}

/** The notes to chart, in the order they were written: drafts waiting for review and finalized notes not yet copied. */
export function chartNotes(q: Queue): Note[] {
  return [...q.ready, ...q.uncopied].sort((a, b) => (a.generatedAt ?? a.updatedAt).localeCompare(b.generatedAt ?? b.updatedAt))
}

/**
 * The charting list after notes have finished or been deleted: notes still in the record keep their place
 * (charted ones included, so going back works), and notes that became ready since are added at the end.
 */
export function extendChart(ids: string[], notes: Note[], q: Queue): string[] {
  const known = new Set(notes.map((n) => n.id))
  const kept = ids.filter((id) => known.has(id))
  const have = new Set(kept)
  const added = chartNotes(q).filter((n) => !have.has(n.id)).map((n) => n.id)
  return added.length || kept.length !== ids.length ? [...kept, ...added] : ids
}

/** The next note after `id` that still needs something, wrapping round to the start; null when all are charted. */
export function nextToChart(ids: string[], notes: Note[], id: string): Note | null {
  const byId = new Map(notes.map((n) => [n.id, n]))
  const i = ids.indexOf(id)
  for (let k = 1; k <= ids.length; k++) {
    const n = byId.get(ids[(i + k) % ids.length])
    if (n && n.id !== id && chartStatus(n) !== 'done') return n
  }
  return null
}
