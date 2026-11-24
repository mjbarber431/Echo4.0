import { BookOpen, ClipboardList, Search, Settings as Gear, Users } from 'lucide-react'
import { buildQueue, chartNotes, plansToChart } from '@shared/queue'
import { useStore, type Route } from '../store'
import { useActivity } from './ActivityPanel'
import { UpdateBadge } from './UpdateBadge'

export type MainTab = 'clients' | 'charting' | 'library'

/** Which of the three main tabs a page belongs to (Settings belongs to none). */
export function tabOf(route: Route): MainTab | null {
  switch (route.view) {
    case 'charting':
    case 'chart':
    case 'chart-plan':
      return 'charting'
    case 'library':
      return 'library'
    case 'settings':
      return null
    default:
      return 'clients'
  }
}

const TABS: { id: MainTab; label: string; icon: typeof Users; key: string }[] = [
  { id: 'clients', label: 'Clients', icon: Users, key: '⌘1' },
  { id: 'charting', label: 'Charting', icon: ClipboardList, key: '⌘2' },
  { id: 'library', label: 'Library', icon: BookOpen, key: '⌘3' }
]

/** The title bar: the three main tabs, and finding a client, background activity, updates and Settings. */
export function TopBar({ onFind, activityOpen, setActivityOpen }: { onFind(): void; activityOpen: boolean; setActivityOpen(open: boolean): void }) {
  const { route, navigate, notes, clients, jobs } = useStore()
  const tab = tabOf(route)
  const toChart = chartNotes(buildQueue(notes, clients, jobs)).length + plansToChart(clients).length
  const activity = useActivity()
  // In the Clients tab Activity is always shown in the client list, so the button is only needed elsewhere.
  const listed = tab === 'clients'
  const go = (t: MainTab) => {
    if (t === 'clients') navigate({ view: 'clients' })
    // Charting's own page, which offers to resume a batch under way.
    else if (t === 'charting') navigate({ view: 'charting' })
    else navigate({ view: 'library' })
  }

  return (
    <header className="topbar drag">
      <div className="topbar-left" />
      <nav
        className="topbar-tabs no-drag"
        role="tablist"
        style={{ '--tab-index': Math.max(0, TABS.findIndex((t) => t.id === tab)) } as React.CSSProperties}
      >
        {tab && <span className="topbar-tabs-thumb" aria-hidden />}
        {TABS.map(({ id, label, icon: Icon, key }) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => go(id)} title={key}>
            <Icon size={14} strokeWidth={tab === id ? 2.2 : 1.8} />
            <span>{label}</span>
            {id === 'charting' && toChart > 0 && <span className="side-count">{toChart}</span>}
          </button>
        ))}
      </nav>
      <div className="topbar-right no-drag">
        <UpdateBadge />
        {activity.count > 0 && !listed && (
          <button
            className={`topbar-activity ${activity.failed ? 'failed' : ''}`}
            onClick={() => !activity.writing && setActivityOpen(!activityOpen)}
            aria-expanded={activityOpen || activity.writing}
            title={activity.writing ? 'Shown at the bottom right while notes are writing' : 'Show or hide activity'}
          >
            {activity.writing ? <span className="activity-orb" aria-hidden /> : <span className="activity-new" aria-hidden />}
            <span>{activity.writing ? 'Writing' : 'Activity'}</span>
            <span className="side-count">{activity.count}</span>
          </button>
        )}
        <button className="topbar-search" onClick={onFind} title="Find client (⌘K)">
          <Search size={14} />
          <span>Find</span>
          <kbd>⌘K</kbd>
        </button>
        <button className={`icon-btn ${route.view === 'settings' ? 'on' : ''}`} onClick={() => navigate({ view: 'settings' })} title="Settings (⌘,)" aria-label="Settings">
          <Gear size={16} />
        </button>
      </div>
    </header>
  )
}
