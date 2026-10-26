import type { AiContextResult, AiNoteResult, AiPlanResult, Client, Goal, Note, Settings, TreatmentPlan } from './types'
import { nextReviewDate, todayISO } from './compliance'
import { noteDiagnoses } from './diagnosis'
import { cleanBody } from './format'
import { CONTEXT_VERSION, withFollowUp } from './prompts'

// Pure functions that merge AI output into notes and client records. Kept free
// of React/Electron so they can be unit tested.

type NewId = () => string

export function emptyPlan(now: string): TreatmentPlan {
  return { goals: [], frequency: '', modalities: '', dischargeCriteria: '', reviewDate: null, lastReviewed: null, updatedAt: now }
}

export function newGoal(id: NewId, now: string, g: { problem: string; goal: string; objectives: string[]; interventions: string }): Goal {
  return {
    id: id(),
    problem: g.problem,
    goal: g.goal,
    objectives: g.objectives.map((text) => ({ id: id(), text, status: 'not_started' })),
    interventions: g.interventions,
    status: 'not_started',
    progress: '',
    targetDate: null,
    createdAt: now,
    updatedAt: now
  }
}

/** Attach a fresh AI result to a draft note. Unknown goal IDs from the model are dropped. */
export function applyAiResult(note: Note, result: AiNoteResult, client: Client, now: string): Note {
  const goalIds = new Set(client.plan?.goals.map((g) => g.id) ?? [])
  return {
    ...note,
    sections: result.sections.map((s) => ({ heading: s.heading.trim(), body: cleanBody(s.body) })),
    reviewItems: result.review_items.filter((x) => x.trim()),
    suggestions: {
      goalUpdates: result.goal_updates
        .filter((u) => goalIds.has(u.goal_id))
        .map((u) => ({ goalId: u.goal_id, status: u.status, progress: u.progress, accepted: true })),
      newGoals: result.new_goals.map((g) => ({ ...g, accepted: true })),
      planMeta: result.plan_meta
        ? { frequency: result.plan_meta.frequency, modalities: result.plan_meta.modalities, dischargeCriteria: result.plan_meta.discharge_criteria }
        : null,
      diagnoses: result.diagnoses,
      contextUpdate: result.context_update.trim(),
      // The intake is the diagnostic evaluation, so its diagnoses replace any provisional one entered with the client.
      // They're read from the note text at finalize (noteDiagnoses), so this stays on even when the model's list is empty.
      applyDiagnoses: note.type === 'intake'
    },
    generatedAt: now,
    updatedAt: now
  }
}

/**
 * Apply an amended draft. The clinician's choices in the side panel carry over, and a
 * note reopened after finalizing keeps the suggestions that were already applied.
 */
export function applyAmendResult(note: Note, result: AiNoteResult, client: Client, followUp: string, now: string): Note {
  const amended = applyAiResult(note, result, client, now)
  // The draft may hold the clinician's own edits, so a section the model drops or renames keeps its previous text.
  const key = (h: string) => h.trim().toLowerCase()
  const sections = note.sections.map((s) => amended.sections.find((x) => key(x.heading) === key(s.heading)) ?? s)
  const next = { ...amended, sections, dictation: withFollowUp(note.dictation, followUp) }
  const prior = note.suggestions
  if (!prior || !next.suggestions) return next
  if (note.finalizedAt) return { ...next, suggestions: prior }
  const declined = new Set(prior.goalUpdates.filter((u) => !u.accepted).map((u) => u.goalId))
  const declinedGoals = new Set(prior.newGoals.filter((g) => !g.accepted).map((g) => g.goal))
  return {
    ...next,
    suggestions: {
      ...next.suggestions,
      goalUpdates: next.suggestions.goalUpdates.map((u) => ({ ...u, accepted: !declined.has(u.goalId) })),
      newGoals: next.suggestions.newGoals.map((g) => ({ ...g, accepted: !declinedGoals.has(g.goal) })),
      applyDiagnoses: prior.applyDiagnoses
    }
  }
}

function snapshot(client: Client, now: string, reason: string): Client['planHistory'] {
  if (!client.plan) return client.planHistory
  return [{ savedAt: now, reason, plan: client.plan }, ...client.planHistory].slice(0, 50)
}

/** Apply a finalized note's accepted suggestions to the client record. */
export function finalizeClient(note: Note, client: Client, settings: Settings, id: NewId, now: string): Client {
  const s = note.suggestions
  let next: Client = { ...client, updatedAt: now }
  if (!s) return next

  if (s.contextUpdate) {
    // A note sees only the last three notes, so it can't bring an older context up to date; only a
    // new client's first context, or one already current, counts as written under the current rules.
    const current = client.contextVersion === CONTEXT_VERSION || !client.context.trim()
    next = { ...next, context: s.contextUpdate, contextVersion: current ? CONTEXT_VERSION : client.contextVersion }
  }
  const diagnoses = noteDiagnoses(note)
  if (s.applyDiagnoses && diagnoses.length) next.diagnoses = diagnoses

  const accepted = s.goalUpdates.filter((u) => u.accepted)
  const newGoals = s.newGoals.filter((g) => g.accepted)
  const touchesPlan = accepted.length > 0 || newGoals.length > 0 || !!s.planMeta

  if (touchesPlan) {
    const base = client.plan ?? emptyPlan(now)
    const goals = base.goals.map((g) => {
      const u = accepted.find((x) => x.goalId === g.id)
      return u ? { ...g, status: u.status, progress: u.progress, updatedAt: now } : g
    })
    for (const g of newGoals) goals.push(newGoal(id, now, g))
    const isNewPlan = !client.plan || client.plan.goals.length === 0
    const plan: TreatmentPlan = {
      ...base,
      goals,
      frequency: s.planMeta?.frequency || base.frequency,
      modalities: s.planMeta?.modalities || base.modalities,
      dischargeCriteria: s.planMeta?.dischargeCriteria || base.dischargeCriteria,
      reviewDate: isNewPlan && newGoals.length ? nextReviewDate(note.session.date, settings.planReviewDays) : base.reviewDate,
      lastReviewed: isNewPlan && newGoals.length ? note.session.date : base.lastReviewed,
      updatedAt: now
    }
    next = { ...next, plan, planHistory: snapshot(client, now, `Before ${note.type} note ${note.session.date}`) }
  }

  if (note.type === 'termination') next.status = 'discharged'
  return next
}

/** Replace a client's plan with an AI-drafted plan (onboarding or periodic review). */
export function applyPlanResult(client: Client, result: AiPlanResult, settings: Settings, id: NewId, now: string): Client {
  const existing = new Map((client.plan?.goals ?? []).map((g) => [g.id, g]))
  const goals: Goal[] = result.goals.map((g) => {
    const prior = g.existing_goal_id ? existing.get(g.existing_goal_id) : undefined
    const priorObjectives = new Map((prior?.objectives ?? []).map((o) => [o.text, o]))
    return {
      id: prior?.id ?? id(),
      problem: g.problem,
      goal: g.goal,
      objectives: g.objectives.map((text) => priorObjectives.get(text) ?? { id: id(), text, status: 'not_started' as const }),
      interventions: g.interventions,
      status: g.status,
      progress: g.progress,
      targetDate: prior?.targetDate ?? null,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now
    }
  })
  const today = todayISO()
  return {
    ...client,
    diagnoses: result.diagnoses.length ? result.diagnoses : client.diagnoses,
    ...(result.context_update.trim() ? { context: result.context_update.trim(), contextVersion: CONTEXT_VERSION } : {}),
    plan: {
      goals,
      frequency: result.frequency,
      modalities: result.modalities,
      dischargeCriteria: result.discharge_criteria,
      reviewDate: nextReviewDate(today, settings.planReviewDays),
      lastReviewed: today,
      updatedAt: now
    },
    planHistory: snapshot(client, now, 'Before AI plan update'),
    updatedAt: now
  }
}

/** A context written under older rules (or imported) with finalized notes it may not reflect gets rebuilt once from the full record. */
export function needsContextRebuild(client: Client, notes: Note[]): boolean {
  return (client.contextVersion ?? 0) < CONTEXT_VERSION && notes.some((n) => n.clientId === client.id && n.status === 'final')
}

export function applyContextRebuild(client: Client, result: AiContextResult, now: string): Client {
  const context = result.context_update.trim()
  // An empty reply leaves the client as it was, so the rebuild is tried again.
  return context ? { ...client, context, contextVersion: CONTEXT_VERSION, updatedAt: now } : client
}
