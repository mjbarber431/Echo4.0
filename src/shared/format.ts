import type { Client, Note, NoteSection, Settings, TreatmentPlan } from './types'
import { GOAL_STATUS_LABEL, NOTE_TYPE_LABEL } from './types'
import { formatDateUS, isTelehealth, placeOfService } from './compliance'

// Builds what lands on the clipboard. Everything is plain text first (most EHR
// fields are plain text); an HTML twin keeps headings bold in rich-text fields.

function heading(text: string, settings: Settings): string {
  return settings.headingStyle === 'caps' ? text.toUpperCase() : text
}

/** Strip any markdown the model may have slipped in so nothing odd pastes into the EHR. */
export function cleanBody(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const CPT_DESCRIPTION: Record<string, string> = {
  '90791': 'Psychiatric diagnostic evaluation',
  '90837': 'Individual psychotherapy, 53+ minutes',
  '90834': 'Individual psychotherapy, 38–52 minutes',
  '90832': 'Individual psychotherapy, 16–37 minutes'
}

export function headerLines(note: Note, client: Client, settings: Settings): string[] {
  const s = note.session
  const lines = [`Date of service: ${formatDateUS(s.date)}`]
  if (s.cpt && s.cpt !== 'none') lines.push(`Service: CPT ${s.cpt}${CPT_DESCRIPTION[s.cpt] ? ` – ${CPT_DESCRIPTION[s.cpt]}` : ''}`)
  lines.push(
    `Location: ${isTelehealth(s.setting) ? `Telehealth, synchronous audio-video${settings.telehealthPlatform ? ` (${settings.telehealthPlatform})` : ''}; ` : 'In person; '}${placeOfService(s.setting)}`
  )
  lines.push(`Participants: ${s.participants || 'Client'}`)
  const dx = note.type === 'intake' && note.suggestions?.applyDiagnoses ? note.suggestions.diagnoses : client.diagnoses
  if (dx.length) lines.push(`Diagnosis: ${dx.map((d) => `${d.code} ${d.description}`).join('; ')}`)
  return lines
}

export function signatureLine(settings: Settings): string {
  const who = [settings.clinicianName.trim(), settings.credentials.trim()].filter(Boolean).join(', ')
  return who ? `Clinician: ${who}` : ''
}

export function sectionText(section: NoteSection, settings: Settings): string {
  return `${heading(section.heading, settings)}:\n${cleanBody(section.body)}`
}

export function noteToText(note: Note, client: Client, settings: Settings): string {
  const parts: string[] = []
  if (settings.includeHeader) {
    parts.push(`${heading(NOTE_TYPE_LABEL[note.type], settings)}\n${headerLines(note, client, settings).join('\n')}`)
  }
  for (const section of note.sections) parts.push(sectionText(section, settings))
  if (settings.includeSignature) {
    const sig = signatureLine(settings)
    if (sig) parts.push(sig)
  }
  return parts.join('\n\n')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function paragraphsHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

export function sectionHtml(section: NoteSection, settings: Settings): string {
  return `<p><b>${escapeHtml(heading(section.heading, settings))}:</b></p>${paragraphsHtml(cleanBody(section.body))}`
}

export function noteToHtml(note: Note, client: Client, settings: Settings): string {
  const parts: string[] = []
  if (settings.includeHeader) {
    parts.push(
      `<p><b>${escapeHtml(heading(NOTE_TYPE_LABEL[note.type], settings))}</b><br>${headerLines(note, client, settings).map(escapeHtml).join('<br>')}</p>`
    )
  }
  for (const section of note.sections) parts.push(sectionHtml(section, settings))
  if (settings.includeSignature) {
    const sig = signatureLine(settings)
    if (sig) parts.push(`<p>${escapeHtml(sig)}</p>`)
  }
  return parts.join('')
}

export function planToText(plan: TreatmentPlan, client: Client, settings: Settings): string {
  const parts: string[] = [heading('Treatment Plan', settings)]
  if (client.diagnoses.length) parts.push(`Diagnosis: ${client.diagnoses.map((d) => `${d.code} ${d.description}`).join('; ')}`)
  plan.goals.forEach((g, i) => {
    const lines = [
      `${heading(`Goal ${i + 1}`, settings)} (${GOAL_STATUS_LABEL[g.status]})`,
      `Problem: ${g.problem}`,
      `Goal: ${g.goal}`,
      ...g.objectives.map((o, j) => `Objective ${i + 1}${String.fromCharCode(97 + j)}: ${o.text} (${GOAL_STATUS_LABEL[o.status]})`),
      `Interventions: ${g.interventions}`
    ]
    if (g.targetDate) lines.push(`Target date: ${formatDateUS(g.targetDate)}`)
    if (g.progress) lines.push(`Progress: ${g.progress}`)
    parts.push(lines.join('\n'))
  })
  const meta = [
    plan.frequency && `Frequency: ${plan.frequency}`,
    plan.modalities && `Modalities: ${plan.modalities}`,
    plan.dischargeCriteria && `Discharge criteria: ${plan.dischargeCriteria}`,
    plan.reviewDate && `Next review: ${formatDateUS(plan.reviewDate)}`
  ].filter(Boolean)
  if (meta.length) parts.push(meta.join('\n'))
  return parts.join('\n\n')
}

export function textToHtml(text: string): string {
  return paragraphsHtml(text)
}

// A standalone, printable page for the plan, rendered to PDF in the main process.
// Unlike the clipboard text it carries the client's name, since the file is the
// clinician's own copy for the chart and never goes to the AI.
export function planToDocumentHtml(plan: TreatmentPlan, client: Client, settings: Settings): string {
  const clinician = [settings.clinicianName.trim(), settings.credentials.trim()].filter(Boolean).join(', ')
  const facts: [string, string][] = [
    ['Client', client.name],
    ...(client.pronouns.trim() ? ([['Pronouns', client.pronouns.trim()]] as [string, string][]) : []),
    ['Diagnosis', client.diagnoses.length ? client.diagnoses.map((d) => `${d.code} ${d.description}`).join('; ') : 'None on file'],
    ...(clinician ? ([['Clinician', clinician]] as [string, string][]) : []),
    ['Plan date', formatDateUS(plan.lastReviewed ?? plan.updatedAt.slice(0, 10))],
    ['Next review', plan.reviewDate ? formatDateUS(plan.reviewDate) : 'Not set']
  ]
  const goals = plan.goals
    .map((g, i) => {
      const objectives = g.objectives
        .map((o, j) => `<tr><td class="num">${i + 1}${String.fromCharCode(97 + j)}</td><td>${escapeHtml(o.text)}</td><td class="status">${GOAL_STATUS_LABEL[o.status]}</td></tr>`)
        .join('')
      const rows: [string, string][] = [
        ['Problem', g.problem],
        ['Interventions', g.interventions],
        ['Target date', g.targetDate ? formatDateUS(g.targetDate) : ''],
        ['Progress', g.progress]
      ]
      return `<section class="goal">
        <h2><span>Goal ${i + 1}</span><span class="status">${GOAL_STATUS_LABEL[g.status]}</span></h2>
        <p class="goal-text">${escapeHtml(g.goal)}</p>
        ${rows.filter(([, v]) => v.trim()).map(([k, v]) => `<p><b>${k}:</b> ${escapeHtml(v)}</p>`).join('')}
        ${objectives ? `<table><thead><tr><th></th><th>Measurable objective</th><th class="status">Status</th></tr></thead><tbody>${objectives}</tbody></table>` : ''}
      </section>`
    })
    .join('')
  const meta: [string, string][] = [
    ['Frequency', plan.frequency],
    ['Modalities', plan.modalities],
    ['Discharge criteria', plan.dischargeCriteria]
  ]
  return `<!doctype html><html><head><meta charset="utf-8"><title>Treatment Plan</title><style>
    @page { size: Letter; margin: 0.75in 0.8in; }
    body { font: 10.5pt/1.45 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 0; }
    h1 { font-size: 18pt; margin: 0 0 12pt; letter-spacing: 0.01em; }
    h2 { display: flex; justify-content: space-between; font-size: 11.5pt; margin: 0 0 4pt; padding-bottom: 3pt; border-bottom: 1px solid #ccc; }
    h3 { font-size: 11.5pt; margin: 0 0 4pt; }
    p { margin: 0 0 4pt; }
    .facts { display: grid; grid-template-columns: max-content 1fr; gap: 2pt 14pt; margin-bottom: 18pt; padding: 8pt 10pt; background: #f4f4f4; border-radius: 4pt; }
    .facts dt { font-weight: 600; } .facts dd { margin: 0; }
    .goal { margin-bottom: 16pt; break-inside: avoid; }
    .goal-text { font-weight: 600; margin-bottom: 6pt; }
    .status { font-weight: 500; color: #555; white-space: nowrap; text-align: right; }
    table { width: 100%; border-collapse: collapse; margin-top: 6pt; }
    th { text-align: left; font-size: 9pt; font-weight: 600; color: #555; border-bottom: 1px solid #ccc; padding: 2pt 4pt; }
    td { vertical-align: top; padding: 3pt 4pt; border-bottom: 1px solid #eee; }
    td.num { width: 22pt; font-weight: 600; }
    .meta { margin-top: 4pt; break-inside: avoid; }
    .signatures { width: 50%; margin-top: 36pt; break-inside: avoid; }
    .sig { border-top: 1px solid #333; padding-top: 3pt; font-size: 9pt; color: #555; display: flex; justify-content: space-between; }
  </style></head><body>
    <h1>Treatment Plan</h1>
    <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>
    ${goals}
    <section class="meta">${meta.filter(([, v]) => v.trim()).map(([k, v]) => `<p><b>${k}:</b> ${escapeHtml(v)}</p>`).join('')}</section>
    <div class="signatures">
      <div class="sig"><span>Clinician signature${clinician ? ` (${escapeHtml(clinician)})` : ''}</span><span>Date</span></div>
    </div>
  </body></html>`
}
