import { describe, expect, it } from 'vitest'
import type { Client, Note } from '../src/shared/types'
import { buildChatSystem, chatTitle, chatToHtml, formatCost, threadCost, turnCost, userContent, type ChatThread } from '../src/shared/chat'

const client: Client = {
  id: 'c1',
  name: 'Jordan Avery',
  pronouns: 'they/them',
  setting: 'office',
  diagnoses: [{ code: 'F41.1', description: 'Generalized anxiety disorder' }],
  status: 'active',
  context: 'Jordan reports worry about work. Avery family history of anxiety.',
  scratchpad: 'PRIVATE: my reactions to Jordan',
  plan: null,
  planHistory: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
}

const note = (id: string, date: string, body: string): Note => ({
  id,
  clientId: 'c1',
  type: 'progress',
  format: 'SOAP',
  status: 'final',
  session: { date, cpt: '90837', setting: 'office', participants: 'Client' },
  attest: { noSafetyConcerns: true, mseUnremarkable: true },
  dictation: '',
  sections: [{ heading: 'Subjective', body }],
  reviewItems: [],
  suggestions: null,
  generatedAt: null,
  finalizedAt: null,
  copiedAt: null,
  source: 'desktop',
  createdAt: date,
  updatedAt: date
})

describe('chat prompt', () => {
  const notes = [note('n2', '2026-10-20', 'Jordan felt calmer.'), note('n1', '2026-10-13', 'Jordan was anxious.')]

  it('sends the whole record without the name or the scratchpad', () => {
    const system = buildChatSystem(client, notes, '2026-10-30')
    expect(system).not.toMatch(/Jordan|Avery/)
    expect(system).not.toContain('PRIVATE')
    expect(system).toContain('Client was anxious.')
    expect(system).toContain('Client felt calmer.')
    // Oldest first.
    expect(system.indexOf('anxious')).toBeLessThan(system.indexOf('calmer'))
    expect(system).toContain('F41.1')
    // The library comes before the record, so it's the same for every client.
    expect(system.indexOf('RESOURCE LIBRARY')).toBeLessThan(system.indexOf('CLIENT RECORD'))
  })

  it('removes the name from what the clinician types and adds new notes ahead of it', () => {
    const content = userContent('How is Jordan doing?', client, [note('n3', '2026-10-27', 'Jordan slept better.')])
    expect(content).toHaveLength(2)
    expect(JSON.stringify(content)).not.toContain('Jordan')
    expect(content[1]).toEqual({ type: 'text', text: 'How is Client doing?' })
    expect(content[0].text).toContain('finalized since this chat started')
  })

  it('titles a chat from its first line', () => {
    expect(chatTitle('  What patterns do you see?\nMore')).toBe('What patterns do you see?')
    expect(chatTitle('x'.repeat(100))).toHaveLength(58)
  })
})

describe('chat cost', () => {
  it('prices each reply by its model and usage', () => {
    const turn = { id: 't', role: 'assistant' as const, text: '', content: [], at: '', model: 'claude-opus-5-5', usage: { input: 1000, output: 1000, cacheRead: 100_000, cacheWrite: 0 } }
    // 1k in at $4, 1k out at $20, 100k cache reads at $0.20 per million.
    expect(turnCost(turn)).toBeCloseTo(0.004 + 0.02 + 0.02)
    expect(threadCost({ turns: [turn, { ...turn, model: 'unknown' }] } as unknown as ChatThread)).toBeCloseTo(0.044)
    expect(formatCost(0.004)).toBe('under 1¢')
    expect(formatCost(0.18)).toBe('18¢')
    expect(formatCost(1.5)).toBe('$1.50')
  })
})

describe('chat markdown', () => {
  it('escapes everything Claude writes', () => {
    expect(chatToHtml('<img src=x onerror=alert(1)> **bold**')).toBe('<p>&lt;img src=x onerror=alert(1)&gt; <b>bold</b></p>')
  })

  it('renders lists, headings and inline styles', () => {
    expect(chatToHtml('## Plan\n- one *two*\n- `three`\n\n1. first\n2. second')).toBe(
      '<h3>Plan</h3><ul><li>one <i>two</i></li><li><code>three</code></li></ul><ol><li>first</li><li>second</li></ol>'
    )
  })

  it('renders tables', () => {
    expect(chatToHtml('| Goal | Status |\n|---|---|\n| 1 | Met |')).toBe('<table><thead><tr><th>Goal</th><th>Status</th></tr></thead><tbody><tr><td>1</td><td>Met</td></tr></tbody></table>')
  })

  it('leaves snake_case and lone asterisks alone', () => {
    expect(chatToHtml('goal_id and 2 * 3 * 4')).toBe('<p>goal_id and 2 * 3 * 4</p>')
  })
})
