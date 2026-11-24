import { UserPlus } from 'lucide-react'
import { todayISO } from '@shared/compliance'
import { useStore } from '../store'
import { longDate } from '../lib/util'
import { Button } from '../components/ui'
import { QueueSections, useQueueTotal } from './Queue'

/** Clients, the home tab: the queue across every client. The client list is on the left. */
export function ClientsView({ onNewClient }: { onNewClient(): void }) {
  const { clients } = useStore()
  const total = useQueueTotal()

  return (
    <div className="page today">
      <header className="page-head drag" />
      <div className="today-body">
        <div className="today-hero">
          <p className="eyebrow">{longDate(todayISO())}</p>
          <h1 className="display">{total ? `${total} to do.` : 'All caught up.'}</h1>
        </div>
        {clients.length === 0 ? (
          <div className="start-empty">
            <p className="muted">Add a client to begin. All Echo needs is a name.</p>
            <Button variant="primary" icon={<UserPlus size={15} />} onClick={onNewClient}>
              Add your first client
            </Button>
          </div>
        ) : (
          <QueueSections />
        )}
      </div>
    </div>
  )
}
