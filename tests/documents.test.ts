import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts, degrees } from '@cantoo/pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { apply, assignedParts, canAssign, exportedPages, exportFileName, invert, multiply, scoreHistory, titleFromFile, uprightToPdf, type ClientDocument, type DocPage } from '../src/shared/documents'
import { combinePdfs, imagesToPdf, inspectPdf, renderDocument, selectPages } from '../src/shared/documentPdf'
import type { Resource } from '../src/shared/resources'

/** What the editor stores for a page: pdf.js's layout at 100%. */
async function layoutOf(bytes: Uint8Array): Promise<DocPage[]> {
  const doc = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise
  const pages: DocPage[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 })
    pages.push({ w: vp.width, h: vp.height, t: [...vp.transform] })
  }
  return pages
}

/** Text on a page with its position in page space (top-left, y down), as a reader would see it. */
async function textOn(bytes: Uint8Array, pageIndex = 0): Promise<{ str: string; x: number; y: number }[]> {
  const doc = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise
  const page = await doc.getPage(pageIndex + 1)
  const vp = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  return content.items.flatMap((item) => {
    if (!('str' in item) || !item.str.trim()) return []
    const [x, y] = vp.convertToViewportPoint(item.transform[4], item.transform[5])
    return [{ str: item.str, x, y }]
  })
}

const baseDoc = (over: Partial<ClientDocument> = {}): ClientDocument => ({
  id: 'd1',
  clientId: 'c1',
  title: 'PHQ-9',
  origin: { kind: 'library', resourceId: 'r1', part: 0 },
  file: 'f1',
  pageCount: 1,
  status: 'todo',
  completedAt: null,
  score: '',
  layout: null,
  marks: [],
  fields: {},
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
  ...over
})

describe('document geometry', () => {
  it('inverts and composes matrices', () => {
    const m = [0, 1, -1, 0, 30, 40]
    const id = multiply(m, invert(m))
    expect(id.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([1, 0, 0, 1, 0, 0])
  })

  it('maps upright page space back onto the PDF for unrotated and rotated pages', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage([612, 792])
    pdf.addPage([612, 792]).setRotation(degrees(90))
    const layout = await layoutOf(await pdf.save())
    expect(layout[1].w).toBeCloseTo(792)
    for (const page of layout) {
      const toPdf = uprightToPdf(page)
      // The top-left corner of the page as shown is (0, h) upright; through the viewport it must land back on (0, 0).
      const [px, py] = apply(toPdf, 10, page.h - 20)
      const [vx, vy] = apply(page.t, px, py)
      expect(vx).toBeCloseTo(10)
      expect(vy).toBeCloseTo(20)
    }
  })
})

describe('writing a document out', () => {
  it('returns the original when nothing was filled in', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage()
    const bytes = await pdf.save()
    expect(await renderDocument(bytes, { layout: null, marks: [], fields: {} })).toBe(bytes)
  })

  it('puts typed text where it was placed, upright, on plain and rotated pages', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage([612, 792])
    pdf.addPage([612, 792]).setRotation(degrees(90))
    const original = await pdf.save()
    const layout = await layoutOf(original)
    const out = await renderDocument(original, {
      layout,
      fields: {},
      marks: [
        { id: 'a', page: 0, type: 'text', x: 100, y: 200, size: 12, text: 'Slept 5 hours\nWalked twice', color: 'black' },
        { id: 'b', page: 1, type: 'text', x: 300, y: 100, size: 12, text: 'Rotated note', color: 'blue' },
        { id: 'c', page: 0, type: 'check', x: 50, y: 50, size: 14, color: 'black' },
        { id: 'd', page: 0, type: 'ink', points: [10, 10, 20, 20, 30, 10], width: 2, color: 'red' },
        { id: 'e', page: 0, type: 'highlight', x: 90, y: 195, w: 120, h: 16 },
        { id: 'f', page: 0, type: 'circle', x: 300, y: 300, w: 22, h: 22, color: 'black' }
      ]
    })
    const first = await textOn(out, 0)
    const slept = first.find((t) => t.str === 'Slept 5 hours')!
    expect(slept.x).toBeCloseTo(100, 0)
    // The baseline sits BASELINE × size below the box's top.
    expect(slept.y).toBeCloseTo(200 + 0.87 * 12, 0)
    const walked = first.find((t) => t.str === 'Walked twice')!
    expect(walked.y - slept.y).toBeCloseTo(1.2 * 12, 0)
    const rotated = (await textOn(out, 1)).find((t) => t.str === 'Rotated note')!
    expect(rotated.x).toBeCloseTo(300, 0)
    expect(rotated.y).toBeCloseTo(100 + 0.87 * 12, 0)
  })

  it('fills and flattens form fields', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([612, 792])
    const form = pdf.getForm()
    const name = form.createTextField('client.name')
    name.addToPage(page, { x: 50, y: 700, width: 200, height: 20 })
    const ok = form.createCheckBox('consent')
    ok.addToPage(page, { x: 50, y: 650, width: 14, height: 14 })
    const out = await renderDocument(await pdf.save(), { layout: await layoutOf(await pdf.save()), marks: [], fields: { 'client.name': 'Taylor “TJ” Smith ☺', consent: true, missing: 'x' } })
    const reread = await PDFDocument.load(out)
    expect(reread.getForm().getFields()).toHaveLength(0)
    // Curly quotes survive; the emoji Helvetica can't draw becomes "?".
    expect((await textOn(out)).map((t) => t.str).join(' ')).toContain('Taylor “TJ” Smith ?')
  })

  it('draws a signature image', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage([612, 792])
    const original = await pdf.save()
    // A 1×1 PNG.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const out = await renderDocument(original, { layout: await layoutOf(original), fields: {}, marks: [{ id: 's', page: 0, type: 'signature', x: 50, y: 600, w: 150, h: 40, image: png, signer: 'matthew' }] })
    expect(out.length).toBeGreaterThan(original.length)
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1)
  })

  it('turns images into one page each and checks PDFs', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    const bytes = await imagesToPdf([{ bytes: png, type: 'png' }, { bytes: png, type: 'png' }])
    expect(await inspectPdf(bytes)).toEqual({ pageCount: 2 })
    await expect(inspectPdf(new TextEncoder().encode('not a pdf'))).rejects.toThrow(/couldn’t read/)
  })
})

describe('one document from several tabs', () => {
  async function pdfOf(...labels: string[]): Promise<Uint8Array> {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    for (const label of labels) pdf.addPage([612, 792]).drawText(label, { x: 72, y: 700, size: 14, font })
    return pdf.save()
  }

  it('joins the tabs in order and counts each one’s pages', async () => {
    const { bytes, counts } = await combinePdfs([await pdfOf('Measure 1', 'Measure 2'), await pdfOf('Scoring')])
    expect(counts).toEqual([2, 1])
    expect(await inspectPdf(bytes)).toEqual({ pageCount: 3 })
    expect((await textOn(bytes, 2)).map((t) => t.str)).toEqual(['Scoring'])
  })

  it('flattens form fields, which copied pages can’t keep', async () => {
    const form = await PDFDocument.create()
    form.addPage([612, 792])
    form.getForm().createTextField('name').addToPage(form.getPage(0), { x: 72, y: 600, width: 200, height: 20 })
    const { bytes } = await combinePdfs([await form.save(), await pdfOf('Scoring')])
    expect((await PDFDocument.load(bytes)).getForm().getFields()).toHaveLength(0)
  })

  it('keeps only the pages chosen for export, with what was drawn on them', async () => {
    const original = (await combinePdfs([await pdfOf('Measure'), await pdfOf('Scoring'), await pdfOf('Charts')])).bytes
    const layout = await layoutOf(original)
    const doc = baseDoc({ pageCount: 3, layout, marks: [{ id: 'm', page: 2, type: 'text', x: 100, y: 300, size: 12, text: 'Week 3', color: 'black' }] })
    const out = await selectPages(await renderDocument(original, doc), exportedPages({ pageCount: 3, exportPages: [0, 2] }))
    expect(await inspectPdf(out)).toEqual({ pageCount: 2 })
    expect((await textOn(out, 1)).map((t) => t.str)).toEqual(expect.arrayContaining(['Charts', 'Week 3']))
    expect(await selectPages(original, [0, 1, 2])).toBe(original)
  })
})

describe('document helpers', () => {
  const r = (over: Partial<Resource>): Resource => ({ id: 'r', title: 'Values Card Sort', topic: 'ACT', kind: 'exercise', audience: 'adults', ...over })

  it('assigns every tab Echo can print, in order, but never audio or slides', () => {
    const acbs = r({ parts: [{ label: 'Overview', file: 'a.html', format: 'html' }, { label: 'cards.pdf', file: 'b.pdf', format: 'pdf' }, { label: 'track.mp3', file: 't.mp3', format: 'audio' }, { label: 'deck.pptx', file: 'd.pptx', format: 'office' }, { label: 'sheet.png', file: 's.png', format: 'image' }] })
    expect(assignedParts(acbs)).toEqual([0, 1, 4])
    expect(canAssign(r({ parts: [{ label: 'track.mp3', file: 't.mp3', format: 'audio' }] }))).toBe(false)
    expect(canAssign(r({ url: 'https://contextualscience.org/x' }))).toBe(false)
  })

  it('exports the chosen pages, or every page when none valid are chosen', () => {
    expect(exportedPages({ pageCount: 4 })).toEqual([0, 1, 2, 3])
    expect(exportedPages({ pageCount: 4, exportPages: [] })).toEqual([0, 1, 2, 3])
    expect(exportedPages({ pageCount: 4, exportPages: [3, 1, 1] })).toEqual([1, 3])
    expect(exportedPages({ pageCount: 4, exportPages: [7, -1, 1.5] })).toEqual([0, 1, 2, 3])
  })

  it('names exported files after the document, client and date', () => {
    expect(exportFileName({ title: 'PHQ-9: Week 3/4', completedAt: '2026-10-05T12:00:00', updatedAt: '2026-10-09T12:00:00' }, 'Jordan Lee')).toBe('PHQ-9 Week 34 - Jordan Lee - 2026-10-05.pdf')
    expect(titleFromFile('signed_consent_form.PDF')).toBe('signed consent form')
  })

  it('lists a measure’s scores oldest first', () => {
    const docs = [
      baseDoc({ id: 'a', score: '18', completedAt: '2026-09-01T00:00:00Z' }),
      baseDoc({ id: 'b', score: '', completedAt: '2026-09-15T00:00:00Z' }),
      baseDoc({ id: 'c', score: '11 ', completedAt: '2026-10-01T00:00:00Z' }),
      baseDoc({ id: 'd', score: '7', clientId: 'other' })
    ]
    expect(scoreHistory(docs, docs[0]).map((s) => s.score)).toEqual(['18', '11'])
  })
})
