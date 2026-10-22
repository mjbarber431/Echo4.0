import { useEffect, useRef, useState } from 'react'
import type { Client } from '@shared/types'
import { nextNoteType } from '@shared/mobile'
import { useCommand, useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { CommandPalette } from './components/CommandPalette'
import { ClientModal, type ClientStart } from './components/ClientModal'
import { BackupModal } from './components/BackupModal'
import { LegacyImportModal } from './components/LegacyImportModal'
import { LockScreen } from './components/LockScreen'
import { Toasts } from './components/ui'
import { QueueView } from './views/QueueView'
import { ClientView } from './views/ClientView'
import { NoteView } from './views/NoteView'
import { SettingsView } from './views/SettingsView'
import { Onboarding } from './views/Onboarding'

export function App() {
  const store = useStore()
  const { route, navigate, settings, notes, createNote, emit, noteSidebar } = store
  const [palette, setPalette] = useState<'find' | 'note' | null>(null)
  const [newClient, setNewClient] = useState<{ name: string } | null>(null)
  const [backup, setBackup] = useState<'export' | 'import' | null>(null)
  const [legacyImport, setLegacyImport] = useState(false)
  const [locked, setLocked] = useState(settings.lockEnabled)

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

  const currentClientId = route.view === 'client' ? route.id : route.view === 'note' ? notes.find((n) => n.id === route.id)?.clientId : undefined

  // Menu commands from the main process. Note-level commands go to whichever view subscribed.
  const handleRef = useRef<(command: string) => void>(() => {})
  handleRef.current = (command: string) => {
    switch (command) {
      case 'settings':
        return navigate({ view: 'settings' })
      case 'queue':
        return navigate({ view: 'queue' })
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
      // Only from the client page: leaving a note mid-dictation would drop the recording.
      case 'scratchpad':
        return route.view === 'client' && navigate({ view: 'client', id: route.id, tab: route.tab === 'scratchpad' ? 'notes' : 'scratchpad' })
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

  const showSidebar = route.view !== 'note' || noteSidebar

  return (
    <div className={showSidebar ? 'app' : 'app no-sidebar'}>
      {showSidebar && <Sidebar onNewClient={() => setNewClient({ name: '' })} onFind={() => setPalette('find')} />}
      <main className="main">
        {route.view === 'queue' && <QueueView onNewClient={() => setNewClient({ name: '' })} />}
        {route.view === 'client' && <ClientView key={route.id} clientId={route.id} tab={route.tab} />}
        {route.view === 'note' && <NoteView noteId={route.id} />}
        {route.view === 'settings' && <SettingsView />}
      </main>
      {palette && (
        <CommandPalette mode={palette} onClose={() => setPalette(null)} onNewClient={(name) => setNewClient({ name })} onStartNote={startNote} />
      )}
      {newClient && <ClientModal initialName={newClient.name} onClose={() => setNewClient(null)} onCreated={onClientCreated} />}
      {backup && <BackupModal mode={backup} onClose={() => setBackup(null)} />}
      {legacyImport && <LegacyImportModal onClose={() => setLegacyImport(false)} />}
      <Toasts />
    </div>
  )
}
