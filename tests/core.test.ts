import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiNoteResult, Client, Note, Settings } from '../src/shared/types'
import { auditChecks, cptForMinutes, defaultAttestations, defaultSession, scanRisk } from '../src/shared/compliance'
import { buildAmendMessages, buildNoteMessages, buildPlanMessages, NOTE_SCHEMA, PLAN_SCHEMA, PROGRESS_SECTIONS, redactName } from '../src/shared/prompts'
import { cleanBody, noteToHtml, noteToText, planToDocumentHtml } from '../src/shared/format'
import { applyAiResult, applyAmendResult, finalizeClient } from '../src/shared/finalize'
import { buildQueue, isModelFailure, nextModelUp, queueCount, suggestModel } from '../src/shared/queue'
import { COVERAGE_MODEL, coverage, parseReply, type MessageReply } from '../src/main/ai'
import { migrateApiKey, migrateSettings } from '../src/main/vault'
import { applyLive, coachInput, coachItems, emptyLive, liveText, nextCoverage, takeDone, type LiveEvent } from '../src/shared/coach'

const settings: Settings = {
  clinicianName: 'Alex Rivera',
  credentials: 'LCSW',
  noteFormat: 'SOAP',
  sessionMinutes: 55,
  telehealthPlatform: '',
  planReviewDays: 90,
  includeHeader: true,
  includeSignature: true,
  headingStyle: 'caps',
  customInstructions: '',
  textModel: 'claude-haiku-5-5',
  transcribeModel: 'parakeet-tdt-0.6b-v2',
  reasoningEffort: 'low',
  liveCoverage: false,
  lockEnabled: false,
  lockMinutes: 10,
  onboarded: true
}

let n = 0
const id = () => `id-${++n}`

function makeClient(): Client {
  return {
    id: 'client-1',
    name: 'Jordan Secretname',
    pronouns: 'they/them',
    setting: 'office',
    diagnoses: [{ code: 'F41.1', description: 'Generalized anxiety disorder' }],
    status: 'active',
    context: 'Working on worry.',
    scratchpad: 'PRIVATE-SCRATCH reminder about their sister',
    plan: {
      goals: [
        {
          id: 'goal-a',
          problem: 'Excessive worry',
          goal: 'Reduce worry',
          objectives: [{ id: 'o1', text: 'Worry < 1 hr/day', status: 'in_progress' }],
          interventions: 'CBT',
          status: 'in_progress',
          progress: '',
          targetDate: null,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01'
        }
      ],
      frequency: 'Weekly',
      modalities: 'CBT',
      dischargeCriteria: '',
      reviewDate: '2026-12-01',
      lastReviewed: '2026-09-01',
      updatedAt: '2026-09-01'
    },
    planHistory: [],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01'
  }
}

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    clientId: 'client-1',
    type: 'progress',
    format: 'SOAP',
    status: 'draft',
    session: { date: '2026-10-18', cpt: '90837', setting: 'office', participants: 'Client' },
    attest: defaultAttestations(),
    dictation: 'We did cognitive restructuring on goal one. Client engaged.',
    sections: [],
    reviewItems: [],
    suggestions: null,
    generatedAt: null,
    finalizedAt: null,
    copiedAt: null,
    source: 'desktop',
    createdAt: '2026-10-18',
    updatedAt: '2026-10-18',
    ...overrides
  }
}

describe('CPT defaults', () => {
  it('maps minutes to psychotherapy codes at the CPT thresholds', () => {
    expect(cptForMinutes(53)).toBe('90837')
    expect(cptForMinutes(52)).toBe('90834')
    expect(cptForMinutes(38)).toBe('90834')
    expect(cptForMinutes(37)).toBe('90832')
    expect(cptForMinutes(16)).toBe('90832')
    expect(cptForMinutes(15)).toBeNull()
  })

  it('defaults to 90837 for a 55 minute session, with no session times', () => {
    const s = defaultSession('progress', settings, 'office', new Date('2026-10-18T15:02:00'))
    expect(s).toEqual({ date: '2026-10-18', cpt: '90837', setting: 'office', participants: 'Client' })
    expect(defaultSession('progress', { ...settings, sessionMinutes: 45 }, 'office').cpt).toBe('90834')
    expect(defaultSession('intake', settings, 'office').cpt).toBe('90791')
  })
})

describe('risk scan', () => {
  it('detects explicit risk content', () => {
    expect(scanRisk('Client endorsed passive SI without plan')).toContain('SI/HI')
    expect(scanRisk('reports suicidal thoughts last week')).toContain('suicide')
    expect(scanRisk('we updated the safety plan')).toContain('safety plan')
    expect(scanRisk('history of self-harm')).toContain('self-harm')
  })

  it('detects how the local transcriber spells numbers and initialisms', () => {
    expect(scanRisk("she'll call 9, 8, 8, if things get worse")).toContain('safety plan')
    expect(scanRisk('gave her the nine eight eight number')).toContain('safety plan')
    expect(scanRisk('placed on a 5-1-5-0 last year')).toContain('hospitalization')
    expect(scanRisk('Client endorsed passive S.I. without plan')).toContain('SI/HI')
  })

  it('does not trigger on ordinary words', () => {
    expect(scanRisk('Client was sitting with sisters, er, discussing work')).toEqual([])
    expect(scanRisk('history of substance abuse in remission')).toEqual([])
  })
})

describe('prompt assembly', () => {
  it('strips the client name from dictation, context, and prior notes', () => {
    const client = { ...makeClient(), context: 'Jordan is working on worry.' }
    const prior = { ...makeNote({ id: 'old', status: 'final' }), sections: [{ heading: 'Plan', body: 'Jordan will practice.' }] }
    const note = makeNote({ dictation: "Jordan said Jordan's week was hard. JORDAN Secretname was tearful." })
    const all = buildNoteMessages({ note, client, settings, priorNotes: [prior] }).map((m) => m.content).join('\n')
    expect(all).not.toMatch(/jordan|secretname/i)
    expect(all).toContain('Client said Client’s week was hard.')
    const plan = buildPlanMessages(client, settings, 'Jordan wants to sleep better', [prior]).map((m) => m.content).join('\n')
    expect(plan).not.toMatch(/jordan/i)
    expect(plan).toContain('Client will practice.')
  })

  it('redaction leaves ordinary words alone', () => {
    expect(redactName('Will said he will try. Hope feels hopeful.', 'Will Hope')).toBe('Client said he will try. Client feels hopeful.')
    expect(redactName('Talked with Ann about planning.', 'Ann M.')).toBe('Talked with Client about planning.')
  })

  it('never sends the client name or scratchpad, and includes plan goal ids', () => {
    const client = makeClient()
    const messages = buildNoteMessages({ note: makeNote(), client, settings, priorNotes: [] })
    const all = messages.map((m) => m.content).join('\n')
    expect(all).not.toContain('Jordan')
    expect(all).not.toContain('Secretname')
    expect(all).not.toContain('PRIVATE-SCRATCH')
    expect(all).toContain('goal_id: goal-a')
    expect(all).toContain('"Subjective", "Objective", "Assessment", "Plan", "Risk Assessment"')
  })

  it('caps prior notes for routine notes but sends them in full for discharge and plan updates', () => {
    const client = makeClient()
    const long = 'x'.repeat(3000)
    const older = { ...makeNote({ id: 'older', status: 'final', session: { ...makeNote().session, date: '2026-09-01' } }), sections: [{ heading: 'Plan', body: `OLDEST ${long}` }] }
    const newer = { ...makeNote({ id: 'newer', status: 'final', session: { ...makeNote().session, date: '2026-10-01' } }), sections: [{ heading: 'Plan', body: `NEWEST ${long}` }] }
    const priorNotes = [newer, older] // most recent first, as the main process passes them

    const progress = buildNoteMessages({ note: makeNote(), client, settings, priorNotes })[1].content
    expect(progress).toContain('RECENT NOTES (oldest first')
    expect(progress).not.toContain(long)
    expect(progress.indexOf('OLDEST')).toBeLessThan(progress.indexOf('NEWEST'))

    const discharge = buildNoteMessages({ note: makeNote({ type: 'termination' }), client, settings, priorNotes })[1].content
    expect(discharge).toContain('ALL PRIOR NOTES')
    expect(discharge).toContain(`OLDEST ${long}`)
    expect(discharge).toContain('documented sessions: 3')

    const plan = buildPlanMessages(client, settings, 'Goal 1 is met.', priorNotes)[1].content
    expect(plan).toContain(`NEWEST ${long}`)
  })

  it('deduces plan changes from the record when nothing is dictated', () => {
    const base = makeClient()
    const client = { ...base, plan: { ...base.plan!, lastReviewed: '2026-09-15', dischargeCriteria: 'Worry under 1 hr/day for 8 weeks' } }
    const prior = { ...makeNote({ id: 'old', status: 'final' }), sections: [{ heading: 'Plan', body: 'Jordan reports worry is rare now.' }] }
    const [system, user] = buildPlanMessages(client, settings, '  ', [prior]).map((m) => m.content)
    expect(system).toContain('deduce it from the prior notes')
    expect(system).toContain('Never remove a goal by omitting it')
    expect(system).toContain('keep the current plan’s values')
    expect(system).not.toContain("from the clinician's dictation")
    expect(user).toContain('Plan last reviewed: 09/15/2026')
    expect(user).toContain('Discharge criteria: Worry under 1 hr/day for 8 weeks')
    expect(user).toContain('None. Deduce the plan changes from the record above.')
    expect(user).toContain('Client reports worry is rare now.')
    expect(user).not.toMatch(/jordan/i)

    const dictated = buildPlanMessages(client, settings, 'Goal 1 is met.', [prior])[0].content
    expect(dictated).toContain("from the clinician's dictation")
    expect(dictated).not.toContain('Never remove a goal by omitting it')
  })

  it('asks notes and plans to carry intake background forward in the rolling context', () => {
    const client = makeClient()
    const note = buildNoteMessages({ note: makeNote(), client, settings, priorNotes: [] })[0].content
    const plan = buildPlanMessages(client, settings, 'Goal 1 is met.', [])[0].content
    for (const system of [note, plan]) {
      expect(system).toContain('at most 600 words')
      expect(system).toContain('Background: presenting problem')
      expect(system).toContain('Never drop risk history.')
    }
  })

  it('uses the safety default only when the dictation is silent on risk', () => {
    const client = makeClient()
    const quiet = buildNoteMessages({ note: makeNote(), client, settings, priorNotes: [] })[1].content
    expect(quiet).toContain('Clinician attests: no safety concerns')
    const risky = buildNoteMessages({ note: makeNote({ dictation: 'Client disclosed passive SI this week.' }), client, settings, priorNotes: [] })[1].content
    expect(risky).toContain('Safety default NOT available')
    expect(risky).not.toContain('Clinician attests: no safety concerns')
  })
})

describe('structured output schemas', () => {
  // Claude structured outputs: every object forbids extras, and these schemas list every property as required.
  function assertStrict(schema: Record<string, unknown>, path = 'root'): void {
    const type = schema.type
    const isObject = type === 'object' || (Array.isArray(type) && type.includes('object'))
    if (isObject) {
      const props = Object.keys(schema.properties as object)
      expect(schema.additionalProperties, path).toBe(false)
      expect([...(schema.required as string[])].sort(), path).toEqual([...props].sort())
      for (const [k, v] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) assertStrict(v, `${path}.${k}`)
    }
    if (schema.items) assertStrict(schema.items as Record<string, unknown>, `${path}[]`)
    if (Array.isArray(schema.anyOf)) schema.anyOf.forEach((s, i) => assertStrict(s as Record<string, unknown>, `${path}|${i}`))
    expect('default' in schema, path).toBe(false)
    // Unsupported by structured outputs.
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern']) expect(k in schema, `${path}.${k}`).toBe(false)
  }
  it('note schema is strict-mode compatible', () => assertStrict(NOTE_SCHEMA))
  it('plan schema is strict-mode compatible', () => assertStrict(PLAN_SCHEMA))
})

describe('note output', () => {
  const result: AiNoteResult = {
    sections: PROGRESS_SECTIONS.SOAP.map((h) => ({ heading: h, body: `**${h}** body for Goal 1.\n* point` })),
    goal_updates: [
      { goal_id: 'goal-a', status: 'partially_met', progress: 'Worry down to 2 hrs/day.' },
      { goal_id: 'made-up', status: 'met', progress: 'should be dropped' }
    ],
    new_goals: [],
    plan_meta: null,
    diagnoses: [],
    context_update: 'Updated context.',
    review_items: ['Confirm homework']
  }

  it('strips markdown and drops unknown goal ids', () => {
    const client = makeClient()
    const note = applyAiResult(makeNote(), result, client, '2026-10-18T15:00:00Z')
    expect(note.sections[0].body).toBe('Subjective body for Goal 1.\n- point')
    expect(note.suggestions?.goalUpdates.map((g) => g.goalId)).toEqual(['goal-a'])
  })

  it('renders the plan as a printable page with the client name and escaped text', () => {
    const base = makeClient()
    const client = { ...base, plan: { ...base.plan!, goals: [{ ...base.plan!.goals[0], goal: 'Worry <less> & sleep' }], dischargeCriteria: '' } }
    const html = planToDocumentHtml(client.plan, client, settings)
    expect(html).toContain('Jordan Secretname')
    expect(html).toContain('Worry &lt;less&gt; &amp; sleep')
    expect(html).toContain('<td class="num">1a</td><td>Worry &lt; 1 hr/day</td>')
    expect(html).toContain('F41.1 Generalized anxiety disorder')
    expect(html).not.toContain('Discharge criteria:')
    expect(html).not.toContain('PRIVATE-SCRATCH')
  })

  it('formats plain text and HTML for the clipboard with header and signature', () => {
    const client = makeClient()
    const note = applyAiResult(makeNote(), result, client, 'now')
    const text = noteToText(note, client, settings)
    expect(text).toContain('Date of service: 10/18/2026')
    expect(text).not.toContain('Time:')
    expect(text).toContain('CPT 90837')
    expect(text).toContain('F41.1 Generalized anxiety disorder')
    expect(text).toContain('SUBJECTIVE:\n')
    expect(text).toContain('Clinician: Alex Rivera, LCSW')
    expect(text).not.toMatch(/\*\*/)
    expect(noteToHtml(note, client, settings)).toContain('<b>SUBJECTIVE:</b>')
  })

  it('finalizing applies accepted goal updates and context once', () => {
    const client = makeClient()
    const note = applyAiResult(makeNote(), result, client, 'now')
    const next = finalizeClient(note, client, settings, id, '2026-10-18T15:00:00Z')
    expect(next.context).toBe('Updated context.')
    expect(next.plan?.goals[0].status).toBe('partially_met')
    expect(next.planHistory).toHaveLength(1)
    expect(next.scratchpad).toBe(client.scratchpad)
  })

  it('an intake’s diagnoses replace the one entered with the client', () => {
    const client = makeClient()
    const dx = [{ code: 'F41.0', description: 'Panic disorder' }]
    const intake = applyAiResult(makeNote({ type: 'intake' }), { ...result, diagnoses: dx }, client, 'now')
    expect(intake.suggestions?.applyDiagnoses).toBe(true)
    expect(noteToText(intake, client, settings)).toContain('Diagnosis: F41.0 Panic disorder')
    expect(finalizeClient(intake, client, settings, id, 'now').diagnoses).toEqual(dx)
    // Unchanged codes and progress notes leave the record alone.
    expect(applyAiResult(makeNote({ type: 'intake' }), { ...result, diagnoses: client.diagnoses }, client, 'now').suggestions?.applyDiagnoses).toBe(false)
    expect(applyAiResult(makeNote(), { ...result, diagnoses: dx }, client, 'now').suggestions?.applyDiagnoses).toBe(false)
  })

  it('termination moves the client to discharged', () => {
    const client = makeClient()
    const note = applyAiResult(makeNote({ type: 'termination' }), result, client, 'now')
    expect(finalizeClient(note, client, settings, id, 'now').status).toBe('discharged')
  })

  it('audit checks pass for a complete progress note', () => {
    const client = makeClient()
    const note = { ...applyAiResult(makeNote(), result, client, 'now'), reviewItems: [] }
    const failing = auditChecks(note, client).filter((c) => c.level !== 'ok')
    expect(failing).toEqual([])
  })
})

describe('cleanBody', () => {
  it('removes headings and bold markers', () => {
    expect(cleanBody('## Plan\n**Next** session')).toBe('Plan\nNext session')
  })
})

describe('follow-up amendments', () => {
  const draft = makeNote({
    sections: [
      { heading: 'Subjective', body: 'Jordan reported a hard week.' },
      { heading: 'Risk Assessment', body: 'No risk to self or others was reported or observed.' }
    ],
    reviewItems: ['Confirm homework for Jordan'],
    suggestions: {
      goalUpdates: [{ goalId: 'goal-a', status: 'in_progress', progress: 'Some progress.', accepted: false }],
      newGoals: [],
      planMeta: null,
      diagnoses: [],
      contextUpdate: 'Old context.',
      applyDiagnoses: false
    },
    generatedAt: 'then'
  })

  it('sends the current draft and answers with names removed and no scratchpad', () => {
    const all = buildAmendMessages({ note: draft, client: makeClient(), settings, priorNotes: [], followUp: 'Jordan will do thought records. SECRETNAME agreed.', flagged: draft.reviewItems })
      .map((m) => m.content)
      .join('\n')
    expect(all).not.toMatch(/jordan|secretname/i)
    expect(all).not.toContain('PRIVATE-SCRATCH')
    expect(all).toContain('CURRENT DRAFT')
    expect(all).toContain('Client reported a hard week.')
    expect(all).toContain('- Confirm homework for Client')
    expect(all).toContain('Follow-up after reviewing the draft: Client will do thought records.')
  })

  it('drops the safety default when the follow-up raises risk', () => {
    const user = buildAmendMessages({ note: draft, client: makeClient(), settings, priorNotes: [], followUp: 'Client disclosed passive SI, safety plan updated.', flagged: [] })[1].content
    expect(user).toContain('Safety default NOT available')
    expect(user).not.toContain('Clinician attests: no safety concerns')
  })

  it('keeps the clinician’s choices and records the follow-up in the dictation', () => {
    const result: AiNoteResult = {
      sections: draft.sections,
      goal_updates: [{ goal_id: 'goal-a', status: 'partially_met', progress: 'More progress.' }],
      new_goals: [],
      plan_meta: null,
      diagnoses: [],
      context_update: 'New context.',
      review_items: []
    }
    const next = applyAmendResult(draft, result, makeClient(), 'Homework is thought records.', 'now')
    expect(next.suggestions?.goalUpdates[0]).toMatchObject({ status: 'partially_met', accepted: false })
    expect(next.reviewItems).toEqual([])
    expect(next.dictation).toBe(`${draft.dictation}\n\nFollow-up after reviewing the draft: Homework is thought records.`)
    // A section the model leaves out keeps the clinician's text rather than vanishing.
    const dropped = applyAmendResult(draft, { ...result, sections: [{ heading: 'subjective', body: 'Revised.' }] }, makeClient(), 'x', 'now')
    expect(dropped.sections).toEqual([{ heading: 'subjective', body: 'Revised.' }, draft.sections[1]])
    // A reopened note already applied its suggestions on finalize, so they stay as they were.
    const reopened = applyAmendResult({ ...draft, finalizedAt: 'earlier' }, result, makeClient(), 'x', 'now')
    expect(reopened.suggestions).toEqual(draft.suggestions)
  })
})

describe('queue', () => {
  const section = [{ heading: 'Subjective', body: 'x' }]
  const at = (h: number) => new Date(2026, 9, 19, h).toISOString()

  it('sorts every note that still needs something into one place', () => {
    const notes = [
      makeNote({ id: 'writing' }),
      makeNote({ id: 'failed' }),
      makeNote({ id: 'ready-late', sections: section, generatedAt: at(11) }),
      makeNote({ id: 'ready-early', sections: section, generatedAt: at(9) }),
      makeNote({ id: 'unwritten' }),
      makeNote({ id: 'uncopied', status: 'final', sections: section, finalizedAt: at(10) }),
      makeNote({ id: 'finished', status: 'final', sections: section, finalizedAt: at(10), copiedAt: at(10) }),
      makeNote({ id: 'old', status: 'final', sections: section, finalizedAt: new Date(2026, 9, 1).toISOString(), copiedAt: 'x' }),
      makeNote({ id: 'orphan', clientId: 'deleted' })
    ]
    const jobs = {
      writing: { kind: 'write' as const, stage: 'writing' as const, startedAt: 1 },
      failed: { kind: 'write' as const, stage: 'writing' as const, startedAt: 2, error: 'Network down' }
    }
    const q = buildQueue(notes, [makeClient()], jobs, '2026-10-19')
    const ids = (list: Note[]) => list.map((n) => n.id)
    expect(ids(q.writing)).toEqual(['writing'])
    expect(ids(q.failed)).toEqual(['failed'])
    // The first one written is the first one to review.
    expect(ids(q.ready)).toEqual(['ready-early', 'ready-late'])
    expect(ids(q.unwritten)).toEqual(['unwritten'])
    expect(ids(q.uncopied)).toEqual(['uncopied'])
    expect(ids(q.finished)).toEqual(['finished'])
    expect(queueCount(q)).toBe(4)
  })

  it('ignores a leftover job on a note that has since been finalized', () => {
    const note = makeNote({ status: 'final', sections: section, finalizedAt: at(10) })
    const q = buildQueue([note], [makeClient()], { [note.id]: { kind: 'amend', stage: 'writing', startedAt: 1, error: 'x' } }, '2026-10-19')
    expect(q.failed).toEqual([])
    expect(q.uncopied).toEqual([note])
  })
})

describe('Messages API reply parsing', () => {
  const reply = (content: MessageReply['content'], stop_reason: MessageReply['stop_reason'] = 'end_turn', stop_details: MessageReply['stop_details'] = null): MessageReply => ({ content, stop_reason, stop_details })
  const thinking = { type: 'thinking', thinking: '', signature: 'sig' } as MessageReply['content'][number]
  const text = (t: string) => ({ type: 'text', text: t, citations: null }) as MessageReply['content'][number]

  it('reads JSON from the text blocks and skips thinking blocks', () => {
    expect(parseReply<{ ok: boolean }>(reply([thinking, text('{"ok":'), text('true}')]))).toEqual({ ok: true })
  })

  it('reports a refusal before trying to parse it', () => {
    const refused = reply([text('{"sec')], 'refusal', { type: 'refusal', category: 'general_harms', explanation: null } as MessageReply['stop_details'])
    expect(() => parseReply(refused)).toThrow(/Claude declined.*general_harms/)
  })

  it('reports cut-off replies', () => {
    expect(() => parseReply(reply([text('{"sections": [')], 'max_tokens'))).toThrow(/cut off/)
    expect(() => parseReply(reply([], 'model_context_window_exceeded'))).toThrow(/cut off/)
  })

  it('reports an empty reply', () => {
    expect(() => parseReply(reply([thinking]))).toThrow(/empty/)
  })
})

describe('suggesting a stronger model', () => {
  it('steps up from Haiku to Sonnet to Opus, and no further', () => {
    expect(nextModelUp('claude-haiku-5-5')).toBe('claude-sonnet-5-5')
    expect(nextModelUp('claude-sonnet-5-5')).toBe('claude-opus-5-5')
    expect(nextModelUp('claude-opus-5-5')).toBeNull()
    expect(nextModelUp('claude-some-custom-model')).toBeNull()
  })

  it('waits for repeated rewrites', () => {
    expect(suggestModel('claude-haiku-5-5', 0)).toBeNull()
    expect(suggestModel('claude-haiku-5-5', 1)).toBeNull()
    expect(suggestModel('claude-haiku-5-5', 2)).toBe('claude-sonnet-5-5')
    expect(suggestModel('claude-opus-5-5', 5)).toBeNull()
  })

  it('counts failures the model caused, not network or key errors', () => {
    const errorOf = (body: MessageReply) => {
      try {
        parseReply(body)
      } catch (err) {
        return (err as Error).message
      }
      return ''
    }
    expect(isModelFailure(errorOf({ stop_reason: 'refusal', stop_details: null, content: [] } as unknown as MessageReply))).toBe(true)
    expect(isModelFailure(errorOf({ stop_reason: 'max_tokens', stop_details: null, content: [] } as unknown as MessageReply))).toBe(true)
    expect(isModelFailure(errorOf({ stop_reason: 'end_turn', stop_details: null, content: [] } as unknown as MessageReply))).toBe(true)
    expect(isModelFailure('Couldn’t reach Anthropic. Check your internet connection and try again.')).toBe(false)
    expect(isModelFailure('Anthropic rate limit reached. Wait a moment and try again.')).toBe(false)
  })
})

describe('settings from the OpenAI version', () => {
  it('moves OpenAI models to Claude and the local transcriber', () => {
    const old = { ...settings, textModel: 'gpt-6.1-sol', transcribeModel: 'gpt-transcribe', liveTranscribeModel: 'gpt-live-transcribe' } as Settings
    const next = migrateSettings(old)
    expect(next.textModel).toBe('claude-haiku-5-5')
    expect(next.transcribeModel).toBe('parakeet-tdt-0.6b-v2')
    expect('liveTranscribeModel' in next).toBe(false)
  })

  it('keeps Claude and local model choices', () => {
    const next = migrateSettings({ ...settings, textModel: 'claude-sonnet-5-5', transcribeModel: 'parakeet-tdt-0.6b-v3' })
    expect([next.textModel, next.transcribeModel]).toEqual(['claude-sonnet-5-5', 'parakeet-tdt-0.6b-v3'])
  })

  it('drops a saved OpenAI key but keeps an Anthropic one', () => {
    expect(migrateApiKey('sk-proj-abc')).toBe('')
    expect(migrateApiKey(undefined)).toBe('')
    expect(migrateApiKey('sk-ant-api03-abc')).toBe('sk-ant-api03-abc')
  })
})

describe('live coverage', () => {
  afterEach(() => vi.unstubAllGlobals())

  const ids = (note: Note, client = makeClient(), text?: string) => coachItems(note, client, text).map((i) => i.id)

  it('asks about what a progress note needs, but not what the clinician attested', () => {
    expect(ids(makeNote())).toEqual(['symptoms', 'interventions', 'response', 'goals', 'next'])
    // No plan goals: nothing to report progress against.
    expect(ids(makeNote(), { ...makeClient(), plan: null })).not.toContain('goals')
  })

  it('asks about risk and mental status only when the attestations are off', () => {
    const off = makeNote({ attest: { noSafetyConcerns: false, mseUnremarkable: false } })
    expect(ids(off)).toEqual(expect.arrayContaining(['risk', 'mse']))
  })

  it('asks for a risk level and safety plan once risk comes up, even live', () => {
    const note = makeNote()
    expect(ids(note, makeClient(), 'Client mentioned passive SI this week.')).toEqual(expect.arrayContaining(['risk-level', 'risk-plan']))
    expect(ids(note, makeClient(), 'Client mentioned passive SI this week.')).not.toContain('risk')
  })

  it('has its own list for intakes and discharge summaries', () => {
    expect(ids(makeNote({ type: 'intake' }))).toEqual(['presenting', 'hpi', 'impact', 'history', 'substance', 'impression', 'plan'])
    expect(ids(makeNote({ type: 'termination' }))).toEqual(['reason', 'course', 'status', 'aftercare'])
  })

  it('removes the client name from the text it checks', () => {
    const input = coachInput('Jordan said Secretname family stuff is hard. Goal one.', makeClient(), makeNote())
    expect(input).not.toMatch(/Jordan|Secretname/)
    expect(input).toContain('Goal 1: Reduce worry')
  })

  it('releases a covered item only after two "no" answers in a row', () => {
    let c = nextCoverage({ covered: {}, misses: {} }, { a: 0, b: 1 })
    expect(c.covered).toEqual({ a: false, b: true })
    c = nextCoverage(c, { a: 1, b: 0 })
    expect(c.covered).toEqual({ a: true, b: true })
    c = nextCoverage(c, { b: 1 })
    c = nextCoverage(c, { b: 0 })
    expect(c.covered.b).toBe(true)
    c = nextCoverage(c, { b: 0 })
    expect(c.covered).toEqual({ a: true, b: false })
  })

  const message = (answers: Record<string, boolean>) =>
    new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: COVERAGE_MODEL, stop_reason: 'end_turn', stop_details: null, content: [{ type: 'text', text: JSON.stringify(answers) }], usage: { input_tokens: 1, output_tokens: 1 } }),
      { headers: { 'content-type': 'application/json' } }
    )

  it('asks Claude one redacted yes/no question per item through the Messages API only', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => message({ symptoms: true, interventions: false, response: false, goals: false, next: false }))
    vi.stubGlobal('fetch', fetch)
    const result = await coverage('sk-ant-test', makeNote(), makeClient(), 'Jordan was anxious at work.')
    expect(result).toEqual({ symptoms: 1, interventions: 0, response: 0, goals: 0, next: 0 })
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages')
    const headers = new Headers(init.headers)
    expect(headers.get('x-api-key')).toBe('sk-ant-test')
    expect(headers.get('anthropic-beta')).toBeNull()
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('claude-haiku-5-5')
    expect(JSON.stringify(body.messages)).not.toContain('Jordan')
    expect(body.output_config.effort).toBe('low')
    expect(body.output_config.format.schema.required).toEqual(['symptoms', 'interventions', 'response', 'goals', 'next'])
    expect('temperature' in body).toBe(false)
  })

  it('ignores a base URL or token from the environment', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://elsewhere.example')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'other-org-token')
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => message({ symptoms: true, interventions: true, response: true, goals: true, next: true }))
    vi.stubGlobal('fetch', fetch)
    await coverage('sk-ant-test', makeNote(), makeClient(), 'Anxious at work.')
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toMatch(/^https:\/\/api\.anthropic\.com\//)
    expect(new Headers(init.headers).get('authorization')).toBeNull()
    vi.unstubAllEnvs()
  })

  it('skips the request when nothing has been said', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await coverage('sk-test', makeNote(), makeClient(), '  ')).toEqual({})
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('live transcript', () => {
  const run = (events: LiveEvent[]) => events.reduce(applyLive, emptyLive())

  it('streams deltas and replaces them with the completed text', () => {
    const t = run([
      { type: 'delta', itemId: 'a', text: 'We did ' },
      { type: 'delta', itemId: 'a', text: 'exposure' },
      { type: 'completed', itemId: 'a', text: 'We did exposure.' },
      { type: 'delta', itemId: 'a', text: ' late' }
    ])
    expect(liveText(t)).toBe('We did exposure.')
  })

  it('orders turns by commit even when completions arrive out of order', () => {
    const t = run([
      { type: 'committed', itemId: 'a', previousItemId: null },
      { type: 'committed', itemId: 'b', previousItemId: 'a' },
      { type: 'completed', itemId: 'b', text: 'Second.' },
      { type: 'completed', itemId: 'a', text: 'First.' }
    ])
    expect(liveText(t)).toBe('First. Second.')
  })

  it('hands on finished turns in spoken order, holding back those after an unfinished one', () => {
    const t = run([
      { type: 'committed', itemId: 'a', previousItemId: null },
      { type: 'committed', itemId: 'b', previousItemId: 'a' },
      { type: 'committed', itemId: 'c', previousItemId: 'b' },
      { type: 'completed', itemId: 'a', text: 'First.' },
      { type: 'completed', itemId: 'c', text: 'Third.' },
      { type: 'delta', itemId: 'b', text: 'Sec' }
    ])
    const first = takeDone(t)
    expect(first.texts).toEqual(['First.'])
    expect(liveText(first.rest)).toBe('Sec Third.')
    const second = takeDone(applyLive(first.rest, { type: 'completed', itemId: 'b', text: 'Second.' }))
    expect(second.texts).toEqual(['Second.', 'Third.'])
    expect(second.rest.order).toEqual([])
  })

  it('keeps what arrived of a failed turn, and everything when the stream goes away', () => {
    const t = run([
      { type: 'committed', itemId: 'a', previousItemId: null },
      { type: 'delta', itemId: 'a', text: 'Half a' },
      { type: 'failed', itemId: 'a', message: 'oops' },
      { type: 'committed', itemId: 'b', previousItemId: 'a' },
      { type: 'delta', itemId: 'b', text: 'still going' }
    ])
    expect(takeDone(t).texts).toEqual(['Half a'])
    expect(takeDone(t, true).texts).toEqual(['Half a', 'still going'])
  })
})
