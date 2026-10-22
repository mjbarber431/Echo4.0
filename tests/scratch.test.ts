import { describe, expect, it } from 'vitest'
import { escapeInline, escapeItemStart, escapeLineStart, inlineToHtml, openLoopCount, parseScratch, SCRATCH_TEMPLATES, scratchToHtml } from '../src/shared/scratch'

describe('scratchpad format', () => {
  it('loads plain text from before formatting as paragraphs', () => {
    expect(scratchToHtml('Ask about the move\n\nSister is Dana')).toBe('<p>Ask about the move</p><p><br></p><p>Sister is Dana</p>')
    expect(scratchToHtml('')).toBe('<p><br></p>')
  })

  it('parses each block kind', () => {
    expect(parseScratch('## Big\n### Small\n- a\n1. b\n- [ ] c\n- [x] d\n> e\n---\nf').map((b) => b.kind)).toEqual([
      'h2',
      'h3',
      'bullet',
      'number',
      'todo',
      'todo',
      'quote',
      'hr',
      'p'
    ])
  })

  it('groups list items and keeps checklist state', () => {
    expect(scratchToHtml('- [ ] call school\n- [x] send ROI\n- plain')).toBe(
      '<ul data-type="checklist"><li data-checked="false">call school</li><li data-checked="true">send ROI</li></ul><ul><li>plain</li></ul>'
    )
    expect(scratchToHtml('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>')
  })

  it('renders inline formatting, nested', () => {
    expect(inlineToHtml('**bold _both_** and ~~gone~~')).toBe('<b>bold <i>both</i></b> and <s>gone</s>')
    expect(inlineToHtml('==hi== =={green}there==')).toContain('background-color: rgba(250, 204, 21')
    expect(inlineToHtml('=={green}there==')).toBe('<span style="background-color: rgba(74, 222, 128, 0.3)">there</span>')
    // Adjacent runs of different formats, as the editor writes them.
    expect(inlineToHtml('**a****_b_**')).toBe('<b>a</b><b><i>b</i></b>')
  })

  it('leaves unclosed markers literal', () => {
    expect(inlineToHtml('5 ** 3 and snake_case')).toBe('5 ** 3 and snake_case')
  })

  it('escapes HTML so stored text can never become markup', () => {
    const html = scratchToHtml('<img src=x onerror=alert(1)>\n## <script>x</script>\n==<b>"q"</b>==')
    expect(html).not.toMatch(/<img|<script|<b>"/)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&quot;q&quot;')
  })

  it('round-trips literal markers through escaping', () => {
    const text = 'a * b ** c _d_ ~~e~~ ==f== \\ g'
    expect(inlineToHtml(escapeInline(text))).toBe(text)
    expect(parseScratch(escapeLineStart('- not a bullet'))[0]).toEqual({ kind: 'p', text: '\\- not a bullet' })
    expect(inlineToHtml(escapeLineStart('# not a heading'))).toBe('# not a heading')
    expect(parseScratch(`- ${escapeItemStart('[ ] literal')}`)[0].kind).toBe('bullet')
  })

  it('keeps backslashes that are not escapes', () => {
    expect(inlineToHtml('C:\\temp\\notes')).toBe('C:\\temp\\notes')
  })

  it('counts open loops for the tab badge', () => {
    expect(openLoopCount('- [ ] a\n- [x] b\n- [ ] c\n- d')).toBe(2)
    expect(openLoopCount('just text')).toBe(0)
  })

  it('templates parse into the blocks they promise', () => {
    for (const t of SCRATCH_TEMPLATES) expect(parseScratch(t.md('Monday, October 19'))[0].kind).toBe('h3')
    expect(openLoopCount(SCRATCH_TEMPLATES.find((t) => t.id === 'next')!.md(''))).toBe(3)
  })
})
