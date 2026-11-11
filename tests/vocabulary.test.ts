import { describe, expect, it } from 'vitest'
import { BUILT_IN_VOCABULARY, MAX_CUSTOM_TERMS, parseCustomVocabulary, vocabularyTerms } from '../src/shared/vocabulary'

describe('vocabulary', () => {
  it('reads every group of the built-in list, aliases included', () => {
    const texts = BUILT_IN_VOCABULARY.map((e) => e.text)
    expect(texts).toContain('sertraline')
    expect(texts).toContain('trichotillomania')
    expect(BUILT_IN_VOCABULARY.find((e) => e.text === 'cognitive defusion')?.aliases).toContain('cognitive diffusion')
    expect(BUILT_IN_VOCABULARY.every((e) => e.text.length >= 3)).toBe(true)
  })

  it('reads one term per line, with mishearings after "="', () => {
    expect(parseCustomVocabulary('Jardiance\n\n  Klonopin = clonopin, clono pin \nab\n')).toEqual([
      { text: 'Jardiance' },
      { text: 'Klonopin', aliases: ['clonopin', 'clono pin'] }
    ])
  })

  it('caps how many terms can be added', () => {
    const lines = Array.from({ length: MAX_CUSTOM_TERMS + 20 }, (_, i) => `term${i}`).join('\n')
    expect(parseCustomVocabulary(lines)).toHaveLength(MAX_CUSTOM_TERMS)
  })

  it('adds custom terms after the built-in ones', () => {
    const all = vocabularyTerms('Jardiance')
    expect(all.length).toBe(BUILT_IN_VOCABULARY.length + 1)
    expect(all.at(-1)).toEqual({ text: 'Jardiance' })
  })
})
