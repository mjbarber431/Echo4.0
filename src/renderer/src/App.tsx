import { useEffect, useRef, useState } from 'react'
import type { Client } from '@shared/types'
import { nextNoteType } from '@shared/mobile'
import { useCommand, useStore } from './store'
import { TopBar, tabOf } from './components/TopBar'
import { ClientList } from './components/ClientList'
import { ActivityTray } from './components/ActivityPanel'
import { CommandPalette } from './components/CommandPalette'
import { ClientModal, type ClientStart } from './components/ClientModal'
import { BackupModal } from './components/BackupModal'
import { LegacyImportModal } from './components/LegacyImportModal'
import { LockScreen } from './components/LockScreen'
import { Toasts } from './components/ui'
import { ClientsView } from './views/ClientsView'
import { ChartingView } from './views/ChartingView'
import { PlanChartView } from './views/PlanChartView'
import { ClientView } from './views/ClientView'
import { NoteView } from './views/NoteView'
import { ChartView } from './views/ChartView'
import { SettingsView } from './views/SettingsView'
import { LibraryView } from './views/LibraryView'
import { DocumentView } from './views/DocumentView'
import { ResourceViewer } from './components/ResourceViewer'
import { Onboarding } from './views/Onboarding'

export function App() {
  const store = useStore()
  const { route, navigate, settings, notes, createNote, emit } = store
  const [palette, setPalette] = useState<'find' | 'note' | null>(null)
  const [newClient, setNewClient] = useState<{ name: string } | null>(null)
  const [backup, setBackup] = useState<'export' | 'import' | null>(null)
  const [legacyImport, setLegacyImport] = useState(false)
  const [locked, setLocked] = useState(settings.lockEnabled)
  const [activityOpen, setActivityOpen] = useState(false)

  /** Resume a client's open draft rather than creating a duplicate. */
  const startNote = (client: Client) => {
    const draft = notes.find((n) => n.clientId === client.id && n.status === 'draft')
    if (draft) return navigate({ view: 'note', id: draft.id })
    const note = createNote(client.id, nextNoteType(client, notes))
    navigate({ view: 'note', id: note.id })
  }

  const onClientCreated = (client: Client, start: ClientStart) => {
    if (start === 'intake') {
      const note = createNote(client.id, 'intake')
      navigate({ view: 'note', id: note.id })
    } else navigate({ view: 'client', id: client.id, tab: 'plan' })
  }

  const currentClientId =
    route.view === 'client' ? route.id : route.view === 'note' ? notes.find((n) => n.id === route.id)?.clientId : route.view === 'document' ? store.documents.find((d) => d.id === route.id)?.clientId : undefined

  // Menu commands from the main process. Note-level commands go to whichever view subscribed.
  const handleRef = useRef<(command: string) => void>(() => {})
  handleRef.current = (command: string) => {
    switch (command) {
      case 'settings':
        return navigate({ view: 'settings' })
      case 'clients':
        return navigate({ view: 'clients' })
      case 'charting':
        return navigate({ view: 'charting' })
      case 'new-client':
        return setNewClient({ name: '' })
      case 'find':
        return setPalette('find')
      case 'lock':
        return settings.lockEnabled && setLocked(true)
      case 'backup-export':
        return setBackup('export')
      case 'backup-import':
        return setBackup('import')
      case 'legacy-import':
        return setLegacyImport(true)
      // Neither runs behind the lock screen.
      case 'chart':
        return !locked && settings.onboarded && store.startCharting()
      case 'open-ehrs':
        return !locked && settings.onboarded && void store.openEhrs()
      // Only from the client page: leaving a note mid-dictation would drop the recording.
      case 'scratchpad':
        return route.view === 'client' && navigate({ view: 'client', id: route.id, tab: route.tab === 'scratchpad' ? 'notes' : 'scratchpad' })
      case 'library':
        return route.view === 'library' ? emit('find-in-library') : navigate({ view: 'library' })
      case 'ask':
        return route.view === 'client' && navigate({ view: 'client', id: route.id, tab: route.tab === 'ask' ? 'notes' : 'ask' })
      case 'new-note': {
        const client = store.clients.find((c) => c.id === currentClientId && c.status === 'active')
        if (client && route.view === 'client') return startNote(client)
        return setPalette('note')
      }
      default:
        emit(command)
    }
  }

  useEffect(() => window.echo.onMenu((command) => handleRef.current(command)), []) // eslint-disable-line react-hooks/exhaustive-deps
  // "Next note" while one is writing: pick the next client without waiting.
  useCommand('next-note', () => setPalette('note'))

  if (!settings.onboarded) return <Onboarding />
  if (locked) return <LockScreen onUnlock={() => setLocked(false)} />

  // Focused charting keeps to itself: Echo tiled beside the EHRs needs the room.
  const focused = route.view === 'chart' || route.view === 'chart-plan'

  return (
    <div className={focused ? 'app focused' : 'app'}>
      {!focused && <TopBar onFind={() => setPalette('find')} activityOpen={activityOpen} setActivityOpen={setActivityOpen} />}
      <main className="main">
        {tabOf(route) === 'clients' ? (
          // The Clients tab keeps its client list on every page.
          <div className="with-sidebar">
            <ClientList onNewClient={() => setNewClient({ name: '' })} onFind={() => setPalette('find')} />
            <div className="tab-main">
              {route.view === 'clients' && <ClientsView onNewClient={() => setNewClient({ name: '' })} />}
              {route.view === 'client' && <ClientView key={route.id} clientId={route.id} tab={route.tab} />}
              {route.view === 'note' && <NoteView noteId={route.id} />}
              {route.view === 'document' && <DocumentView key={route.id} docId={route.id} />}
            </div>
          </div>
        ) : (
          <>
            {route.view === 'charting' && <ChartingView />}
            {route.view === 'chart' && <ChartView noteId={route.id} />}
            {route.view === 'chart-plan' && <PlanChartView key={route.clientId} clientId={route.clientId} from={route.from} />}
            {route.view === 'settings' && <SettingsView />}
            {route.view === 'library' && <LibraryView />}
          </>
        )}
      </main>
      {/* Outside the Clients tab (whose client list shows Activity), it floats at the bottom right. */}
      {!focused && tabOf(route) !== 'clients' && <ActivityTray open={activityOpen} setOpen={setActivityOpen} />}
      {palette && (
        <CommandPalette mode={palette} onClose={() => setPalette(null)} onNewClient={(name) => setNewClient({ name })} onStartNote={startNote} />
      )}
      {newClient && <ClientModal initialName={newClient.name} onClose={() => setNewClient(null)} onCreated={onClientCreated} />}
      {backup && <BackupModal mode={backup} onClose={() => setBackup(null)} />}
      {legacyImport && <LegacyImportModal onClose={() => setLegacyImport(false)} />}
      <ResourceViewer />
      <Toasts />
    </div>
  )
}
