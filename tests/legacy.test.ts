import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Client, Note, Settings } from '../src/shared/types'
import { legacyDate, mergeLegacy, summarizeLegacy, type LegacyClient } from '../src/shared/legacy'
import { parseDiagnoses } from '../src/shared/diagnosis'
import { readLegacyBackup } from '../src/main/legacyBackup'
import { noteSortKey, todayISO } from '../src/shared/compliance'
import { buildQueue, queueCount } from '../src/shared/queue'
import { buildContextMessages, buildNoteMessages, describePriorNotes } from '../src/shared/prompts'
import { applyContextRebuild, finalizeClient, needsContextRebuild } from '../src/shared/finalize'
import { noteToText } from '../src/shared/format'

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
const uid = () => `uid-${++n}`

/** Same algorithm as exportAllData in the previous Echo's storage.ts. */
function legacyBackup(clients: LegacyClient[], password: string): Buffer {
  const salt = randomBytes(32)
  const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify({ version: 2, exportedAt: '2026-10-18T00:00:00.000Z', clients }), 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from('ECHOBACKUP2\n'), salt, iv, cipher.getAuthTag(), body])
}

function sample(): LegacyClient[] {
  return [
    {
      id: 'c-old-1',
      name: 'Riley Testperson',
      dateOfBirth: '1990-01-02',
      phone: '555-0100',
      email: 'riley@example.com',
      diagnosis: 'F41.1 Generalized anxiety disorder; adjustment concerns',
      ehrProfile: 'alma',
      createdAt: '2026-01-05T15:00:00.000Z',
      updatedAt: '2026-09-01T15:00:00.000Z',
      treatmentPlan: {
        id: 'p-1',
        diagnosis: 'Major depressive disorder, recurrent, moderate (F33.1)',
        presenting_problem: 'Worry and low mood after job loss.',
        theoretical_orientation: 'CBT, ACT',
        interventions: 'Cognitive restructuring; values work',
        frequency: 'Weekly',
        additional_notes: '',
        goals: [
          { id: 'g-1', goal: 'Reduce worry', objectives: '- Practice worry time daily\n2. Rate anxiety weekly', status: 'active' },
          { id: 'g-2', goal: 'Return to work', objectives: 'Apply to 3 jobs', status: 'completed', targetDate: '2026-06-30' }
        ],
        createdAt: '2026-01-05T15:00:00.000Z',
        updatedAt: '2026-04-01T15:00:00.000Z'
      },
      notes: [
        {
          id: 'n-1',
          clientId: 'c-old-1',
          type: 'intake',
          date: '2026-01-05',
          transcription: 'Intake with Riley.',
          sections: [{ key: 'presenting', title: 'Presenting Problem', content: '**Riley** reports worry.' }],
          version: 1,
          createdAt: '2026-01-05T16:00:00.000Z',
          updatedAt: '2026-01-05T17:00:00.000Z'
        },
        {
          id: 'n-2',
          clientId: 'wrong-id',
          type: 'progress',
          date: '2026-09-01T23:30:00.000Z',
          transcription: 'Discussed safety plan.',
          sections: [{ key: 'data', title: 'Data', content: 'Riley reviewed coping skills.' }],
          version: 1,
          createdFrom: 'ios',
          createdAt: '2026-09-01T23:45:00.000Z',
          updatedAt: '2026-09-02T00:10:00.000Z'
        }
      ]
    },
    {
      id: 'c-old-2',
      name: 'Sam Example',
      createdAt: '2026-02-01T15:00:00.000Z',
      updatedAt: '2026-02-01T15:00:00.000Z',
      notes: []
    }
  ]
}

const empty = (): { clients: Client[]; notes: Note[] } => ({ clients: [], notes: [] })

describe('legacy backup file', () => {
  it('decrypts a backup exported by the previous Echo', () => {
    expect(readLegacyBackup(legacyBackup(sample(), 'hunter22'), 'hunter22').map((c) => c.name)).toEqual(['Riley Testperson', 'Sam Example'])
  })

  it('rejects a wrong password and other files', () => {
    expect(() => readLegacyBackup(legacyBackup(sample(), 'hunter22'), 'nope')).toThrow(/Wrong password/)
    expect(() => readLegacyBackup(Buffer.from('ECHOBK1' + 'x'.repeat(100)), 'x')).toThrow(/previous Echo/)
  })
})

describe('legacy mapping', () => {
  it('extracts ICD-10 codes and keeps uncoded text out of the diagnosis list', () => {
    const { diagnoses, uncoded } = parseDiagnoses('F41.1 Generalized anxiety disorder; adjustment concerns', 'Major depressive disorder (F33.1)')
    expect(diagnoses).toEqual([
      { code: 'F41.1', description: 'Generalized anxiety disorder' },
      { code: 'F33.1', description: 'Major depressive disorder' }
    ])
    expect(uncoded).toEqual(['adjustment concerns'])
  })

  it('imports fields the old app saved as arrays or other non-strings', () => {
    const [c] = sample()
    const odd = c as unknown as Record<string, any>
    odd.diagnosis = ['F41.1 Generalized anxiety disorder', 'F33.1 Major depressive disorder']
    odd.treatmentPlan.presenting_problem = null
    odd.treatmentPlan.additional_notes = ['Prefers mornings']
    odd.treatmentPlan.interventions = ['Cognitive restructuring', 'Values work']
    odd.treatmentPlan.goals[0].objectives = ['Objective 1a: Practice worry time daily', 'Objective 1b: Rate anxiety weekly']
    odd.notes[0].sections[0].content = ['Riley reports worry.', 'Sleep is poor.']
    odd.notes[0].transcription = undefined
    const { clients, notes } = mergeLegacy(empty(), [c], settings, uid)
    expect(clients[0].diagnoses.map((d) => d.code)).toEqual(['F41.1', 'F33.1'])
    expect(clients[0].context).toBe('Additional notes: Prefers mornings')
    expect(clients[0].plan?.goals[0].objectives.map((o) => o.text)).toEqual(['Practice worry time daily', 'Rate anxiety weekly'])
    expect(clients[0].plan?.goals[0].interventions).toBe('Cognitive restructuring\nValues work')
    expect(notes[0].sections[0].body).toBe('Riley reports worry.\nSleep is poor.')
    expect(notes[0].dictation).toBe('')
  })

  it('takes the diagnosis from an imported intake when the old client had none', () => {
    const [c] = sample()
    delete c.diagnosis
    c.treatmentPlan!.diagnosis = ''
    c.notes![0].sections!.push({ key: 'dx', title: 'Diagnostic Impressions', content: 'Diagnosis: F41.1 Generalized anxiety disorder; R/O F33.1' })
    expect(mergeLegacy(empty(), [c], settings, uid).clients[0].diagnoses).toEqual([{ code: 'F41.1', description: 'Generalized anxiety disorder' }])
    // An existing client re-imported with that intake is filled in too.
    const existing = { ...mergeLegacy(empty(), [{ ...c, notes: [] }], settings, uid).clients[0], diagnoses: [] }
    expect(mergeLegacy({ clients: [existing], notes: [] }, [c], settings, uid).clients.find((x) => x.id === c.id)?.diagnoses.map((d) => d.code)).toEqual(['F41.1'])
  })

  it('normalizes dates of service to local YYYY-MM-DD', () => {
    expect(legacyDate('2026-03-04', '')).toBe('2026-03-04')
    expect(legacyDate('2026-09-01T23:30:00.000Z', '')).toBe(todayISO(new Date('2026-09-01T23:30:00.000Z')))
    expect(legacyDate('', '2026-02-01T15:00:00.000Z')).toBe(todayISO(new Date('2026-02-01T15:00:00.000Z')))
  })

  it('imports one client with notes and plan as history', () => {
    const merged = mergeLegacy(empty(), [sample()[0]], settings, uid)
    expect(merged.report).toMatchObject({ clientsAdded: 1, notesAdded: 2, plansAdded: 1 })
    const [client] = merged.clients
    expect(client.diagnoses.map((d) => d.code)).toEqual(['F41.1', 'F33.1'])
    expect(client.plan?.goals.map((g) => [g.id, g.status])).toEqual([
      ['g-1', 'in_progress'],
      ['g-2', 'met']
    ])
    expect(client.plan?.goals[0].objectives.map((o) => o.text)).toEqual(['Practice worry time daily', 'Rate anxiety weekly'])
    expect(client.plan?.reviewDate).toBe('2026-06-30')
    // Identifiers stay out of the AI-bound context; they go to the scratchpad.
    expect(client.context).toContain('Worry and low mood')
    expect(client.context).not.toMatch(/555-0100|riley@example|1990/)
    expect(client.scratchpad).toContain('555-0100')

    for (const note of merged.notes) {
      expect(note.clientId).toBe('c-old-1')
      expect(note.status).toBe('final')
    }
    const progress = merged.notes.find((x) => x.id === 'n-2')!
    expect(progress.source).toBe('mobile')
    expect(progress.attest.noSafetyConcerns).toBe(false)
    expect(progress.session.cpt).toBe('')
    expect(noteToText(progress, client, settings)).not.toContain('CPT')
    expect(merged.notes.find((x) => x.id === 'n-1')!.sections[0].body).toBe('Riley reports worry.')

    // Nothing lands on Queue.
    const q = buildQueue(merged.notes, merged.clients, {}, '2026-10-19')
    expect(queueCount(q) + q.unwritten.length + q.finished.length).toBe(0)
    // Prior notes sent to the AI have the first name redacted.
    expect(describePriorNotes(merged.notes, client)).not.toContain('Riley')
  })

  it('rebuilds an imported context once from the full record, intake included', () => {
    const [legacy] = sample()
    const intake = `Riley has a history of alcohol use disorder in remission and takes sertraline 50 mg. ${'x'.repeat(2500)} INTAKE-END`
    legacy.notes[0].sections = [{ key: 'history', title: 'History', content: intake }]
    for (let i = 3; i <= 6; i++) {
      legacy.notes.push({ ...legacy.notes[1], id: `n-${i}`, clientId: 'c-old-1', date: `2026-09-0${i}`, sections: [{ key: 'data', title: 'Data', content: `Session ${i}.` }] })
    }
    const merged = mergeLegacy(empty(), [legacy], settings, uid)
    const client = merged.clients.find((c) => c.id === 'c-old-1')!
    const finalized = [...merged.notes].sort((a, b) => noteSortKey(b).localeCompare(noteSortKey(a)))

    expect(needsContextRebuild(client, merged.notes)).toBe(true)
    // Routine notes only see the last three, so the intake never reaches them.
    expect(buildNoteMessages({ note: { ...finalized[0], status: 'draft' }, client, settings, priorNotes: finalized.slice(0, 3) })[1].content).not.toContain('sertraline')

    const [system, user] = buildContextMessages(client, settings, finalized).map((m) => m.content)
    expect(system).toContain('Rebuild this client')
    expect(system).toContain('Background: presenting problem')
    expect(user).toContain('INTAKE-END')
    expect(user).toContain('Worry and low mood')
    expect(user.indexOf('sertraline')).toBeLessThan(user.indexOf('Session 6.'))
    expect(user).not.toContain('Riley')

    const rebuilt = applyContextRebuild(client, { context_update: 'Background: sertraline 50 mg.' }, '2026-10-19T00:00:00.000Z')
    expect(rebuilt.context).toBe('Background: sertraline 50 mg.')
    expect(needsContextRebuild(rebuilt, merged.notes)).toBe(false)
  })

  it('keeps an imported context due for a rebuild until one runs, and skips clients with no notes', () => {
    const merged = mergeLegacy(empty(), sample(), settings, uid)
    const riley = merged.clients.find((c) => c.id === 'c-old-1')!
    const sam = merged.clients.find((c) => c.id === 'c-old-2')!
    expect(needsContextRebuild(sam, merged.notes)).toBe(false)
    const note: Note = { ...merged.notes[1], suggestions: { goalUpdates: [], newGoals: [], planMeta: null, diagnoses: [], applyDiagnoses: false, contextUpdate: 'Updated.' } }
    // A routine note's context update doesn't see the intake, so the rebuild is still due.
    expect(needsContextRebuild(finalizeClient(note, riley, settings, uid, '2026-10-19T00:00:00.000Z'), merged.notes)).toBe(true)
    expect(applyContextRebuild(riley, { context_update: '  ' }, '2026-10-19T00:00:00.000Z')).toBe(riley)

    // A new client's first context is written under the current rules.
    const fresh: Client = { ...sam, context: '' }
    const intake: Note = { ...note, clientId: sam.id, type: 'intake' }
    expect(needsContextRebuild(finalizeClient(intake, fresh, settings, uid, '2026-10-19T00:00:00.000Z'), [intake])).toBe(false)
  })

  it('is a no-op the second time, and only adds what is missing', () => {
    const first = mergeLegacy(empty(), [sample()[0]], settings, uid)
    const state = { clients: first.clients, notes: first.notes }
    const again = mergeLegacy(state, [sample()[0]], settings, uid)
    expect(again.clients).toEqual([])
    expect(again.notes).toEqual([])
    expect(again.report).toMatchObject({ clientsExisting: 1, notesExisting: 2, notesAdded: 0, plansAdded: 0 })

    const withNew = sample()[0]
    withNew.notes.push({ ...withNew.notes[1], id: 'n-3', date: '2026-10-01' })
    expect(mergeLegacy(state, [withNew], settings, uid).notes.map((x) => x.id)).toEqual(['n-3'])
  })

  it('summarizes clients for the picker and flags name matches', () => {
    const here = mergeLegacy(empty(), [sample()[0]], settings, uid)
    const other: Client = { ...here.clients[0], id: 'someone-else', name: 'sam  example' }
    const rows = summarizeLegacy(sample(), { clients: [...here.clients, other], notes: here.notes })
    expect(rows.map((r) => [r.name, r.imported, r.newNotes, r.nameMatch])).toEqual([
      ['Riley Testperson', true, 0, false],
      ['Sam Example', false, 0, true]
    ])
  })
})
