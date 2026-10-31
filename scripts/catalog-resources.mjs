// Builds the clinical resource catalogue (src/shared/resources.json) from the
// ClinicalResources folder. Rerun it whenever files are added, moved or removed:
//
//   node scripts/catalog-resources.mjs [ClinicalResources]
//
// Needs poppler (brew install poppler) for PDFs and macOS textutil for Word files.
// Only titles and classifications are written out; no document text is kept, so
// the catalogue can be committed while the library itself stays out of git.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

const root = process.argv[2] ?? 'ClinicalResources'
const OUT = 'src/shared/resources.json'

// ---------------------------------------------------------------------------
// Curation: things the files can't tell us themselves.
// ---------------------------------------------------------------------------

/**
 * What's catalogued: the practice works in ACT, mostly with anxiety disorders (all
 * subtypes) and depression, so the library is ACT material, anxiety and exposure work,
 * depression psychoeducation and behavioural activation, anxiety/OCD/trauma/depression
 * and intake measures, and safety planning. Everything else in the folder is ignored.
 */
const KEEP = [
  // ACT
  /^Measures Package for ACT\.pdf$/,
  /GettingUnstuckInACT/,
  /\/Values\//,
  /Values_and_Goals_Clarification|values-discussion-questions|exploring-values|values-self-exploration/,
  /^INTERVENTIONS\/Self Compassion\//,
  /Info What is Self Compassion|Self-Forgiveness-Self-Acceptance/,
  /Info_Accepting_Uncertainty|WS-Accepting Uncertainty|WS-Challening Intolerance of Uncertainty/,
  // Anxiety and exposure
  /^INTERVENTIONS\/Anxiety\/(?!.*(Unhelpful Thinking Styles|Analysing your Thinking|Behavioural Experiments|challenging-anxious-thoughts|Anxiety Assessments|Coronavirus|anxiety-test|Complete Anxiety Treatment))/,
  /^INTERVENTIONS\/Agorophobia\//,
  /^INTERVENTIONS\/(Social Phobia Shyness|Specific Phobia)\//,
  /creating-an-exposure-hierarchy|avoidance-hierarchy|What Happens When I Feel Anxious|my-fears-and-strengths/,
  /Info_Situational_Exposure|WS Situational Exposure Diary|Info_How_Worry_Works/,
  /PTSD\/(understanding_ptsd|what-is-trauma|ptsd_and_memory|grounding-techniques-free|safety-behaviors-free|nightmare_exposure|Grounding Techniques\.pdf)/,
  /What_is_Generalized_Anxiety|Children_myfears|SAS-TR/,
  // Anxiety subtypes: OCD, health anxiety, perfectionism, BFRBs, and children's fears
  /Skin-Picking-Disorder-Fact-Sheet|what-is-perfectionism|Concerns, Feelings, and Hopes about OCD|Info_Postpone_Your_Worry|WS-Postpone your Worry/,
  /Child PHP\/(An Anxious Story|Dixie Overcomes Her Fears|Maurice Faces His Fear|Finding and Losing Your Anxiety|School Fear Reduction|Reduce Nighttime Fears|Expressions of Fear through Art)/,
  /my-fears-and-strengths|Parents Response to Childs Phobia/,
  // Depression: psychoeducation, behavioural activation, rumination
  /Depression\/(Info-Dep-MHP-What is depression|Info-Psychotherapy for depression|Info-Staying Healthy|Info-What causes depression|Info_mindfulness_and_letting_go|behavioral_activation|Weekly Schedule for Behavioral Activation|Worksheets\/WS-Behavioural Activation|Worksheets\/WS-Weekly Activity Schedule|Worksheets\/WS Letting Go With Mindfulness|Worksheets\/WS-Symptoms of Depression|coping-skills-depression|cycle-of-depression|depression-info-sheet|what_is_rumination|what-is-postpartum-depression|Coping With Anxiety and Depression During Pregnancy|DEPRESSION MOOD CHART|KYB-4)/,
  /Bipolar\/(ACFB026|ACFB02A|Info-Vicious Cycle of Depression|rumination_diary)|Bipolar\/Worksheets\/ACFB035/,
  /activities-behavioral-activation|behavioral-activation part 2|Positive Activities for BH|Positive Activities for Behavioral Activation|supporting-someone-with-depression|Talking to Parents About Depression|fact-sheet-postpartum-depression|daily-mood-chart/,
  // Measures (anxiety, OCD, trauma, depression, and intake screening)
  /Becks-Depression-Inventory-BDI-II|Beck Scoring|Quick Inventory of Depressive|CES-DC|HAMILTON-DEPRESSION|Depression-Bereavement-Exclusion|Level-2-Depression|Severity-Measure-For-Depression/,
  /APA_DSM5_(Level-1|Level-2-(Anxiety|Repetitive|Depression-Adult|Sleep|Somatic|Substance)|Severity-Measure-For-(Agoraphobia|Generalized|Panic|Social|Specific|Depression-Adult)|Severity-of-(Acute|Post|Posttraumatic)|Cultural-Formulation)/,
  /GAD708|GADSCORE|PHQ|OCI-R|YBOC|PCL-5|VA119-17|PTSD Diagnostic Scale|child_ptsd_symptom_scale|MDQ\.pdf|adhd-questionnaire-ASRS|Alcohol Assessment AUDIT|CUDIT-R-revised|Mental_status_B8506|mental health status exam|Postpartum scale/,
  // Safety planning: current official screeners, assessment guides and the Stanley-Brown plan,
  // downloaded from Columbia, NIMH and the plan's authors (the older folder material is left out)
  /^Safety Planning\//
]

/** Left out even if KEEP matches: not clinical material, or personal. */
const EXCLUDE = new Set([
  'INTERVENTIONS/Screen Shot 2020-07-21 at 11.59.12 AM.png', // a personal payment receipt
  'INTERVENTIONS/Assessments/APA_DSM5_Level-2-Mania-Adult.textClipping', // a stray clipping of the PDF beside it
  'INTERVENTIONS/Children /Child PHP/directory.doc' // the file list for the folder it's in
])

/** Titles for files whose names don't say what they are. */
const TITLES = {
  'INTERVENTIONS/Screen Shot 2019-07-11 at 1.25.01 PM.png': 'Instrumental Activities of Daily Living (IADL) Checklist',
  'INTERVENTIONS/Screen Shot 2020-01-03 at 10.19.05 AM.png': 'Coping Ideas by Feeling (Instead of Self-Harm)',
  'INTERVENTIONS/Screen Shot 2020-09-11 at 8.43.01 AM.png': 'DBT Cheat Sheet',
  'INTERVENTIONS/Screen Shot 2020-09-11 at 8.48.10 AM.png': 'Emotion Regulation Worksheet: Identifying the Function of an Emotion',
  'INTERVENTIONS/Screen Shot 2020-09-30 at 9.01.53 AM.png': 'Past vs. Present Reflection',
  'INTERVENTIONS/Divorce/Screen Shot 2017-02-09 at 8.39.41 AM.png': 'Stages of Loss and Grief for Children (Divorce)',
  'INTERVENTIONS/Family Therapy/Screen Shot 2017-01-16 at 8.29.43 PM.png': 'Reuniting Estranged Family Members: Objectives and Interventions (1)',
  'INTERVENTIONS/Family Therapy/Screen Shot 2017-01-16 at 8.29.54 PM.png': 'Reuniting Estranged Family Members: Objectives and Interventions (2)',
  'INTERVENTIONS/Family Therapy/Screen Shot 2017-01-16 at 8.30.06 PM.png': 'Reuniting Estranged Family Members: Objectives and Interventions (3)',
  'INTERVENTIONS/Sexual Identity Confusion/Screen Shot 2020-09-28 at 12.02.02 PM.png': 'Treatment Plans Based on Theoretical Orientation',
  'INTERVENTIONS/DBT/IMG_2286-2.JPG': 'Mindful Living 101 (Infographic)',
  'INTERVENTIONS/sllanguagesa.png': 'What’s Your Self-Love Language?',
  'INTERVENTIONS/Children /new doc 2017-03-15 21.07.08_1.pdf': 'Talking Out an Argument (Children)',
  'INTERVENTIONS/Suicide/Safety Planning_Suicide RIsk/2021-05-06T134320.pdf': 'Suicide Prevention and Intervention: Provider Bulletin (Anthem)',
  'INTERVENTIONS/Bipolar/ACFB026.pdf': 'Behavioural Activation: Fun and Achievement',
  'INTERVENTIONS/Bipolar/ACFB02A.pdf': 'Fun Activities Catalogue',
  'INTERVENTIONS/Bipolar/Worksheets/ACFB035.pdf': 'Behavioural Activation Worksheet: Fun and Achievement',
  'INTERVENTIONS/Bipolar/1.docx': 'Changing Extreme Language in Self-Talk',
  'INTERVENTIONS/Bipolar/12CAPS.PDF': 'Self-Control Techniques (CAPS Module 12)',
  'INTERVENTIONS/PTSD/VA119-17-Q-0269-007.pdf': 'Clinician-Administered PTSD Scale for DSM-5 (CAPS-5)',
  'INTERVENTIONS/Anxiety/face.pdf': 'FACE: Overcoming Avoidance',
  'INTERVENTIONS/3 C_S.pdf': 'Shifting Perspective on Stigma: CBT Techniques (EASE)',
  'INTERVENTIONS/CBT/3C_SCBT.pdf': 'Catch It, Check It, Change It (3 Cs)',
  'INTERVENTIONS/CBT/3Cs.png': 'Catch It, Check It, Change It (3 Cs)',
  'INTERVENTIONS/Stress/145-Stress-Management-PDFs.pdf': 'Stress Response Checklist',
  'INTERVENTIONS/Assessments/Chaos-Assessment.pdf': 'Internal Chaos Quiz: Root Causes of Overwhelm',
  'INTERVENTIONS/Assessments/bavqr.pdf': 'Beliefs About Voices Questionnaire, Revised (BAVQ-R)',
  'INTERVENTIONS/Assessments/SBQ.pdf': 'Suicide Behaviors Questionnaire, Revised (SBQ-R)',
  'INTERVENTIONS/Assessments/GAD708.19.08Cartwright.pdf': 'GAD-7 Anxiety Scale',
  'INTERVENTIONS/Assessments/GADSCORE.png': 'GAD-7 Scoring Guide',
  'INTERVENTIONS/Assessments/MDQ.pdf': 'Mood Disorder Questionnaire (MDQ)',
  'INTERVENTIONS/Assessments/OCI-R.pdf': 'Obsessive-Compulsive Inventory, Revised (OCI-R)',
  'INTERVENTIONS/Assessments/adhd-questionnaire-ASRS111.pdf': 'Adult ADHD Self-Report Scale (ASRS v1.1)',
  'INTERVENTIONS/Assessments/YBOC-Symptom-Checklist.pdf': 'Yale-Brown Obsessive Compulsive Symptom Checklist (Y-BOCS)',
  'INTERVENTIONS/Assessments/Borderline-Symptom-List-BLS-23.pdf': 'Borderline Symptom List (BSL-23)',
  'INTERVENTIONS/Assessments/SAS-TR for children .pdf': 'Separation Anxiety Scale for Children (SAS)',
  'INTERVENTIONS/PTSD/PCL-5_Standard.pdf': 'PTSD Checklist for DSM-5 (PCL-5)',
  'INTERVENTIONS/Addiction/Alcohol Assessment AUDIT.pdf': 'Alcohol Use Disorders Identification Test (AUDIT)',
  'INTERVENTIONS/Addiction/CUDIT-R-revised-with-scoring.pdf': 'Cannabis Use Disorder Identification Test, Revised (CUDIT-R), with Scoring',
  'INTERVENTIONS/Addiction/cudit-r.pdf': 'Cannabis Use Disorder Identification Test, Revised (CUDIT-R)',
  'INTERVENTIONS/Eating_Skin Picking Disorders/JTxSOS-SCOFF Questionnaire August 2016.pdf': 'SCOFF Eating Disorder Questionnaire',
  'INTERVENTIONS/Eating_Skin Picking Disorders/SCOFF SCreening Tool For Eating Disorders-Kathleen Rindahl-Thursday.pdf': 'SCOFF Screening Tool for Eating Disorders (Presentation)',
  'INTERVENTIONS/Eating_Skin Picking Disorders/eat-26-rating-scale.pdf': 'Eating Attitudes Test (EAT-26)',
  'INTERVENTIONS/Psychosis/MedAvante_PANSS_SCI-PANSS_1999_English.pdf': 'Structured Clinical Interview for PANSS (SCI-PANSS)',
  'INTERVENTIONS/Psychosis/PANSS-Scoring-Criteria.pdf': 'PANSS Scoring Criteria',
  'INTERVENTIONS/Depression/Quick Inventory of Depressive Symptomatology QIDS SR-16_website_PDF.pdf': 'Quick Inventory of Depressive Symptomatology (QIDS-SR16)',
  'INTERVENTIONS/Depression/CES-DC-Depression Scale for Children.pdf': 'CES-DC Depression Scale for Children',
  'INTERVENTIONS/Assessments/Postpartum scale_edinburghscale.pdf': 'Edinburgh Postnatal Depression Scale (EPDS)',
  'INTERVENTIONS/Assessments/HAMILTON-DEPRESSION.pdf': 'Hamilton Depression Rating Scale (HAM-D)',
  'INTERVENTIONS/Assessments/hamilton_depression_scale.pdf': 'Hamilton Depression Rating Scale (HAM-D), Alternate Form',
  'INTERVENTIONS/Adjustment Disorder/ADNM_20.pdf': 'Adjustment Disorder: New Module (ADNM-20)',
  'INTERVENTIONS/Sexual Acting Out/Sex Addict _SAST.pdf': 'Sexual Addiction Screening Test (SAST)',
  'INTERVENTIONS/cms-quality-child_adhd_rating_scale_screener.pdf': 'Child ADHD Rating Scale Screener',
  'INTERVENTIONS/Assessments/Mental_status_B8506_03-14.pdf': 'Mental Status Examination Form',
  'INTERVENTIONS/Bipolar/MoodCheck-Bipolar-Screener.pdf': 'MoodCheck Bipolar Screener',
  'INTERVENTIONS/Children /MOPS_m_mMixer.pdf': 'M&M Mixer Game',
  'INTERVENTIONS/Children /M_M Anger Game.pdf': 'M&M Anger Game',
  'INTERVENTIONS/Children /M_M Feelinga Game.pdf': 'M&M Feelings Game',
  'INTERVENTIONS/Children /imom_strengths_struggles_color.pdf': 'My Strengths and Struggles',
  'INTERVENTIONS/Children /bucketdrops.pdf': 'Bucket Drops (Filling Others’ Buckets)',
  'INTERVENTIONS/Children /Plan-Oppositional.pdf': 'Treatment Plan: Oppositional Defiant Disorder (Adolescent)',
  'INTERVENTIONS/01822ad207213fbb9fc7962896e65167--cravings-chart-food-cravings.jpg': 'Food Cravings Chart',
  'INTERVENTIONS/Neurotransmitter-chart-optimized.jpg': 'Neurotransmitter Chart',
  'INTERVENTIONS/Copy of Depression.png': 'Depression (Visual)',
  'INTERVENTIONS/mhplan1.pdf': 'Mental Health Plan (Part 1)',
  'INTERVENTIONS/mhplan2.pdf': 'Mental Health Plan (Part 2)',
  'INTERVENTIONS/SMIC-Horizontal-Blank-Timeline-8869_PDF.pdf': 'Blank Life Timeline',
  'INTERVENTIONS/PMR.m4a': 'Progressive Muscle Relaxation (Audio)',
  'INTERVENTIONS/Interpersonal_Emotion_Regulation_IERQ_.docx': 'Interpersonal Emotion Regulation Questionnaire (IERQ)',
  'INTERVENTIONS/VA119-17-Q-0269-007.pdf': 'Clinician-Administered PTSD Scale for DSM-5 (CAPS-5)',
  'INTERVENTIONS/MentalHealthRadioQuestions.docx': 'Black Superwoman Syndrome: Discussion Notes',
  'INTERVENTIONS/dbt_skills_training_handouts_and_worksheets_-_linehan_marsha_srg_.pdf': 'DBT Skills Training Handouts and Worksheets (Linehan, 2nd ed.)',
  'INTERVENTIONS/TheCompleteSetofWorksheetsandHandoutsfromGettingUnstuckInACT.pdf': 'Getting Unstuck in ACT: Complete Worksheets and Handouts (Harris)',
  'Measures Package for ACT.pdf': 'ACT Measures Package (Ciarrochi & Bilich)',
  'INTERVENTIONS/Agorophobia/Agorophobia tx plan .pdf': 'Treatment Plan Overview: Agoraphobia',
  'INTERVENTIONS/Anxiety/Anxiety-Disorders-FS.pdf': 'Anxiety Disorders Fact Sheet',
  'INTERVENTIONS/Anxiety/avoidance-hierarchy-free-en-us.pdf': 'Avoidance Hierarchy',
  'INTERVENTIONS/Anxiety/deep-breathing.pdf': 'Deep Breathing',
  'INTERVENTIONS/Anxiety/What is Anxiety_.pdf': 'What Is Anxiety? (Overview)',
  'INTERVENTIONS/Anxiety/Anxiety Guide.pdf': 'Anxiety Guide (Workbook)',
  'INTERVENTIONS/Assessments/PHQ -9 with score.pdf': 'PHQ-9 Depression Questionnaire, with Scoring',
  'INTERVENTIONS/Assessments/PHQ-2_English.pdf': 'PHQ-2 Depression Screener',
  'INTERVENTIONS/Assessments/PHQ-9 NEW.pdf': 'PHQ-9 Depression Questionnaire',
  'INTERVENTIONS/Assessments/DV_Safety_Plan.pdf': 'Domestic Violence Safety Plan',
  'INTERVENTIONS/Assessments/mental health status exam.pdf': 'Mental Status Exam Checklist',
  'INTERVENTIONS/Children /Children_myfears.pdf': 'My Fears (Children)',
  'INTERVENTIONS/Depression/Worksheets/WS-Challening Intolerance of Uncertainty.pdf': 'Challenging Intolerance of Uncertainty',
  'INTERVENTIONS/Depression/Worksheets/WS-Accepting Uncertainty.pdf': 'Accepting Uncertainty (Worksheet)',
  'INTERVENTIONS/Lifestyle Management /Values/TjfAHQ-values-clarification.pdf': 'Values Clarification',
  'INTERVENTIONS/Lifestyle Management /Values/exploring-values.pdf': 'Exploring Values',
  'INTERVENTIONS/PTSD/grounding-techniques-free-en-us.pdf': 'Grounding Techniques (Handout)',
  'INTERVENTIONS/PTSD/safety-behaviors-free-en-us.pdf': 'Safety Behaviors',
  'INTERVENTIONS/PTSD/avoidance-hierarchy-free-en-us.pdf': 'Avoidance Hierarchy',
  'INTERVENTIONS/Self Compassion/Building Self-Compassion - 01 - Understanding Self-Compassion.pdf': 'Building Self-Compassion 1: Understanding Self-Compassion',
  'INTERVENTIONS/Self Compassion/Building Self-Compassion - 02 - Barriers to Self-Compassion.pdf': 'Building Self-Compassion 2: Barriers to Self-Compassion',
  'INTERVENTIONS/Self-Forgiveness-Self-Acceptance-Worksheet.pdf': 'Self-Forgiveness and Self-Acceptance',
  'INTERVENTIONS/Suicide/CrisisPlan2012Manual.pdf': 'Personal Crisis Plan (Advance Directive)',
  'INTERVENTIONS/Suicide/Safety Planning_Suicide RIsk/NAMI-Virginia-Guide-to-Helping-an-Individual-through-a-Psychiatric-Crisis-2018.pdf': 'Helping Someone Through a Psychiatric Crisis (NAMI Virginia)',
  'INTERVENTIONS/Suicide/Safety Planning_Suicide RIsk/safety-plan.pdf': 'Safety Plan',
  'INTERVENTIONS/Suicide/Safety Planning_Suicide RIsk/suicide-assessment.pdf': 'Suicide Risk Assessment',
  'INTERVENTIONS/Suicide/Safety Planning_Suicide RIsk/vasafetyplancolor.pdf': 'Safety Plan (VA)',
  'INTERVENTIONS/Suicide/SafetyPlan.pdf': 'Safety Plan (Alternate Form)',
  'INTERVENTIONS/Suicide/Suicidal Ideation_ How to Document - SocialWork.Career.pdf': 'Suicidal Ideation: How to Document',
  'INTERVENTIONS/Suicide/SuicideHelp.docx': 'Getting Help for Suicidal Thoughts',
  'INTERVENTIONS/Suicide/distraction-techniques-pm-2.pdf': 'Distraction Techniques',
  'INTERVENTIONS/Suicide/postcrisisplan.pdf': 'Post-Crisis Plan',
  'INTERVENTIONS/SuicidePrevention.pdf': 'Suicide Prevention (Overview)',
  'INTERVENTIONS/Self Harm Alternatives.docx': 'Self-Harm Alternatives'
}

/** Folder names to topics. Files outside these get a topic from their title. */
const TOPICS = {
  Addiction: 'Substance Use',
  'Adjustment Disorder': 'Adjustment',
  Agorophobia: 'Anxiety',
  'Anger ': 'Anger',
  Anxiety: 'Anxiety',
  Assessments: 'Measures',
  BPD: 'Borderline Personality',
  Borderline: 'Borderline Personality',
  Bipolar: 'Bipolar',
  CBT: 'CBT',
  'Children ': 'Children',
  'Cultural Competence': 'Cultural Competence',
  DBT: 'DBT',
  DIetician: 'Nutrition',
  Depression: 'Depression',
  'Developing Your Own Sensory Diet': 'Sensory Processing',
  Divorce: 'Divorce & Separation',
  'Eating_Skin Picking Disorders': 'Eating Disorders',
  Enuresis: 'Children',
  'Facing Your Feelings': 'Distress Tolerance',
  'Family Therapy': 'Family',
  'Grief and Loss': 'Grief & Loss',
  'Keeping Your Balance': 'Bipolar',
  'Lifestyle Management ': 'Wellness & Lifestyle',
  'Marriage_Relationships': 'Couples & Relationships',
  'Medical Conditions': 'Health & Illness',
  'Medication Compliance': 'Health & Illness',
  'Meditation_Mindfulness': 'Mindfulness',
  'Overcoming disordered eating - Part B': 'Eating Disorders',
  PTSD: 'Trauma & PTSD',
  'Parenting ': 'Parenting',
  'Positive ': 'Positive Psychology',
  Psychosis: 'Psychosis',
  'Self Compassion': 'Self-Compassion',
  'Self-Esteem': 'Self-Esteem',
  'Sexual Acting Out': 'Sexuality',
  'Sexual Identity Confusion': 'Sexuality',
  'Social Phobia Shyness': 'Anxiety',
  'Specific Phobia': 'Anxiety',
  Stress: 'Stress',
  Suicide: 'Safety Planning',
  'Understanding Therapy': 'Psychoeducation',
  'Unhelpful Thinking Styles Information Sheets': 'CBT'
}

/** Topic from a title, for files not in a topic folder. First match wins. */
const TOPIC_WORDS = [
  [/suicid|self[- ]?harm|safety plan|crisis|sbq/i, 'Safety Planning'],
  [/apa_dsm5|gad7|gadscore|phq|oci-r|ybocs?|pcl-5|caps-5|asrs|mdq|audit|cudit|mental status|edinburgh|postpartum scale|ptsd scale/i, 'Measures'],
  [/trauma|ptsd|emdr|ace|abuse|victim|post-?traumatic/i, 'Trauma & PTSD'],
  [/\bact\b|getting unstuck|acceptance and commitment/i, 'ACT'],
  [/dbt|dialectical|linehan/i, 'DBT'],
  [/grief|loss|dementia/i, 'Grief & Loss'],
  [/divorce|separation/i, 'Divorce & Separation'],
  [/anx|panic|exposure|worry|fear|phobi/i, 'Anxiety'],
  [/depress|behavio(u)?ral activation|activities|postpartum/i, 'Depression'],
  [/adhd|add\b|focus/i, 'ADHD'],
  [/stress|relax|breath|pmr/i, 'Stress'],
  [/mindful|meditat|mbct|grounding|body ?scan/i, 'Mindfulness'],
  [/couple|relationship|boundar|family|partner/i, 'Couples & Relationships'],
  [/self-?compassion|self-?forgiv|self-?esteem|self-?love|self-?respect/i, 'Self-Esteem'],
  [/positive|gratitude|strength|happiness|best possible|affirmation|values|four agreements/i, 'Positive Psychology'],
  [/cbt|thought|cognitive|socratic|reappraisal|thinking|distortion|defense mechanism|stimulus/i, 'CBT'],
  [/habit|goal|self-?care|burnout|energy|chakra|cleanse|smudging|wellness|mental ?health ?(maintenance|plan)/i, 'Wellness & Lifestyle'],
  [/progress note|cpt code|v[_ ]codes|tx plan|treatment plan|planner|community services|211|clinician/i, 'Clinical Practice'],
  [/marijuana|craving|substance/i, 'Substance Use'],
  [/brain|neurotransmitter|affect|life[- ]?story|timeline|looking (back|forward)|past/i, 'Psychoeducation']
]

/** Large compilations indexed piece by piece, each piece opening at its page. */
const SECTIONS = {
  'Measures Package for ACT.pdf': { from: 'toc', kind: 'assessment', topic: 'ACT' },
  'INTERVENTIONS/TheCompleteSetofWorksheetsandHandoutsfromGettingUnstuckInACT.pdf': { from: 'outline', match: /^(?!.*\.pdf$)(?!Complete|Worksheets for|GettingUnstuck)/, topic: 'ACT', clean: (t) => t.replace(/ - from 'Getting Unstuck In ACT' by Russ Harris$/i, '').replace(/ - 2-pages - April 2013$/, '').replace(/^Intro to the psych flex/i, 'Introduction to the Psych Flex') }
}

// ---------------------------------------------------------------------------

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: cmd === 'osascript' ? 200_000 : 60_000 })
  } catch {
    return ''
  }
}
const walk = (dir) => readdirSync(dir).flatMap((name) => (name.startsWith('.') ? [] : statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]))

function extract(file, ext) {
  if (ext === 'pdf') return { pages: Number(run('pdfinfo', [file]).match(/^Pages:\s+(\d+)/m)?.[1]) || null, text: run('pdftotext', ['-l', '3', '-enc', 'UTF-8', file, '-']) }
  if (['doc', 'docx', 'webarchive', 'rtf'].includes(ext)) return { pages: null, text: run('textutil', ['-convert', 'txt', '-stdout', file]) }
  return { pages: null, text: '' }
}

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with', 'your', 'my', 'is', 'are'])
const ACRONYMS = /^(act|add|adhd|cbt|dbt|ptsd|bpd|ocd|tf|mbct|mbsr|na|apa|dsm|dsm5|phq|gad|iep|emdr|ace|aces|ie|tx|wrap|mh|bh|eft|sft|reach|glad|ipt|iadl|iadls|ii|iii|iv)$/i

function titleCase(s) {
  return s
    .split(' ')
    .map((w, i) => {
      if (ACRONYMS.test(w)) return w.toUpperCase().replace(/^DSM5$/, 'DSM-5')
      if (/[A-Z].*[A-Z]|\d/.test(w) && w !== w.toUpperCase()) return w // mixed case like PhD, CUDIT-R
      const lower = w.toLowerCase()
      if (i > 0 && SMALL.has(lower)) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

/** A readable title from a file name. */
function titleFromName(path) {
  let s = basename(path, extname(path))
  s = s
    // Random download prefixes like "lLhzrv-" or "JTxSOS-", but not a word like "Trauma-".
    .replace(/^([A-Za-z0-9]{6})-(?=[A-Za-z])/, (m, p) => (/[A-Z0-9]/.test(p.slice(1)) && /[a-z]/.test(p) ? '' : m))
    .replace(/^APA_DSM-?5[_-]/, 'DSM-5 ')
    .replace(/-(Adult)$/, ' (Adult)')
    .replace(/-Child-Age-11-to-17$/, ' (Child 11–17)')
    .replace(/-Parent-(?:Or-Guardian-)?(?:O|o)f-Child-Age-6-to-17$/, ' (Parent of Child 6–17)')
    .replace(/[ _-]*(FILLABLE|fillable|Fillable|free|web|optimized|508|print[_ ]big)$/g, '')
    .replace(/(?<=[a-z])\d+$/, '') // "disorder2"
    .replace(/(?<=\s|_)(?:\d{6,}|r\d{4}[ _]\d{4}|final[ _]\d{2}[ _]\d{4})$/, '')
    .replace(/[-_ ](free[-_ ])?en[-_]us$/i, '')
    .replace(/ _ (The Chopra Center|Psychology Today|The Huffington Post|DO-IT|Lucida®)$/i, '')
    .replace(/_ /g, ': ')
    .replace(/[_]+/g, ' ')
    .replace(/(?<=[A-Za-z])-(?=[A-Za-z])(?![A-Z]{2,}\b)/g, (m, i, all) => (/^DSM-5/.test(all) || (all.match(/-/g) ?? []).length > 1 ? ' ' : m))
    .replace(/(?<=[a-z])(?=[A-Z][a-z])/g, ' ') // camelCase
    .replace(/^(WS|Info)[- ]+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  const shouty = s === s.toUpperCase() || s === s.toLowerCase()
  return shouty ? titleCase(s) : s.replace(/^./, (c) => c.toUpperCase())
}

function kindOf(title, path, ext, pages, text) {
  const t = `${title} ${basename(path)}`
  if (['mp3', 'm4a'].includes(ext)) return 'audio'
  if (/chopra center|psychology today|huffington|lucida|summit medical|socialwork\.career/i.test(path)) return 'article'
  if (/tx plan|treatment plan|tx planning|treatment planning|planner|goals[_ ]objectives|cpt code|progress note phrases|v[_ ]codes|clinician thesaurus/i.test(t)) return 'clinician'
  if (/manual|facilitator|implementation|for mental health professionals|session-by-session|how to document|resourcekit|^ppt|for axis 1/i.test(t)) return 'clinician'
  if (/safety plan|Assessment Worksheet/i.test(t)) return 'worksheet'
  if (/Assessment Guide|Information Sheet/i.test(t)) return 'clinician'
  if (/assessment|scale|inventory|questionnaire|screen(er|ing)\b|measure|\btest\b|quiz|checklist|phq|gad-?7|audit|cudit|pcl-5|bdi|asrs|scoff|eat-26|y-?bocs|oci-r|mdq|qids|panss|caps-5|sbq|bavq|sast|adnm|level-[12]|severity|cultural-formulation|ierq|personal anger assessment|anxiety-test/i.test(t) || /\/Assessments\//.test(path)) return 'assessment'
  if (['png', 'jpg', 'jpeg'].includes(ext)) return 'visual'
  if ((pages ?? 0) >= 15 || /workbook|handouts and worksheets|complete set|guide$|booklet|package/i.test(t)) return 'workbook'
  if (/worksheet|^ws|\bws\b|log\b|diary|record|chart|journal|tracker|tracking|schedule|hierarchy|sentence completion|contract|\bplan\b|activity|exercise|game|letter|card|coupon|jar|wheel|mandala|bracelet|catcher|time capsule|questions|interview|story|album|incident report|homework|my |i am |things i/i.test(t)) return 'worksheet'
  if ((text.match(/_{6,}/g) ?? []).length >= 4) return 'worksheet'
  return 'handout'
}

function audienceOf(title, path) {
  const t = `${title} ${path}`
  if (/couple|marri|husband|wife|partner|love busters|love languages|infidelity/i.test(t)) return 'couples'
  if (/parent|family|caregiver/i.test(t) && !/child age 11|adolescent/i.test(t)) return /child|kid|bedwetting|enuresis/i.test(t) ? 'parents' : 'family'
  if (/teen|adolescent|age-11-to-17|11 to 17|youth/i.test(t)) return 'teens'
  if (/child|kid|children|enuresis|bedwetting|\/Child PHP\//i.test(t)) return 'children'
  if (/group/i.test(t)) return 'groups'
  return 'adults'
}

/** Topics after the folders: values and self-compassion are ACT work; uncertainty and worry are anxiety work. */
const RETOPIC = [
  [/\/Values\/|values-discussion|Values_and_Goals|Self Compassion|Self-Forgiveness/, 'ACT'],
  [/Uncertainty|Worry|Situational_Exposure|Situational Exposure|Children_myfears|Fear|Anxious|Your Anxiety|OCD|perfectionism|Skin-Picking|Phobia/, 'Anxiety'],
  [/Depression\/|ACFB0|Vicious Cycle of Depression|rumination|behavioral-activation|Behavioral Activation|Positive Activities|daily-mood-chart|depression/i, 'Depression'],
  [/^Safety Planning\//, 'Safety Planning']
]

function topicOf(path, title) {
  for (const [re, topic] of RETOPIC) if (re.test(path)) return topic
  const parts = path.split('/')
  if (parts[0] === 'INTERVENTIONS' && parts.length > 2 && TOPICS[parts[1]]) return TOPICS[parts[1]]
  for (const [re, topic] of TOPIC_WORDS) if (re.test(title) || re.test(basename(path))) return topic
  return 'General'
}

/** Leaf entries of a PDF's bookmark tree, with their pages. */
function outline(file) {
  const xml = run('pdftohtml', ['-xml', '-i', '-stdout', '-f', '1', '-l', '1', file])
  const items = []
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '’')
  for (const m of xml.matchAll(/<item page="(\d+)">([^<]*)<\/item>/g)) items.push({ page: Number(m[1]), title: decode(m[2]).replace(/\s+/g, ' ').trim() })
  return items
}

/** Entries of a dotted table of contents ("Title ........ 12"), skipping section headings. */
function toc(text) {
  const lines = [...text.matchAll(/^(.+?)\s*\.{3,}\s*(\d+)\s*$/gm)].map((m) => ({ title: m[1].trim(), page: Number(m[2]) }))
  // A heading is followed by its first entry on the very next page.
  const headings = /^(Forward|Avoidance \/ Acceptance|Fusion \/ Dysfunctional thinking|Mindfulness \/ Awareness of feelings|Value clarification .*|ACT measures for specific populations|General ACT measures)$/
  // Headings aren't resources, but a section ends where the next heading starts.
  return lines.map((l) => (headings.test(l.title) ? { ...l, heading: true } : l))
}

const id = (s) => createHash('sha1').update(s).digest('hex').slice(0, 8)

const files = walk(root)
  .map((f) => relative(root, f))
  .filter((p) => !EXCLUDE.has(p) && KEEP.some((re) => re.test(p)))
  .sort()
const seen = new Map()
const seenTitles = new Map()
/** Pages where each compilation's sections and headings start. */
const stops = new Map()
const items = []
for (const path of files) {
  const file = join(root, path)
  const ext = extname(path).slice(1).toLowerCase()
  const sha = createHash('sha1').update(readFileSync(file)).digest('hex')
  // The same file filed in two folders is one resource, listed under its first folder.
  if (seen.has(sha)) {
    seen.get(sha).also.push(path)
    continue
  }
  const { pages, text } = extract(file, ext)
  const title = TITLES[path] ?? titleFromName(path)
  const kind = kindOf(title, path, ext, pages, text)
  // The same handout saved twice under different names is listed once.
  const key = `${title.toLowerCase().replace(/[^a-z0-9]/g, '')}:${pages}`
  if (seenTitles.has(key)) {
    seenTitles.get(key).also.push(path)
    continue
  }
  const retopic = RETOPIC.find(([re]) => re.test(path))?.[1]
  const item = { id: id(sha), path, title, topic: retopic ?? (kind === 'assessment' && !/ACT/.test(title) ? 'Measures' : topicOf(path, title)), kind, audience: audienceOf(title, path), format: ext, pages, also: [] }
  seen.set(sha, item)
  seenTitles.set(key, item)
  items.push(item)

  const sections = SECTIONS[path]
  if (sections) {
    const all = sections.from === 'toc' ? toc(text) : outline(file).filter((e) => sections.match.test(e.title))
    stops.set(item.id, all.map((e) => e.page))
    const entries = all.filter((e) => !e.heading)
    const parents = new Set()
    for (const e of entries) {
      const name = (sections.clean ?? ((t) => t))(e.title.replace(/\.pdf$/, ''))
      const key = `${name}#${e.page}`
      if (parents.has(key)) continue
      parents.add(key)
      items.push({
        id: id(`${sha}#${e.page}#${name}`),
        path,
        page: e.page,
        parent: item.id,
        title: name,
        topic: sections.topic ?? item.topic,
        kind: sections.kind ?? (/worksheet/i.test(name) ? 'worksheet' : /handout/i.test(name) ? 'handout' : kindOf(name, path, 'pdf', 1, '')),
        audience: audienceOf(name, path),
        format: 'pdf',
        pages: null,
        also: []
      })
    }
  }
}
for (const item of items) if (!item.also.length) delete item.also
for (const item of items) if (item.pages === null) delete item.pages

// Official pages worth opening on the web (forms in other languages, apps, crisis lines).
items.push(
  { id: id('https://suicidesafetyplan.com/forms/'), title: 'Stanley-Brown Safety Plan: Official Forms, Translations and App', topic: 'Safety Planning', kind: 'clinician', audience: 'adults', url: 'https://suicidesafetyplan.com/forms/', note: 'The authors’ page: the current form in many languages, the app, and permissions' },
  { id: id('https://cssrs.columbia.edu/the-columbia-scale-c-ssrs/cssrs-for-communities-and-healthcare/'), title: 'Columbia Protocol (C-SSRS): All Versions and Training', topic: 'Safety Planning', kind: 'clinician', audience: 'adults', url: 'https://cssrs.columbia.edu/the-columbia-scale-c-ssrs/cssrs-for-communities-and-healthcare/', note: 'Every C-SSRS version (full, screeners, children’s) and free training' },
  { id: id('https://988lifeline.org/'), title: '988 Suicide & Crisis Lifeline', topic: 'Safety Planning', kind: 'handout', audience: 'adults', url: 'https://988lifeline.org/', note: 'Call or text 988, or chat online; for a client’s safety plan' }
)

// ACBS member resources, picked by select-acbs.mjs from a crawl of the site.
const acbs = existsSync('scripts/acbs-resources.json') ? JSON.parse(readFileSync('scripts/acbs-resources.json', 'utf8')) : []
items.push(...acbs)
// The ACT Measures Package's measures sit with the other ACT measures.
for (const item of items) if (item.parent && item.topic === 'ACT' && item.kind === 'assessment') item.topic = 'ACT Measures'

// ---------------------------------------------------------------------------
// What Echo shows in its viewer. Everything generated goes in <library>/.echo,
// next to the files it comes from, so the library folder is self-contained.
// ---------------------------------------------------------------------------

const ECHO = '.echo'
mkdirSync(join(root, ECHO, 'sections'), { recursive: true })
mkdirSync(join(root, ECHO, 'converted'), { recursive: true })
mkdirSync(join(root, ECHO, 'thumbs'), { recursive: true })

const PART_FORMAT = { pdf: 'pdf', html: 'html', htm: 'html', mp3: 'audio', m4a: 'audio', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', doc: 'html', docx: 'html', rtf: 'html', ppt: 'office', pptx: 'office', xls: 'office', xlsx: 'office' }

/** Which iWork app exports each Office format to PDF. */
const EXPORTER = { doc: 'Pages', docx: 'Pages', rtf: 'Pages', ppt: 'Keynote', pptx: 'Keynote', xls: 'Numbers', xlsx: 'Numbers' }

/** Office files exported to PDF by Pages, Keynote or Numbers, which keeps forms and tables laid out as designed. */
function exportPdf(rel, key) {
  const out = `${ECHO}/converted/${key}.pdf`
  if (existsSync(join(root, out))) return out
  const app = EXPORTER[extname(rel).slice(1).toLowerCase()]
  const esc = (p) => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `with timeout of 180 seconds
  tell application "${app}"
    set d to open (POSIX file "${esc(join(resolve(root), rel))}")
    export d to (POSIX file "${esc(join(resolve(root), out))}") as PDF
    close d saving no
  end tell
end timeout`
  run('osascript', ['-e', script])
  return existsSync(join(root, out)) ? out : null
}

/** One viewable part for a file: Office files as PDF (or, failing that, HTML or a thumbnail). */
function partFor(rel, label, key) {
  const ext = extname(rel).slice(1).toLowerCase()
  const format = PART_FORMAT[ext]
  if (!format) return { label, file: rel, format: 'other' }
  if (EXPORTER[ext] && process.platform === 'darwin') {
    const pdf = exportPdf(rel, key)
    if (pdf) return { label, file: pdf, format: 'pdf', original: rel }
  }
  if (['doc', 'docx', 'rtf'].includes(ext)) {
    const out = `${ECHO}/converted/${key}.html`
    if (!existsSync(join(root, out))) run('textutil', ['-convert', 'html', '-output', join(root, out), join(root, rel)])
    return existsSync(join(root, out)) ? { label, file: out, format: 'html', original: rel } : { label, file: rel, format: 'office' }
  }
  if (format === 'office') {
    const thumb = `${ECHO}/thumbs/${key}.png`
    if (!existsSync(join(root, thumb))) {
      const tmp = join(root, ECHO, 'thumbs', `tmp-${key}`)
      mkdirSync(tmp, { recursive: true })
      run('qlmanage', ['-t', '-s', '1400', '-o', tmp, join(root, rel)])
      const made = readdirSync(tmp).find((f) => f.endsWith('.png'))
      if (made) renameSync(join(tmp, made), join(root, thumb))
      rmSync(tmp, { recursive: true, force: true })
    }
    return { label, file: rel, format: 'office', ...(existsSync(join(root, thumb)) ? { thumb } : {}) }
  }
  return { label, file: rel, format }
}

/** A compilation's section as its own PDF, so scrolling stays within it. */
function sectionPdf(item, last) {
  const out = `${ECHO}/sections/${item.id}.pdf`
  if (!existsSync(join(root, out))) {
    const tmp = join(root, ECHO, 'sections', `tmp-${item.id}`)
    mkdirSync(tmp, { recursive: true })
    run('pdfseparate', ['-f', String(item.page), '-l', String(last), join(root, item.path), join(tmp, 'p-%04d.pdf')])
    const pages = readdirSync(tmp).sort().map((f) => join(tmp, f))
    if (pages.length) run('pdfunite', [...pages, join(root, out)])
    rmSync(tmp, { recursive: true, force: true })
  }
  return out
}

// Sections run to the page before the next one starts; the last runs to the end.
for (const parent of items.filter((i) => items.some((s) => s.parent === i.id))) {
  const sections = items.filter((s) => s.parent === parent.id).sort((a, b) => a.page - b.page)
  sections.forEach((s, i) => {
    const next = Math.min(...(stops.get(parent.id) ?? sections.map((n) => n.page)).filter((p) => p > s.page))
    const last = Number.isFinite(next) ? next - 1 : parent.pages
    s.pages = last - s.page + 1
    s.parts = [{ label: s.title, file: sectionPdf(s, last), format: 'pdf' }]
  })
}

for (const item of items.filter((i) => i.path && !i.parts)) item.parts = [partFor(item.path, item.title, item.id)]

// ACBS: the page's own text, then its attachments, from download-acbs (ClinicalResources/ACBS).
const content = existsSync(join(root, 'ACBS', 'acbs-content.json')) ? JSON.parse(readFileSync(join(root, 'ACBS', 'acbs-content.json'), 'utf8')) : null
for (const item of items.filter((i) => i.source === 'acbs')) {
  const page = content?.pages?.[item.id]
  const parts = []
  if (page?.html && cleanHtml(page.html).replace(/<[^>]+>/g, '').trim().length > 40) {
    const file = `ACBS/${item.id}/page.html`
    mkdirSync(join(root, 'ACBS', item.id), { recursive: true })
    writeFileSync(join(root, file), pageDocument(item.title, cleanHtml(page.html), page.author))
    parts.push({ label: 'Overview', file, format: 'html' })
  }
  for (const [i, f] of (content?.saved?.[item.id] ?? []).entries()) parts.push(partFor(`ACBS/${item.id}/${f.name}`, f.label || f.name, `${item.id}-${i}`))
  if (parts.length) item.parts = parts
}

/** Keeps a page's text and structure; drops scripts, embeds, images and inline handlers. */
function cleanHtml(html) {
  return html
    .replace(/<(script|style|iframe|object|embed|form|noscript|svg|video|audio)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(img|input|button|link|meta|source|picture)\b[^>]*>/gi, '')
    .replace(/\s(on\w+|style|class|id|data-[\w-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/href\s*=\s*("|')\s*javascript:[^"']*\1/gi, 'href="#"')
    .replace(/href="\//g, 'href="https://contextualscience.org/')
    .replace(/<p>\s*(&nbsp;)?\s*<\/p>/g, '')
}

function pageDocument(title, body, author) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><title>${esc(title)}</title><style>
:root { color-scheme: light dark; --text: #1e2421; --muted: #6b746f; --accent: #2e6b5e; --bg: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --text: #eaeeec; --muted: #9aa39e; --accent: #6cb5a3; --bg: #232625; } }
body { margin: 0; background: var(--bg); color: var(--text); font: 15.5px/1.65 ui-serif, 'New York', Georgia, serif; }
main { max-width: 680px; margin: 0 auto; padding: 28px 32px 60px; }
h1 { font: 600 22px/1.3 -apple-system, sans-serif; margin: 0 0 4px; }
.by { font: 12px -apple-system, sans-serif; color: var(--muted); margin-bottom: 22px; }
h2, h3, h4 { font-family: -apple-system, sans-serif; font-size: 15px; margin: 22px 0 6px; }
a { color: var(--accent); }
table { border-collapse: collapse; font: 13px -apple-system, sans-serif; } td, th { border: 1px solid #8884; padding: 4px 8px; }
blockquote { margin: 0; padding-left: 14px; border-left: 3px solid #8884; color: var(--muted); }
</style></head><body><main><h1>${esc(title)}</h1><div class="by">ACBS member resource${author ? ` · shared by ${esc(author)}` : ''}</div>${body}</main></body></html>`
}

writeFileSync(OUT, `${JSON.stringify({ builtFrom: basename(root), count: items.length, items }, null, 1)}\n`)
const by = (k) => Object.entries(items.reduce((a, i) => ((a[i[k]] = (a[i[k]] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1])
console.log(`${items.length} resources (${files.length} files, ${acbs.length} from ACBS) → ${OUT}`)
console.log('kinds:', by('kind').map(([k, n]) => `${k} ${n}`).join(', '))
console.log('topics:', by('topic').map(([k, n]) => `${k} ${n}`).join(', '))
console.log('audiences:', by('audience').map(([k, n]) => `${k} ${n}`).join(', '))
void dirname
