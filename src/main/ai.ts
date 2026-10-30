import Anthropic from '@anthropic-ai/sdk'
import { coachInput, coachItems, type CoachItem } from '../shared/coach'
import { MODEL_FAILURE } from '../shared/queue'
import { scanRisk } from '../shared/compliance'
import type { AiContextResult, AiLetterResult, AiNoteResult, AiPlanResult, Client, Note, Settings } from '../shared/types'
import { buildAmendMessages, buildContextMessages, buildLetterMessages, buildNoteMessages, buildPlanMessages, CONTEXT_SCHEMA, LETTER_SCHEMA, NOTE_SCHEMA, PLAN_SCHEMA, restoreLetterName, sectionsFor, type ChatMessage, type LetterPromptInput } from '../shared/prompts'

// Claude calls run only in the main process so the API key never reaches the
// renderer, and nothing here logs PHI.
//
// The Anthropic BAA covers only the Messages API (with structured outputs and
// prompt caching), the Models API and token counting, and only through an API
// key from a HIPAA-configured organization. Echo uses nothing else: no betas,
// no Batch or Files API, no server tools.

const API = 'https://api.anthropic.com'

export class AiError extends Error {}

/**
 * Every setting is pinned, so nothing in the environment (ANTHROPIC_BASE_URL,
 * ANTHROPIC_AUTH_TOKEN, an `ant` login profile, ANTHROPIC_LOG=debug) can send
 * PHI to another organization or write it to a log.
 */
function anthropic(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, authToken: null, baseURL: API, logLevel: 'off' })
}

function friendly(err: unknown): Error {
  if (err instanceof AiError) return err
  if (err instanceof Anthropic.AuthenticationError) return new AiError('Anthropic rejected the API key. Check it in Settings.')
  if (err instanceof Anthropic.PermissionDeniedError) return new AiError('This API key isn’t allowed to do that. Check that it belongs to your HIPAA-configured organization.')
  if (err instanceof Anthropic.NotFoundError) return new AiError(`Model not available to this API key: ${detail(err)}`)
  if (err instanceof Anthropic.RateLimitError) return new AiError('Anthropic rate limit reached. Wait a moment and try again.')
  if (err instanceof Anthropic.APIConnectionError) return new AiError('Couldn’t reach Anthropic. Check your internet connection and try again.')
  if (err instanceof Anthropic.APIError) return new AiError(`Anthropic error (${err.status ?? 'no status'}): ${detail(err)}`)
  return err instanceof Error ? err : new AiError(String(err))
}

function detail(err: InstanceType<typeof Anthropic.APIError>): string {
  return (err.error as { error?: { message?: string } } | undefined)?.error?.message ?? err.message
}

export async function listModels(apiKey: string): Promise<string[]> {
  try {
    const ids: string[] = []
    for await (const model of anthropic(apiKey).models.list()) ids.push(model.id)
    return ids.sort()
  } catch (err) {
    throw friendly(err)
  }
}

/** The prompt builders put instructions in a system message; Claude takes them as the top-level system prompt. */
function split(messages: ChatMessage[]): { system: string; user: Anthropic.MessageParam[] } {
  return {
    system: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'),
    user: messages.filter((m) => m.role === 'user').map((m) => ({ role: 'user', content: m.content }))
  }
}

async function structured<T>(apiKey: string, settings: Settings, messages: ChatMessage[], schema: object): Promise<T> {
  const { system, user } = split(messages)
  const effort = settings.reasoningEffort === 'default' ? {} : { effort: settings.reasoningEffort }
  try {
    // Streamed because thinking counts toward max_tokens and long outputs can outlast a plain request's timeout.
    const stream = anthropic(apiKey).messages.stream({
      model: settings.textModel,
      max_tokens: 64000,
      // The instructions are the same for every note of a type, so they're cached across a batch of notes.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: user,
      output_config: { ...effort, format: { type: 'json_schema', schema: schema as Record<string, unknown> } }
    })
    return parseReply<T>(await stream.finalMessage())
  } catch (err) {
    throw friendly(err)
  }
}

/** The parts of a Messages reply that are read. */
export type MessageReply = Pick<Anthropic.Message, 'stop_reason' | 'stop_details' | 'content'>

// Checks run in this order: refused, cut off, empty, then parse. A refusal
// doesn't follow the schema, so it must be caught before JSON.parse.
export function parseReply<T>(body: MessageReply): T {
  if (body.stop_reason === 'refusal') {
    const why = body.stop_details?.explanation || body.stop_details?.category
    throw new AiError(`${MODEL_FAILURE.declined}${why ? ` (${why})` : ''}. Try rewording the dictation, or write this one by hand.`)
  }
  if (body.stop_reason === 'max_tokens' || body.stop_reason === 'model_context_window_exceeded') {
    throw new AiError(`${MODEL_FAILURE.cutOff} Try a shorter dictation or a lower effort setting.`)
  }
  // Thinking blocks come first; the answer is in the text blocks.
  const text = body.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  if (!text) throw new AiError(MODEL_FAILURE.empty)
  return JSON.parse(text) as T
}

export async function generateNote(apiKey: string, settings: Settings, note: Note, client: Client, priorNotes: Note[]): Promise<AiNoteResult> {
  return structured<AiNoteResult>(apiKey, settings, buildNoteMessages({ note, client, settings, priorNotes }), NOTE_SCHEMA)
}

export async function amendNote(apiKey: string, settings: Settings, note: Note, client: Client, priorNotes: Note[], followUp: string, flagged: string[]): Promise<AiNoteResult> {
  return structured<AiNoteResult>(apiKey, settings, buildAmendMessages({ note, client, settings, priorNotes, followUp, flagged }), NOTE_SCHEMA)
}

export async function generatePlan(apiKey: string, settings: Settings, client: Client, dictation: string, priorNotes: Note[]): Promise<AiPlanResult> {
  return structured<AiPlanResult>(apiKey, settings, buildPlanMessages(client, settings, dictation, priorNotes), PLAN_SCHEMA)
}

export async function rebuildContext(apiKey: string, settings: Settings, client: Client, priorNotes: Note[]): Promise<AiContextResult> {
  return structured<AiContextResult>(apiKey, settings, buildContextMessages(client, settings, priorNotes), CONTEXT_SCHEMA)
}

export async function writeLetter(apiKey: string, settings: Settings, input: LetterPromptInput): Promise<AiLetterResult> {
  const result = await structured<AiLetterResult>(apiKey, settings, buildLetterMessages(input), LETTER_SCHEMA)
  const restore = (text: string) => restoreLetterName(text, input.clientName)
  return { salutation: restore(result.salutation), body: restore(result.body), closing: restore(result.closing), review_items: result.review_items.map(restore) }
}

// ---------------------------------------------------------------------------
// Live coverage. One yes/no answer per element the note needs, asked of a fast
// model at low effort every few seconds while the clinician dictates.
// ---------------------------------------------------------------------------

export const COVERAGE_MODEL = 'claude-haiku-5-5'

export async function coverage(apiKey: string, note: Note, client: Client, dictation: string): Promise<Record<string, number>> {
  const items = coachItems(note, client, dictation)
  if (!dictation.trim() || items.length === 0) return {}
  const answers = await askCoverage(apiKey, items, coachInput(dictation, client, note))
  return Object.fromEntries(Object.entries(answers).map(([id, yes]) => [id, yes ? 1 : 0]))
}

async function askCoverage(apiKey: string, items: CoachItem[], input: string): Promise<Record<string, boolean>> {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: items.map((i) => i.id),
    properties: Object.fromEntries(items.map((i) => [i.id, { type: 'boolean', description: i.question }]))
  }
  try {
    const reply = await anthropic(apiKey).messages.create({
      model: COVERAGE_MODEL,
      // Room for brief thinking before a short JSON answer.
      max_tokens: 4096,
      system: 'Answer each question about the dictation with true or false. Answer true only if the dictation itself says it.',
      messages: [{ role: 'user', content: input }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema } }
    })
    return parseReply<Record<string, boolean>>(reply)
  } catch (err) {
    throw friendly(err)
  }
}

// ---------------------------------------------------------------------------
// Mock provider (ECHO_MOCK_AI=1) for demos and testing without an API key.
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function mockTranscribe(): Promise<string> {
  await delay(700)
  return 'Client reported a stressful week at work with two panic episodes, down from four last week. We reviewed the thought record homework and did cognitive restructuring around catastrophic predictions about her performance review. Practiced paced breathing in session. She was engaged and a bit tearful when discussing her mother. Plan is to keep doing thought records and try one exposure, going to the grocery store at a busy time.'
}

export async function mockGenerateNote(note: Note, client: Client): Promise<AiNoteResult> {
  // Long enough to leave the note and start another while it writes, as with a real model.
  await delay(5000)
  const headings = sectionsFor(note.type, note.format)
  const goal = client.plan?.goals[0]
  const bodies: Record<string, string> = {
    Subjective: 'Client reported a stressful week at work with two panic episodes, a decrease from four the prior week. Client described anticipatory anxiety about an upcoming performance review and became tearful when discussing their relationship with their mother.',
    Objective: 'Client was alert, oriented, and appropriately groomed. Speech was normal in rate and volume. Mood was described as "stressed"; affect was anxious and congruent, briefly tearful. Thought process was linear and goal-directed. Client was engaged throughout the session.',
    Assessment: `Client continues to meet criteria for the diagnosis on file, with panic symptoms interfering with occupational functioning. Client demonstrated progress toward Goal 1, with panic frequency reduced by half. Client was able to identify catastrophic predictions and generate balanced alternatives with prompting. Continued weekly psychotherapy remains medically necessary to consolidate cognitive skills and begin graded exposure.`,
    Plan: 'Interventions this session included review of thought-record homework, cognitive restructuring targeting catastrophic predictions (Goal 1), and paced-breathing practice. Client will continue daily thought records and complete one in-vivo exposure (grocery store at a busy time) before next session. Continue weekly individual psychotherapy.',
    'Risk Assessment': 'No risk to self or others was reported or observed this session. No safety concerns were identified.'
  }
  return {
    sections: headings.map((h) => ({ heading: h, body: bodies[h] ?? `[Demo text for ${h}. Add your Anthropic API key in Settings to generate real notes.]` })),
    goal_updates: goal ? [{ goal_id: goal.id, status: 'in_progress', progress: 'Panic episodes decreased from 4 to 2 per week; client applying cognitive restructuring with prompting.' }] : [],
    new_goals:
      note.type === 'intake'
        ? [
            {
              problem: 'Panic attacks and anticipatory anxiety impairing occupational functioning',
              goal: 'Client will reduce panic attacks and return to full participation at work.',
              objectives: ['Reduce panic attacks from 4/week to 1 or fewer per week', 'Use a coping skill in 80% of anxious episodes as reported in a weekly log'],
              interventions: 'CBT for panic: psychoeducation, cognitive restructuring, interoceptive and in-vivo exposure, paced breathing'
            }
          ]
        : [],
    plan_meta: note.type === 'intake' ? { frequency: 'Weekly individual psychotherapy, 53+ minutes', modalities: 'Cognitive behavioral therapy', discharge_criteria: 'Panic attacks 1 or fewer per month for 8 weeks and full return to work duties.' } : null,
    diagnoses: note.type === 'intake' ? [{ code: 'F41.0', description: 'Panic disorder' }] : [],
    context_update: 'Client presents with panic disorder impacting work. Responds well to CBT; thought records are helping. Panic frequency down from 4/week to 2/week. Relationship with mother is a recurring stressor. Next: first in-vivo exposure (busy grocery store). No risk history.',
    review_items: ['Demo mode: this note was produced by the mock provider, not Claude.']
  }
}

/** Demo amendment: the follow-up lands in the section before the risk assessment, or the risk section if it mentions risk. */
export async function mockAmendNote(note: Note, client: Client, followUp: string): Promise<AiNoteResult> {
  await delay(1200)
  const risky = scanRisk(followUp).length > 0
  const riskIndex = note.sections.findIndex((s) => /risk/i.test(s.heading))
  const target = risky && riskIndex >= 0 ? riskIndex : Math.max(0, (riskIndex >= 0 ? riskIndex : note.sections.length) - 1)
  const addition = `Clinician follow-up: ${followUp.trim()}`
  const s = note.suggestions
  return {
    sections: note.sections.map((x, i) => (i !== target ? x : { ...x, body: risky ? addition : `${x.body.trim()}\n\n${addition}` })),
    goal_updates: (s?.goalUpdates ?? []).map((u) => ({ goal_id: u.goalId, status: u.status, progress: u.progress })),
    new_goals: (s?.newGoals ?? []).map(({ accepted: _, ...g }) => g),
    plan_meta: s?.planMeta ? { frequency: s.planMeta.frequency, modalities: s.planMeta.modalities, discharge_criteria: s.planMeta.dischargeCriteria } : null,
    diagnoses: s?.diagnoses ?? [],
    context_update: s?.contextUpdate || client.context,
    review_items: []
  }
}

export async function mockGeneratePlan(client: Client): Promise<AiPlanResult> {
  await delay(1000)
  return {
    goals: [
      {
        existing_goal_id: client.plan?.goals[0]?.id ?? null,
        problem: 'Depressed mood and withdrawal limiting social and occupational functioning',
        goal: 'Client will improve mood and re-engage in valued activities.',
        objectives: ['Reduce PHQ-9 from 16 to below 10 within 12 weeks', 'Complete 3 scheduled pleasant or valued activities per week'],
        interventions: 'Behavioral activation, cognitive restructuring, activity scheduling',
        status: 'in_progress',
        progress: 'Baseline established; client beginning activity scheduling.'
      }
    ],
    frequency: 'Weekly individual psychotherapy',
    modalities: 'CBT, behavioral activation',
    discharge_criteria: 'PHQ-9 below 10 for 4 consecutive weeks and sustained engagement in valued activities.',
    diagnoses: client.diagnoses,
    context_update: client.context || 'Demo context generated by the mock provider.',
    review_items: ['Demo mode: this plan was produced by the mock provider, not Claude.']
  }
}

export async function mockRebuildContext(client: Client): Promise<AiContextResult> {
  await delay(800)
  return { context_update: client.context || 'Demo context rebuilt by the mock provider.' }
}

export async function mockWriteLetter(input: LetterPromptInput): Promise<AiLetterResult> {
  await delay(900)
  const body = input.draft
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1) + (/[.!?]$/.test(p) ? '' : '.'))
    .join('\n\n')
  return { salutation: input.salutation || 'To whom it may concern,', body, closing: input.closing || 'Sincerely,', review_items: ['Demo mode: this is a tidied copy of your text, not a letter written by Claude.'] }
}
