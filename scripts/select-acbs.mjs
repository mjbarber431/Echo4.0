// Picks the ACBS member resources that belong in Echo's library from a crawl of
// contextualscience.org/clinical_resources, and writes scripts/acbs-resources.json,
// which catalog-resources.mjs merges into the catalogue. Only titles, links and a
// one-line note are kept; the resources themselves stay on ACBS.
//
//   node scripts/select-acbs.mjs <crawl.json>
//
// The crawl is a JSON list of { url, title, path, excerpt, files } for each page,
// taken with a signed-in member session (see the git history for how).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const pages = (typeof raw === 'string' ? JSON.parse(raw) : raw).pages.filter((p) => !p.error)
const parts = (p) => (p.path ? p.path.split(' > ') : [])

/** Under `section`, `depth` levels down from it (1 = its direct children). */
const under = (p, section, depth) => {
  const pp = parts(p)
  const i = pp.indexOf(section)
  return i >= 0 && pp.length - i === depth
}

// Protocols that fit an ACT practice focused on anxiety and depression, plus the general ACT ones.
const PROTOCOLS = new Set([
  'Introducing ACT to clients',
  '6 Session ACT Toolkit',
  'Agoraphobia',
  'ACT Made Simple: Togus One Week Protocol',
  'ACT Treatment Outlines for Anxiety and Depression (Forman et al., 2007 effectiveness study)',
  'ACT for Depression and Anxiety Group - Cornell University Counseling and Psychological Services',
  'ACT for Perinatal Mood and Anxiety Disorders Skills Group Handouts',
  'ACT Self Help and the World Health Organization: "Doing What Matters in Times of Stress" and Self-Help Plus (SH+)',
  'Choice Point Model',
  'General Therapy Manual',
  'Living By Committed ACTion Workbook',
  'Math Anxiety',
  'Mindfulness and Acceptance-based Group Therapy for Social Anxiety Disorder',
  'Mindtrain- ACT treatment manual for therapists working with anxious children',
  'OCD',
  'Self-Help Manual for Anxiety and/or Depression',
  'Skin picking',
  'Trichotillomania',
  'The ACT Matrix',
  'The ACT Matrix for Intake Sessions',
  'The ACT Roadmap - A Free Guide for getting started with ACT',
  'Visual Aid for explaining how the Observing Self relates to our brain',
  'Earliest ACT Protocols (aka "Comprehensive Distancing")',
  'Group Treatment of Depression',
  'Postpartum Depression',
  'ACT For Sleep Problems',
  'Acceptance and Commitment Therapy for Insomnia'
])
const PROTOCOL_PAGES = new Set([
  'ACT in plain language',
  'A short introduction to ACT to be handed out after a first session',
  'Metaphors for Introducing ACT to Clients',
  'Comparing ACT and CBT',
  'ACT orientation diagrams',
  'Questions on the hexaflex for young people',
  'Noticing Hooks and What You Do Next',
  'Togus Protocol 5/24/10',
  'ACT for Agoraphobia',
  'ACT WITH CHOICE MODEL',
  'Adaptation of Choice Point Handout',
  'Choice point for young people',
  'Mindfulness and Acceptance-Based Group Therapy for Social Anxiety Disorder: A Treatment Manual, Second Edition',
  'Handouts for General ACT Manual',
  'The MATRIX Worksheet w/ Fill in Blanks and Excel Codes',
  'Learning the Matrix',
  'The Survival-Vital Matrix',
  'ACT for Anxiety related to COVID-19'
])

const MEASURE_SECTIONS = ['Psychological Flexibility or Inflexibility Measures', 'Fusion Measures', 'Mindfulness Measures', 'Values Measures', 'Compassion Measures', 'Emotion Regulation Measures', 'Other ACT-Related Measures', 'Child and Adolescent Measures']
/** Measures for other problems, or about therapists rather than clients. */
const SKIP_MEASURE = /Diabetes|Chronic|Pain|Body Image|Illness|Healthcare|Physical Activity|Fidelity|Knowledge|ACT Check|Problem Specific|Computerized/i
/** Problem-specific AAQ and Psy-Flex variants for anxiety subtypes and depression. */
const ANXIETY_VARIANT = /AAQ-OC|AAQ-TS|SA-AAQ|TA-AAQ|B-SA-AAQ|AAQ-D\b|AAQ-TTM|AAQH|Panic|Health Anx|Worry|Perfection|Depress|Hoard|Trich|Skin|BFRB|Body Dysmorph|Misophon|Insomnia|Sleep|Suicid/i

const OFF_TOPIC = /Languages Other Than English|^Metaphors in |Tarjetas|Meditar|Español|Telehealth|Videoconferencing|Telemental|Smartphone Apps|Some more options|Chronic Pain|therapy homework version|Opioid|for couples work/i
/** Translations filed as their own pages (the English page links them too). */
const TRANSLATION = / - (Korean|Persian|Portuguese|Thai|Kurdish|Turkish|Arabic|Spanish|French|German|Italian|Chinese|Japanese|Dutch|Polish|Russian)\b| Persian Version|\b(Russian|Español|Spanish|Swedish)$/i

const SECTIONS = {
  Metaphors: { kind: 'metaphor', topic: 'ACT Metaphors' },
  'Exercises and Meditations': { kind: 'exercise', topic: 'ACT Exercises' },
  'Support Materials and Worksheets': { kind: 'worksheet', topic: 'ACT' },
  'Assessment and Monitoring Tools': { kind: 'assessment', topic: 'ACT Measures' },
  'Case Formulation Frameworks': { kind: 'clinician', topic: 'Case Formulation' },
  'Techniques and Components': { kind: 'clinician', topic: 'ACT' },
  'Organizing Sessions': { kind: 'clinician', topic: 'ACT' },
  'Video examples of ACT in Session': { kind: 'video', topic: 'ACT' }
}

/** A one-line note from the page's opening text. */
function note(excerpt) {
  // The first sentence that says what the resource is, skipping submission notes and boilerplate.
  const sentences = (excerpt ?? '').replace(/https?:\/\/\S+/g, '').split(/(?<=[.!?])\s/).map((x) => x.trim())
  const first = sentences.find((x) => x.length >= 25 && !/^(Originally|Please|Disclaimer|see att|Several|Attached|Here is|Here are|These videos|I've put|I have|Submitted|Posted|Hi |Dear |Thanks|Feel free)/i.test(x) && !/\bBox \d|\b\d{5}\b|@|\bphone\b|\btel\b|copyright|©/i.test(x)) ?? ''
  if (first.length < 25) return undefined
  return first.length > 110 ? `${first.slice(0, 107).replace(/\s+\S*$/, '')}…` : first
}

const audience = (title) => (/child|kid|youth|young people|adolescent|-A\)|teen/i.test(title) ? (/parent/i.test(title) ? 'parents' : 'children') : /parent/i.test(title) ? 'parents' : /group/i.test(title) ? 'groups' : 'adults')

const picked = []
const add = (p, kind, topic, section) => {
  if (picked.some((x) => x.url === p.url) || TRANSLATION.test(p.title)) return
  // Session paperwork rather than something to give or use with a client.
  if (/Progress Note|Self-Care Monitoring|Clinical significance tester|Survey of Guiding Principles/i.test(p.title)) kind = 'clinician'
  picked.push({
    id: createHash('sha1').update(p.url).digest('hex').slice(0, 8),
    title: p.title,
    topic,
    kind,
    audience: audience(p.title),
    url: p.url,
    source: 'acbs',
    section,
    note: kind === 'assessment' ? undefined : note(p.excerpt)
  })
}

for (const p of pages) {
  const pp = parts(p)
  for (const [section, { kind, topic }] of Object.entries(SECTIONS)) {
    // A section's pages and its groups' pages (Defusion Exercises > Airplanes), but not the groups
    // themselves, pages in other languages, or tech and chronic-pain material.
    const container = (p.children > 0 && !p.files.length && (p.excerpt ?? '').length < 300) || /^(Acceptance|Defusion|Values|Meditation|Other) Exercises$/.test(p.title)
    if ((under(p, section, 1) || under(p, section, 2)) && !container && !OFF_TOPIC.test(p.title)) add(p, kind, topic, pp.length - pp.indexOf(section) === 2 ? pp[pp.length - 1] : section)
  }
  if (under(p, 'Treatment Protocol and Manuals', 1) && PROTOCOLS.has(p.title)) add(p, 'protocol', 'Protocols', 'Treatment Protocols and Manuals')
  if (pp.includes('Treatment Protocol and Manuals') && PROTOCOL_PAGES.has(p.title)) add(p, /worksheet|handout|diagram|matrix/i.test(p.title) ? 'worksheet' : 'protocol', 'Protocols', pp[pp.length - 1])
  for (const s of MEASURE_SECTIONS) if (under(p, s, 1) && !SKIP_MEASURE.test(p.title)) add(p, 'assessment', 'ACT Measures', s)
  if ((pp.includes('AAQ variations for specific problems') || pp.includes('Psy-Flex variations for specific problems')) && ANXIETY_VARIANT.test(p.title)) add(p, 'assessment', 'ACT Measures', 'AAQ variations for specific problems')
}

picked.sort((a, b) => a.topic.localeCompare(b.topic) || a.title.localeCompare(b.title))
for (const r of picked) if (!r.note) delete r.note
writeFileSync('scripts/acbs-resources.json', `${JSON.stringify(picked, null, 1)}\n`)
const by = picked.reduce((a, r) => ((a[r.topic] = (a[r.topic] ?? 0) + 1), a), {})
console.log(`${picked.length} ACBS resources:`, Object.entries(by).map(([t, n]) => `${t} ${n}`).join(', '))
