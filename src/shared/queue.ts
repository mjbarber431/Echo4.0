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

/** What still needs the clinician: the count shown beside Queue. Notes being written show in Activity instead. */
export function queueCount(q: Queue): number {
  return q.failed.length + q.ready.length + q.uncopied.length
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
