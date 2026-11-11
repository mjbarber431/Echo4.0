// The EHRs the clinician charts in, and how their windows are arranged beside Echo.
// Echo only opens each EHR's own page in Chrome; it never reads from or types into it.

export interface Ehr {
  id: string
  /** What the clinician calls it, e.g. "SimplePractice". */
  name: string
  /** The page to open: usually the EHR's sign-in page or dashboard. Always https. */
  url: string
}

/**
 * How the windows are arranged. Echo is always the first window.
 * - `side`: Echo on the left, one Chrome window on the right with each EHR in a tab; Echo switches between them
 * - `none`: open the EHRs and leave every window where it is
 * - `grid`: Echo and the EHRs share the screen in a grid (four windows: one per corner)
 * - `echo-left`: Echo on the left half, the EHRs stacked on the right
 * - `columns`: side by side, Echo first
 */
export type EhrLayout = 'side' | 'none' | 'grid' | 'echo-left' | 'columns'

export const EHR_LAYOUTS: { value: EhrLayout; label: string }[] = [
  { value: 'side', label: 'Side by side' },
  { value: 'grid', label: 'Grid' },
  { value: 'echo-left', label: 'Echo left' },
  { value: 'columns', label: 'Columns' },
  { value: 'none', label: 'Don’t arrange' }
]

export const DEFAULT_EHR_LAYOUT: EhrLayout = 'side'

/** In the side-by-side layout, Echo's share of the screen width, and the least it gets on a narrow screen. */
export const SIDE_ECHO_SHARE = 0.4
export const SIDE_ECHO_MIN = 600

/** Whether the layout puts every EHR in one window's tabs rather than a window each. */
export const usesTabs = (layout: EhrLayout) => layout === 'side'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The URL to open for what the clinician typed, or null if it can't be an EHR page.
 * A bare address ("secure.simplepractice.com") gets https://. Plain http is refused: it would send the sign-in in the clear.
 */
export function normalizeEhrUrl(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password) return null
  return url.toString()
}

/** The EHRs that can be opened, in order. */
export function usableEhrs(ehrs: Ehr[] | undefined): Ehr[] {
  return (ehrs ?? []).flatMap((e) => {
    const url = normalizeEhrUrl(e.url)
    return url ? [{ ...e, url, name: e.name.trim() || hostOf(url) }] : []
  })
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * The part of the host shared by the EHR's pages, so a tab already open on another of its
 * pages counts: signing in at login.example.com often lands on app.example.com.
 * Naive (the last two labels), which is right for the .com/.net/.io domains EHRs use.
 */
export function siteOf(url: string): string {
  return hostOf(url).replace(/^www\./, '').split('.').slice(-2).join('.')
}

/**
 * Where each of `count` windows goes in `area` (the screen's work area, without the menu bar and Dock).
 * Index 0 is Echo; `side` always gives two (Echo, then the EHRs' window). Edges are rounded so neighbouring windows meet without gaps or overlaps.
 */
export function layoutRects(count: number, area: Rect, layout: EhrLayout): Rect[] {
  if (count <= 0 || layout === 'none') return []
  // Side by side: Echo and one window for all the EHRs, however many there are.
  if (layout === 'side') {
    const echo = Math.round(Math.min(area.width / 2, Math.max(SIDE_ECHO_MIN, area.width * SIDE_ECHO_SHARE)))
    return [
      { x: area.x, y: area.y, width: echo, height: area.height },
      { x: area.x + echo, y: area.y, width: area.width - echo, height: area.height }
    ]
  }
  const cell = (col: number, cols: number, row: number, rows: number, x0 = 0, x1 = 1): Rect => {
    const left = Math.round(area.x + area.width * (x0 + ((x1 - x0) * col) / cols))
    const right = Math.round(area.x + area.width * (x0 + ((x1 - x0) * (col + 1)) / cols))
    const top = Math.round(area.y + (area.height * row) / rows)
    const bottom = Math.round(area.y + (area.height * (row + 1)) / rows)
    return { x: left, y: top, width: right - left, height: bottom - top }
  }
  if (count === 1) return [cell(0, 1, 0, 1)]
  if (layout === 'columns') return Array.from({ length: count }, (_, i) => cell(i, count, 0, 1))
  // Echo on the left half; the rest stacked in the right half.
  const echoLeft = () => {
    const others = count - 1
    return [cell(0, 1, 0, 1, 0, 0.5), ...Array.from({ length: others }, (_, i) => cell(0, 1, i, others, 0.5, 1))]
  }
  if (layout === 'echo-left' || count === 3) return echoLeft()
  // Grid: two windows side by side, four in the corners, more in rows of ceil(√n), a short last row widening to fill.
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  return Array.from({ length: count }, (_, i) => {
    const row = Math.floor(i / cols)
    const inRow = row === rows - 1 ? count - cols * (rows - 1) : cols
    return cell(i % cols, inRow, row, rows)
  })
}
