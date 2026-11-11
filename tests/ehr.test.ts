import { describe, expect, it } from 'vitest'
import type { Client, Note } from '../src/shared/types'
import { defaultAttestations } from '../src/shared/compliance'
import { layoutRects, normalizeEhrUrl, siteOf, usableEhrs, type Rect } from '../src/shared/ehr'
import { buildQueue, chartNotes, chartStatus, extendChart, nextToChart } from '../src/shared/queue'

const AREA: Rect = { x: 0, y: 25, width: 1512, height: 919 }

/** Every pixel of the area covered exactly once. */
function tiles(rects: Rect[], area: Rect): boolean {
  const total = rects.reduce((sum, r) => sum + r.width * r.height, 0)
  if (total !== area.width * area.height) return false
  return rects.every((a, i) =>
    rects.every((b, j) => i === j || a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y)
  )
}

describe('EHR addresses', () => {
  it('adds https to a bare address and refuses anything else', () => {
    expect(normalizeEhrUrl('secure.simplepractice.com')).toBe('https://secure.simplepractice.com/')
    expect(normalizeEhrUrl(' https://www.therapynotes.com/app/login/ ')).toBe('https://www.therapynotes.com/app/login/')
    expect(normalizeEhrUrl('http://ehr.example.com')).toBeNull()
    expect(normalizeEhrUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeEhrUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeEhrUrl('https://user:pass@ehr.example.com')).toBeNull()
    expect(normalizeEhrUrl('localhost')).toBeNull()
    expect(normalizeEhrUrl('')).toBeNull()
  })

  it('treats another page of the same EHR as already open', () => {
    expect(siteOf('https://login.example-ehr.com/signin')).toBe('example-ehr.com')
    expect(siteOf('https://app.example-ehr.com/dashboard')).toBe('example-ehr.com')
    expect(siteOf('https://www.therapynotes.com/')).toBe('therapynotes.com')
  })

  it('names an unnamed EHR after its address and drops unusable rows', () => {
    const ehrs = usableEhrs([
      { id: 'a', name: '', url: 'secure.simplepractice.com' },
      { id: 'b', name: 'Old', url: 'http://insecure.example.com' },
      { id: 'c', name: ' TherapyNotes ', url: 'https://www.therapynotes.com' }
    ])
    expect(ehrs.map((e) => e.name)).toEqual(['secure.simplepractice.com', 'TherapyNotes'])
  })
})

describe('window layouts', () => {
  it('puts Echo and three EHRs one per corner', () => {
    const r = layoutRects(4, AREA, 'grid')
    expect(r[0]).toEqual({ x: 0, y: 25, width: 756, height: 460 })
    expect(r[3]).toEqual({ x: 756, y: 485, width: 756, height: 459 })
    expect(tiles(r, AREA)).toBe(true)
  })

  it('tiles the screen exactly in every layout and count', () => {
    for (const layout of ['grid', 'echo-left', 'columns'] as const) {
      for (let n = 1; n <= 9; n++) {
        const r = layoutRects(n, AREA, layout)
        expect(r).toHaveLength(n)
        expect(tiles(r, AREA), `${layout} × ${n}`).toBe(true)
      }
    }
  })

  it('keeps Echo on the left half with the EHRs stacked beside it', () => {
    const r = layoutRects(4, AREA, 'echo-left')
    expect(r[0]).toMatchObject({ x: 0, width: 756, height: 919 })
    expect(r.slice(1).every((x) => x.x === 756 && x.width === 756)).toBe(true)
  })

  it('gives three windows Echo’s half and two quarters rather than leaving a corner empty', () => {
    expect(layoutRects(3, AREA, 'grid')).toEqual(layoutRects(3, AREA, 'echo-left'))
  })

  it('side by side gives Echo 40% (at least 600 px, at most half) and one window for every EHR', () => {
    const r = layoutRects(4, AREA, 'side')
    expect(r).toEqual([
      { x: 0, y: 25, width: 605, height: 919 },
      { x: 605, y: 25, width: 907, height: 919 }
    ])
    expect(tiles(r, AREA)).toBe(true)
    expect(layoutRects(2, { ...AREA, width: 1300 }, 'side')[0].width).toBe(600)
    expect(layoutRects(2, { ...AREA, width: 1100 }, 'side')[0].width).toBe(550)
    expect(layoutRects(2, { ...AREA, width: 2560 }, 'side')[0].width).toBe(1024)
  })

  it('leaves windows alone when arranging is off', () => {
    expect(layoutRects(4, AREA, 'none')).toEqual([])
  })
})

const client = { id: 'c1', name: 'Jordan' } as Client

function note(id: string, overrides: Partial<Note>): Note {
  return {
    id,
    clientId: 'c1',
    type: 'progress',
    format: 'SOAP',
    status: 'draft',
    session: { date: '2026-11-10', cpt: '90837', setting: 'office', participants: 'Client' },
    attest: defaultAttestations(),
    dictation: 'x',
    sections: [{ heading: 'S', body: 'b' }],
    reviewItems: [],
    suggestions: null,
    generatedAt: '2026-11-10T10:00:00Z',
    finalizedAt: null,
    copiedAt: null,
    source: 'desktop',
    createdAt: '2026-11-10',
    updatedAt: '2026-11-10',
    ...overrides
  }
}

describe('charting', () => {
  const ready = note('ready', { generatedAt: '2026-11-10T11:00:00Z' })
  const uncopied = note('uncopied', { status: 'final', generatedAt: '2026-11-10T09:00:00Z', finalizedAt: '2026-11-10T12:00:00Z' })
  const copied = note('copied', { status: 'final', finalizedAt: '2026-11-10T12:00:00Z', copiedAt: '2026-11-10T12:01:00Z' })
  const unwritten = note('unwritten', { sections: [], generatedAt: null })

  it('charts drafts to review and uncopied notes, in the order they were written', () => {
    const q = buildQueue([ready, uncopied, copied, unwritten], [client], {}, '2026-11-10')
    expect(chartNotes(q).map((n) => n.id)).toEqual(['uncopied', 'ready'])
    expect([ready, uncopied, copied].map(chartStatus)).toEqual(['review', 'copy', 'done'])
  })

  it('keeps charted notes, drops deleted ones and adds newly written ones at the end', () => {
    const later = note('later', { generatedAt: '2026-11-10T13:00:00Z' })
    const notes = [{ ...uncopied, copiedAt: '2026-11-10T12:05:00Z' }, later]
    const q = buildQueue(notes, [client], {}, '2026-11-10')
    expect(extendChart(['uncopied', 'ready'], notes, q)).toEqual(['uncopied', 'later'])
    const same = ['uncopied', 'later']
    expect(extendChart(same, notes, q)).toBe(same)
  })

  it('offers the next note that still needs something, wrapping round', () => {
    const a = note('a', {})
    const b = note('b', { status: 'final', copiedAt: 'x' })
    const c = note('c', {})
    expect(nextToChart(['a', 'b', 'c'], [a, b, c], 'a')?.id).toBe('c')
    expect(nextToChart(['a', 'b', 'c'], [a, b, c], 'c')?.id).toBe('a')
    expect(nextToChart(['a', 'b'], [a, b], 'a')).toBeNull()
  })
})
