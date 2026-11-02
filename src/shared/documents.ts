import { KIND_LABEL, resourceById, type Resource, type ResourcePart } from './resources'

// A client's documents: Library worksheets and measures assigned to them, files
// added from elsewhere (a signed consent, outside records), and letters and plans
// Echo wrote. Each keeps its PDF exactly as it was when added, in its own encrypted
// file, and what the clinician filled in or drew on it as data alongside. Echo
// draws that onto the PDF only when it's saved out, so marks stay editable and
// the original is never changed.

export type DocStatus = 'todo' | 'done'

export type DocOrigin =
  | { kind: 'library'; resourceId: string; part: number }
  | { kind: 'upload'; filename: string }
  | { kind: 'letter' }
  | { kind: 'plan' }

/**
 * A page as the editor laid it out: its size at 100% and pdf.js's transform from
 * PDF space to that layout, so marks placed on screen land in the same spot on paper
 * whatever the page's rotation or crop box.
 */
export interface DocPage {
  w: number
  h: number
  /** [a, b, c, d, e, f], PDF user space → top-left page space, at scale 1. */
  t: number[]
}

export type InkColor = 'black' | 'blue' | 'red'

export const INK: Record<InkColor, [number, number, number]> = {
  black: [0.08, 0.08, 0.1],
  blue: [0.1, 0.25, 0.65],
  red: [0.78, 0.12, 0.12]
}
export const HIGHLIGHT: [number, number, number] = [1, 0.89, 0.25]

interface MarkBase {
  id: string
  /** Zero-based page index. */
  page: number
}

/** Coordinates are in page space at scale 1 (points, origin top-left, y down). */
export type DocMark =
  | (MarkBase & { type: 'text'; x: number; y: number; size: number; text: string; color: InkColor })
  /** Centred on x, y. */
  | (MarkBase & { type: 'check' | 'cross'; x: number; y: number; size: number; color: InkColor })
  | (MarkBase & { type: 'circle'; x: number; y: number; w: number; h: number; color: InkColor })
  /** Flat x, y pairs. */
  | (MarkBase & { type: 'ink'; points: number[]; width: number; color: InkColor })
  | (MarkBase & { type: 'highlight'; x: number; y: number; w: number; h: number })
  /** The signature image is copied in, so a later change to the letterhead never alters a signed document. */
  | (MarkBase & { type: 'signature'; x: number; y: number; w: number; h: number; image: string; signer: string })

export type MarkType = DocMark['type']

/** A form field's value: text or a choice's export value, or a checkbox. */
export type FieldValue = string | boolean

export interface ClientDocument {
  id: string
  clientId: string
  title: string
  origin: DocOrigin
  /** The encrypted file holding the original PDF. Never changes once the document exists. */
  file: string
  pageCount: number
  /** To complete with the client, or done (and files that just need keeping). */
  status: DocStatus
  completedAt: string | null
  /** A measure's total, as the clinician wrote it, e.g. "14" or "14 (moderate)". */
  score: string
  /** Set by the editor the first time the document is opened. */
  layout: DocPage[] | null
  marks: DocMark[]
  /** Form fields filled in, by fully qualified field name. */
  fields: Record<string, FieldValue>
  /** A Library resource's tabs, in its one PDF. Missing when the document is a single file. */
  sections?: DocSection[]
  /** Zero-based pages that go out when it's saved, previewed or dragged into the EHR. Missing or empty for every page. */
  exportPages?: number[]
  createdAt: string
  updatedAt: string
}

/** One of a Library resource's tabs within a client's document: its pages start at `start` (zero-based). */
export interface DocSection {
  label: string
  start: number
  count: number
}

/** Text and line height in the editor and on paper, as multiples of the font size. */
export const LINE_HEIGHT = 1.2
/** Helvetica's baseline below the top of a line box of LINE_HEIGHT, as a multiple of the font size. */
export const BASELINE = 0.87

export const isFilledIn = (doc: Pick<ClientDocument, 'marks' | 'fields'>): boolean => doc.marks.length > 0 || Object.keys(doc.fields).length > 0

// ---------------------------------------------------------------------------
// Assigning from the Library
// ---------------------------------------------------------------------------

/** Parts Echo can turn into a client's PDF: documents, ACBS pages and images. Slides, spreadsheets and audio can't be. */
export const assignablePart = (part: ResourcePart): boolean => part.format === 'pdf' || part.format === 'html' || part.format === 'image'

/** The resource's tabs that go into a client's document, in order: everything but slides, spreadsheets and audio. */
export const assignedParts = (r: Resource): number[] => (r.parts ?? []).flatMap((p, i) => (assignablePart(p) ? [i] : []))

export const canAssign = (r: Resource): boolean => assignedParts(r).length > 0

/** The tab a document opens on: the real content rather than an ACBS page's overview. */
export const openingSection = (sections: DocSection[]): number => Math.max(0, sections.findIndex((s) => s.label !== 'Overview'))

/** The pages that go out, in order: the chosen ones, or all of them when none are (or none are valid). */
export function exportedPages(doc: Pick<ClientDocument, 'pageCount' | 'exportPages'>): number[] {
  const chosen = [...new Set(doc.exportPages ?? [])].filter((p) => Number.isInteger(p) && p >= 0 && p < doc.pageCount).sort((a, b) => a - b)
  return chosen.length ? chosen : Array.from({ length: doc.pageCount }, (_, i) => i)
}

/** Measures are given to be completed; handouts and the like are just kept as given. */
export const startsAsTodo = (r: Resource): boolean => r.kind === 'assessment' || r.kind === 'worksheet' || r.kind === 'workbook'

export function originLabel(doc: ClientDocument): string {
  switch (doc.origin.kind) {
    case 'library': {
      const r = resourceById(doc.origin.resourceId)
      return r ? KIND_LABEL[r.kind] : 'Library'
    }
    case 'upload':
      return 'Added file'
    case 'letter':
      return 'Letter'
    case 'plan':
      return 'Treatment plan'
  }
}

/** "Completed" for what the client fills in; "Kept" for handouts, files, letters and plans. */
export function doneLabel(doc: ClientDocument): 'Completed' | 'Kept' {
  if (doc.origin.kind !== 'library') return 'Kept'
  const r = resourceById(doc.origin.resourceId)
  return (r && startsAsTodo(r)) || isFilledIn(doc) ? 'Completed' : 'Kept'
}

export const isMeasure = (doc: ClientDocument): boolean => doc.origin.kind === 'library' && resourceById(doc.origin.resourceId)?.kind === 'assessment'

/**
 * Scores for the same measure over time, oldest first, for a trend like "18 → 14 → 9".
 * Only documents with a score count; the date is when it was completed (or added).
 */
export function scoreHistory(docs: ClientDocument[], doc: ClientDocument): { id: string; score: string; date: string }[] {
  if (doc.origin.kind !== 'library') return []
  const resourceId = doc.origin.resourceId
  return docs
    .filter((d) => d.clientId === doc.clientId && d.origin.kind === 'library' && d.origin.resourceId === resourceId && d.score.trim())
    .map((d) => ({ id: d.id, score: d.score.trim(), date: (d.completedAt ?? d.createdAt).slice(0, 10) }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const unsafe = /[/\\:*?"<>|\u0000-\u001f]/g

/** "PHQ-9 - Jordan Lee - 2026-11-01.pdf": the client's name is in it so the right chart is easy to check on upload. */
export function exportFileName(doc: Pick<ClientDocument, 'title' | 'completedAt' | 'updatedAt'>, clientName: string): string {
  // The day where the clinician is, not in UTC.
  const d = new Date(doc.completedAt ?? doc.updatedAt)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const title = doc.title.replace(unsafe, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Document'
  const name = clientName.replace(unsafe, '').trim()
  return `${[title, name, date].filter(Boolean).join(' - ')}.pdf`
}

/** A new document's title from a file name: no extension, no underscores. */
export function titleFromFile(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Document'
}

// ---------------------------------------------------------------------------
// Geometry, shared by the editor and the PDF writer
// ---------------------------------------------------------------------------

export type Matrix = [number, number, number, number, number, number]

/** a then b, in PDF's row-vector convention (a point goes through a first). */
export function multiply(a: number[], b: number[]): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5]
  ]
}

export function invert(m: number[]): Matrix {
  const det = m[0] * m[3] - m[1] * m[2]
  if (!det) throw new Error('This page’s layout can’t be inverted.')
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]
}

export const apply = (m: number[], x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]

/**
 * Maps "upright page space" (the page as the editor shows it, origin bottom-left, y up)
 * to PDF user space. Drawing in that space puts marks where they were placed and keeps
 * text upright, even on rotated pages.
 */
export function uprightToPdf(page: DocPage): Matrix {
  const flip: Matrix = [1, 0, 0, -1, 0, page.h]
  return multiply(flip, invert(page.t))
}

/** Stroke points for a check mark or a cross centred on x, y (page space, y down). */
export function glyphStrokes(type: 'check' | 'cross', x: number, y: number, size: number): number[][] {
  const s = size
  if (type === 'check') return [[x - 0.36 * s, y + 0.02 * s, x - 0.12 * s, y + 0.3 * s, x + 0.4 * s, y - 0.34 * s]]
  const r = 0.3 * s
  return [
    [x - r, y - r, x + r, y + r],
    [x - r, y + r, x + r, y - r]
  ]
}

export const glyphWidth = (size: number): number => Math.max(1.2, size * 0.12)
