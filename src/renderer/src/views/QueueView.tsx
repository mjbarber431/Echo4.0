import { useMemo, type ReactNode } from 'react'
import { InboxRow } from '../components/InboxRow'
import { CalendarClock, CheckCircle2, CircleAlert, ClipboardList, ExternalLink, FilePen, FileText, RotateCcw, Smartphone, Target, UserPlus } from 'lucide-react'
import type { Client, Note } from '@shared/types'
import { NOTE_TYPE_LABEL } from '@shared/types'
import { planReviewDue, todayISO } from '@shared/compliance'
import { noteToHtml, noteToText } from '@shared/format'
import { buildPlanQueue, buildQueue, chartNotes, chartStatus } from '@shared/queue'
import { longDate, relativeDay } from '../lib/util'
import { useStore } from '../store'
import { Avatar, Button, CopyButton, Kbd } from '../components/ui'

/**
 * Home. Everything across all clients that still needs the clinician: drafts to review,
 * finalized notes not yet in the EHR, unwritten drafts and plan reviews due. Notes being
 * written show in the sidebar's Activity panel, and new notes start from ⌘N.
 */
export function QueueView({ onNewClient }: { onNewClient(): void }) {
  const { clients, notes, inbox, jobs, unseen, planJobs, planDrafts, settings, navigate, saveNote, retryJob, retryPlan, charting, startCharting, stopCharting, openEhrs } = useStore()
  const today = todayISO()
  const byId = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients])
  const q = useMemo(() => buildQueue(notes, clients, jobs, today), [notes, clients, jobs, today])
  const p = useMemo(() => buildPlanQueue(clients, planJobs, planDrafts), [clients, planJobs, planDrafts])
  // A plan being drafted (or waiting for review) isn't also due for review.
  const reviews = clients.filter((c) => c.status === 'active' && planReviewDue(c, today) && !planJobs[c.id] && !planDrafts[c.id])
  const total = inbox.length + q.failed.length + q.ready.length + q.uncopied.length + q.unwritten.length + reviews.length + p.failed.length + p.ready.length

  const toChart = chartNotes(q).length
  const charted = charting ? notes.filter((n) => charting.includes(n.id)) : []
  const resume = charted.find((n) => chartStatus(n) !== 'done') ?? charted[0]

  const open = (n: Note) => navigate({ view: 'note', id: n.id })
  const markCopied = (n: Note) => void saveNote({ ...n, copiedAt: new Date().toISOString() })
  const copy = (n: Note, c: Client) => <CopyButton text={noteToText(n, c, settings)} html={noteToHtml(n, c, settings)} onCopied={() => markCopied(n)} />
  const row = (n: Note, icon: ReactNode, text: ReactNode, aside?: ReactNode) => {
    const c = byId.get(n.clientId)!
    return (
      <div key={n.id} className="list-row" onClick={() => open(n)} role="button">
        {icon}
        <Avatar id={c.id} name={c.name} size={24} />
        <span className="grow">
          <b>{c.name}</b> · {text}
        </span>
        {aside && <span onClick={(e) => e.stopPropagation()}>{aside}</span>}
      </div>
    )
  }
  const planRow = (c: Client, icon: ReactNode, text: ReactNode, aside?: ReactNode) => (
    <div key={`plan-${c.id}`} className="list-row" onClick={() => navigate({ view: 'client', id: c.id, tab: 'plan' })} role="button">
      {icon}
      <Avatar id={c.id} name={c.name} size={24} />
      <span className="grow">
        <b>{c.name}</b> · {text}
      </span>
      {aside && <span onClick={(e) => e.stopPropagation()}>{aside}</span>}
    </div>
  )
  const section = (title: string, rows: ReactNode[]) =>
    rows.length > 0 && (
      <section className="today-section">
        <h2>{title}</h2>
        <div className="list-card">{rows}</div>
      </section>
    )

  return (
    <div className="page today">
      <header className="page-head drag" />
      <div className="today-body">
        <div className="today-hero">
          <p className="eyebrow">{longDate(today)}</p>
          <h1 className="display">{total ? `${total} to do.` : 'All caught up.'}</h1>
          {(toChart > 0 || !!settings.ehrs?.length) && (
            <div className="row gap chart-start">
              {charting ? (
                <>
                  <Button variant="primary" icon={<ClipboardList size={15} />} onClick={() => navigate({ view: 'chart', id: resume?.id })} title="Back to the notes you're charting">
                    Resume charting
                  </Button>
                  <Button variant="ghost" onClick={stopCharting}>
                    Stop charting
                  </Button>
                </>
              ) : (
                toChart > 0 && (
                  <Button variant="primary" icon={<ClipboardList size={15} />} onClick={startCharting} title="⇧⌘E">
                    Chart {toChart} note{toChart === 1 ? '' : 's'}
                  </Button>
                )
              )}
              {!!settings.ehrs?.length && (
                <Button variant="ghost" icon={<ExternalLink size={14} />} onClick={() => void openEhrs()} title="⌥⌘E">
                  Open EHRs
                </Button>
              )}
              {toChart > 0 && !charting && <Kbd>⇧⌘E</Kbd>}
            </div>
          )}
        </div>

        {clients.length === 0 ? (
          <div className="start-empty">
            <p className="muted">Add a client to begin. All Echo needs is a name.</p>
            <Button variant="primary" icon={<UserPlus size={15} />} onClick={onNewClient}>
              Add your first client
            </Button>
          </div>
        ) : (
          !total && (
            <p className="muted">
              Press <Kbd>⌘N</Kbd> to start the next note.
            </p>
          )
        )}

        {inbox.length > 0 && (
          <section className="today-section">
            <h2>
              <Smartphone size={13} /> From your iPhone
            </h2>
            <div className="list-card">
              {[...inbox]
                .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
                .map((m) => (
                  <InboxRow key={m.id} memo={m} />
                ))}
            </div>
          </section>
        )}

        {section('Couldn’t write', [
          ...q.failed.map((n) =>
            row(
              n,
              <CircleAlert size={16} className="error" />,
              <>
                {NOTE_TYPE_LABEL[n.type]} <span className="muted">couldn’t be {jobs[n.id].kind === 'amend' ? 'revised' : 'written'}: {jobs[n.id].error}</span>
              </>,
              (jobs[n.id].kind === 'write' || jobs[n.id].followUp) && (
                <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => retryJob(n.id)}>
                  Retry
                </Button>
              )
            )
          ),
          ...p.failed.map((c) =>
            planRow(
              c,
              <CircleAlert size={16} className="error" />,
              <>
                Treatment plan <span className="muted">couldn’t be {planJobs[c.id].updating ? 'updated' : 'drafted'}: {planJobs[c.id].error}</span>
              </>,
              planJobs[c.id].dictation !== undefined && (
                <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => retryPlan(c.id)}>
                  Retry
                </Button>
              )
            )
          )
        ])}

        {section('Review', [
          ...q.ready.map((n) =>
            row(
              n,
              <FileText size={16} className="accent" />,
              <>
                {NOTE_TYPE_LABEL[n.type]} {unseen[n.id] && <span className="chip chip-draft">New</span>}{' '}
                {n.reviewItems.length > 0 && <span className="chip chip-warn">{n.reviewItems.length} to check</span>}
              </>,
              <span className="muted small">{relativeDay(n.session.date, today)}</span>
            )
          ),
          ...p.ready.map((c) =>
            planRow(
              c,
              <Target size={16} className="accent" />,
              <>
                Treatment plan {planDrafts[c.id].unseen && <span className="chip chip-draft">New</span>}{' '}
                {planDrafts[c.id].reviewItems.length > 0 && <span className="chip chip-warn">{planDrafts[c.id].reviewItems.length} to check</span>}
              </>
            )
          )
        ])}

        {section(
          'Copy to EHR',
          q.uncopied.map((n) => row(n, <CheckCircle2 size={16} className="warn" />, <>{NOTE_TYPE_LABEL[n.type]} <span className="muted">finalized, not yet copied</span></>, copy(n, byId.get(n.clientId)!)))
        )}

        {section(
          'Drafts',
          q.unwritten.map((n) =>
            row(
              n,
              <FilePen size={16} className="accent" />,
              <>
                {NOTE_TYPE_LABEL[n.type]} <span className="muted">{n.dictation.trim() ? 'dictated, not written yet' : 'not started'}</span>
              </>,
              <span className="muted small">{relativeDay(n.session.date, today)}</span>
            )
          )
        )}

        {section(
          'Plan reviews due',
          reviews.map((c) => (
            <button key={c.id} className="list-row" onClick={() => navigate({ view: 'client', id: c.id, tab: 'plan' })}>
              <CalendarClock size={16} className="warn" />
              <Avatar id={c.id} name={c.name} size={24} />
              <span className="grow">
                <b>{c.name}</b> · treatment plan review due
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
