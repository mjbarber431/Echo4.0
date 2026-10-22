import { useMemo } from 'react'
import { CircleAlert, RotateCcw } from 'lucide-react'
import { NOTE_TYPE_LABEL } from '@shared/types'
import { buildQueue } from '@shared/queue'
import { useStore } from '../store'

/**
 * What Echo is doing in the background, at the foot of the sidebar: notes being written, notes that
 * failed, and finished notes that haven't been opened yet. Hidden when there's nothing to show.
 */
export function ActivityPanel() {
  const { notes, clients, jobs, unseen, navigate, retryJob } = useStore()
  const q = useMemo(() => buildQueue(notes, clients, jobs), [notes, clients, jobs])
  const fresh = q.ready.filter((n) => unseen[n.id])
  const byId = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients])
  if (!q.writing.length && !q.failed.length && !fresh.length) return null

  const item = (id: string, clientId: string, icon: React.ReactNode, status: string, cls = '', aside?: React.ReactNode) => (
    <div key={id} className={`activity-item ${cls}`} onClick={() => navigate({ view: 'note', id })} role="button" tabIndex={0}>
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
          (jobs[n.id].kind === 'write' || jobs[n.id].followUp) && (
            <button
              className="icon-btn"
              title="Try again"
              aria-label="Try again"
              onClick={(e) => {
                e.stopPropagation()
                retryJob(n.id)
              }}
            >
              <RotateCcw size={13} />
            </button>
          )
        )
      )}
      {fresh.map((n) => item(n.id, n.clientId, <span className="activity-new" aria-hidden />, `${NOTE_TYPE_LABEL[n.type]} ready`, 'fresh'))}
    </section>
  )
}
