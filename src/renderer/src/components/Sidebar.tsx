import { useMemo, useState } from 'react'
import { ChevronRight, Inbox, Plus, Search, Settings as Gear } from 'lucide-react'
import { todayISO } from '@shared/compliance'
import { buildQueue, queueCount } from '@shared/queue'
import { useStore } from '../store'
import { Avatar, Kbd } from './ui'
import { ActivityPanel } from './ActivityPanel'
import { UpdateBadge } from './UpdateBadge'

export function Sidebar({ onNewClient, onFind }: { onNewClient(): void; onFind(): void }) {
  const { clients, notes, inbox, jobs, route, navigate } = useStore()
  const [showDischarged, setShowDischarged] = useState(false)
  const today = todayISO()

  const drafts = useMemo(() => new Set(notes.filter((n) => n.status === 'draft').map((n) => n.clientId)), [notes])
  const seenToday = useMemo(() => new Set(notes.filter((n) => n.session.date === today).map((n) => n.clientId)), [notes, today])
  const writing = useMemo(() => new Set(notes.filter((n) => jobs[n.id] && !jobs[n.id].error).map((n) => n.clientId)), [notes, jobs])
  const waiting = useMemo(() => queueCount(buildQueue(notes, clients, jobs)), [notes, clients, jobs]) + inbox.length

  const sorted = useMemo(() => [...clients].sort((a, b) => a.name.localeCompare(b.name)), [clients])
  const active = sorted.filter((c) => c.status === 'active')
  const discharged = sorted.filter((c) => c.status === 'discharged')

  const activeId = route.view === 'client' ? route.id : route.view === 'note' ? notes.find((n) => n.id === route.id)?.clientId : undefined

  const item = (c: (typeof clients)[number]) => (
    <button key={c.id} className={`side-item ${activeId === c.id ? 'active' : ''}`} onClick={() => navigate({ view: 'client', id: c.id })}>
      <Avatar id={c.id} name={c.name} size={24} />
      <span className="side-name">{c.name}</span>
      {writing.has(c.id) ? <span className="dot dot-writing" title="Writing note" /> : drafts.has(c.id) ? <span className="dot dot-draft" title="Draft note" /> : seenToday.has(c.id) ? <span className="dot dot-done" title="Seen today" /> : null}
    </button>
  )

  return (
    <aside className="sidebar">
      <div className="drag sidebar-top" />
      <button className="side-search" onClick={onFind}>
        <Search size={14} />
        <span>Find client</span>
        <Kbd>⌘K</Kbd>
      </button>

      <nav className="side-nav">
        <button className={`side-item ${route.view === 'queue' ? 'active' : ''}`} onClick={() => navigate({ view: 'queue' })}>
          <span className="side-icon">
            <Inbox size={15} />
          </span>
          <span className="side-name">Queue</span>
          {waiting > 0 && <span className="side-count">{waiting}</span>}
        </button>
      </nav>

      <div className="side-section">
        <span>Clients</span>
        <button className="icon-btn" onClick={onNewClient} title="New client (⇧⌘N)" aria-label="New client">
          <Plus size={15} />
        </button>
      </div>
      <div className="side-list">
        {active.length === 0 && (
          <button className="side-empty" onClick={onNewClient}>
            Add your first client
          </button>
        )}
        {active.map(item)}
        {discharged.length > 0 && (
          <>
            <button className="side-section side-toggle" onClick={() => setShowDischarged((v) => !v)}>
              <ChevronRight size={13} className={showDischarged ? 'rot' : ''} />
              <span>Discharged ({discharged.length})</span>
            </button>
            {showDischarged && discharged.map(item)}
          </>
        )}
      </div>

      <ActivityPanel />
      <UpdateBadge />

      <button className={`side-item side-settings ${route.view === 'settings' ? 'active' : ''}`} onClick={() => navigate({ view: 'settings' })}>
        <span className="side-icon">
          <Gear size={15} />
        </span>
        <span className="side-name">Settings</span>
      </button>
    </aside>
  )
}
