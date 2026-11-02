import {
  BlendMode,
  LineCapStyle,
  LineJoinStyle,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  concatTransformationMatrix,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  type PDFFont,
  type PDFPage
} from '@cantoo/pdf-lib'
import { BASELINE, HIGHLIGHT, INK, LINE_HEIGHT, glyphStrokes, glyphWidth, isFilledIn, uprightToPdf, type ClientDocument, type DocMark, type DocPage, type FieldValue } from './documents'

// Writes a client document out as a finished PDF: the original with the form
// fields filled in and flattened, and the marks drawn on as ordinary page content,
// so it looks the same in Preview, a browser or any EHR's document viewer.

type Markup = Pick<ClientDocument, 'layout' | 'marks' | 'fields'>

/** Opens a PDF for writing. Owner-protected PDFs (no password needed to open) are opened too. */
export async function openPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { password: '', updateMetadata: false })
  } catch (err) {
    throw new Error(`Echo couldn’t read this PDF (${(err as Error).message}). If it needs a password to open, save an unprotected copy first.`)
  }
}

/** Checks a file is a PDF Echo can work with and counts its pages. */
export async function inspectPdf(bytes: Uint8Array): Promise<{ pageCount: number }> {
  const pdf = await openPdf(bytes)
  const pageCount = pdf.getPageCount()
  if (!pageCount) throw new Error('That PDF has no pages.')
  return { pageCount }
}

/** One page per image, each fitted on a US Letter page with half-inch margins. */
export async function imagesToPdf(images: { bytes: Uint8Array; type: 'png' | 'jpg' }[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  for (const image of images) {
    const embedded = image.type === 'png' ? await pdf.embedPng(image.bytes) : await pdf.embedJpg(image.bytes)
    const landscape = embedded.width > embedded.height
    const [pw, ph] = landscape ? [792, 612] : [612, 792]
    const scale = Math.min((pw - 72) / embedded.width, (ph - 72) / embedded.height, 1)
    const w = embedded.width * scale
    const h = embedded.height * scale
    pdf.addPage([pw, ph]).drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h })
  }
  return pdf.save()
}

/**
 * Several PDFs as one, in order, with how many pages each brought. Form fields are
 * flattened first: copied pages lose their place in the form, so a field would show
 * in the editor but never reach the finished PDF. The markup tools fill them instead.
 */
export async function combinePdfs(files: Uint8Array[]): Promise<{ bytes: Uint8Array; counts: number[] }> {
  const out = await PDFDocument.create()
  const counts: number[] = []
  for (const bytes of files) {
    const src = await openPdf(bytes)
    try {
      src.getForm().flatten()
    } catch {
      // A form pdf-lib can't flatten keeps its fields' printed look.
    }
    const pages = await out.copyPages(src, src.getPageIndices())
    for (const page of pages) out.addPage(page)
    counts.push(pages.length)
  }
  return { bytes: await out.save(), counts }
}

/** Just these pages (zero-based, in order) of a PDF. */
export async function selectPages(bytes: Uint8Array, pages: number[]): Promise<Uint8Array> {
  const src = await openPdf(bytes)
  if (pages.length === src.getPageCount() && pages.every((p, i) => p === i)) return bytes
  const out = await PDFDocument.create()
  for (const page of await out.copyPages(src, pages)) out.addPage(page)
  return out.save()
}

/** The finished PDF. Returns the original untouched when nothing has been filled in. */
export async function renderDocument(original: Uint8Array, markup: Markup): Promise<Uint8Array> {
  if (!isFilledIn(markup)) return original
  const pdf = await openPdf(original)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  if (Object.keys(markup.fields).length) fillFields(pdf, markup.fields, font)
  const pages = pdf.getPages()
  const byPage = new Map<number, DocMark[]>()
  for (const m of markup.marks) byPage.set(m.page, [...(byPage.get(m.page) ?? []), m])
  for (const [index, marks] of byPage) {
    const page = pages[index]
    const layout = markup.layout?.[index]
    if (!page || !layout) continue
    await drawMarks(pdf, page, layout, marks, font)
  }
  return pdf.save()
}

/** Text Helvetica can't draw (emoji, most non-Latin scripts) becomes "?" rather than failing the whole document. */
export function printable(text: string, font: PDFFont): string {
  const known = new Set(font.getCharacterSet())
  return [...text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')]
    .map((ch) => (ch === '\n' || known.has(ch.codePointAt(0)!) ? ch : ch === '✓' || ch === '✔' ? 'X' : '?'))
    .join('')
}

function fillFields(pdf: PDFDocument, values: Record<string, FieldValue>, font: PDFFont): void {
  const form = pdf.getForm()
  for (const [name, value] of Object.entries(values)) {
    try {
      const field = form.getFieldMaybe(name)
      if (!field) continue
      if (field instanceof PDFTextField) {
        const text = printable(String(value), font)
        const max = field.getMaxLength()
        field.setText(max !== undefined ? text.slice(0, max) : text)
      } else if (field instanceof PDFCheckBox) {
        if (value === true) field.check()
        else field.uncheck()
      } else if (field instanceof PDFRadioGroup) {
        if (typeof value === 'string' && value) field.select(value)
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        if (typeof value === 'string' && value) field.select(value)
      }
    } catch {
      // A field pdf-lib can't set (an unusual export value, say) is skipped rather than losing the rest.
    }
  }
  try {
    form.updateFieldAppearances(font)
    form.flatten()
  } catch {
    // Flattening fails on some malformed forms. The values are still set, so they show in any PDF viewer.
  }
}

async function drawMarks(pdf: PDFDocument, page: PDFPage, layout: DocPage, marks: DocMark[], font: PDFFont): Promise<void> {
  const H = layout.h
  // Everything below is drawn in upright page space: origin bottom-left of the page as the editor shows it.
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...uprightToPdf(layout)))
  const images = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>()
  for (const m of marks) {
    switch (m.type) {
      case 'text': {
        const [r, g, b] = INK[m.color]
        printable(m.text, font)
          .split('\n')
          .forEach((line, i) => {
            if (line) page.drawText(line, { x: m.x, y: H - (m.y + (i * LINE_HEIGHT + BASELINE) * m.size), size: m.size, font, color: rgb(r, g, b) })
          })
        break
      }
      case 'check':
      case 'cross':
        strokePaths(page, H, glyphStrokes(m.type, m.x, m.y, m.size), glyphWidth(m.size), INK[m.color])
        break
      case 'ink':
        strokePaths(page, H, [m.points], m.width, INK[m.color])
        break
      case 'circle': {
        const [r, g, b] = INK[m.color]
        page.drawEllipse({ x: m.x + m.w / 2, y: H - (m.y + m.h / 2), xScale: m.w / 2, yScale: m.h / 2, borderColor: rgb(r, g, b), borderWidth: 1.4 })
        break
      }
      case 'highlight': {
        const [r, g, b] = HIGHLIGHT
        page.drawRectangle({ x: m.x, y: H - m.y - m.h, width: m.w, height: m.h, color: rgb(r, g, b), opacity: 0.45, blendMode: BlendMode.Multiply })
        break
      }
      case 'signature': {
        const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(m.image)
        if (!match) break
        let image = images.get(m.image)
        if (!image) {
          const bytes = Buffer.from(match[2], 'base64')
          image = match[1] === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes)
          images.set(m.image, image)
        }
        page.drawImage(image, { x: m.x, y: H - m.y - m.h, width: m.w, height: m.h })
        break
      }
    }
  }
  page.pushOperators(popGraphicsState())
}

/** Strokes polylines given in page space (y down). */
function strokePaths(page: PDFPage, H: number, paths: number[][], width: number, [r, g, b]: [number, number, number]): void {
  const ops = [pushGraphicsState(), setStrokingRgbColor(r, g, b), setLineWidth(width), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round)]
  for (const pts of paths) {
    if (pts.length < 2) continue
    ops.push(moveTo(pts[0], H - pts[1]))
    // A single tap still leaves a dot.
    if (pts.length === 2) ops.push(lineTo(pts[0] + 0.01, H - pts[1]))
    for (let i = 2; i < pts.length; i += 2) ops.push(lineTo(pts[i], H - pts[i + 1]))
  }
  ops.push(stroke(), popGraphicsState())
  page.pushOperators(...ops)
}
