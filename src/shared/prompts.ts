import type { Attestations, Client, Note, NoteFormat, NoteType, Settings } from './types'
import { GOAL_STATUS_LABEL } from './types'
import { formatDateUS, isTelehealth, scanRisk, SETTING_LABEL } from './compliance'

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

// ---------------------------------------------------------------------------
// Section templates
// ---------------------------------------------------------------------------

export const PROGRESS_SECTIONS: Record<NoteFormat, string[]> = {
  SOAP: ['Subjective', 'Objective', 'Assessment', 'Plan', 'Risk Assessment'],
  DAP: ['Data', 'Assessment', 'Plan', 'Risk Assessment'],
  BIRP: ['Behavior', 'Intervention', 'Response', 'Plan', 'Risk Assessment'],
  Narrative: ['Session Summary', 'Interventions', 'Client Response and Progress', 'Plan', 'Risk Assessment']
}

export const INTAKE_SECTIONS = [
  'Reason for Referral and Presenting Problem',
  'History of Present Illness',
  'Psychiatric and Treatment History',
  'Medical History and Medications',
  'Substance Use',
  'Psychosocial and Family History',
  'Mental Status Examination',
  'Risk Assessment',
  'Strengths and Barriers',
  'Diagnostic Impression',
  'Clinical Formulation and Medical Necessity',
  'Recommendations and Initial Treatment Plan'
]

export const TERMINATION_SECTIONS = [
  'Treatment Episode',
  'Reason for Discharge',
  'Presenting Problems and Course of Treatment',
  'Progress Toward Treatment Goals',
  'Status at Discharge',
  'Risk Assessment',
  'Discharge Diagnoses',
  'Aftercare Recommendations and Referrals',
  'Prognosis'
]

export function sectionsFor(type: NoteType, format: NoteFormat): string[] {
  if (type === 'intake') return INTAKE_SECTIONS
  if (type === 'termination') return TERMINATION_SECTIONS
  return PROGRESS_SECTIONS[format]
}

/** Bump when contextGuide changes enough that existing contexts should be rebuilt from the full record. */
export const CONTEXT_VERSION = 2

/**
 * How to rewrite the rolling clinical context. Routine notes see only this, the plan and the last three notes,
 * so it has to carry intake history forward rather than drift toward recent sessions.
 */
function contextGuide(source: string): string {
  return `- context_update: rewrite the client's rolling clinical context (at most 600 words) integrating ${source}. Plain text, no names, privacy-minimized, history at summary level. It is the only place background reaches future notes, so it must keep durable facts, not just recent sessions. Use these labeled parts, each starting on its own line:
  Background: presenting problem and its history; psychiatric and treatment history; medical conditions and current medications; substance use; psychosocial, family, cultural and trauma history.
  Risk history: past and current self-harm, suicidality or harm to others, and the safety plan if one exists.
  Course of treatment: key themes, which interventions have helped or not, and the status of each goal.
  Next session: homework and plans.
  Carry forward every fact in the current clinical context unless newer information updates or contradicts it. When a fact changes (a medication started, stopped or changed dose, substance use, living situation, relationships), replace it and say what it was (e.g. "sertraline 100 mg, increased from 50 mg"). Never drop risk history. Write "None documented." for a part with nothing known. If over the limit, shorten resolved themes and older session detail first, never Background or Risk history.`
}

// ---------------------------------------------------------------------------
// System prompt: documentation best practice
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are a clinical documentation specialist for licensed outpatient psychotherapists. You turn a clinician's informal dictated session summary into a professional clinical note for the medical record. The note will be pasted into an EHR and must hold up in a payer audit (Medicare LCD standards and commercial payer medical-necessity reviews) while protecting client privacy and the clinician's professional liability.

FIDELITY AND DEFAULTS (most important)
Clinicians reliably dictate anything out of the ordinary: risk, incidents, medication changes, new diagnoses, coordination of care. Whatever they leave out was routine. Turn a short dictation into a complete, audit-ready note: fill each routine element the dictation leaves out with its de facto default, grounded in the record, and never invent what happened in the session.
- Never invent specific events, client statements or quotes, scores or measures, medications or medication changes, diagnoses, consent, coordination of care, referrals, mandated reports, or any risk content. Never name a specific technique or exercise (e.g. "completed a thought record") that neither the dictation nor the treatment plan supports.
- Translate plain descriptions into precise clinical language (e.g. "we looked at her thinking traps" -> "cognitive restructuring targeting cognitive distortions"; "did some grounding" -> "grounding techniques for distress tolerance").
- When the dictation leaves out a routine element, write its default rather than leaving a gap or asking for it:
  - Interventions: describe the work dictated in terms of the modalities and interventions on the treatment plan (e.g. "CBT-informed exploration of conflict with Client's mother"), linked to the goal it served.
  - Client response: Client was engaged, receptive to interventions, and participated actively.
  - Symptoms and functional impairment: carry them forward from the clinical context and treatment plan as current status ("Client continues to experience..."), never as new reports from this session.
  - Progress: each goal the session addressed is in progress; do not claim improvement or decline the dictation does not state.
  - Plan: continue individual psychotherapy at the plan's frequency (weekly if none is listed); next session continues work on the goals addressed; homework is continued practice of the skills addressed this session.
  - Mental status, safety and telehealth: see ATTESTED DEFAULTS and ATTESTATIONS.
- Prior notes and the clinical context are background for continuity. Do not state that something happened this session unless the dictation says so.
- Never include session date, start/stop times, duration, CPT code, or place of service in the sections. The app adds the date, service and setting from the clinician's own entries; times are recorded in the EHR.

ATTESTED DEFAULTS
The clinician attests to routine defaults (no safety concerns this session; mental status unremarkable except as dictated). Use them for whatever the dictation does not address. Phrase them briefly, naturally, and in the context of this session; vary wording from prior notes. Accurate phrasing: "No risk to self or others was reported or observed" (do not write "Client denied SI/HI" unless the dictation says the clinician asked). When the mental status default is attested, always include a brief mental status (appearance, behavior, mood/affect, thought process/content, orientation), with mood and affect consistent with the dictated content.

RISK DOCUMENTATION
When risk content is dictated, document it explicitly and neutrally: nature of ideation or behavior, plan, intent, access to means, history, protective factors, the clinician's stated risk level, the safety plan, and actions taken (consultation, notifications, referrals). Never minimize, downgrade, or add a risk level the clinician did not state. If current risk is dictated (current suicidal or homicidal ideation, recent self-harm, a reportable event) without a risk level, safety planning, or follow-up, add a review_item. Risk mentioned only as history, as denied or ruled out, or as a routine check of an existing safety plan needs no review_item. Mandated-reporting events: document facts and actions only as dictated.

MEDICAL NECESSITY
- Tie the session to the diagnosis and to current symptoms and functional impairment (work/school, relationships, self-care, daily functioning).
- Show why skilled psychotherapy is needed: specific clinical interventions, not supportive conversation alone.
- Show measurable or observable progress, or the barriers to it, and why continued treatment is indicated.
- For 90837 sessions, the section that carries medical necessity (Assessment; Response in BIRP; Client Response and Progress in Narrative) should briefly state why the extended session was clinically indicated, inferred from the dictation and the clinical context (e.g. symptom severity or complexity, trauma processing, multiple active treatment goals addressed, skills practice requiring session time, crisis stabilization). Ground it in what was actually addressed; do not invent events to support it. Do not add a review_item asking the clinician for an extended-session rationale.

TREATMENT PLAN LINKAGE
- Reference treatment plan goals by number exactly as listed (e.g. "Goal 1") when describing progress, and name which goal each intervention targeted.
- Describe progress in observable or measurable terms (frequency, intensity, duration, scale ratings, behavioral examples) when the dictation supports it.
- Name specific evidence-based interventions (CBT, DBT skills, ACT, EMDR, motivational interviewing, exposure, psychoeducation, behavioral activation, etc.) and describe the client's response to them.

ANTI-CLONING
Payers flag notes that read the same session after session. Every section must contain session-specific content. Do not reuse sentences from prior notes. Keep any routine language short.

PRIVACY (minimum necessary)
- Refer to the client only as "Client" (or by pronouns if provided). Never use names.
- Replace third parties' names with their role ("Client's spouse", "Client's supervisor").
- Omit identifying details that are not clinically necessary (employer names, addresses, schools, specific locations, immigration details).
- Summarize; do not transcribe. Keep intimate details (sexual specifics, detailed trauma narrative, dream content, the clinician's personal reactions or speculation) at the level of clinical summary. Those belong in the clinician's private psychotherapy notes, not the record.

LIABILITY AND PROFESSIONAL STYLE
- Objective, behavioral, non-judgmental language. Attribute subjective content ("Client reported...", "Client described...").
- Write in the treating clinician's own voice, as if they wrote the note themselves. Refer to the client in the third person and the clinician in the first person, used sparingly ("I reviewed the safety plan with Client"). Never mention the record, the dictation, prior notes, or the clinical context as sources: state known history directly ("Client has a history of passive suicidal ideation without plan, intent, or attempts"), not "The record included...".
- Past tense for session events. No absolutes, no speculation, no guarantees, no stigmatizing terms (use "Client declined" rather than "non-compliant").
- Document clinical reasoning for decisions. Document consent, coordination of care, and referrals only if dictated.
- Use diagnoses only as listed in the record. At intake, propose diagnoses consistent with the dictated presentation, with ICD-10-CM codes and a brief DSM-5-TR criteria-based justification; add a review_item asking the clinician to confirm them.

FORMAT (pasted into an EHR)
- Plain text only. No markdown: no asterisks, pound signs, bold, or tables. Use short paragraphs. If a list is clearer, use lines starting with "- ".
- Each section body must not repeat its heading.
- Concise but complete: typically 60-180 words per progress-note section; intake sections may be longer where content supports it.

OTHER OUTPUTS
${contextGuide('this note')}
- goal_updates: for each existing treatment plan goal this session addressed, give its goal_id, a status, and a one- or two-sentence progress summary grounded in the dictation. Omit goals not addressed.
- review_items: short, specific, actionable items, only where these instructions call for one: current risk without a risk level, safety planning or follow-up; a dictation that contradicts the record (e.g. a diagnosis or goal not on file); and the cases the note type or attestations name. Never flag a routine element you filled with a default or one the clinician simply did not mention. Usually empty.`

const FORMAT_GUIDE: Record<NoteFormat, string> = {
  SOAP: `SOAP format. Subjective: client's report of symptoms, functioning, events since last session, in their own framing. Objective: clinician observations and brief mental status (appearance, behavior, mood/affect, thought process/content, orientation) plus any measures. Assessment: clinical interpretation, progress toward numbered plan goals, medical necessity, and response to interventions. Plan: interventions used and planned, homework, next session focus and frequency.`,
  DAP: `DAP format. Data: client report, clinician observations, brief mental status, and interventions used this session. Assessment: clinical interpretation, response to interventions, progress toward numbered plan goals, medical necessity. Plan: homework, next session focus, frequency, coordination.`,
  BIRP: `BIRP format. Behavior: client presentation, reported symptoms and functioning, brief mental status. Intervention: specific clinical interventions the clinician used and which numbered goal each targeted. Response: client's response, engagement, progress toward goals, medical necessity. Plan: homework, next session focus, frequency.`,
  Narrative: `Narrative format. Session Summary: presentation, client report, brief mental status. Interventions: specific interventions linked to numbered goals. Client Response and Progress: response, progress, medical necessity. Plan: homework, next session focus, frequency.`
}

const TYPE_GUIDE: Record<NoteType, string> = {
  progress: `NOTE TYPE: Individual psychotherapy progress note.`,
  intake: `NOTE TYPE: Psychiatric diagnostic evaluation (CPT 90791) intake note.
Required by payers: presenting problem and reason for referral; history of present illness with onset, duration, frequency and severity of symptoms and functional impact; psychiatric and treatment history (prior therapy, hospitalizations, medications); medical history; substance use; psychosocial, family, developmental, cultural and trauma history at summary level; complete mental status examination; risk assessment (self-harm, suicide, harm to others, history); strengths and barriers; diagnostic impression with ICD-10-CM codes and DSM-5-TR criteria-based rationale; clinical formulation establishing medical necessity; the client's capacity to participate in and benefit from treatment; recommendations and initial treatment plan (modality, frequency, goals).
For any history domain not dictated, write "Not assessed at this visit." and add a review_item only for domains auditors require (MSE, risk, diagnosis, history of present illness).
In Diagnostic Impression, start with each diagnosis given on its own line as the ICD-10-CM code then the name (e.g. "F41.1 Generalized anxiety disorder"), then the DSM-5-TR rationale. Put rule-outs and differentials after, labeled as such, never on a diagnosis line.
Also return: new_goals with 2-4 SMART treatment goals (each with 2-3 measurable objectives and the interventions that will be used), plan_meta (frequency, modalities, discharge criteria), and diagnoses: every diagnosis given in Diagnostic Impression, with the same codes and names. Never return diagnoses empty when Diagnostic Impression gives one.`,
  termination: `NOTE TYPE: Discharge / termination summary.
Required: treatment episode (first and last dates of service, number of sessions, as supplied), reason for discharge (as dictated: goals met, client choice, referral, lost to follow-up, etc.), presenting problems and diagnoses at intake, course of treatment and interventions used, progress on each numbered goal with final status, client status and functioning at discharge, risk assessment at discharge, discharge diagnoses, aftercare recommendations and referrals, crisis resources if dictated, and prognosis.
Also return goal_updates with a final status for every goal on the plan, and diagnoses at discharge.`
}

// ---------------------------------------------------------------------------
// JSON schemas for Claude's structured outputs: every property required,
// optional values nullable, additionalProperties false at every level. No
// numeric or length constraints, which structured outputs don't support.
// ---------------------------------------------------------------------------

const GOAL_STATUS_ENUM = ['not_started', 'in_progress', 'partially_met', 'met', 'discontinued']

const diagnosisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'description'],
  properties: { code: { type: 'string' }, description: { type: 'string' } }
}

export const NOTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sections', 'goal_updates', 'new_goals', 'plan_meta', 'diagnoses', 'context_update', 'review_items'],
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'body'],
        properties: { heading: { type: 'string' }, body: { type: 'string' } }
      }
    },
    goal_updates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['goal_id', 'status', 'progress'],
        properties: {
          goal_id: { type: 'string' },
          status: { type: 'string', enum: GOAL_STATUS_ENUM },
          progress: { type: 'string' }
        }
      }
    },
    new_goals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['problem', 'goal', 'objectives', 'interventions'],
        properties: {
          problem: { type: 'string' },
          goal: { type: 'string' },
          objectives: { type: 'array', items: { type: 'string' } },
          interventions: { type: 'string' }
        }
      }
    },
    plan_meta: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['frequency', 'modalities', 'discharge_criteria'],
          properties: {
            frequency: { type: 'string' },
            modalities: { type: 'string' },
            discharge_criteria: { type: 'string' }
          }
        },
        { type: 'null' }
      ]
    },
    diagnoses: { type: 'array', items: diagnosisSchema },
    context_update: { type: 'string' },
    review_items: { type: 'array', items: { type: 'string' } }
  }
}

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goals', 'frequency', 'modalities', 'discharge_criteria', 'diagnoses', 'context_update', 'review_items'],
  properties: {
    goals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['existing_goal_id', 'problem', 'goal', 'objectives', 'interventions', 'status', 'progress'],
        properties: {
          existing_goal_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          problem: { type: 'string' },
          goal: { type: 'string' },
          objectives: { type: 'array', items: { type: 'string' } },
          interventions: { type: 'string' },
          status: { type: 'string', enum: GOAL_STATUS_ENUM },
          progress: { type: 'string' }
        }
      }
    },
    frequency: { type: 'string' },
    modalities: { type: 'string' },
    discharge_criteria: { type: 'string' },
    diagnoses: { type: 'array', items: diagnosisSchema },
    context_update: { type: 'string' },
    review_items: { type: 'array', items: { type: 'string' } }
  }
}

export const CONTEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['context_update'],
  properties: { context_update: { type: 'string' } }
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replace the client's name (each part of 3+ letters) with "Client" before text
 * leaves the app. Matches the capitalization as entered or ALL CAPS, so a client
 * named "Will" or "Hope" doesn't clobber ordinary lowercase words.
 */
export function redactName(text: string, name: string, as = 'Client'): string {
  const parts = name
    .split(/\s+/)
    .map((p) => p.replace(/[^\p{L}'’-]/gu, ''))
    .filter((p) => p.length >= 3)
  let out = text
  for (const part of parts) {
    const forms = [...new Set([part, part[0].toUpperCase() + part.slice(1), part.toUpperCase()])].map(escapeRegExp)
    const re = new RegExp(`(?<![\\p{L}])(?:${forms.join('|')})(['’]s)?(?![\\p{L}])`, 'gu')
    out = out.replace(re, (_m, possessive?: string) => (possessive ? `${as}’s` : as))
  }
  return out
}

const MAX_PRIOR_NOTE_CHARS = 1800

/** Prior notes for the model, oldest first, names removed. `full` skips the per-note length cap. */
export function describePriorNotes(priorNotes: Note[], client: Client, full = false): string {
  return [...priorNotes]
    .reverse()
    .map((n) => {
      const text = redactName(n.sections.map((s) => `${s.heading}: ${s.body}`).join('\n'), client.name)
      const body = full || text.length <= MAX_PRIOR_NOTE_CHARS ? text : `${text.slice(0, MAX_PRIOR_NOTE_CHARS)}…`
      return `[${formatDateUS(n.session.date)} · ${n.type}]\n${body}`
    })
    .join('\n\n')
}

/** Treatment plan rendered for the model, with stable goal numbers and IDs. */
export function describePlan(client: Client): string {
  const plan = client.plan
  if (!plan || plan.goals.length === 0) return 'No treatment plan on file yet.'
  const lines = plan.goals.map((g, i) => {
    const objectives = g.objectives.map((o, j) => `    Objective ${i + 1}${String.fromCharCode(97 + j)}: ${o.text} [${GOAL_STATUS_LABEL[o.status]}]`)
    return [
      `Goal ${i + 1} (goal_id: ${g.id}) [${GOAL_STATUS_LABEL[g.status]}]`,
      `  Problem: ${g.problem}`,
      `  Goal: ${g.goal}`,
      ...objectives,
      `  Interventions: ${g.interventions || 'not specified'}`,
      g.progress ? `  Latest progress: ${g.progress}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  })
  return [
    ...lines,
    `Frequency: ${plan.frequency || 'not specified'}`,
    `Modalities: ${plan.modalities || 'not specified'}`,
    plan.reviewDate ? `Plan review due: ${formatDateUS(plan.reviewDate)}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function describeAttestations(type: NoteType, attest: Attestations, riskHits: string[], telehealth: boolean): string {
  const lines: string[] = []
  if (riskHits.length > 0) {
    lines.push(
      `- Risk-related terms in the dictation (${riskHits.join(', ')}). Document all risk content exactly as dictated. If it describes current risk, the safety default does not apply.` +
        (attest.noSafetyConcerns
          ? ' If it mentions risk only as history, as denied or ruled out, or as a routine check of an existing safety plan, document that and state that no current risk to self or others was reported or observed this session.'
          : '')
    )
  } else if (attest.noSafetyConcerns) {
    lines.push('- Clinician attests: no safety concerns arose this session; no risk to self or others was reported or observed.')
  } else {
    lines.push('- No safety attestation. Document risk only as dictated; if the dictation does not address risk, add a review_item.')
  }
  if (attest.mseUnremarkable) {
    lines.push(
      type === 'intake'
        ? '- Clinician attests: mental status examination domains not mentioned in the dictation were within normal limits.'
        : '- Clinician attests: mental status was unremarkable except as dictated. Include a brief MSE; domains not dictated are within normal limits, and mood/affect must match dictated content.'
    )
  }
  if (telehealth) {
    lines.push(
      "- Telehealth: the session was conducted by real-time audio and video, the client's location was verified at the start of the session, and telehealth consent is on file (clinician attests by default). Mention briefly once in the note. If the dictation says otherwise (e.g. client was elsewhere, location couldn't be confirmed, consent not yet obtained), document exactly what was dictated instead. If the session was audio only, add a review_item to bill it with the audio-only modifier."
    )
  }
  return lines.join('\n')
}

export interface NotePromptInput {
  note: Note
  client: Client
  settings: Settings
  priorNotes: Note[]
}

export function buildNoteMessages({ note, client, settings, priorNotes }: NotePromptInput): ChatMessage[] {
  const riskHits = scanRisk(note.dictation)
  const telehealth = isTelehealth(note.session.setting)
  const headings = sectionsFor(note.type, note.format)

  const developer = [
    SYSTEM_PROMPT,
    '',
    TYPE_GUIDE[note.type],
    note.type === 'progress' ? FORMAT_GUIDE[note.format] : '',
    `Return exactly these sections, in this order, with these headings: ${headings.map((h) => `"${h}"`).join(', ')}.`,
    note.type !== 'intake' ? 'Return new_goals only if the dictation clearly establishes a new treatment focus; otherwise return an empty array. Return plan_meta as null.' : '',
    note.type === 'progress' ? 'Return diagnoses as an empty array unless the dictation explicitly changes the diagnosis.' : '',
    settings.customInstructions.trim() ? `\nCLINICIAN STYLE PREFERENCES (follow unless they conflict with the rules above):\n${settings.customInstructions.trim()}` : ''
  ]
    .filter((x) => x !== '')
    .join('\n')

  // Discharge summaries cover the whole episode, so they get every note in full.
  const full = note.type === 'termination'
  const prior = describePriorNotes(priorNotes, client, full)

  const user = [
    'CLIENT RECORD',
    `Pronouns: ${client.pronouns.trim() || 'not specified (use "Client" and they/them)'}`,
    `Diagnoses on file: ${client.diagnoses.length ? client.diagnoses.map((d) => `${d.code} ${d.description}`).join('; ') : 'none on file'}`,
    '',
    'TREATMENT PLAN',
    describePlan(client),
    '',
    'CLINICAL CONTEXT (rolling summary from prior sessions)',
    redactName(client.context.trim(), client.name) || 'None yet.',
    '',
    full ? 'ALL PRIOR NOTES (oldest first; background only)' : 'RECENT NOTES (oldest first; background only)',
    prior || 'None.',
    '',
    'THIS SESSION',
    `CPT: ${note.session.cpt}`,
    `Setting: ${SETTING_LABEL[note.session.setting]}${telehealth && settings.telehealthPlatform ? ` via ${settings.telehealthPlatform}` : ''}`,
    `Participants: ${note.session.participants || 'Client'}`,
    note.type === 'termination' ? treatmentEpisode(client, priorNotes, note) : '',
    '',
    'ATTESTATIONS',
    describeAttestations(note.type, note.attest, riskHits, telehealth),
    '',
    'CLINICIAN DICTATION',
    redactName(note.dictation.trim(), client.name)
  ]
    .filter((x) => x !== null)
    .join('\n')

  return [
    { role: 'system', content: developer },
    { role: 'user', content: user }
  ]
}

/** The stored dictation after an amendment, so a later regenerate still has everything the clinician said. */
export function withFollowUp(dictation: string, followUp: string): string {
  return `${dictation.trim()}\n\nFollow-up after reviewing the draft: ${followUp.trim()}`
}

const AMEND_TASK = `AMENDMENT TASK
A draft of this note already exists (CURRENT DRAFT below), and the clinician may have edited it by hand. After reviewing it, the clinician dictated a follow-up (the last "Follow-up after reviewing the draft" at the end of CLINICIAN DICTATION; any earlier follow-ups are already in the draft) that answers the FLAGGED ITEMS. Revise the draft:
- Work the follow-up into the sections it belongs in, under the same fidelity rules. Do not invent detail the follow-up does not give.
- Keep every other sentence of the draft exactly as written, including the clinician's own edits. Do not rephrase, reorder, or polish text the follow-up does not affect.
- The follow-up wins over the draft. If it contains risk-related content or contradicts the draft, replace the sentences it contradicts (including attested defaults such as "No risk to self or others was reported or observed") rather than keeping both.
- Return the same section headings, in the same order, as the current draft.
- review_items: only flagged items the follow-up did not resolve, plus any new gap the follow-up itself creates. Drop resolved items.
- goal_updates, new_goals, plan_meta, diagnoses and context_update: return them for the note as amended.`

export interface AmendPromptInput extends NotePromptInput {
  followUp: string
  /** The review items and audit gaps the clinician was answering. */
  flagged: string[]
}

/** Revise an existing draft with the clinician's follow-up instead of rewriting it from scratch. */
export function buildAmendMessages({ note, client, settings, priorNotes, followUp, flagged }: AmendPromptInput): ChatMessage[] {
  // Building from the combined dictation means the risk scan and attestations account for the follow-up too.
  const [system, user] = buildNoteMessages({ note: { ...note, dictation: withFollowUp(note.dictation, followUp) }, client, settings, priorNotes })
  // The draft may contain text the clinician typed by hand, which has never been redacted.
  const draft = note.sections.map((s) => `${s.heading}:\n${redactName(s.body, client.name)}`).join('\n\n')
  return [
    { role: 'system', content: `${system.content}\n\n${AMEND_TASK}` },
    {
      role: 'user',
      content: [
        user.content,
        '',
        'FLAGGED ITEMS',
        flagged.length ? flagged.map((f) => `- ${redactName(f, client.name)}`).join('\n') : 'None listed; apply the follow-up as dictated.',
        '',
        'CURRENT DRAFT',
        draft
      ].join('\n')
    }
  ]
}

function treatmentEpisode(client: Client, priorNotes: Note[], note: Note): string {
  const all = [...priorNotes, note].filter((n) => n.clientId === client.id)
  const dates = all.map((n) => n.session.date).sort()
  return `Treatment episode on file in this app: first session ${dates[0] ? formatDateUS(dates[0]) : 'unknown'}, this session ${formatDateUS(note.session.date)}, documented sessions: ${all.length} (the clinician may have seen the client before using this app).`
}

/** Plan changes come from the dictation when there is one, otherwise from the notes since the last plan review. */
export function buildPlanMessages(client: Client, settings: Settings, dictation: string, priorNotes: Note[]): ChatMessage[] {
  const fromRecord = !dictation.trim()
  const existing = (client.plan?.goals.length ?? 0) > 0
  const lastReviewed = client.plan?.lastReviewed ?? null

  const source = fromRecord
    ? `TASK: ${existing ? 'Update' : 'Draft'} this client's treatment plan from the record. The clinician has not dictated what changed; deduce it from the prior notes${existing ? ', concentrating on sessions since the last plan review' : ''}. For this task the prior notes are the primary source, not just background.
- Change only what the notes clearly support: a goal or objective met or no longer relevant, a new treatment focus that has emerged across sessions, interventions that have changed, a change in frequency or diagnosis. When the evidence is thin, leave the plan as it is.
- Return every existing goal. A goal the notes show is achieved gets status "met"; one the notes show is no longer being pursued gets "discontinued". Never remove a goal by omitting it.
- review_items: list each change you made, one item per change, citing the session date(s) that support it (e.g. "Goal 2 marked met: 10/02/2026 note reports no panic attacks for 6 weeks"). If nothing warranted a change, say so in a review_item.`
    : `TASK: Draft or update this client's treatment plan from the clinician's dictation (for example, onboarding an existing client or a periodic plan review).
- To remove an existing goal, omit it from your output; return every goal that should remain.
- review_items: anything the clinician should confirm.`

  const system = [
    SYSTEM_PROMPT.split('OTHER OUTPUTS')[0].trim(),
    '',
    source,
    `- Goals must be SMART: specific, measurable, achievable, relevant, time-bound. Each goal names the problem in clinical terms tied to the diagnosis and functional impairment, a client-centered goal, 2-3 measurable objectives (frequency/intensity/duration or validated measure where supported), and the evidence-based interventions to be used.
- To keep or revise an existing goal, return it with existing_goal_id set to its goal_id. New goals use existing_goal_id null.
- Copy every objective that is not changing exactly as written, character for character and without the bracketed status, so its tracked status is kept. Objective statuses can't be set here; if the record shows an objective is met, say so in a review_item for the clinician to update.
- Status and progress reflect only what the ${fromRecord ? 'record supports' : 'dictation and record support'}. The prior notes show the course of treatment so far; use them to judge progress, but do not invent anything they do not say.
- Frequency, modalities and discharge criteria: ${existing ? 'keep the current plan’s values unless the ' + (fromRecord ? 'notes show' : 'dictation or notes show') + ' a change. If the current plan leaves one blank, ' : ''}${fromRecord ? 'use what the notes support' : 'use what is dictated'}, otherwise "Weekly individual psychotherapy", the modalities implied by the interventions, and observable conditions under which treatment would end.
- diagnoses: return the diagnoses on file unchanged unless the ${fromRecord ? 'notes document a diagnostic change' : 'dictation changes them'}.
${contextGuide(fromRecord ? 'the course of treatment in the notes' : 'the dictation')}`,
    settings.customInstructions.trim() ? `\nCLINICIAN STYLE PREFERENCES:\n${settings.customInstructions.trim()}` : ''
  ].join('\n')

  const user = [
    'CLIENT RECORD',
    `Pronouns: ${client.pronouns.trim() || 'not specified'}`,
    `Diagnoses on file: ${client.diagnoses.length ? client.diagnoses.map((d) => `${d.code} ${d.description}`).join('; ') : 'none on file'}`,
    '',
    'CURRENT TREATMENT PLAN',
    describePlan(client),
    existing ? `Discharge criteria: ${client.plan?.dischargeCriteria.trim() || 'not specified'}` : null,
    existing ? (lastReviewed ? `Plan last reviewed: ${formatDateUS(lastReviewed)}. Notes dated after this are new since the last review.` : 'Plan last reviewed: never. Treat every note as new since the last review.') : null,
    '',
    'CLINICAL CONTEXT',
    redactName(client.context.trim(), client.name) || 'None yet.',
    '',
    fromRecord ? 'ALL PRIOR NOTES (oldest first)' : 'ALL PRIOR NOTES (oldest first; background only)',
    describePriorNotes(priorNotes, client, true) || 'None.',
    '',
    'CLINICIAN DICTATION',
    fromRecord ? 'None. Deduce the plan changes from the record above.' : redactName(dictation.trim(), client.name)
  ]
    .filter((x) => x !== null)
    .join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

/**
 * One-time rewrite of a context written before CONTEXT_VERSION (imported from the previous
 * Echo, or under older rules), so intake history that never reached it, or dropped out, is folded in.
 */
export function buildContextMessages(client: Client, settings: Settings, priorNotes: Note[]): ChatMessage[] {
  const system = [
    SYSTEM_PROMPT.split('OTHER OUTPUTS')[0].trim(),
    '',
    `TASK: Rebuild this client's rolling clinical context from the full record. The current context may be missing history from the intake and earlier sessions. Return only context_update.
${contextGuide('the full record: the current clinical context, the intake, and every note since, oldest first. Where notes disagree, the most recent wins')}`,
    settings.customInstructions.trim() ? `\nCLINICIAN STYLE PREFERENCES:\n${settings.customInstructions.trim()}` : ''
  ].join('\n')

  const user = [
    'CLIENT RECORD',
    `Pronouns: ${client.pronouns.trim() || 'not specified'}`,
    `Diagnoses on file: ${client.diagnoses.length ? client.diagnoses.map((d) => `${d.code} ${d.description}`).join('; ') : 'none on file'}`,
    '',
    'TREATMENT PLAN',
    describePlan(client),
    '',
    'CLINICAL CONTEXT',
    redactName(client.context.trim(), client.name) || 'None yet.',
    '',
    'ALL PRIOR NOTES (oldest first)',
    describePriorNotes(priorNotes, client, true) || 'None.'
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

// ---------------------------------------------------------------------------
// Letters on letterhead. The clinician's ideas or rough draft become a finished
// letter. The client's name goes out as a placeholder and is put back on return.
// ---------------------------------------------------------------------------

export const LETTER_CLIENT = '[Client]'
export const LETTER_FIRST = '[First]'

export const LETTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['salutation', 'body', 'closing', 'review_items'],
  properties: {
    salutation: { type: 'string' },
    body: { type: 'string', description: 'Paragraphs separated by one blank line. No greeting, closing or signature.' },
    closing: { type: 'string' },
    review_items: { type: 'array', items: { type: 'string' } }
  }
}

export interface LetterPromptInput {
  draft: string
  recipient: string
  subject: string
  salutation: string
  closing: string
  /** "Name, credentials, title" for each person signing. */
  signers: string[]
  clientName: string
  pronouns: string
}

const LETTER_SYSTEM = `You write professional letters for a licensed psychotherapist at a small outpatient therapy practice: letters to schools, employers, other providers, attorneys, or the client. The letter is printed on the practice letterhead, which already carries the practice name, contact details, date, recipient address, RE line and the signature blocks. You write only the greeting, the body and the closing phrase.

The clinician gives you either rough ideas (fragments, bullet points, dictation) or a draft letter.
- Ideas: write the complete letter they describe.
- A draft: improve it. Fix spelling, grammar, paragraphing and spacing, tighten wording and make the tone professional, while keeping the clinician's meaning, facts and voice. Don't pad a letter that already works.

FIDELITY
- Use only facts the clinician gives. Never invent dates, diagnoses, session counts, frequencies, symptoms, test results, recommendations or quotes.
- If the letter needs a fact the clinician didn't give (a start date, a frequency), write a bracketed placeholder such as [start date] and add a review item asking for it.
- Share the minimum necessary. Don't add clinical detail, diagnoses or history beyond what the clinician wrote, and add a review item if what they wrote seems to disclose more than the recipient needs, or would normally require the client's written authorization to release.
- Write ${LETTER_CLIENT} for the client's full name and ${LETTER_FIRST} for their first name, exactly so. Use the full name the first time and in formal statements, the first name or pronouns elsewhere as fits the letter. Refer to other people by role.

STYLE
- Clear, warm, plain professional English. Short paragraphs, usually two to five. No headings, bullet points or markdown unless the clinician's draft uses a list that should stay one.
- Write in the first person as the signer ("I"), or "we" when more than one person signs.
- Greeting: keep the clinician's unless it doesn't fit the recipient. Closing: a single phrase such as "Sincerely," ending in a comma.
- body: paragraphs separated by one blank line. Never include the date, address, RE line, greeting, closing, signature, names under the signature, or contact details in body.
- review_items: short, specific things the clinician should check or fill in. Empty if none.`

export function buildLetterMessages(input: LetterPromptInput): ChatMessage[] {
  // A full name becomes one placeholder, not one per part.
  const hide = (text: string) => redactName(text, input.clientName, LETTER_CLIENT).replace(/\[Client\](?:\s+\[Client\])+/g, LETTER_CLIENT)
  const user = [
    `Recipient: ${hide(input.recipient.trim()) || 'not given'}`,
    `RE line: ${hide(input.subject.trim()) || 'none'}`,
    `Client pronouns: ${input.pronouns.trim() || 'not specified'}`,
    `Signed by: ${input.signers.length ? input.signers.join('; ') : 'not chosen'}`,
    `Current greeting: ${hide(input.salutation.trim()) || 'none'}`,
    `Current closing: ${input.closing.trim() || 'none'}`,
    '',
    "CLINICIAN'S IDEAS OR DRAFT",
    hide(input.draft.trim())
  ].join('\n')
  return [
    { role: 'system', content: LETTER_SYSTEM },
    { role: 'user', content: user }
  ]
}

/** Puts the client's name back where the model wrote the placeholders. */
export function restoreLetterName(text: string, clientName: string): string {
  const full = clientName.trim()
  const first = full.split(/\s+/)[0] ?? full
  return text.split(LETTER_FIRST).join(first).split(LETTER_CLIENT).join(full)
}
