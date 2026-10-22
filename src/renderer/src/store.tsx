import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AppState, Client, MobileMemo, Note, NoteType, PublicSettings, Settings } from '@shared/types'
import { NOTE_TYPE_LABEL } from '@shared/types'
import { DEFAULT_CLIENT_SETTING, defaultAttestations, defaultSession } from '@shared/compliance'
import { applyAiResult, applyAmendResult, applyContextRebuild, needsContextRebuild } from '@shared/finalize'
import { isModelFailure, type NoteJob } from '@shared/queue'
import { memoToNote, type ClientMatch } from '@shared/mobile'
import { api, errorMessage, nowISO, uid } from './lib/util'

export type ClientTab = 'notes' | 'plan' | 'context' | 'scratchpad'

export type Route =
  | { view: 'queue' }
  | { view: 'client'; id: string; tab?: ClientTab }
  | { view: 'note'; id: string }
  | { view: 'settings' }

interface Toast {
  id: number
  message: string
  tone: 'default' | 'error' | 'success'
  action?: { label: string; run(): void }
}

/** The draft before the last follow-up was applied, for Undo, and which sections it changed. */
export interface Amended {
  before: Note
  changed: number[]
}

/** How often a note has been rewritten on one model, and the model it was switched to, if any. */
export interface Rewrites {
  model: string
  count: number
  /** A stronger model chosen for this note only. */
  override?: string
}

interface Store {
  settings: PublicSettings
  clients: Client[]
  notes: Note[]
  route: Route
  navigate(route: Route): void
  saveSettings(patch: Partial<Settings>): Promise<void>
  setApiKey(key: string): Promise<void>
  replaceState(state: AppState): void
  /** Adds records imported in the main process without disturbing notes being written. */
  addImported(clients: Client[], notes: Note[]): void
  saveClient(client: Client): void
  createClient(fields: Pick<Client, 'name' | 'pronouns' | 'diagnoses'> & Partial<Pick<Client, 'setting'>>): Client
  deleteClient(id: string): void
  saveNote(note: Note): Promise<void>
  createNote(clientId: string, type: NoteType): Note
  deleteNote(id: string): void
  /** Recordings from the iPhone waiting for their client to be confirmed. */
  inbox: MobileMemo[]
  /** Give a recording to its client as a draft, and start writing it unless `write` is false. Returns the note. */
  takeMemo(memoId: string, clientId: string, heard: ClientMatch['heard'], write: boolean): Note | null
  discardMemo(memoId: string): void
  /** Notes being written (or that failed to), by note ID. Writing runs here so leaving the note doesn't stop it. */
  jobs: Record<string, NoteJob>
  /**
   * Write the note from its dictation. Pass the transcript's finish() if the last of it is still being transcribed,
   * and `model` to write this note (and its follow-ups) with a different model from Settings.
   */
  writeNote(noteId: string, transcribing?: Promise<void>, model?: string): void
  /** Rewrites per note this session, so Echo can suggest a stronger model when one keeps being redone. */
  rewrites: Record<string, Rewrites>
  /** Drop a note's model override so it follows Settings again. */
  clearOverride(noteId: string): void
  /** Work a follow-up into the draft. `answer` is a promise while its transcript is still finishing. */
  amendNote(noteId: string, flagged: string[], answer: string | Promise<string>): void
  retryJob(noteId: string): void
  dismissJob(noteId: string): void
  amends: Record<string, Amended>
  setAmended(noteId: string, amended: Amended | null): void
  /** Notes that finished in the background and haven't been opened since. */
  unseen: Record<string, true>
  markSeen(noteId: string): void
  toast(message: string, tone?: Toast['tone'], action?: Toast['action']): void
  dismissToast(id: number): void
  toasts: Toast[]
  /** The client list is hidden while writing a note unless the clinician brings it back. */
  noteSidebar: boolean
  setNoteSidebar(open: boolean): void
  on(command: string, handler: () => void): () => void
  emit(command: string): boolean
}

const Ctx = createContext<Store | null>(null)

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('Store missing')
  return s
}

/** Subscribe to a menu/keyboard command while the component is mounted. */
export function useCommand(command: string, handler: () => void): void {
  const { on } = useStore()
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => on(command, () => ref.current()), [on, command])
}

const upsert = <T extends { id: string }>(list: T[], item: T): T[] => (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item])

export function StoreProvider({ initial, children }: { initial: AppState; children: ReactNode }) {
  const [settings, setSettings] = useState(initial.settings)
  const [clients, setClientsState] = useState(initial.clients)
  const [notes, setNotesState] = useState(initial.notes)
  const [inbox, setInbox] = useState(initial.inbox)
  const [route, setRouteState] = useState<Route>({ view: 'queue' })
  const [jobs, setJobsState] = useState<Record<string, NoteJob>>({})
  const [amends, setAmends] = useState<Record<string, Amended>>({})
  const [unseen, setUnseen] = useState<Record<string, true>>({})
  const [toasts, setToasts] = useState<Toast[]>([])
  const [noteSidebar, setNoteSidebar] = useState(false)
  const [rewrites, setRewrites] = useState<Record<string, Rewrites>>({})
  const handlers = useRef(new Map<string, Set<() => void>>())
  /** Context rebuilds in flight, by client ID, so two notes for one client share one. */
  const rebuilds = useRef(new Map<string, Promise<void>>())

  // Background jobs outlive the render that started them, so they read the latest
  // records through these refs, which change in step with state.
  const notesRef = useRef(notes)
  const clientsRef = useRef(clients)
  const routeRef = useRef(route)
  const jobsRef = useRef(jobs)
  /** Bumped when a backup restore replaces everything, so jobs started before it are dropped. */
  const epoch = useRef(0)
  const setNotes = useCallback((fn: (ns: Note[]) => Note[]) => {
    notesRef.current = fn(notesRef.current)
    setNotesState(notesRef.current)
  }, [])
  const setClients = useCallback((fn: (cs: Client[]) => Client[]) => {
    clientsRef.current = fn(clientsRef.current)
    setClientsState(clientsRef.current)
  }, [])
  const setRoute = useCallback((r: Route) => {
    routeRef.current = r
    setRouteState(r)
  }, [])
  const setJob = useCallback((noteId: string, job: NoteJob | null) => {
    const next = { ...jobsRef.current }
    if (job) next[noteId] = job
    else delete next[noteId]
    jobsRef.current = next
    setJobsState(next)
  }, [])

  // Quitting mid-job loses audio that hasn't been transcribed yet, so the main process asks first.
  useEffect(() => {
    if (!Object.values(jobs).some((j) => !j.error)) return
    const hold = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', hold)
    return () => window.removeEventListener('beforeunload', hold)
  }, [jobs])

  const markSeen = useCallback(
    (noteId: string) =>
      setUnseen((u) => {
        if (!u[noteId]) return u
        const { [noteId]: _, ...rest } = u
        return rest
      }),
    []
  )

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const toast = useCallback(
    (message: string, tone: Toast['tone'] = 'default', action?: Toast['action']) => {
      const id = Date.now() + Math.random()
      setToasts((t) => [...t, { id, message, tone, action }])
      setTimeout(() => dismissToast(id), action ? 8000 : tone === 'error' ? 6000 : 2600)
    },
    [dismissToast]
  )

  // Recordings arrive from the phone while Echo is open.
  const inboxRef = useRef(inbox)
  inboxRef.current = inbox
  useEffect(
    () =>
      api().onInbox((next) => {
        const added = next.filter((m) => !inboxRef.current.some((x) => x.id === m.id)).length
        setInbox(next)
        if (added) toast(added === 1 ? 'A recording arrived from your iPhone' : `${added} recordings arrived from your iPhone`, 'success', { label: 'Show', run: () => setRoute({ view: 'queue' }) })
      }),
    [toast, setRoute]
  )

  const on = useCallback((command: string, handler: () => void) => {
    const set = handlers.current.get(command) ?? new Set()
    set.add(handler)
    handlers.current.set(command, set)
    return () => {
      set.delete(handler)
    }
  }, [])

  const emit = useCallback((command: string) => {
    const set = handlers.current.get(command)
    if (!set || set.size === 0) return false
    set.forEach((h) => h())
    return true
  }, [])

  const store = useMemo<Store>(() => {
    const saveNote = async (note: Note) => {
      const next = { ...note, updatedAt: nowISO() }
      setNotes((ns) => upsert(ns, next))
      await api().upsertNote(next)
    }

    /**
     * Rebuild a client's context once from every finalized note if it was imported or written under
     * older rules. Failures are dropped: the note still gets written, and the rebuild is tried again next time.
     */
    const ensureContext = (clientId: string): Promise<void> => {
      const client = clientsRef.current.find((c) => c.id === clientId)
      if (!client || !needsContextRebuild(client, notesRef.current)) return Promise.resolve()
      const inFlight = rebuilds.current.get(clientId)
      if (inFlight) return inFlight
      const started = epoch.current
      const run = api()
        .rebuildContext(clientId)
        .then(async (result) => {
          const latest = clientsRef.current.find((c) => c.id === clientId)
          // A restore, a finalized note or a hand edit in the meantime wins over the rebuild.
          if (epoch.current !== started || !latest || latest.context !== client.context || !needsContextRebuild(latest, notesRef.current)) return
          const next = applyContextRebuild(latest, result, nowISO())
          setClients((cs) => upsert(cs, next))
          await api().upsertClient(next)
        })
        .catch(() => {})
        .finally(() => rebuilds.current.delete(clientId))
      rebuilds.current.set(clientId, run)
      return run
    }

    /**
     * Run one background job for a note. `work` does the slow part and returns how to apply
     * the result to the note as it is by then. Results for a note that was deleted, finalized
     * or replaced by a restore in the meantime are dropped rather than resurrecting it.
     */
    const runJob = async (noteId: string, job: NoteJob, work: (progress: (patch: Partial<NoteJob>) => void) => Promise<(note: Note, client: Client) => Note>) => {
      if (jobsRef.current[noteId] && !jobsRef.current[noteId].error) return
      setJob(noteId, job)
      const started = epoch.current
      // False once a restore replaced everything, or the job was dismissed or superseded.
      const mine = () => epoch.current === started && jobsRef.current[noteId]?.startedAt === job.startedAt
      const progress = (patch: Partial<NoteJob>) => {
        if (!mine()) throw new Error('Superseded')
        setJob(noteId, { ...jobsRef.current[noteId], ...patch })
      }
      const current = () => {
        const note = notesRef.current.find((n) => n.id === noteId)
        const client = clientsRef.current.find((c) => c.id === note?.clientId)
        return note && client && note.status === 'draft' ? { note, client } : null
      }
      const viewing = () => routeRef.current.view === 'note' && routeRef.current.id === noteId
      const open = { label: 'Open', run: () => setRoute({ view: 'note', id: noteId }) }
      try {
        const apply = await work(progress)
        if (!mine()) return
        const now = current()
        if (!now) return setJob(noteId, null)
        await saveNote(apply(now.note, now.client))
        setJob(noteId, null)
        if (!viewing()) {
          setUnseen((u) => ({ ...u, [noteId]: true }))
          const what = job.kind === 'amend' ? 'follow-up was applied' : `${NOTE_TYPE_LABEL[now.note.type].toLowerCase()} is ready to review`
          toast(`${now.client.name}’s ${what}`, 'success', open)
        }
      } catch (err) {
        if (!mine()) return
        const now = current()
        if (!now) return setJob(noteId, null)
        setJob(noteId, { ...jobsRef.current[noteId], error: errorMessage(err) })
        toast(viewing() ? errorMessage(err) : `Couldn’t write ${now.client.name}’s note: ${errorMessage(err)}`, 'error', viewing() ? undefined : open)
      }
    }

    /**
     * A Regenerate press, or Try again after the model itself failed, counts as a rewrite. Retrying after a network
     * or key error doesn't, and neither does switching models, which starts the count again.
     */
    const countRewrite = (noteId: string, model?: string): string | undefined => {
      const prev = jobsRef.current[noteId]
      const note = notesRef.current.find((n) => n.id === noteId)
      const r = rewrites[noteId]
      const override = model ?? r?.override
      const used = override ?? settings.textModel
      const counts = !model && (prev?.error ? isModelFailure(prev.error) : !!note?.sections.length)
      const count = (r?.model === used ? r.count : 0) + (counts ? 1 : 0)
      setRewrites((rs) => ({ ...rs, [noteId]: { model: used, count, override } }))
      return override
    }

    const writeNote = (noteId: string, transcribing?: Promise<void>, model?: string) => {
      if (jobsRef.current[noteId] && !jobsRef.current[noteId].error) return
      const override = countRewrite(noteId, model)
      void runJob(noteId, { kind: 'write', stage: transcribing ? 'transcribing' : 'writing', startedAt: Date.now() }, async (progress) => {
        await transcribing
        const note = notesRef.current.find((n) => n.id === noteId)
        if (!note?.dictation.trim()) throw new Error('Nothing was picked up. Try recording again, or type your summary.')
        progress({ stage: 'writing' })
        // The main process reads the note and client from the vault, so both must be current first.
        await Promise.all([saveNote(note), ensureContext(note.clientId)])
        const result = await api().generateNote(noteId, override)
        return (current, client) => {
          setAmends(({ [noteId]: _, ...rest }) => rest)
          return applyAiResult(current, result, client, nowISO())
        }
      })
    }

    const amendNote = (noteId: string, flagged: string[], answer: string | Promise<string>) =>
      void runJob(noteId, { kind: 'amend', stage: typeof answer === 'string' ? 'writing' : 'transcribing', startedAt: Date.now(), flagged }, async (progress) => {
        const followUp = (await answer).trim()
        if (!followUp) throw new Error('Nothing was picked up. Try recording again, or type your answer.')
        progress({ stage: 'writing', followUp })
        const before = notesRef.current.find((n) => n.id === noteId)
        if (!before) throw new Error('Note not found.')
        await saveNote(before)
        const result = await api().amendNote(noteId, followUp, flagged, rewrites[noteId]?.override)
        return (current, client) => {
          const next = applyAmendResult(current, result, client, followUp, nowISO())
          const changed = next.sections.flatMap((x, i) => (x.body !== before.sections[i]?.body || x.heading !== before.sections[i]?.heading ? [i] : []))
          setAmends((a) => ({ ...a, [noteId]: { before, changed } }))
          return next
        }
      })

    const takeMemo = (memoId: string, clientId: string, heard: ClientMatch['heard'], write: boolean): Note | null => {
      const memo = inboxRef.current.find((m) => m.id === memoId)
      const client = clientsRef.current.find((c) => c.id === clientId)
      if (!memo || !client) return null
      const note = memoToNote(memo, client, notesRef.current, settings, heard, nowISO())
      setNotes((ns) => upsert(ns, note))
      setInbox((items) => items.filter((m) => m.id !== memoId))
      // The note is saved before the recording leaves the inbox, so a crash in between can't lose it.
      void api()
        .upsertNote(note)
        .then(() => api().removeMemo(memoId))
      if (write) writeNote(note.id)
      return note
    }

    return {
      settings,
      clients,
      notes,
      inbox,
      takeMemo,
      discardMemo(memoId) {
        setInbox((items) => items.filter((m) => m.id !== memoId))
        void api().removeMemo(memoId)
      },
      route,
      jobs,
      amends,
      rewrites,
      unseen,
      markSeen,
      toasts,
      noteSidebar,
      setNoteSidebar,
      on,
      emit,
      toast,
      dismissToast,
      navigate: setRoute,
      writeNote,
      amendNote,
      clearOverride(noteId) {
        setRewrites(({ [noteId]: r, ...rest }) => (r ? { ...rest, [noteId]: { ...r, override: undefined } } : rest))
      },
      retryJob(noteId) {
        const job = jobsRef.current[noteId]
        if (!job?.error) return
        if (job.kind === 'write') writeNote(noteId)
        else if (job.followUp) amendNote(noteId, job.flagged ?? [], job.followUp)
      },
      dismissJob(noteId) {
        if (jobsRef.current[noteId]?.error) setJob(noteId, null)
      },
      setAmended(noteId, amended) {
        setAmends(({ [noteId]: _, ...rest }) => (amended ? { ...rest, [noteId]: amended } : rest))
      },
      async saveSettings(patch) {
        setSettings(await api().saveSettings(patch))
      },
      async setApiKey(key) {
        setSettings(await api().setApiKey(key))
      },
      addImported(imported, importedNotes) {
        setClients((cs) => imported.reduce(upsert, cs))
        setNotes((ns) => importedNotes.reduce(upsert, ns))
        for (const id of new Set([...imported.map((c) => c.id), ...importedNotes.map((n) => n.clientId)])) void ensureContext(id)
      },
      replaceState(state) {
        epoch.current++
        jobsRef.current = {}
        setJobsState({})
        setAmends({})
        setRewrites({})
        setUnseen({})
        setSettings(state.settings)
        setClients(() => state.clients)
        setNotes(() => state.notes)
        setInbox(state.inbox)
        setRoute({ view: 'queue' })
      },
      saveClient(client) {
        const next = { ...client, updatedAt: nowISO() }
        setClients((cs) => upsert(cs, next))
        void api().upsertClient(next)
        // Drafts follow the client's setting; finalized notes keep what was billed.
        const drafts = notesRef.current.filter((n) => n.clientId === next.id && n.status === 'draft' && n.session.setting !== next.setting)
        if (drafts.length) {
          const updated = drafts.map((n) => ({ ...n, session: { ...n.session, setting: next.setting }, updatedAt: nowISO() }))
          setNotes((ns) => ns.map((n) => updated.find((u) => u.id === n.id) ?? n))
          updated.forEach((n) => void api().upsertNote(n))
        }
      },
      createClient(fields) {
        const now = nowISO()
        const client: Client = {
          id: uid(),
          name: fields.name.trim(),
          pronouns: fields.pronouns.trim(),
          setting: fields.setting ?? DEFAULT_CLIENT_SETTING,
          diagnoses: fields.diagnoses,
          status: 'active',
          context: '',
          scratchpad: '',
          plan: null,
          planHistory: [],
          createdAt: now,
          updatedAt: now
        }
        setClients((cs) => [...cs, client])
        void api().upsertClient(client)
        return client
      },
      deleteClient(id) {
        setClients((cs) => cs.filter((c) => c.id !== id))
        setNotes((ns) => ns.filter((n) => n.clientId !== id))
        void api().deleteClient(id)
      },
      saveNote,
      createNote(clientId, type) {
        const now = nowISO()
        const client = clientsRef.current.find((c) => c.id === clientId)
        const session = defaultSession(type, settings, client?.setting ?? DEFAULT_CLIENT_SETTING)
        const note: Note = {
          id: uid(),
          clientId,
          type,
          format: settings.noteFormat,
          status: 'draft',
          session,
          attest: defaultAttestations(),
          dictation: '',
          sections: [],
          reviewItems: [],
          suggestions: null,
          generatedAt: null,
          finalizedAt: null,
          copiedAt: null,
          source: 'desktop',
          createdAt: now,
          updatedAt: now
        }
        setNotes((ns) => [...ns, note])
        void api().upsertNote(note)
        return note
      },
      deleteNote(id) {
        if (jobsRef.current[id]?.error) setJob(id, null)
        setNotes((ns) => ns.filter((n) => n.id !== id))
        void api().deleteNote(id)
      }
    }
  }, [settings, clients, notes, inbox, route, jobs, amends, rewrites, unseen, toasts, noteSidebar, on, emit, toast, dismissToast, markSeen, setNotes, setClients, setRoute, setJob])

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}
