import type { Client, Note } from './types'
import { scanRisk } from './compliance'
import { redactName } from './prompts'

// Live coverage while the clinician dictates: which elements an auditor expects
// the dictation has covered so far. Each item is one yes/no question for the
// model. Attested defaults (safety, mental status, telehealth) are not
// asked about unless the clinician turned them off or the risk scan did.

export interface CoachItem {
  id: string
  /** Short label for the checklist. */
  label: string
  /** The predicate the model answers about the dictation. */
  question: string
}

/** A covered item is released only after this many "not covered" answers in a row, so one low-effort "no" doesn't make the checklist flicker. */
export const RELEASE_AFTER = 2

export interface CoverageState {
  covered: Record<string, boolean>
  /** "Not covered" answers in a row for items that are currently covered. */
  misses: Record<string, number>
}

const item = (id: string, label: string, question: string): CoachItem => ({ id, label, question: `Does the dictation so far ${question}` })

const RISK_ITEMS = [
  item('risk-level', 'Risk level', 'state the clinician’s assessed level of risk (e.g. low, moderate, high) for the risk it mentions?'),
  item('risk-plan', 'Safety plan or actions', 'say what was done about the risk it mentions, such as safety planning, means restriction, consultation, notification or referral?')
]

/** `dictation` is what has been said so far, including live text not yet in the note. */
export function coachItems(note: Note, client: Client, dictation = note.dictation): CoachItem[] {
  const items: CoachItem[] = []
  const risky = scanRisk(dictation).length > 0

  if (note.type === 'progress') {
    items.push(item('symptoms', 'Symptoms and functioning', 'describe the client’s current symptoms or how they are affecting daily life (work, school, relationships, self-care)?'))
    items.push(item('interventions', 'Interventions used', 'name or describe a specific therapeutic intervention or technique the clinician used this session (beyond general support or conversation)?'))
    items.push(item('response', 'Client response', 'describe how the client responded to the work done in session (engagement, insight, skill use, reaction)?'))
    if (client.plan?.goals.length) items.push(item('goals', 'Progress on a goal', 'describe progress, setbacks or lack of change on at least one of the treatment goals listed?'))
    items.push(item('next', 'Plan or homework', 'say what comes next: homework, the focus of the next session, or a change in treatment?'))
  } else if (note.type === 'intake') {
    items.push(item('presenting', 'Why they’re seeking help', 'state the presenting problem or why the client is seeking treatment now?'))
    items.push(item('hpi', 'Symptom history', 'describe the onset, duration, frequency or severity of the client’s symptoms?'))
    items.push(item('impact', 'Functional impact', 'describe how the symptoms affect the client’s functioning (work, school, relationships, self-care)?'))
    items.push(item('history', 'Treatment history', 'mention prior mental health treatment, hospitalizations or psychiatric medications, or that there were none?'))
    items.push(item('substance', 'Substance use', 'mention the client’s alcohol or drug use, or that there is none?'))
    items.push(item('impression', 'Your impression', 'give the clinician’s diagnostic impression or clinical formulation?'))
    items.push(item('plan', 'Treatment plan', 'state recommendations or a plan for treatment (modality, frequency or goals)?'))
  } else {
    items.push(item('reason', 'Why treatment is ending', 'state the reason treatment is ending (goals met, client choice, referral, lost to follow-up, etc.)?'))
    items.push(item('course', 'Progress on goals', 'describe how the client progressed over treatment or the status of their goals?'))
    items.push(item('status', 'Status at discharge', 'describe the client’s current symptoms or functioning at the end of treatment?'))
    items.push(item('aftercare', 'Aftercare', 'give recommendations, referrals or aftercare for after discharge?'))
  }

  if (risky) items.push(...RISK_ITEMS)
  else if (!note.attest.noSafetyConcerns) items.push(item('risk', 'Risk assessment', 'describe the clinician’s assessment of the client’s risk to self or others?'))
  if (!note.attest.mseUnremarkable) items.push(item('mse', 'Mental status', 'describe the clinician’s observations of the client’s mood, affect, appearance, behavior or thought process?'))
  return items
}

/** The evidence sent with the questions. Names are removed, as for every other request. */
export function coachInput(dictation: string, client: Client, note: Note): string {
  const goals = note.type === 'progress' ? (client.plan?.goals ?? []) : []
  const plan = goals.length ? `\n\nTreatment goals on the plan:\n${goals.map((g, i) => `Goal ${i + 1}: ${g.goal}`).join('\n')}` : ''
  return redactName(`A licensed psychotherapist is dictating a ${note.type === 'termination' ? 'discharge summary' : `${note.type} note`} summary aloud. The dictation may be partial, informal and out of order.${plan}\n\nDictation so far:\n${dictation.trim()}`, client.name)
}

/** Apply a fresh set of answers (1 covered, 0 not) with hysteresis. Items the reply doesn't mention keep their state. */
export function nextCoverage(prev: CoverageState, answers: Record<string, number>): CoverageState {
  const covered = { ...prev.covered }
  const misses = { ...prev.misses }
  for (const [id, a] of Object.entries(answers)) {
    if (a >= 0.5) {
      covered[id] = true
      delete misses[id]
    } else if (covered[id] && (misses[id] ?? 0) + 1 < RELEASE_AFTER) misses[id] = (misses[id] ?? 0) + 1
    else {
      covered[id] = false
      delete misses[id]
    }
  }
  return { covered, misses }
}

/** Demo mode: crude keyword matching stands in for the model. */
const MOCK_PATTERNS: Record<string, RegExp> = {
  symptoms: /anx|panic|depress|mood|sleep|stress|worr|work|school/i,
  interventions: /cbt|restructur|exposure|breath|ground|mindful|thought record|skill|psychoeducation|activation|emdr|dbt|act\b/i,
  response: /engaged|respond|tearful|receptive|insight|able to|struggled/i,
  goals: /goal|progress|improv|decreas|increas|down from|better|worse/i,
  next: /homework|next (session|week)|plan is|continue|practice|will try/i,
  presenting: /seeking|referred|presents?|came in|because/i,
  hpi: /since|started|began|months|years|weeks|daily|every/i,
  impact: /work|school|relationship|sleep|function|daily/i,
  history: /prior|previous|before|therap|medication|hospital|no history/i,
  substance: /alcohol|drink|drug|cannabis|substance|sober/i,
  impression: /impression|diagnos|criteria|consistent with|formulation/i,
  plan: /plan|weekly|recommend|frequency|goal/i,
  reason: /ending|terminat|discharg|goals met|moving|referr/i,
  course: /progress|goal|improv|over (the )?(course|treatment)/i,
  status: /now|currently|at discharge|doing/i,
  aftercare: /recommend|referr|aftercare|follow[- ]?up|resources/i,
  'risk-level': /\b(low|moderate|high|imminent) risk|risk (level|is)/i,
  'risk-plan': /safety plan|988|crisis|means|consult|notif|referr/i,
  risk: /risk|safety|SI\b|suicid/i,
  mse: /affect|mood|appear|groom|oriented|thought process|speech/i
}

export function mockCoverage(items: CoachItem[], dictation: string): Record<string, number> {
  return Object.fromEntries(items.map((i) => [i.id, MOCK_PATTERNS[i.id]?.test(dictation) ? 0.9 : 0.1]))
}

// ---------------------------------------------------------------------------
// The live transcript. Each turn is transcribed on its own, so text is kept per
// item and ordered by when each turn was committed (or first seen, if the
// commit event hasn't arrived yet).
// ---------------------------------------------------------------------------

export type LiveEvent =
  | { type: 'committed'; itemId: string; previousItemId: string | null }
  | { type: 'delta'; itemId: string; text: string }
  | { type: 'completed'; itemId: string; text: string }
  /** The turn couldn't be transcribed. What arrived of it is kept. */
  | { type: 'failed'; itemId: string; message: string }
  /** A commit with nothing in the buffer: no turn will follow it. */
  | { type: 'empty' }
  | { type: 'error'; message: string }
  | { type: 'closed' }

export interface LiveTranscript {
  order: string[]
  text: Record<string, string>
  done: Record<string, boolean>
}

export const emptyLive = (): LiveTranscript => ({ order: [], text: {}, done: {} })

export function applyLive(t: LiveTranscript, e: LiveEvent): LiveTranscript {
  if (e.type === 'committed') {
    const order = t.order.filter((id) => id !== e.itemId)
    const after = e.previousItemId ? order.indexOf(e.previousItemId) : -1
    // No previous item means the first turn. One that's unknown (already dropped) means this one goes last.
    order.splice(!e.previousItemId ? 0 : after >= 0 ? after + 1 : order.length, 0, e.itemId)
    return { ...t, order }
  }
  if (e.type === 'delta' || e.type === 'completed') {
    if (t.done[e.itemId] && e.type === 'delta') return t
    const order = t.order.includes(e.itemId) ? t.order : [...t.order, e.itemId]
    const text = { ...t.text, [e.itemId]: e.type === 'delta' ? (t.text[e.itemId] ?? '') + e.text : e.text }
    return { order, text, done: e.type === 'completed' ? { ...t.done, [e.itemId]: true } : t.done }
  }
  if (e.type === 'failed') {
    const order = t.order.includes(e.itemId) ? t.order : [...t.order, e.itemId]
    return { ...t, order, done: { ...t.done, [e.itemId]: true } }
  }
  return t
}

/**
 * Take the finished turns from the front, in the order they were spoken. A turn
 * still being transcribed holds back the ones after it. `all` takes every turn,
 * finished or not, when the stream is going away.
 */
export function takeDone(t: LiveTranscript, all = false): { texts: string[]; rest: LiveTranscript } {
  const n = all ? t.order.length : t.order.findIndex((id) => !t.done[id])
  const ids = t.order.slice(0, n < 0 ? t.order.length : n)
  const texts = ids.map((id) => t.text[id]?.trim()).filter((s): s is string => !!s)
  return { texts, rest: dropLive(t, ids) }
}

export function liveText(t: LiveTranscript): string {
  return t.order
    .map((id) => t.text[id]?.trim())
    .filter(Boolean)
    .join(' ')
}

/** Drop turns that have been handed on. */
export function dropLive(t: LiveTranscript, ids: string[]): LiveTranscript {
  const gone = new Set(ids)
  const keep = (rec: Record<string, unknown>) => Object.fromEntries(Object.entries(rec).filter(([id]) => !gone.has(id)))
  return { order: t.order.filter((id) => !gone.has(id)), text: keep(t.text) as Record<string, string>, done: keep(t.done) as Record<string, boolean> }
}
