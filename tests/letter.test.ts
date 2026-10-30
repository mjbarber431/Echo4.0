import { describe, expect, it } from 'vitest'
import { DEFAULT_LETTERHEAD, letterDate, letterToDocumentHtml, type Letter } from '../src/shared/letter'
import { buildLetterMessages, restoreLetterName } from '../src/shared/prompts'

const letter: Letter = {
  date: '2026-10-26',
  recipient: 'Ms. Lee\nRiverside School',
  subject: 'Sam <Example>',
  salutation: 'Dear Ms. Lee,',
  body: 'First paragraph.\n\nSecond <b>paragraph</b>.',
  closing: 'Sincerely,',
  signerIds: ['grace']
}

describe('letter', () => {
  it('escapes what the clinician types', () => {
    const html = letterToDocumentHtml(letter, DEFAULT_LETTERHEAD)
    expect(html).toContain('RE: Sam &lt;Example&gt;')
    expect(html).toContain('<p>Second &lt;b&gt;paragraph&lt;/b&gt;.</p>')
    expect(html).toContain('October 26, 2026')
  })

  it('signs only with the chosen signers', () => {
    const html = letterToDocumentHtml(letter, DEFAULT_LETTERHEAD)
    expect(html).toContain('Grace Bryan, LCSW')
    expect(html).not.toContain('Matthew Barber, LPC')
  })

  it('embeds only image data URLs', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const lh = { ...DEFAULT_LETTERHEAD, logo: 'https://example.com/x.png', signers: DEFAULT_LETTERHEAD.signers.map((s) => ({ ...s, signature: png })) }
    const html = letterToDocumentHtml(letter, lh)
    expect(html).not.toContain('example.com')
    expect(html).toContain(`<img src="${png}"`)
  })

  it('puts the footer on the sheet only in preview', () => {
    expect(letterToDocumentHtml(letter, DEFAULT_LETTERHEAD, true)).toContain('page-foot')
    expect(letterToDocumentHtml(letter, DEFAULT_LETTERHEAD)).not.toContain('page-foot')
  })

  it('leaves an unparseable date as typed', () => {
    expect(letterDate('soon')).toBe('soon')
  })
})

describe('letter prompt', () => {
  const input = {
    draft: 'Sam Example has come weekly. Sam’s anxiety is better. Ask Ms. Lee about Sam.',
    recipient: 'Ms. Lee',
    subject: 'Sam Example',
    salutation: 'Dear Ms. Lee,',
    closing: 'Sincerely,',
    signers: ['Grace Bryan, LCSW, Licensed Clinical Social Worker'],
    clientName: 'Sam Example',
    pronouns: 'she/her'
  }

  it('never sends the client’s name', () => {
    const text = buildLetterMessages(input).map((m) => m.content).join('\n')
    expect(text).not.toMatch(/Sam|Example/)
    expect(text).toContain('[Client]’s anxiety')
    expect(text).toContain('RE line: [Client]\n')
    expect(text).toContain('[Client] has come weekly')
  })

  it('puts the name back', () => {
    expect(restoreLetterName('[Client] attends weekly. [First] is engaged.', 'Sam Example')).toBe('Sam Example attends weekly. Sam is engaged.')
  })
})
