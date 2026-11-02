import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { PanelTopClose, PanelTopOpen } from 'lucide-react'
import type { ClientDocument } from '@shared/documents'
import type { Signer } from '@shared/letter'
import type { DocHistory, PresentApi } from '@shared/types'
import { errorMessage } from './lib/util'
import { DocTabs, useDocTab } from './components/DocTabs'

declare global {
  interface Window {
    echoPresent?: PresentApi
  }
}

const DocEditor = lazy(() => import('./components/DocEditor').then((m) => ({ default: m.DocEditor })))

/**
 * The presentation window: one document, nothing else from Echo. It has no access to the client
 * list, notes or settings (see preload/present.ts), so sharing this window on screen can't show them.
 */
export function PresentApp() {
  const present = window.echoPresent!
  const [doc, setDoc] = useState<ClientDocument | null>(null)
  const bytes = useRef<Uint8Array | null>(null)
  const [signers, setSigners] = useState<Signer[]>([])
  const [error, setError] = useState('')
  const [tools, setTools] = useState(true)
  const [history, setHistory] = useState<DocHistory | null>(null)
  const [clientName, setClientName] = useState('')
  const [startTab, setStartTab] = useState<number | undefined>()
  const latest = useRef(doc)
  latest.current = doc

  useEffect(() => {
    present
      .load()
      .then((loaded) => {
        bytes.current = loaded.bytes
        setStartTab(loaded.tab)
        setClientName(loaded.clientName)
        setDoc(loaded.doc)
        document.title = loaded.doc.title
      })
      .catch((err) => setError(errorMessage(err)))
    present
      .signers()
      .then(setSigners)
      .catch(() => {})
    present
      .history()
      .then(setHistory)
      .catch(() => {})
    return present.onDocument((event) => {
      if ('doc' in event) setDoc(event.doc)
      else if ('history' in event) setHistory(event.history)
      else if ('deleted' in event) present.close()
    })
  }, [present])

  const tab = useDocTab(doc, startTab)
  const loadBytes = useCallback(async () => bytes.current ?? (await present.load()).bytes, [present])
  const save = useCallback(
    (patch: Pick<ClientDocument, 'marks' | 'fields' | 'layout'>, undoable: boolean) => {
      const current = latest.current
      if (!current) return
      const next = { ...current, ...patch }
      setDoc(next)
      void present.save(next, undoable).catch((err) => setError(errorMessage(err)))
    },
    [present]
  )

  return (
    <div className="present-root">
      <header className="present-head drag">
        <h1>{doc?.title ?? ''}</h1>
        <div className="present-actions no-drag">
          <button className="btn btn-ghost btn-sm" onClick={() => setTools((v) => !v)} title={tools ? 'Hide the tools for a clean view' : 'Show the markup tools'}>
            {tools ? <PanelTopClose size={14} /> : <PanelTopOpen size={14} />}
            <span>{tools ? 'Hide tools' : 'Show tools'}</span>
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => present.close()}>
            <span>Done</span>
          </button>
        </div>
      </header>
      {error && <div className="doc-error">{error}</div>}
      <DocTabs sections={tab.sections} index={tab.index} onPick={tab.setIndex} />
      {doc && (
        <Suspense fallback={<div className="doc-loading">Opening…</div>}>
          <DocEditor
            doc={doc}
            loadBytes={loadBytes}
            onChange={save}
            history={history}
            onUndo={() => void present.undo().catch((err) => setError(errorMessage(err)))}
            onRedo={() => void present.redo().catch((err) => setError(errorMessage(err)))}
            signers={signers}
            clientName={clientName || undefined}
            pages={tab.pages}
            presentation
            hideTools={!tools}
          />
        </Suspense>
      )}
    </div>
  )
}
