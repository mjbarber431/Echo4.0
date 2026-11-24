import { describe, expect, it } from 'vitest'
import { addInstruction, betterRoute, buildScript, describeAction, fillTemplate, nextChoose, scriptLine, templateText, type ScriptStep, pickMatch, unsafeLabel, keepable, macCombo, pickTimeOffsets, placeTask, toScreen, weekOf } from '../src/shared/placement'
import { ehrForClient, learnedFor, learnedPatch, normalizeEhrUrl, type Ehr } from '../src/shared/ehr'
import { batchCounts, planPieces, planTask, unplacedPieces, withoutCodes, type PlaceBatch } from '../src/shared/placement'
import type { TreatmentPlan } from '../src/shared/types'

describe('placing notes', () => {
  it('finds the Monday-to-Sunday week of the session date', () => {
    // Thursday 19 November 2026
    expect(weekOf('2026-11-19')).toEqual({ start: '2026-11-16', end: '2026-11-22' })
    // A Monday and a Sunday are in their own week
    expect(weekOf('2026-11-16')).toEqual({ start: '2026-11-16', end: '2026-11-22' })
    expect(weekOf('2026-11-22')).toEqual({ start: '2026-11-16', end: '2026-11-22' })
    // Across a month and a year
    expect(weekOf('2026-12-01')).toEqual({ start: '2026-11-30', end: '2026-12-06' })
    expect(weekOf('2027-01-02')).toEqual({ start: '2026-12-28', end: '2027-01-03' })
  })

  it('tells Claude the week, not the exact date', () => {
    const text = placeTask({ ehrName: 'TestEHR', clientName: 'Sam Rivera', noteLabel: 'Progress note', sessionDate: '2026-11-19', today: '2026-11-23' })
    expect(text).toContain('Monday, November 16, 2026 to Sunday, November 22, 2026')
    expect(text).toContain('Today: Monday, November 23, 2026')
    expect(text).toContain('first time in TestEHR')
    expect(text).not.toContain('2026-11-19')
  })

  it('puts the clinician’s instructions before the saved route', () => {
    const text = placeTask({ ehrName: 'TestEHR', clientName: 'Sam', noteLabel: 'Progress note', sessionDate: '2026-11-19', today: '2026-11-23', instructions: 'Use the Notes tab.', route: '1. Calendar' })
    expect(text.indexOf('Use the Notes tab.')).toBeLessThan(text.indexOf('1. Calendar'))
  })

  it('passes the code, location and shifted times for the form', () => {
    const text = placeTask({ ehrName: 'TestEHR', clientName: 'Sam', noteLabel: 'Progress note', sessionDate: '2026-11-19', today: '2026-11-23', details: { cpt: '90837', setting: 'telehealth-home', startOffset: 3, endOffset: -2 } })
    expect(text).toContain('CPT 90837')
    expect(text).toContain('the client’s home')
    expect(text).toContain('scheduled start plus 3 minutes (for a 2:00 PM appointment, 2:03 PM)')
    expect(text).toContain('scheduled end minus 2 minutes (for a 3:00 PM end, 2:58 PM)')
    expect(text).toContain('at least 53 minutes')
    const intake = placeTask({ ehrName: 'TestEHR', clientName: 'Sam', noteLabel: 'Intake', sessionDate: '2026-11-19', today: '2026-11-23', details: { cpt: '90791', setting: 'telehealth-home', startOffset: -4, endOffset: 5 } })
    expect(intake).toContain('CPT 90791')
    expect(intake).not.toContain('at least')
  })

  it('moves each time 2–5 minutes and never shortens a session by more than 4', () => {
    let seed = 1
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
    for (let i = 0; i < 2000; i++) {
      const { startOffset, endOffset } = pickTimeOffsets(random)
      for (const n of [startOffset, endOffset]) expect(Math.abs(n) >= 2 && Math.abs(n) <= 5).toBe(true)
      expect(endOffset - startOffset).toBeGreaterThanOrEqual(-4)
    }
  })

  it('maps screenshot pixels to screen points and refuses anything outside', () => {
    const shot = { width: 1280, height: 1000, frame: { x: 640, y: 25, width: 1280, height: 1000 } }
    expect(toScreen([0, 0], shot)).toEqual({ x: 640, y: 25 })
    expect(toScreen([640, 500], shot)).toEqual({ x: 1280, y: 525 })
    const scaled = { width: 1280, height: 640, frame: { x: 0, y: 0, width: 1920, height: 960 } }
    expect(toScreen([1280, 640], scaled)).toEqual({ x: 1920, y: 960 })
    expect(toScreen([1281, 10], shot)).toBeNull()
    expect(toScreen([-1, 10], shot)).toBeNull()
    expect(toScreen(['a', 1], shot)).toBeNull()
    expect(toScreen(undefined, shot)).toBeNull()
  })

  it('speaks the Mac’s modifier keys', () => {
    expect(macCombo('super+v')).toBe('cmd+v')
    expect(macCombo('ctrl+Shift+T')).toBe('ctrl+shift+t')
    expect(macCombo('Return')).toBe('return')
    expect(macCombo('option+Left')).toBe('alt+left')
  })

  it('keeps the clinician’s guidance word for word, without the client’s name or repeats', () => {
    const kept0 = keepable('Sam Rivera’s notes are under Documents', 'Sam Rivera')
    expect(kept0).not.toMatch(/Sam|Rivera/)
    expect(kept0).toContain('notes are under Documents')
    let kept = addInstruction(undefined, 'Use the Notes tab.')
    kept = addInstruction(kept, '  Use the   Notes tab. ')
    kept = addInstruction(kept, 'Pick Free text.')
    expect(kept).toBe('Use the Notes tab.\nPick Free text.')
    expect(addInstruction(kept, '')).toBe(kept)
  })

  it('logs each action in plain words', () => {
    expect(describeAction('left_click', { coordinate: [1, 2] })).toBe('Clicked')
    expect(describeAction('type', { text: 'Rivera' })).toBe('Typed “Rivera”')
    expect(describeAction('scroll', { scroll_direction: 'down' })).toBe('Scrolled down')
  })

  it('accepts a fake EHR served on this Mac, but no other plain http', () => {
    expect(normalizeEhrUrl('http://localhost:5179')).toBe('http://localhost:5179/')
    expect(normalizeEhrUrl('http://127.0.0.1:5179/schedule')).toBe('http://127.0.0.1:5179/schedule')
    expect(normalizeEhrUrl('http://localhost')).toBeNull()
    expect(normalizeEhrUrl('http://localhost.example.com:80')).toBeNull()
    expect(normalizeEhrUrl('localhost')).toBeNull()
  })

  it('replaces a route only with a better one', () => {
    const base = { placed: true, route: '1. click "Notes"', fixed: false, turns: 6, seconds: 60 }
    // A failed run never touches it, however it was written.
    expect(betterRoute({ ...base, placed: false, fixed: true, saved: 'old', savedSeconds: 200 })).toBe(false)
    // The first route is kept.
    expect(betterRoute({ ...base, saved: undefined })).toBe(true)
    // Faster by at least 10% replaces it; a little faster or slower doesn't.
    expect(betterRoute({ ...base, saved: 'old', savedSeconds: 70 })).toBe(true)
    expect(betterRoute({ ...base, saved: 'old', savedSeconds: 64 })).toBe(false)
    expect(betterRoute({ ...base, saved: 'old', savedSeconds: 50 })).toBe(false)
    // Time decides over request count once there's a time.
    expect(betterRoute({ ...base, turns: 2, saved: 'old', savedTurns: 9, savedSeconds: 55 })).toBe(false)
    // A route saved before timing falls back to request count.
    expect(betterRoute({ ...base, saved: 'old', savedTurns: 7 })).toBe(true)
    expect(betterRoute({ ...base, saved: 'old', savedTurns: 6 })).toBe(false)
    // A fix replaces it even if slower.
    expect(betterRoute({ ...base, fixed: true, saved: 'old', savedSeconds: 10 })).toBe(true)
    // A route edited by hand (no time or count) is replaced only by a fix.
    expect(betterRoute({ ...base, seconds: 5, saved: 'mine' })).toBe(false)
    expect(betterRoute({ ...base, route: '  ', saved: undefined })).toBe(false)
  })

  it('clicks a label where it is now, but never guesses between two', () => {
    const at = (x: number, y: number, exact = true) => ({ exact, box: { x, y, width: 100, height: 20 } })
    expect(pickMatch([], null)).toEqual({ error: 'not on screen' })
    expect(pickMatch([at(100, 100)], null)).toEqual({ x: 150, y: 110 })
    // Moved since last time, but the only one: still clicked.
    expect(pickMatch([at(600, 600)], { x: 150, y: 110 })).toEqual({ x: 650, y: 610 })
    // Twice: the one near where it was.
    expect(pickMatch([at(600, 600), at(110, 100)], { x: 150, y: 110 })).toEqual({ x: 160, y: 110 })
    // Twice and neither near: refused.
    expect(pickMatch([at(600, 600), at(900, 100)], { x: 150, y: 110 })).toHaveProperty('error')
    expect(pickMatch([at(600, 600), at(900, 100)], null)).toHaveProperty('error')
    // An exact match beats a longer line that contains the label.
    expect(pickMatch([at(100, 100, false), at(500, 500)], null)).toEqual({ x: 550, y: 510 })
  })

  it('won’t click anything that could sign, save or send', () => {
    for (const l of ['Sign & Lock', 'Save draft', 'Submit', 'Finalize note', 'Send to client', 'Delete']) expect(unsafeLabel(l)).toBe(true)
    for (const l of ['Progress Note', 'Calendar', 'Free text / paste', 'Billing', 'Notes']) expect(unsafeLabel(l)).toBe(false)
  })

  it('keeps a recorded route without the client’s name, and leaves client and date steps to Claude', () => {
    const step = (s: Partial<ScriptStep> & Pick<ScriptStep, 'action'>): ScriptStep => ({ label: '', x: 10, y: 20, text: '', amount: 0, choose: false, what: '', ...s })
    const trace = [
      step({ action: 'click', label: 'Calendar' }),
      step({ action: 'click', label: 'Clients' }), // a dead end
      step({ action: 'click', label: 'Search' }),
      step({ action: 'type', text: 'Rivera' }),
      step({ action: 'key', text: 'return' }),
      step({ action: 'click', label: 'Rivera, Sam' }),
      step({ action: 'click', label: 'Thu 19' }),
      step({ action: 'click', label: '' }), // an icon
      step({ action: 'click', label: 'Progress' }),
      step({ action: 'other', text: 'Right-clicked' })
    ]
    const path = [1, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ step: n, choose: false, what: '' }))
    path[4] = { step: 6, choose: true, what: 'click Sam Rivera in the results' }
    const script = buildScript(trace, path, 'Sam Rivera')
    expect(script.map((x) => x.choose)).toEqual([false, false, false, false, true, true, true, false, true])
    // The search is replayable with a placeholder; nothing saved holds the name.
    expect(script[2].text).toBe('{last}')
    expect(JSON.stringify(script)).not.toMatch(/Sam|Rivera/)
    expect(script[4].what).toBe('click Client Client in the results')
    expect(nextChoose(script, 0)).toBe(4)
    expect(nextChoose(script, 7)).toBe(8)
    expect(nextChoose(script.slice(0, 4), 0)).toBe(4)
    expect(scriptLine(script[0], 0)).toBe('1. click "Calendar" at (10, 20)')
    expect(scriptLine(script[4], 4)).toMatch(/^5\. choose: /)
  })

  it('turns the client’s name into placeholders and back', () => {
    expect(templateText('Sam Rivera', 'Sam Rivera')).toBe('{client}')
    expect(templateText('rivera, sam', 'Sam Rivera')).toBe('{last}, {first}')
    expect(templateText('Riverside', 'Sam Rivera')).toBe('Riverside')
    expect(fillTemplate('{last}, {first}', 'Sam Rivera')).toBe('Rivera, Sam')
  })

  const plan: TreatmentPlan = {
    goals: [
      {
        id: 'g1',
        problem: 'Sam Rivera reports panic attacks most days.',
        goal: 'Reduce panic attacks to fewer than one a week.',
        objectives: [
          { id: 'o1', text: 'Use paced breathing during early signs of panic, 4 of 5 times.', status: 'in_progress' },
          { id: 'o2', text: 'Old objective no longer pursued.', status: 'discontinued' }
        ],
        interventions: 'Interoceptive exposure; ACT defusion skills.',
        status: 'in_progress',
        progress: '',
        targetDate: '2027-02-01',
        createdAt: '',
        updatedAt: ''
      }
    ],
    frequency: 'Weekly 53-minute individual sessions',
    modalities: 'ACT, CBT',
    dischargeCriteria: 'Panic attacks under one a week for two months.',
    reviewDate: '2027-02-15',
    lastReviewed: null,
    updatedAt: ''
  }

  it('gives Claude the plan in numbered pieces, without the client’s name or dropped objectives', () => {
    const pieces = planPieces(plan, 'Sam Rivera')
    expect(pieces.map((p) => p.id)).toEqual(['P1', 'G1', 'G1.O1', 'G1.I', 'G1.T', 'F', 'M', 'D', 'R'])
    expect(JSON.stringify(pieces)).not.toMatch(/Sam|Rivera|no longer pursued/)
    const text = planTask({ ehrName: 'TestEHR', clientName: 'Sam Rivera', today: '2026-11-23', pieces, diagnoses: [{ code: 'F41.0', description: 'Panic disorder' }] })
    expect(text).toContain('[G1.O1] Goal 1, objective 1: Use paced breathing')
    expect(text).toContain('F41.0 Panic disorder')
    expect(text).toContain('first plan in TestEHR')
  })

  it('finds plan pieces that didn’t land anywhere, allowing reformatting', () => {
    const pieces = planPieces(plan, 'Sam Rivera')
    const filled = [
      'Problem: Client reports panic attacks most days.\nGoal: Reduce panic attacks to fewer than one a week.',
      '• Use paced breathing during early signs of panic, 4 of 5 times',
      'Interventions: interoceptive exposure; ACT defusion skills',
      'Weekly 53-minute individual sessions (ACT, CBT)'
    ]
    // Only discharge criteria are missing; dates aren't checked (the EHR formats them its own way).
    expect(unplacedPieces(pieces, filled).map((p) => p.id)).toEqual(['D'])
    expect(unplacedPieces(pieces, [...filled, 'Discharge when panic attacks are under one a week for two months'])).toEqual([])
  })

  it('keeps what notes and plans learn in an EHR apart', () => {
    const ehr: Ehr = { id: 'e', name: 'X', url: 'https://x.test/', route: 'note route', instructions: 'note tip', plan: { route: 'plan route' } }
    expect(learnedFor(ehr, 'note')).toEqual({ route: 'note route', instructions: 'note tip' })
    expect(learnedFor(ehr, 'plan')).toEqual({ route: 'plan route' })
    expect(learnedPatch('plan', { route: 'new' })).toEqual({ plan: { route: 'new' } })
    expect(learnedPatch('note', { route: 'new' })).toEqual({ route: 'new' })
    expect(ehrForClient({ ehrId: 'e' }, [ehr])?.id).toBe('e')
    expect(ehrForClient({}, [ehr])?.id).toBe('e')
    expect(ehrForClient({}, [ehr, { ...ehr, id: 'f' }])).toBeUndefined()
  })
})

describe('batchCounts', () => {
  const item = (state: PlaceBatch['items'][number]['state']) => ({ noteId: state, clientId: 'c', ehrName: 'EHR', state, message: '' })
  it('counts placed, waiting and the rest as needing the clinician', () => {
    const batch: PlaceBatch = { done: true, items: [item('placed'), item('placed'), item('failed'), item('stopped'), item('waiting')] }
    expect(batchCounts(batch)).toEqual({ placed: 2, notPlaced: 2, waiting: 1 })
  })
})

describe('withoutCodes', () => {
  it('drops service codes from a saved route but keeps coordinates', () => {
    expect(withoutCodes("choose: the client's 90837 appointment in that week")).toBe("choose: the client's appointment in that week")
    expect(withoutCodes('the H0031 session')).toBe('the session')
    expect(withoutCodes('click "Open calendar" at (124, 418)')).toBe('click "Open calendar" at (124, 418)')
  })
})
