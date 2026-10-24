import { afterAll, describe, expect, it } from 'vitest'
import type { Client, Note } from '../src/shared/types'
import { defaultAttestations } from '../src/shared/compliance'
import { DEFAULT_SETTINGS } from '../src/main/vault'
import { extractJson, generateNote, LocalError, normalizeNote, stopLocal } from '../src/main/local'

const client = { plan: { goals: [{ id: 'g1' }] } } as unknown as Client
const headings = ['Data', 'Assessment', 'Plan', 'Risk Assessment']
const sections = headings.map((heading) => ({ heading, body: `${heading} text` }))

describe('local model replies', () => {
  it('finds the JSON past fences and stray thinking', () => {
    expect(extractJson('<think>hmm {no}</think>\n```json\n{"a": 1}\n```')).toEqual({ a: 1 })
    expect(() => extractJson('Sorry, I can’t help with that.')).toThrow(LocalError)
  })

  it('fills in what the schema would have guaranteed and drops what it would have refused', () => {
    const result = normalizeNote(
      {
        sections: [...sections].reverse().map((s, i) => (i === 0 ? { ...s, heading: 'RISK ASSESSMENT:' } : s)),
        goal_updates: [
          { goal_id: 'g1', status: 'in_progress', progress: 'Better' },
          { goal_id: 'nope', status: 'met', progress: '' },
          { goal_id: 'g1', status: 'improving', progress: '' }
        ],
        plan_meta: 'none',
        diagnoses: [{ code: '', description: 'x' }]
      },
      headings,
      client
    )
    expect(result.sections.map((s) => s.heading)).toEqual(headings)
    expect(result.goal_updates).toEqual([{ goal_id: 'g1', status: 'in_progress', progress: 'Better' }])
    expect(result).toMatchObject({ new_goals: [], plan_meta: null, diagnoses: [], context_update: '' })
    expect(result.review_items[0]).toMatch(/local/)
  })

  it('rejects a note missing a section so it can be retried', () => {
    expect(() => normalizeNote({ sections: sections.slice(0, 3) }, headings, client)).toThrow(/Risk Assessment/)
  })
})

// Writes one real note with the downloaded model (ECHO_LOCAL_E2E=1, optionally
// ECHO_LOCAL_THINKING=1) and prints it with the time taken; skipped otherwise.
describe.skipIf(!process.env.ECHO_LOCAL_E2E)('local model, end to end', () => {
  afterAll(stopLocal)

  it('writes a SOAP progress note that updates the existing goal', async () => {
    const realClient = {
      id: 'c1',
      name: 'Jordan Testperson',
      pronouns: 'she/her',
      setting: 'office',
      diagnoses: [{ code: 'F41.0', description: 'Panic disorder' }],
      status: 'active',
      context: 'Background: panic attacks since a job change in spring. Risk history: none documented. Course of treatment: CBT for panic; thought records helping.',
      scratchpad: '',
      plan: {
        goals: [
          {
            id: 'goal-panic',
            problem: 'Panic attacks impairing work',
            goal: 'Reduce panic attacks and return to full work duties',
            objectives: [{ id: 'o1', text: 'Panic attacks 1 or fewer per week', status: 'in_progress' }],
            interventions: 'CBT for panic, interoceptive and in-vivo exposure',
            status: 'in_progress',
            progress: '',
            targetDate: null,
            createdAt: '2026-08-01',
            updatedAt: '2026-08-01'
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
      createdAt: '2026-08-01',
      updatedAt: '2026-08-01'
    } as Client
    const note = {
      id: 'n1',
      clientId: 'c1',
      type: 'progress',
      format: 'SOAP',
      status: 'draft',
      session: { date: '2026-10-20', cpt: '90837', setting: 'office', participants: 'Client' },
      attest: defaultAttestations(),
      dictation:
        'Jordan came in saying it was a rough week at work, two panic attacks, down from four last week. We went over her thought records, she is catching the catastrophizing about her performance review. Did cognitive restructuring on that and practiced paced breathing in session. She was engaged, a bit tearful talking about her mom. No SI. Plan is keep doing thought records and try one exposure, the grocery store at a busy time, before next week.',
      sections: [],
      reviewItems: [],
      suggestions: null,
      generatedAt: null,
      finalizedAt: null,
      copiedAt: null,
      source: 'desktop',
      createdAt: '2026-10-20',
      updatedAt: '2026-10-20'
    } as Note
    const settings = { ...DEFAULT_SETTINGS, localModel: true, localThinking: process.env.ECHO_LOCAL_THINKING === '1' }
    const started = Date.now()
    const result = await generateNote(settings, note, realClient, [])
    console.log(`${((Date.now() - started) / 1000).toFixed(1)} s\n\n${JSON.stringify(result, null, 2)}`)
    expect(result.sections).toHaveLength(5)
    expect(JSON.stringify(result)).not.toContain('Jordan')
  }, 600_000)
})
