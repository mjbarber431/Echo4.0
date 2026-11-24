import { useMemo, useState } from 'react'
import { ChevronRight, Plus, Search } from 'lucide-react'
import { todayISO } from '@shared/compliance'
import { useStore } from '../store'
import { Avatar, Kbd } from './ui'
import { ActivityPanel } from './ActivityPanel'

/** The Clients tab's left column: every client, on every page in the tab, a click from their profile, with Activity at its foot. */
export function ClientList({ onNewClient, onFind }: { onNewClient(): void; onFind(): void }) {
  const { clients, notes, jobs, planJobs, route, navigate, documents } = useStore()
  const [showDischarged, setShowDischarged] = useState(false)
  const today = todayISO()

  const drafts = useMemo(() => new Set(notes.filter((n) => n.status === 'draft').map((n) => n.clientId)), [notes])
  const seenToday = useMemo(() => new Set(notes.filter((n) => n.session.date === today).map((n) => n.clientId)), [notes, today])
  const writing = useMemo(
    () => new Set([...notes.filter((n) => jobs[n.id] && !jobs[n.id].error).map((n) => n.clientId), ...Object.keys(planJobs).filter((id) => !planJobs[id].error)]),
    [notes, jobs, planJobs]
  )

  const sorted = useMemo(() => [...clients].sort((a, b) => a.name.localeCompare(b.name)), [clients])
  const active = sorted.filter((c) => c.status === 'active')
  const discharged = sorted.filter((c) => c.status === 'discharged')

  const activeId =
    route.view === 'client'
      ? route.id
      : route.view === 'note'
        ? notes.find((n) => n.id === route.id)?.clientId
        : route.view === 'document'
          ? documents.find((d) => d.id === route.id)?.clientId
          : undefined

  const item = (c: (typeof clients)[number]) => (
    <button key={c.id} className={`side-item ${activeId === c.id ? 'active' : ''}`} onClick={() => navigate({ view: 'client', id: c.id })}>
      <Avatar id={c.id} name={c.name} size={24} />
      <span className="side-name">{c.name}</span>
      {writing.has(c.id) ? <span className="dot dot-writing" title="Writing" /> : drafts.has(c.id) ? <span className="dot dot-draft" title="Draft note" /> : seenToday.has(c.id) ? <span className="dot dot-done" title="Seen today" /> : null}
    </button>
  )

  return (
    <aside className="sidebar">
      <button className="side-search" onClick={onFind}>
        <Search size={14} />
        <span>Find client</span>
        <Kbd>⌘K</Kbd>
      </button>
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
      {/* Here, Activity stays at the foot of the list whenever there's anything to show, clear of the dictation bar. */}
      <ActivityPanel />
    </aside>
  )
}
