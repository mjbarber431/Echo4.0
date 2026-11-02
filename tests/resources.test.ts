import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { chatToHtml, splitResourceTokens } from '../src/shared/chat'
import { describeLibrary, findResources, RESOURCES, resourceById, resourceWhere, searchResources, topicsForDiagnoses } from '../src/shared/resources'

describe('resource catalogue', () => {
  it('has unique ids and something to open for every entry', () => {
    expect(new Set(RESOURCES.map((r) => r.id)).size).toBe(RESOURCES.length)
    for (const r of RESOURCES) expect(r.path || r.url, r.title).toBeTruthy()
  })

  it('links only to ACBS and the official safety-planning sites', () => {
    for (const r of RESOURCES.filter((r) => r.url)) expect(r.url).toMatch(/^https:\/\/(contextualscience\.org|suicidesafetyplan\.com|cssrs\.columbia\.edu|988lifeline\.org)\//)
    for (const r of RESOURCES.filter((r) => r.source === 'acbs')) expect(r.url).toMatch(/^https:\/\/contextualscience\.org\//)
  })

  it('points every local entry at a file that exists, when the library is here', () => {
    const root = join(__dirname, '..', 'ClinicalResources')
    if (!existsSync(root)) return
    for (const r of RESOURCES.filter((r) => r.path)) expect(existsSync(join(root, r.path!)), r.path).toBe(true)
  })

  it('gives each compilation section a PDF of just its pages', () => {
    const aaq = RESOURCES.find((r) => r.title.includes('Acceptance and Action Questionnaire (AAQ-2)'))!
    expect(aaq.page).toBe(5)
    expect(aaq.pages).toBe(8)
    expect(aaq.parts?.[0]).toMatchObject({ format: 'pdf', file: expect.stringMatching(/^\.echo\/sections\//) })
    expect(resourceWhere(aaq)).toMatch(/ACT Measures Package.*p\. 5/)
  })

  it('has every part the viewer shows on disk, when the library is here', () => {
    const root = join(__dirname, '..', 'ClinicalResources')
    if (!existsSync(root)) return
    for (const r of RESOURCES) for (const p of r.parts ?? []) {
      expect(existsSync(join(root, p.file)), `${r.title}: ${p.file}`).toBe(true)
      if (p.original) expect(existsSync(join(root, p.original)), p.original).toBe(true)
    }
  })

  it('shows ACBS resources from their downloaded copies', () => {
    const acbs = RESOURCES.filter((r) => r.source === 'acbs')
    expect(acbs.filter((r) => r.parts?.length).length / acbs.length).toBeGreaterThan(0.95)
    for (const r of acbs) for (const p of r.parts ?? []) expect(p.file).toMatch(/^(ACBS\/|\.echo\/)/)
  })
})

describe('resource search', () => {
  it('needs every word and ranks title matches first', () => {
    const hits = searchResources('social anxiety')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((r) => /social/i.test(`${r.title} ${r.note ?? ''} ${r.section ?? ''}`))).toBe(true)
    expect(hits[0].title).toMatch(/social anxiety/i)
  })

  it('reads plurals, word endings and filler words', () => {
    expect(searchResources('worksheets').slice(0, 10).every((r) => r.kind === 'worksheet' || /worksheet/i.test(r.title))).toBe(true)
    expect(searchResources('worksheets').length).toBeGreaterThan(10)
    expect(searchResources('depressed').some((r) => /PHQ-9/.test(r.title))).toBe(true)
    expect(searchResources('a metaphor for defusion')[0].kind).toBe('metaphor')
  })

  it('understands clinical synonyms and audiences', () => {
    expect(searchResources('questionnaire for kids').slice(0, 10).every((r) => r.kind === 'assessment')).toBe(true)
    expect(searchResources('questionnaire for kids').some((r) => r.audience === 'children')).toBe(true)
    expect(searchResources('drinking').some((r) => /AUDIT/.test(r.title))).toBe(true)
    expect(searchResources('suicidal').some((r) => r.topic === 'Safety Planning')).toBe(true)
  })

  it('matches short words whole, so "act" doesn’t find "action"', () => {
    for (const r of searchResources('phq')) expect(r.title).toMatch(/PHQ/)
  })

  it('falls back to near matches, and says so, rather than showing nothing', () => {
    const exact = findResources('panic')
    expect(exact.partial).toBe(false)
    const near = findResources('panic xyzzy')
    expect(near.partial).toBe(true)
    expect(near.items.map((r) => r.id)).toEqual(exact.items.map((r) => r.id))
  })

  it('suggests topics from a client’s diagnoses', () => {
    expect(topicsForDiagnoses([{ code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' }, { code: 'F43.10', description: 'PTSD, unspecified' }])).toEqual(['Depression', 'Trauma & PTSD'])
    expect(topicsForDiagnoses([{ code: 'F41.1', description: 'Generalized anxiety disorder' }])).toEqual(['Anxiety'])
    expect(topicsForDiagnoses([{ code: 'F90.0', description: 'ADHD' }])).toEqual([])
  })
})

describe('resources in chat', () => {
  const r = RESOURCES[0]

  it('turns references into links and flags unknown ones', () => {
    const html = chatToHtml(`Try [[r:${r.id}]] next week, not [[r:ffffffff]].`)
    expect(html).toContain(`data-res="${r.id}"`)
    expect(html).toContain('resource not found')
  })

  it('splits references out of the clinician’s own text', () => {
    expect(splitResourceTokens(`About [[r:${r.id}]] for homework`)).toEqual([{ text: 'About ' }, { id: r.id }, { text: ' for homework' }])
  })

  it('gives Claude every resource by id, grouped by topic', () => {
    const library = describeLibrary()
    for (const x of RESOURCES) expect(library).toContain(`${x.id} ${x.title}`)
    expect(library).toMatch(/^## /m)
    expect(resourceById(r.id)).toBe(r)
  })
})
