import type { Attestations, Client, Note, NoteType, SessionInfo, SessionSetting, Settings } from './types'
import { noteDiagnoses } from './diagnosis'

export const CPT_OPTIONS: Record<NoteType, { code: string; label: string }[]> = {
  intake: [{ code: '90791', label: '90791 · Diagnostic evaluation' }],
  progress: [
    { code: '90837', label: '90837 · Psychotherapy 53+ min' },
    { code: '90834', label: '90834 · Psychotherapy 38–52 min' },
    { code: '90832', label: '90832 · Psychotherapy 16–37 min' }
  ],
  termination: [
    { code: '90837', label: '90837 · Psychotherapy 53+ min' },
    { code: '90834', label: '90834 · Psychotherapy 38–52 min' },
    { code: '90832', label: '90832 · Psychotherapy 16–37 min' },
    { code: 'none', label: 'Not billed (summary only)' }
  ]
}

export const SETTING_LABEL: Record<SessionSetting, string> = {
  office: 'In office',
  'telehealth-home': 'Telehealth · client at home',
  'telehealth-other': 'Telehealth · client elsewhere'
}

export const DEFAULT_CLIENT_SETTING: SessionSetting = 'telehealth-home'

export function isTelehealth(setting: SessionSetting): boolean {
  return setting !== 'office'
}

/** Place of service code and modifier for the copied header. */
export function placeOfService(setting: SessionSetting): string {
  switch (setting) {
    case 'office':
      return 'POS 11 (office)'
    case 'telehealth-home':
      return 'POS 10 (telehealth in patient’s home), modifier 95'
    case 'telehealth-other':
      return 'POS 02 (telehealth other than patient’s home), modifier 95'
  }
}

export function todayISO(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function formatDateUS(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso
}

/** Sort key for notes: date of service, then when the note was started. */
export function noteSortKey(note: Note): string {
  return note.session.date + note.createdAt
}

/** CPT code appropriate for a psychotherapy session of the given length (CPT time rules). */
export function cptForMinutes(minutes: number): string | null {
  if (minutes >= 53) return '90837'
  if (minutes >= 38) return '90834'
  if (minutes >= 16) return '90832'
  return null
}

export interface Check {
  id: string
  level: 'ok' | 'warn' | 'error'
  label: string
  detail?: string
}

// Terms that mean the dictation addresses risk explicitly. When any match, the
// "no safety concerns" default must not be used; the note documents what was dictated.
// The local transcriber can spell numbers digit by digit ("9, 8, 8") and initialisms
// with periods ("S.I."), so those spellings count too.
const RISK_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'suicide', re: /suicid/i },
  { label: 'SI/HI', re: /\b(SI|HI|NSSI)\b|\b[SH]\.\s?I\./ },
  { label: 'self-harm', re: /self[-\s]?harm|self[-\s]?injur|\bcutting\b|\bcut (?:her|him|my|them)sel/i },
  { label: 'wish to die', re: /(want|wanted|wish|wishes|wished) to die|better off dead|end (?:my|his|her|their) life|not wake up/i },
  { label: 'harm to others', re: /homicid|kill (?:him|her|them|someone|myself|himself|herself|themselves)|hurt (?:someone|others|him|her|them)/i },
  { label: 'overdose', re: /overdos/i },
  { label: 'weapons', re: /\b(gun|guns|firearm|firearms|weapon|weapons)\b/i },
  { label: 'abuse / neglect', re: /(?<!substance |alcohol |drug )\babuse[ds]?\b|\bneglect|domestic violence|assault/i },
  { label: 'abuse / neglect', re: /\b(DV|IPV)\b/ },
  { label: 'mandated report', re: /mandated report|\bCPS\b|\bAPS\b|child protective|adult protective/i },
  { label: 'safety plan', re: /safety plan|crisis line|\b9[,\s-]*8[,\s-]*8\b|nine[,\s-]+eight[,\s-]+eight|means restriction/i },
  { label: 'hospitalization', re: /hospitali[sz]|inpatient|psych(?:iatric)? hold|\b5[,\s-]*1[,\s-]*5[,\s-]*0\b|emergency room/i },
  { label: 'hospitalization', re: /\bER\b/ },
  { label: 'psychosis', re: /psychos|psychotic|hallucinat|delusion/i }
]

export function scanRisk(text: string): string[] {
  return [...new Set(RISK_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.label))]
}

/** Default session fields. Times aren't tracked here; the EHR is the record for them. */
export function defaultSession(type: NoteType, settings: Settings, setting: SessionSetting, now = new Date()): SessionInfo {
  return {
    date: todayISO(now),
    cpt: type === 'intake' ? '90791' : cptForMinutes(settings.sessionMinutes) ?? '90837',
    setting,
    participants: 'Client'
  }
}

export function defaultAttestations(): Attestations {
  return { noSafetyConcerns: true, mseUnremarkable: true }
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`)
  d.setDate(d.getDate() + days)
  return todayISO(d)
}

export function planReviewDue(client: Client, onDate: string): boolean {
  return !!client.plan?.reviewDate && client.plan.reviewDate <= onDate
}

export function nextReviewDate(fromISO: string, days: number): string {
  return addDays(fromISO, days)
}

/** Deterministic audit-readiness checks shown beside a generated note. */
export function auditChecks(note: Note, client: Client): Check[] {
  const checks: Check[] = []
  const s = note.session

  const hasDx = client.diagnoses.length > 0 || (note.type === 'intake' && noteDiagnoses(note).length > 0)
  checks.push(
    hasDx
      ? { id: 'dx', level: 'ok', label: 'Diagnosis on file' }
      : { id: 'dx', level: 'error', label: 'No diagnosis on file', detail: 'Add an ICD-10 diagnosis to the client.' }
  )

  if (note.type === 'progress') {
    const plan = client.plan
    if (!plan || plan.goals.length === 0) {
      checks.push({ id: 'plan', level: 'error', label: 'No treatment plan', detail: 'Progress notes should tie to plan goals.' })
    } else {
      checks.push(
        planReviewDue(client, s.date)
          ? { id: 'plan', level: 'warn', label: 'Treatment plan review is due', detail: `Review date ${formatDateUS(plan.reviewDate!)}.` }
          : { id: 'plan', level: 'ok', label: 'Current treatment plan on file' }
      )
      const body = note.sections.map((x) => x.body).join('\n')
      checks.push(
        /\bgoal\s*\d/i.test(body)
          ? { id: 'goals', level: 'ok', label: 'Progress tied to plan goals' }
          : { id: 'goals', level: 'warn', label: 'Plan goals not referenced', detail: 'Mention progress toward at least one goal.' }
      )
    }
  }

  const hasRisk = note.sections.some((x) => /risk|safety/i.test(x.heading) && x.body.trim().length > 0)
  checks.push(
    hasRisk
      ? { id: 'risk', level: 'ok', label: 'Risk assessment documented' }
      : { id: 'risk', level: 'error', label: 'Risk assessment missing' }
  )

  if (isTelehealth(s.setting)) {
    checks.push({ id: 'tele', level: 'ok', label: 'Telehealth location & consent attested' })
  }

  if (note.reviewItems.length > 0) {
    checks.push({
      id: 'review',
      level: 'warn',
      label: `${note.reviewItems.length} item${note.reviewItems.length === 1 ? '' : 's'} flagged for your review`
    })
  }
  return checks
}
