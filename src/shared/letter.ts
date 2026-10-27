import { escapeHtml, paragraphsHtml } from './format'

// Letters on the practice's letterhead (for a school, an employer, another
// provider). The same page is shown in the editor's preview and rendered to PDF
// in the main process, so what the clinician sees is what they save.

export interface Signer {
  id: string
  name: string
  credentials: string
  title: string
  /** PNG data URL of the signature, or '' to leave room for signing by hand. */
  signature: string
}

/** The practice's letterhead. Stored in the vault, since the signatures are private. */
export interface Letterhead {
  practiceName: string
  tagline: string
  /** One line each, shown at the top right. */
  contact: string
  footer: string
  /** PNG data URL, or ''. */
  logo: string
  signers: Signer[]
}

export interface Letter {
  date: string // YYYY-MM-DD
  recipient: string
  subject: string
  salutation: string
  body: string
  closing: string
  signerIds: string[]
}

// From person2person.care. Images aren't bundled with the app: they're chosen once in the letter editor.
export const DEFAULT_LETTERHEAD: Letterhead = {
  practiceName: 'Person to Person Therapy',
  tagline: 'A Down-to-Earth Counseling Approach',
  contact: 'info@person2person.care\nperson2person.care\nVA (804) 707-4507 · CO (303) 951-3707',
  footer: 'Person to Person Therapy Collective LLC · Serving Colorado and Virginia',
  logo: '',
  signers: [
    { id: 'matthew', name: 'Matthew Barber', credentials: 'LPC', title: 'Licensed Professional Counselor', signature: '' },
    { id: 'grace', name: 'Grace Bryan', credentials: 'LCSW', title: 'Licensed Clinical Social Worker', signature: '' }
  ]
}

const FOREST = '#184027'
const MUTED = '#4a6553'
const SERIF = `'Iowan Old Style', 'Palatino', Georgia, serif`
const SANS = `'Avenir Next', 'Helvetica Neue', Helvetica, Arial, sans-serif`

/** Only image data URLs go into the page, so nothing in it can load from elsewhere. */
function imageSrc(url: string): string | null {
  return /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(url) ? url : null
}

export function signerLabel(s: Signer): string {
  return [s.name.trim(), s.credentials.trim()].filter(Boolean).join(', ')
}

export function letterDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/** The footer for printToPDF, which repeats it on every page. */
export function letterFooterTemplate(letterhead: Letterhead): string {
  return `<div style="font: 7.5pt ${SANS}; color: ${MUTED}; width: 100%; text-align: center; letter-spacing: 0.02em;">${escapeHtml(letterhead.footer)}</div>`
}

/**
 * The letter as a standalone page. `preview` lays it out as one sheet for the editor:
 * the page margins become padding and the footer sits at the foot of the sheet,
 * where printing puts it through letterFooterTemplate instead.
 */
export function letterToDocumentHtml(letter: Letter, letterhead: Letterhead, preview = false): string {
  const logo = imageSrc(letterhead.logo)
  const contact = letterhead.contact.split('\n').map((l) => l.trim()).filter(Boolean)
  const signers = letter.signerIds.map((id) => letterhead.signers.find((s) => s.id === id)).filter((s): s is Signer => !!s)
  const signatures = signers
    .map((s) => {
      const src = imageSrc(s.signature)
      return `<div class="signer">
        <div class="sig-img">${src ? `<img src="${src}" alt="">` : ''}</div>
        <div class="sig-name">${escapeHtml(signerLabel(s))}</div>
        ${s.title.trim() ? `<div class="sig-title">${escapeHtml(s.title.trim())}</div>` : ''}
      </div>`
    })
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Letter</title><style>
    @page { size: Letter; margin: 0.55in 0.9in 0.75in; }
    html { background: #fff; }
    body { font: 10.5pt/1.55 ${SANS}; color: #1d2420; margin: 0; }
    ${preview ? `body { width: 8.5in; min-height: 11in; box-sizing: border-box; padding: 0.55in 0.9in 0.95in; }
    .page-foot { position: fixed; left: 0; right: 0; bottom: 0.32in; }` : ''}
    .lh { display: flex; align-items: center; gap: 12pt; padding-bottom: 12pt; border-bottom: 1.25pt solid ${FOREST}; }
    .lh img { height: 0.62in; width: auto; }
    .brand { flex: 1; }
    .brand-name { font: 600 18pt/1.1 ${SERIF}; color: ${FOREST}; letter-spacing: 0.005em; }
    .brand-tag { font-size: 7.5pt; color: ${MUTED}; text-transform: uppercase; letter-spacing: 0.14em; margin-top: 4pt; }
    .contact { text-align: right; font-size: 8pt; line-height: 1.5; color: ${MUTED}; white-space: nowrap; }
    .accent { height: 3pt; background: #eff483; margin-bottom: 30pt; }
    p { margin: 0 0 9pt; }
    .date { margin-bottom: 18pt; }
    .recipient { white-space: pre-line; margin-bottom: 18pt; }
    .subject { font-weight: 600; margin-bottom: 14pt; }
    .closing { margin-top: 16pt; break-inside: avoid; }
    .signers { display: flex; flex-wrap: wrap; gap: 6pt 36pt; margin-top: 4pt; }
    .signer { min-width: 2.2in; }
    .sig-img { height: 0.62in; display: flex; align-items: flex-end; }
    .sig-img img { max-height: 0.62in; max-width: 2.3in; }
    .sig-name { font-weight: 600; border-top: 0.75pt solid #b9c3bc; padding-top: 3pt; margin-top: 2pt; }
    .sig-title { font-size: 9pt; color: ${MUTED}; }
  </style></head><body>
    <header class="lh">
      ${logo ? `<img src="${logo}" alt="">` : ''}
      <div class="brand">
        <div class="brand-name">${escapeHtml(letterhead.practiceName)}</div>
        ${letterhead.tagline.trim() ? `<div class="brand-tag">${escapeHtml(letterhead.tagline.trim())}</div>` : ''}
      </div>
      ${contact.length ? `<div class="contact">${contact.map(escapeHtml).join('<br>')}</div>` : ''}
    </header>
    <div class="accent"></div>
    ${letter.date ? `<p class="date">${escapeHtml(letterDate(letter.date))}</p>` : ''}
    ${letter.recipient.trim() ? `<p class="recipient">${escapeHtml(letter.recipient.trim())}</p>` : ''}
    ${letter.subject.trim() ? `<p class="subject">RE: ${escapeHtml(letter.subject.trim())}</p>` : ''}
    ${letter.salutation.trim() ? `<p>${escapeHtml(letter.salutation.trim())}</p>` : ''}
    ${paragraphsHtml(letter.body.trim())}
    <div class="closing">
      ${letter.closing.trim() ? `<p>${escapeHtml(letter.closing.trim())}</p>` : ''}
      ${signatures ? `<div class="signers">${signatures}</div>` : ''}
    </div>
    ${preview && letterhead.footer.trim() ? `<div class="page-foot">${letterFooterTemplate(letterhead)}</div>` : ''}
  </body></html>`
}
