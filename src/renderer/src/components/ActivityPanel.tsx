import { useMemo } from 'react'
import { CircleAlert, RotateCcw } from 'lucide-react'
import { NOTE_TYPE_LABEL } from '@shared/types'
import { buildPlanQueue, buildQueue } from '@shared/queue'
import { useStore } from '../store'

/**
 * What Echo is doing in the background, at the foot of the sidebar: notes and treatment plans being written,
 * ones that failed, and finished ones that haven't been opened yet. Hidden when there's nothing to show.
 */
export function ActivityPanel() {
  const { notes, clients, jobs, unseen, planJobs, planDrafts, navigate, retryJob, retryPlan } = useStore()
  const q = useMemo(() => buildQueue(notes, clients, jobs), [notes, clients, jobs])
  const p = useMemo(() => buildPlanQueue(clients, planJobs, planDrafts), [clients, planJobs, planDrafts])
  const fresh = q.ready.filter((n) => unseen[n.id])
  const freshPlans = p.ready.filter((c) => planDrafts[c.id].unseen)
  const byId = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients])
  if (!q.writing.length && !q.failed.length && !fresh.length && !p.writing.length && !p.failed.length && !freshPlans.length) return null

  const retry = (run: () => void) => (
    <button
      className="icon-btn"
      title="Try again"
      aria-label="Try again"
      onClick={(e) => {
        e.stopPropagation()
        run()
      }}
    >
      <RotateCcw size={13} />
    </button>
  )

  const item = (id: string, clientId: string, icon: React.ReactNode, status: string, cls = '', aside?: React.ReactNode, plan = false) => (
    <div
      key={plan ? `plan-${id}` : id}
      className={`activity-item ${cls}`}
      onClick={() => navigate(plan ? { view: 'client', id: clientId, tab: 'plan' } : { view: 'note', id })}
      role="button"
      tabIndex={0}
    >
      {icon}
      <span className="activity-text">
        <span className="activity-name">{byId.get(clientId)?.name}</span>
        <small>{status}</small>
      </span>
      {aside}
    </div>
  )

  return (
    <section className="activity" aria-label="Activity" aria-live="polite">
      <h3>Activity</h3>
      {q.writing.map((n) => {
        const job = jobs[n.id]
        const status = job.stage === 'transcribing' ? 'Transcribing…' : job.kind === 'amend' ? 'Applying follow-up…' : `Writing ${NOTE_TYPE_LABEL[n.type].toLowerCase()}…`
        return item(n.id, n.clientId, <span className="activity-orb" aria-hidden />, status, 'writing')
      })}
      {q.failed.map((n) =>
        item(
          n.id,
          n.clientId,
          <CircleAlert size={14} className="error" />,
          jobs[n.id].kind === 'amend' ? 'Follow-up failed' : 'Couldn’t write',
          'failed',
          (jobs[n.id].kind === 'write' || jobs[n.id].followUp) && retry(() => retryJob(n.id))
        )
      )}
      {p.writing.map((c) => {
        const job = planJobs[c.id]
        return item(c.id, c.id, <span className="activity-orb" aria-hidden />, job.stage === 'transcribing' ? 'Transcribing…' : job.updating ? 'Updating treatment plan…' : 'Drafting treatment plan…', 'writing', undefined, true)
      })}
      {p.failed.map((c) =>
        item(c.id, c.id, <CircleAlert size={14} className="error" />, 'Couldn’t draft plan', 'failed', planJobs[c.id].dictation !== undefined && retry(() => retryPlan(c.id)), true)
      )}
      {fresh.map((n) => item(n.id, n.clientId, <span className="activity-new" aria-hidden />, `${NOTE_TYPE_LABEL[n.type]} ready`, 'fresh'))}
      {freshPlans.map((c) => item(c.id, c.id, <span className="activity-new" aria-hidden />, 'Treatment plan ready', 'fresh', undefined, true))}
    </section>
  )
}
