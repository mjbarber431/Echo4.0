import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AlertTriangle, ArrowLeft, Check, CheckCircle2, ChevronDown, Circle, CircleAlert, Copy, Inbox, Loader2, Lock, Mic, PanelLeftClose, PanelLeftOpen, PencilLine, RotateCcw, Sparkles, Trash2, Wand2, X } from 'lucide-react'
import type { AiSuggestions, Client, Note, NoteSection } from '@shared/types'
import { GOAL_STATUS_LABEL, modelLabel, NOTE_TYPE_LABEL } from '@shared/types'
import { auditChecks, CPT_OPTIONS, isTelehealth, scanRisk, todayISO, type Check as AuditCheck } from '@shared/compliance'
import { headerLines, noteToHtml, noteToText, sectionHtml, sectionText } from '@shared/format'
import { finalizeClient, sameDiagnoses } from '@shared/finalize'
import { sectionsFor } from '@shared/prompts'
import { buildQueue, isModelFailure, suggestModel, type NoteJob } from '@shared/queue'
import { api, nowISO, relativeDay, uid } from '../lib/util'
import { useCommand, useStore, type Amended } from '../store'
import { DictationSurface, useTranscript } from '../components/Dictation'
import type { DictationController } from '../lib/useDictation'
import { useCoverage, type Coverage } from '../lib/useCoverage'
import { AutoTextarea, Avatar, Button, CopyButton, Kbd } from '../components/ui'

const PLACEHOLDER: Record<Note['type'], string> = {
  progress: 'Talk it through like you would with a colleague. How they’ve been, what you worked on, how they responded, what’s next.\n\nRough and out of order is fine. Echo sorts it into the note.',
  intake: 'Why they’re seeking help now, what you heard and observed, your impression, the plan.\n\nRough and out of order is fine. Skip what didn’t come up; Echo flags what auditors expect.',
  termination: 'Why treatment is ending, how each goal went, where the client is now, and recommendations or referrals.\n\nRough and out of order is fine.'
}

/** Memory prompts shown beside the writing surface when there are no goals to anchor to. */
const CUES: Record<Note['type'], string[]> = {
  progress: ['How they’ve been', 'What you worked on', 'How they responded', 'Homework', 'What’s next'],
  intake: ['Why now', 'Symptoms and history', 'What you observed', 'Risk factors', 'Your impression', 'The plan'],
  termination: ['Why treatment is ending', 'Progress on each goal', 'Where they are now', 'Recommendations or referrals']
}

export function NoteView({ noteId }: { noteId: string }) {
  const { notes, clients } = useStore()
  const note = notes.find((n) => n.id === noteId)
  const client = clients.find((c) => c.id === note?.clientId)
  if (!note || !client) return null
  return <NoteEditor key={note.id} note={note} client={client} />
}

type Busy = NoteJob | null

/** Audit gaps a dictated follow-up can fix. Diagnosis and plan gaps live on the client record instead. */
const FOLLOW_UP_CHECKS = new Set(['goals', 'risk'])

function NoteEditor({ note, client }: { note: Note; client: Client }) {
  const store = useStore()
  const { settings, saveNote, saveClient, navigate, toast, noteSidebar, setNoteSidebar } = store
  // Writing runs in the store, so the clinician can leave and come back while it finishes.
  const job = store.jobs[note.id]
  const busy: Busy = job && !job.error ? job : null
  const failed = job?.error ? job : null
  const amended = store.amends[note.id] ?? null
  const setAmended = (a: Amended | null) => store.setAmended(note.id, a)
  const [showDictation, setShowDictation] = useState(false)
  const [following, setFollowing] = useState(false)
  const [followUp, setFollowUpState] = useState('')
  /** Bumped when a fresh draft arrives so it animates in; 0 means show it as is. A draft that finished in the background is fresh the first time it's opened. */
  const [reveal, setReveal] = useState(() => (store.unseen[note.id] ? 1 : 0))
  const latest = useRef(note)
  latest.current = note
  const followRef = useRef('')

  const update = (patch: Partial<Note>) => {
    const base = latest.current
    const next = { ...base, ...patch }
    latest.current = next
    void saveNote(next)
  }
  const setFollowUp = (text: string) => {
    followRef.current = text
    setFollowUpState(text)
  }

  const transcript = useTranscript(note.dictation, (dictation) => update({ dictation }), settings.liveCoverage)
  const followTranscript = useTranscript(followUp, setFollowUp)

  const final = note.status === 'final'
  const generated = note.sections.length > 0
  const composing = (!generated || showDictation) && !final && busy?.kind !== 'write'
  const followingUp = following && generated && !final && !busy
  // What's been said so far: the dictation plus the live turn still being transcribed.
  const said = transcript.heard ? `${note.dictation.trimEnd()} ${transcript.heard}` : note.dictation
  const riskHits = scanRisk(said)
  const coverage = useCoverage(note, client, said, settings.liveCoverage && composing && !generated)
  const checks = auditChecks(note, client)
  const flagged = [...note.reviewItems, ...checks.filter((c) => c.level !== 'ok' && FOLLOW_UP_CHECKS.has(c.id)).map((c) => (c.detail ? `${c.label}: ${c.detail}` : c.label))]
  const live = (t: typeof transcript) => t.state !== 'idle' || t.pending > 0
  const canWrite = !!note.dictation.trim() || live(transcript)

  // The recorders outlive their surfaces, so a hidden surface must never leave the mic on.
  // Stopping keeps what was said: the last segment is still transcribed.
  useEffect(() => {
    if (!composing && busy?.kind !== 'write' && transcript.state === 'recording') transcript.stop()
  }, [composing, busy, transcript])
  useEffect(() => {
    if (!followingUp && busy?.kind !== 'amend' && followTranscript.state === 'recording') followTranscript.stop()
  }, [followingUp, busy, followTranscript])

  // Bring the clinician to what changed rather than leaving them to hunt for it.
  useEffect(() => {
    if (amended?.changed.length) document.querySelector('.doc-section.changed')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [amended])

  const { markSeen } = store
  useEffect(() => markSeen(note.id), [markSeen, note.id])

  // When a job finishes while this note is open, settle the view the way a finished draft should look.
  const lastJob = useRef(job)
  useEffect(() => {
    const prev = lastJob.current
    lastJob.current = job
    if (!prev || prev.error || job) return
    if (prev.kind === 'write') {
      setShowDictation(false)
      setReveal((r) => r + 1)
    } else {
      setFollowUp('')
      setFollowing(false)
    }
  }, [job])

  /**
   * One press: stop the mic if it's on and hand the note off. Echo finishes the transcript and writes it in the
   * background, so go back to the client right away: the activity panel tracks it, and the next client is one click off.
   */
  const generate = (model?: string) => {
    if (busy || final || !canWrite) return
    if (generated && !window.confirm('Regenerate the note from the dictation? Edits you made to the note text will be replaced.')) return
    store.writeNote(note.id, live(transcript) ? transcript.finish() : undefined, model)
    navigate({ view: 'client', id: client.id })
  }

  // Rewritten a few times on the same model: offer the next one up, for this note.
  const rewrite = store.rewrites[note.id]
  const model = rewrite?.override ?? settings.textModel
  const stronger = suggestModel(model, rewrite?.model === model ? rewrite.count : 0)
  const offerStronger = !!stronger && !final && !busy && canWrite && (failed ? isModelFailure(failed.error ?? '') : generated)

  const openFollowUp = () => {
    if (busy || final) return
    setShowDictation(false)
    setFollowing(true)
    // They asked to answer by voice, so start listening straight away.
    if (followTranscript.state === 'idle') void followTranscript.start()
  }

  const closeFollowUp = () => setFollowing(false)

  /** Revise the draft with the follow-up instead of rewriting it, keeping the clinician's edits. */
  const applyFollowUp = () => {
    if (busy || final) return
    store.amendNote(note.id, flagged, live(followTranscript) ? followTranscript.finish().then(() => followRef.current) : followRef.current)
  }

  const undoFollowUp = () => {
    if (!amended) return
    const { sections, reviewItems, suggestions, dictation, generatedAt } = amended.before
    update({ sections, reviewItems, suggestions, dictation, generatedAt })
    setAmended(null)
    toast('Follow-up undone')
  }

  const copyAll = async () => {
    const current = latest.current
    await api().copy(noteToText(current, client, settings), noteToHtml(current, client, settings))
    update({ copiedAt: nowISO() })
    toast('Copied. Paste into your EHR with ⌘V.', 'success')
  }

  const finalize = async (andCopy: boolean) => {
    if (!generated || final || busy) return
    const current = latest.current
    const blocking = auditChecks(current, client).filter((c) => c.level === 'error')
    if (blocking.length && !window.confirm(`Audit check: ${blocking.map((c) => c.label).join('; ')}.\n\nFinalize anyway?`)) return
    const now = nowISO()
    store.dismissJob(note.id)
    if (!current.finalizedAt) saveClient(finalizeClient(current, client, settings, uid, now))
    const next: Note = { ...current, status: 'final', finalizedAt: current.finalizedAt ?? now }
    latest.current = next
    await saveNote(next)
    setAmended(null)
    setFollowing(false)
    if (andCopy) {
      await api().copy(noteToText(next, client, settings), noteToHtml(next, client, settings))
      update({ copiedAt: nowISO() })
      toast(note.type === 'termination' ? 'Finalized and copied. Client moved to discharged.' : 'Finalized and copied. Plan and context updated.', 'success')
    } else toast('Note finalized', 'success')
  }

  useCommand('generate', () => void (followingUp ? applyFollowUp() : generate()))
  useCommand('copy-note', () => generated && void copyAll())
  useCommand('finalize', () => void finalize(true))

  const backToClient = () => navigate({ view: 'client', id: client.id })

  const generateButton = (
    <div className="dock-action">
      <Button variant="primary" icon={<Wand2 size={15} />} disabled={!canWrite || !!busy} onClick={() => generate()} title="⌘↵">
        {generated ? 'Regenerate' : 'Generate note'}
      </Button>
      <Kbd>⌘↵</Kbd>
    </div>
  )

  const headings = generated ? note.sections.map((x) => x.heading) : sectionsFor(note.type, note.format)
  const revising = !!busy && generated

  return (
    <div className="page">
      <header className="page-head drag">
        <button
          className="icon-btn"
          onClick={() => setNoteSidebar(!noteSidebar)}
          title={noteSidebar ? 'Hide client list' : 'Show client list'}
          aria-label={noteSidebar ? 'Hide client list' : 'Show client list'}
        >
          {noteSidebar ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
        <button className="crumb no-drag" onClick={backToClient}>
          <ArrowLeft size={15} />
          <Avatar id={client.id} name={client.name} size={22} />
          <span>{client.name}</span>
        </button>
        <span className="crumb-sep">/</span>
        <span className="crumb-current">{NOTE_TYPE_LABEL[note.type]}</span>
        <SessionMeta note={note} onChange={(session) => update({ session })} disabled={final || !!busy} />
        <div className="head-actions no-drag">
          {!noteSidebar && <QueuePill noteId={note.id} />}
          <span className={`chip ${final ? 'chip-ok' : 'chip-draft'}`}>{final ? 'Finalized' : 'Draft'}</span>
          {!final && (
            <button
              className="icon-btn"
              title="Discard draft"
              aria-label="Discard draft"
              disabled={!!busy}
              onClick={() => {
                if (window.confirm('Delete this draft?')) {
                  store.deleteNote(note.id)
                  backToClient()
                }
              }}
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </header>

      <div className="page-body with-side">
        <div className="note-main">
          {composing && (
            <section className={generated ? 'compose' : 'compose fill'}>
              {generated && (
                <div className="compose-head">
                  <span>Dictation</span>
                  <button className="icon-btn" onClick={() => setShowDictation(false)} aria-label="Hide dictation">
                    <X size={15} />
                  </button>
                </div>
              )}
              <DictationSurface
                controller={transcript}
                value={note.dictation}
                onChange={(dictation) => update({ dictation })}
                placeholder={PLACEHOLDER[note.type]}
                autoFocusRecord={!generated}
                ready={coverage.ready}
                dock={
                  <>
                    <Attestations note={note} riskHits={riskHits} onChange={(attest) => update({ attest })} />
                    {generateButton}
                  </>
                }
              />
            </section>
          )}

          {failed && <JobError job={failed} onRetry={() => store.retryJob(note.id)} onDismiss={() => store.dismissJob(note.id)} />}

          {offerStronger && stronger && (
            <StrongerModel
              current={model}
              stronger={stronger}
              onWrite={() => generate(stronger)}
              onMakeDefault={() => {
                store.clearOverride(note.id)
                void store.saveSettings({ textModel: stronger })
                toast(`New notes will be written with ${modelLabel(stronger)}. Change it any time in Settings.`, 'success')
              }}
            />
          )}

          {busy && <WritingStatus busy={busy} note={note} generated={generated} />}

          {busy && !generated && <DraftSkeleton note={note} client={client} headings={headings} />}

          {followingUp && (
            <FollowUpPanel
              flagged={flagged}
              controller={followTranscript}
              value={followUp}
              onChange={setFollowUp}
              onApply={applyFollowUp}
              onClose={closeFollowUp}
            />
          )}

          {generated && (
            <>
              <div className={`note-toolbar ${reveal ? 'reveal-fade' : ''}`} key={`bar-${reveal}`}>
                {!final ? (
                  <>
                    <Button variant="primary" icon={<Check size={15} />} onClick={() => finalize(true)} disabled={!!busy} title="⌘S">
                      Finalize &amp; copy
                    </Button>
                    <Button icon={<Copy size={14} />} onClick={copyAll} disabled={!!busy} title="⇧⌘C">
                      Copy note
                    </Button>
                    {!followingUp && (
                      <Button variant="ghost" icon={<Mic size={14} />} onClick={openFollowUp} disabled={!!busy} title="Dictate an addition or correction; Echo revises the draft">
                        Follow up
                      </Button>
                    )}
                    {!showDictation && (
                      <Button variant="ghost" icon={<PencilLine size={14} />} onClick={() => {
                          closeFollowUp()
                          setShowDictation(true)
                        }} disabled={!!busy}>
                        Dictation
                      </Button>
                    )}
                    <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => generate()} disabled={!!busy}>
                      Regenerate
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="primary" icon={<Copy size={14} />} onClick={copyAll}>
                      Copy note
                    </Button>
                    <Button variant="ghost" icon={<PencilLine size={14} />} onClick={() => update({ status: 'draft' })}>
                      Reopen to edit
                    </Button>
                  </>
                )}
                <span className="toolbar-meta muted small">
                  {note.copiedAt ? `Copied ${new Date(note.copiedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Not copied yet'}
                </span>
              </div>

              {amended && !busy && (
                <div className="amend-banner">
                  <Sparkles size={14} />
                  <span>
                    {amended.changed.length
                      ? `Follow-up applied to ${amended.changed.length} section${amended.changed.length === 1 ? '' : 's'}. The rest of your draft is unchanged.`
                      : 'Follow-up applied. No section text needed to change.'}
                  </span>
                  <button className="link" onClick={undoFollowUp}>
                    Undo
                  </button>
                  <button className="icon-btn" onClick={() => setAmended(null)} aria-label="Dismiss">
                    <X size={13} />
                  </button>
                </div>
              )}

              <article className={`card note-doc ${reveal ? 'reveal' : ''} ${revising ? 'revising' : ''}`} key={`doc-${reveal}`} aria-busy={revising}>
                {settings.includeHeader && (
                  <div className="note-header-preview">
                    {headerLines(note, client, settings).map((l) => (
                      <div key={l}>{l}</div>
                    ))}
                  </div>
                )}
                {note.sections.map((section, i) => (
                  <DocSection
                    key={i}
                    index={i}
                    section={section}
                    readOnly={final}
                    locked={revising}
                    changed={!!amended && amended.changed.includes(i)}
                    onChange={(body) => update({ sections: latest.current.sections.map((s, j) => (j === i ? { ...s, body } : s)) })}
                  />
                ))}
              </article>
            </>
          )}
        </div>

        <aside className="note-side">
          {generated ? (
            <div className={`side-stack ${reveal ? 'reveal' : ''}`} key={`side-${reveal}`}>
              {(!final || note.generatedAt) && <AuditPanel checks={checks} />}
              {note.reviewItems.length > 0 && <ReviewItems items={note.reviewItems} onDismiss={(i) => update({ reviewItems: note.reviewItems.filter((_, j) => j !== i) })} />}
              {!final && flagged.length > 0 && !followingUp && (
                <button className="followup-cta" onClick={openFollowUp} disabled={!!busy}>
                  <Mic size={15} />
                  <span>
                    <b>Answer by voice</b>
                    <small>Dictate the missing pieces; Echo works them into this draft.</small>
                  </span>
                </button>
              )}
              {note.suggestions && (
                <Suggestions client={client} suggestions={note.suggestions} applied={!!note.finalizedAt} onChange={(suggestions) => update({ suggestions })} />
              )}
            </div>
          ) : (
            <ReferencePanel type={note.type} client={client} coverage={settings.liveCoverage ? <CoveragePanel coverage={coverage} note={note} /> : null} />
          )}
        </aside>
      </div>
    </div>
  )
}

/** One quiet line in the header; the fields are prefilled defaults, so they open only when needed. */
function SessionMeta({ note, onChange, disabled }: { note: Note; onChange(s: Note['session']): void; disabled: boolean }) {
  const s = note.session
  const set = (patch: Partial<Note['session']>) => onChange({ ...s, ...patch })
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const summary = [relativeDay(s.date, todayISO()), s.cpt === 'none' ? 'Not billed' : s.cpt, isTelehealth(s.setting) ? 'Telehealth' : 'In office'].filter(Boolean).join(' · ')

  return (
    <div className="menu-wrap no-drag" ref={wrap}>
      <button className="session-meta" onClick={() => setOpen((v) => !v)} disabled={disabled} aria-expanded={open} title={disabled ? undefined : 'Session details'}>
        {summary}
        {!disabled && <ChevronDown size={13} />}
      </button>
      {open && (
        <div className="session-pop">
          <label>
            <span>Date</span>
            <input type="date" value={s.date} onChange={(e) => set({ date: e.target.value })} />
          </label>
          <label>
            <span>Service</span>
            <select value={s.cpt} onChange={(e) => set({ cpt: e.target.value })}>
              {CPT_OPTIONS[note.type].map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  )
}

/**
 * Leaving these on is the clinician's attestation (see README), so they stay
 * visible next to Generate. The longer explanations live in tooltips.
 */
function Attestations({ note, riskHits, onChange }: { note: Note; riskHits: string[]; onChange(a: Note['attest']): void }) {
  const a = note.attest
  const risk = riskHits.length > 0
  return (
    <>
      {risk && (
        <div className="risk-banner">
          <AlertTriangle size={15} />
          <div>
            <b>Risk-related words detected</b> ({riskHits.join(', ')}). The safety default is off for this note, so risk is documented only as you dictated it.
            If it’s a false alarm (e.g. “cutting back on caffeine”), just check the risk section after generating.
          </div>
        </div>
      )}
      <div className="attest">
        <AttestChip
          checked={a.noSafetyConcerns && !risk}
          disabled={risk}
          onChange={(v) => onChange({ ...a, noSafetyConcerns: v })}
          label="No safety concerns this session"
          hint="Fills the risk section when you don’t mention risk. You’re attesting this is accurate."
        />
        <AttestChip
          checked={a.mseUnremarkable}
          onChange={(v) => onChange({ ...a, mseUnremarkable: v })}
          label="Mental status unremarkable except as dictated"
          hint="Fills unmentioned MSE domains as within normal limits."
        />
      </div>
    </>
  )
}

function AttestChip({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`attest-chip ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`} title={hint}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="attest-box" aria-hidden>
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      {label}
    </label>
  )
}

function DocSection({ section, index, readOnly, locked, changed, onChange }: { section: NoteSection; index: number; readOnly: boolean; locked: boolean; changed: boolean; onChange(body: string): void }) {
  const { settings } = useStore()
  return (
    <section className={`doc-section ${changed ? 'changed' : ''}`} style={{ '--i': index } as CSSProperties}>
      <div className="section-head">
        <h4>{section.heading}</h4>
        {changed && <span className="changed-tag">Updated</span>}
        <CopyButton text={sectionText(section, settings).split('\n').slice(1).join('\n')} html={sectionHtml(section, settings)} label="" title="Copy this section" />
      </div>
      {readOnly ? <div className="section-body">{section.body}</div> : <AutoTextarea className="section-edit" value={section.body} readOnly={locked} onChange={(e) => onChange(e.target.value)} spellCheck />}
    </section>
  )
}

function AuditPanel({ checks }: { checks: AuditCheck[] }) {
  const problems = checks.filter((c) => c.level !== 'ok').length
  return (
    <section className="side-card">
      <h3>
        {problems === 0 ? <CheckCircle2 size={16} className="ok" /> : <CircleAlert size={16} className="warn" />}
        Audit readiness
      </h3>
      <ul className="checks">
        {checks.map((c) => (
          <li key={c.id} className={`check-${c.level}`}>
            <span className="check-dot" />
            <div>
              <div>{c.label}</div>
              {c.detail && <small>{c.detail}</small>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ReviewItems({ items, onDismiss }: { items: string[]; onDismiss(i: number): void }) {
  return (
    <section className="side-card review">
      <h3>
        <AlertTriangle size={15} className="warn" /> Please review
      </h3>
      <ul>
        {items.map((item, i) => (
          <li key={i}>
            <span>{item}</span>
            <button className="icon-btn" onClick={() => onDismiss(i)} title="Done" aria-label="Mark reviewed">
              <Check size={13} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Suggestions({ client, suggestions: s, applied, onChange }: { client: Client; suggestions: AiSuggestions; applied: boolean; onChange(s: AiSuggestions): void }) {
  const [showContext, setShowContext] = useState(false)
  const goals = client.plan?.goals ?? []
  const offerDx = s.diagnoses.length > 0 && (s.applyDiagnoses || !sameDiagnoses(s.diagnoses, client.diagnoses))
  const has = s.goalUpdates.length || s.newGoals.length || offerDx || s.contextUpdate
  if (!has) return null
  return (
    <section className="side-card">
      <h3>
        <Sparkles size={15} /> {applied ? 'Applied to the record' : 'On finalize, update…'}
      </h3>
      {s.goalUpdates.map((u, i) => {
        const index = goals.findIndex((g) => g.id === u.goalId)
        return (
          <label key={u.goalId} className={`suggestion ${applied ? 'applied' : ''}`}>
            <input
              type="checkbox"
              disabled={applied}
              checked={u.accepted}
              onChange={(e) => onChange({ ...s, goalUpdates: s.goalUpdates.map((x, j) => (j === i ? { ...x, accepted: e.target.checked } : x)) })}
            />
            <div>
              <b>
                Goal {index + 1} → {GOAL_STATUS_LABEL[u.status]}
              </b>
              <p>{u.progress}</p>
            </div>
          </label>
        )
      })}
      {s.newGoals.map((g, i) => (
        <label key={i} className={`suggestion ${applied ? 'applied' : ''}`}>
          <input
            type="checkbox"
            disabled={applied}
            checked={g.accepted}
            onChange={(e) => onChange({ ...s, newGoals: s.newGoals.map((x, j) => (j === i ? { ...x, accepted: e.target.checked } : x)) })}
          />
          <div>
            <b>New goal: {g.goal}</b>
            <p>{g.objectives.join(' · ')}</p>
          </div>
        </label>
      ))}
      {offerDx && (
        <label className={`suggestion ${applied ? 'applied' : ''}`}>
          <input type="checkbox" disabled={applied} checked={s.applyDiagnoses} onChange={(e) => onChange({ ...s, applyDiagnoses: e.target.checked })} />
          <div>
            <b>{client.diagnoses.length && !applied ? 'Replace diagnosis' : 'Set diagnosis'}</b>
            <p>{s.diagnoses.map((d) => `${d.code} ${d.description}`).join('; ')}</p>
          </div>
        </label>
      )}
      {s.contextUpdate && (
        <div className="suggestion context">
          <button className="link" onClick={() => setShowContext((v) => !v)}>
            <ChevronDown size={13} className={showContext ? '' : 'rot-neg'} /> Clinical context {applied ? 'updated' : 'will be refreshed'}
          </button>
          {showContext && <p className="context-preview">{s.contextUpdate}</p>}
        </div>
      )}
    </section>
  )
}

/** Live coverage: what the note needs, ticked off as the clinician talks. */
function CoveragePanel({ coverage: { items, covered, checking, error, ready }, note }: { coverage: Coverage; note: Note }) {
  const attested = note.attest.noSafetyConcerns && note.attest.mseUnremarkable && !items.some((i) => i.id.startsWith('risk'))
  return (
    <div className="ref-block coverage">
      <h3>
        {ready ? 'Ready to write' : 'What the note needs'}
        {checking && <Loader2 size={11} className="spin" aria-label="Checking" />}
      </h3>
      <ul className="coverage-list">
        {items.map((i) => (
          <li key={i.id} className={covered[i.id] ? 'covered' : ''}>
            {covered[i.id] ? <CheckCircle2 size={14} /> : <Circle size={14} />}
            {i.label}
          </li>
        ))}
      </ul>
      <p className="ref-hint">
        {error ? (
          `Couldn’t check the dictation: ${error}`
        ) : ready ? (
          <>
            Everything’s covered. <Kbd>⌘↵</Kbd> when you’re done.
          </>
        ) : attested ? (
          'Ticks off as you talk. Safety and mental status come from the switches under the dictation.'
        ) : (
          'Ticks off as you talk.'
        )}
      </p>
    </div>
  )
}

/** What the clinician may want to glance at while recalling the session: the plan, where things stand, and memory prompts. */
function ReferencePanel({ type, client, coverage }: { type: Note['type']; client: Client; coverage: ReactNode }) {
  const [moreContext, setMoreContext] = useState(false)
  const goals = client.plan?.goals ?? []
  const showGoals = goals.length > 0 && type !== 'intake'
  const longContext = client.context.length > 360
  return (
    <section className="reference">
      {coverage}
      {showGoals ? (
        <div className="ref-block">
          <h3>Treatment goals</h3>
          <ol className="goal-mini">
            {goals.map((g) => (
              <li key={g.id}>
                <span>{g.goal}</span>
                <small>{GOAL_STATUS_LABEL[g.status]}</small>
              </li>
            ))}
          </ol>
          <p className="ref-hint">Say “goal two” and Echo will link it.</p>
        </div>
      ) : coverage ? null : (
        <div className="ref-block">
          <h3>Worth touching on</h3>
          <ul className="cue-list">
            {CUES[type].map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {client.context && type !== 'intake' && (
        <div className="ref-block">
          <h3>Where things stand</h3>
          <p className={`context-snippet ${moreContext ? 'open' : ''}`}>{client.context}</p>
          {longContext && (
            <button className="link" onClick={() => setMoreContext((v) => !v)}>
              {moreContext ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
      <p className="ref-hint privacy-note">
        <Lock size={11} /> The client’s name is removed before writing. Your scratchpad is never sent.
      </p>
    </section>
  )
}

const WRITING_FROM: Record<Note['type'], string> = {
  progress: 'Drawing on the treatment plan, clinical context and recent notes',
  intake: 'Organizing it into a diagnostic evaluation',
  termination: 'Drawing on the full course of treatment'
}

/** What's happening right now. Stages follow real state (the transcript queue, then the model), never a timer. */
function WritingStatus({ busy, note, generated }: { busy: NonNullable<Busy>; note: Note; generated: boolean }) {
  const amend = busy.kind === 'amend'
  const title =
    busy.stage === 'transcribing'
      ? amend
        ? 'Transcribing your follow-up'
        : 'Transcribing the last of your dictation'
      : amend
        ? 'Working your follow-up into the note'
        : generated
          ? 'Rewriting the note from your dictation'
          : `Writing the ${NOTE_TYPE_LABEL[note.type].toLowerCase()}`
  const detail = busy.stage === 'transcribing' ? 'A moment, then Echo starts writing.' : amend ? 'Your edits stay as they are. Only what the follow-up touches changes.' : WRITING_FROM[note.type]
  const { emit, navigate } = useStore()
  return (
    <div className="writing-status" role="status" aria-live="polite">
      <span className="writing-orb" aria-hidden />
      <div key={`${busy.kind}-${busy.stage}`} className="writing-copy">
        <b>{title}</b>
        <small>{detail}</small>
      </div>
      {!amend && (
        <div className="writing-leave">
          <span className="muted small">No need to wait. Echo will let you know when it’s ready.</span>
          <Button size="sm" icon={<Mic size={13} />} onClick={() => emit('next-note')} title="⌘N">
            Next note
          </Button>
          <Button size="sm" variant="ghost" icon={<Inbox size={13} />} onClick={() => navigate({ view: 'queue' })}>
            Queue
          </Button>
        </div>
      )}
    </div>
  )
}

/** The job failed. The note is as it was, so retrying is safe. */
function JobError({ job, onRetry, onDismiss }: { job: NoteJob; onRetry(): void; onDismiss(): void }) {
  const canRetry = job.kind === 'write' || !!job.followUp
  return (
    <div className="job-error" role="alert">
      <CircleAlert size={15} />
      <span>
        <b>{job.kind === 'write' ? 'Echo couldn’t write this note.' : 'Echo couldn’t apply your follow-up.'}</b> {job.error}
      </span>
      {canRetry && (
        <Button size="sm" icon={<RotateCcw size={13} />} onClick={onRetry}>
          Try again
        </Button>
      )}
      <button className="icon-btn" onClick={onDismiss} aria-label="Dismiss">
        <X size={13} />
      </button>
    </div>
  )
}

/** Shown after the same note has been rewritten a few times: a stronger model may get it right. */
function StrongerModel({ current, stronger, onWrite, onMakeDefault }: { current: string; stronger: string; onWrite(): void; onMakeDefault(): void }) {
  return (
    <div className="model-offer" role="status">
      <Sparkles size={15} />
      <span>
        <b>Still not right?</b> {modelLabel(stronger)} reads the dictation more carefully than {modelLabel(current)}. It’s slower and costs more per note.
      </span>
      <Button size="sm" icon={<Wand2 size={13} />} onClick={onWrite}>
        Write with {modelLabel(stronger)}
      </Button>
      <Button size="sm" variant="ghost" onClick={onMakeDefault}>
        Use for all notes
      </Button>
    </div>
  )
}

/** The client list is hidden while writing, so other notes in flight show here instead. */
function QueuePill({ noteId }: { noteId: string }) {
  const { notes, clients, jobs, navigate } = useStore()
  const q = buildQueue(notes, clients, jobs)
  const others = (list: Note[]) => list.filter((n) => n.id !== noteId).length
  const writing = others(q.writing)
  const ready = others(q.ready)
  const failed = others(q.failed)
  if (!writing && !ready && !failed) return null
  const parts = [writing && `${writing} writing`, ready && `${ready} ready`, failed && `${failed} failed`].filter(Boolean)
  return (
    <button className={`queue-pill ${writing ? 'busy' : ''} ${failed ? 'failed' : ''}`} onClick={() => navigate({ view: 'queue' })} title="Open the queue">
      {writing > 0 && <span className="queue-pill-orb" aria-hidden />}
      {parts.join(' · ')}
    </button>
  )
}

/** Laid out exactly like the finished note, so the draft settles into place instead of replacing a spinner. */
function DraftSkeleton({ note, client, headings }: { note: Note; client: Client; headings: string[] }) {
  const { settings } = useStore()
  const widths = [94, 82, 88, 61]
  return (
    <article className="card note-doc writing" aria-hidden>
      {settings.includeHeader && (
        <div className="note-header-preview">
          {headerLines(note, client, settings).map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}
      {headings.map((h, i) => (
        <section key={h} className="doc-section" style={{ '--i': i } as CSSProperties}>
          <div className="section-head">
            <h4>{h}</h4>
          </div>
          <div className="skel-para">
            {widths.slice(0, i % 2 ? 3 : 4).map((w, j) => (
              <div key={j} className="skel-line" style={{ width: `${w - ((i * 7) % 12)}%` }} />
            ))}
          </div>
        </section>
      ))}
    </article>
  )
}

/** Answer what the audit flagged by voice. One press stops the mic and applies it to the draft. */
function FollowUpPanel({ flagged, controller, value, onChange, onApply, onClose }: {
  flagged: string[]
  controller: DictationController
  value: string
  onChange(next: string): void
  onApply(): void
  onClose(): void
}) {
  const live = controller.state !== 'idle' || controller.pending > 0
  return (
    <section className="card followup">
      <div className="card-head">
        <h3>
          <Mic size={15} /> {flagged.length ? 'Answer what’s missing' : 'Add to this note'}
        </h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <X size={15} />
        </button>
      </div>
      {flagged.length > 0 && (
        <ol className="followup-asks">
          {flagged.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ol>
      )}
      <DictationSurface
        compact
        finishable
        controller={controller}
        value={value}
        onChange={onChange}
        placeholder={flagged.length ? 'Answer in any order, e.g. “Risk level is low, we updated the safety plan. Goal two, they used the breathing twice this week.”' : 'Anything to add or correct. Echo works it into the draft and leaves the rest alone.'}
      />
      <div className="generate-row">
        <Button variant="primary" icon={<Wand2 size={15} />} disabled={!value.trim() && !live} onClick={onApply} title="⌘↵">
          Apply to note
        </Button>
        <Kbd>⌘↵</Kbd>
      </div>
    </section>
  )
}
