import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Download, Eye, Files, MonitorUp, MonitorX, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react'
import { doneLabel, exportedPages, isFilledIn, isMeasure, originLabel, scoreHistory, type ClientDocument } from '@shared/documents'
import type { Signer } from '@shared/letter'
import type { DocHistory } from '@shared/types'
import { api, errorMessage } from '../lib/util'
import { useStore } from '../store'
import { DragOut } from '../components/Documents'
import { DocTabs, useDocTab } from '../components/DocTabs'
import { Button } from '../components/ui'

// pdf.js is only loaded when a document is first opened.
const DocEditor = lazy(() => import('../components/DocEditor').then((m) => ({ default: m.DocEditor })))

export function DocumentView({ docId }: { docId: string }) {
  const { documents, clients, saveDocument, deleteDocument, navigate, presenting, toast } = useStore()
  const doc = documents.find((d) => d.id === docId)
  const client = clients.find((c) => c.id === doc?.clientId)
  const [signers, setSigners] = useState<Signer[]>([])
  const [menu, setMenu] = useState(false)
  const [steps, setSteps] = useState<DocHistory | null>(null)
  const tab = useDocTab(doc)
  const latest = useRef(doc)
  latest.current = doc

  useEffect(() => {
    api()
      .getLetterhead()
      .then((l) => setSigners(l.signers))
      .catch(() => {})
  }, [])

  // Undo history is shared with the presentation window and kept while Echo is open.
  useEffect(() => {
    let live = true
    void api()
      .documentHistory(docId)
      .then((h) => live && setSteps(h))
      .catch(() => {})
    const off = api().onDocument((event) => 'history' in event && event.history.id === docId && setSteps(event.history))
    return () => {
      live = false
      off()
    }
  }, [docId])

  const update = useCallback(
    (patch: Partial<ClientDocument>, undoable = false) => {
      const current = latest.current
      if (current) saveDocument({ ...current, ...patch }, undoable)
    },
    [saveDocument]
  )
  const fail = (err: unknown) => toast(errorMessage(err), 'error')
  const undo = useCallback(() => void api().undoDocument(docId).catch(fail), [docId]) // eslint-disable-line react-hooks/exhaustive-deps
  const redo = useCallback(() => void api().redoDocument(docId).catch(fail), [docId]) // eslint-disable-line react-hooks/exhaustive-deps
  const loadBytes = useCallback(() => api().documentBytes(docId), [docId])

  if (!doc || !client) {
    return (
      <div className="page">
        <header className="page-head drag" />
        <div className="page-body">
          <p className="muted doc-gone">This document was deleted.</p>
        </div>
      </div>
    )
  }

  const back = () => navigate({ view: 'client', id: client.id, tab: 'documents' })
  const onScreen = presenting.includes(doc.id)
  const history = isMeasure(doc) ? scoreHistory(documents, doc) : []

  return (
    <div className="page doc-view">
      <header className="page-head drag doc-head">
        <button className="icon-btn lg no-drag" onClick={back} aria-label={`Back to ${client.name}`} title={`Back to ${client.name}’s documents`}>
          <ArrowLeft size={17} />
        </button>
        <div className="doc-title no-drag">
          <TitleInput value={doc.title} onSave={(title) => update({ title })} />
          <div className="lib-meta">
            {client.name} · {originLabel(doc)}
            {doc.pageCount > 1 ? ` · ${doc.pageCount} pages` : ''}
          </div>
        </div>
        <div className="head-actions no-drag">
          {(isMeasure(doc) || doc.score) && (
            <label className="doc-score" title={history.length > 1 ? `Earlier: ${history.filter((h) => h.id !== doc.id).map((h) => `${h.score} (${h.date})`).join(', ')}` : 'The measure’s total, for tracking over time'}>
              Score
              <input value={doc.score} onChange={(e) => update({ score: e.target.value })} placeholder="—" />
            </label>
          )}
          {doc.status === 'todo' ? (
            <Button icon={<Check size={14} />} onClick={() => update({ status: 'done', completedAt: new Date().toISOString() })}>
              Mark complete
            </Button>
          ) : (
            <span className="chip chip-ok" title={doc.completedAt ? `Completed ${new Date(doc.completedAt).toLocaleString()}` : undefined}>
              <Check size={12} /> {doneLabel(doc)}
            </span>
          )}
          {doc.pageCount > 1 && <ExportPages doc={doc} onChange={(exportPages) => update({ exportPages })} />}
          <DragOut doc={doc} label="Drag to EHR" />
          <Button
            variant={onScreen ? 'secondary' : 'primary'}
            icon={onScreen ? <MonitorX size={14} /> : <MonitorUp size={14} />}
            onClick={() => (onScreen ? api().stopPresenting(doc.id) : api().presentDocument(doc.id, tab.index).catch(fail))}
            title={onScreen ? 'Close the presentation window' : 'Open this document alone in its own window, to share on screen'}
          >
            {onScreen ? 'Stop presenting' : 'Present'}
          </Button>
          <div className="menu-wrap">
            <button className="icon-btn lg" onClick={() => setMenu((v) => !v)} aria-label="More">
              <MoreHorizontal size={18} />
            </button>
            {menu && (
              <div className="menu" onMouseLeave={() => setMenu(false)}>
                <button
                  onClick={async () => {
                    setMenu(false)
                    try {
                      const path = await api().exportDocument(doc.id)
                      if (path) toast(`Saved ${path.split('/').pop()}`, 'success')
                    } catch (err) {
                      fail(err)
                    }
                  }}
                >
                  <Download size={14} /> Save as PDF…
                </button>
                <button onClick={() => (setMenu(false), void api().openDocument(doc.id).catch(fail))}>
                  <Eye size={14} /> Open in Preview
                </button>
                {doc.status === 'done' && (
                  <button onClick={() => (setMenu(false), update({ status: 'todo', completedAt: null }))}>
                    <RotateCcw size={14} /> Move to To complete
                  </button>
                )}
                <hr />
                <button
                  className="danger"
                  onClick={() => {
                    setMenu(false)
                    if (!window.confirm(`Delete ${doc.title}${isFilledIn(doc) ? ' and everything filled in on it' : ''}? This can’t be undone.`)) return
                    deleteDocument(doc.id)
                    back()
                  }}
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <DocTabs sections={tab.sections} index={tab.index} onPick={tab.setIndex} />
      <div className="page-body doc-body">
        <Suspense fallback={<div className="doc-loading">Opening…</div>}>
          <DocEditor
            key={doc.id}
            doc={doc}
            loadBytes={loadBytes}
            onChange={update}
            history={steps}
            onUndo={undo}
            onRedo={redo}
            signers={signers}
            clientName={client.name}
            readOnly={onScreen}
            pages={tab.pages}
            banner={
              onScreen && (
                <div className="doc-banner">
                  <MonitorUp size={15} />
                  <span>This document is open in its presentation window. Mark it up there; what you do shows here too.</span>
                  <Button size="sm" variant="ghost" onClick={() => api().presentDocument(doc.id).catch(fail)}>
                    Bring to front
                  </Button>
                </div>
              )
            }
          />
        </Suspense>
      </div>
    </div>
  )
}

function TitleInput({ value, onSave }: { value: string; onSave(v: string): void }) {
  const [text, setText] = useState(value)
  const [base, setBase] = useState(value)
  if (base !== value) {
    setBase(value)
    setText(value)
  }
  const commit = () => {
    const t = text.trim()
    if (t && t !== value) onSave(t)
    else setText(value)
  }
  return (
    <input
      className="doc-title-input"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setText(value)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      aria-label="Document title"
    />
  )
}

/**
 * Which pages go out when the document is saved, previewed or dragged into the EHR,
 * kept with the document. Every page to begin with; by tab, then page, for a Library resource.
 */
function ExportPages({ doc, onChange }: { doc: ClientDocument; onChange(pages: number[] | undefined): void }) {
  const [open, setOpen] = useState(false)
  const chosen = new Set(exportedPages(doc))
  const all = chosen.size === doc.pageCount
  const groups = doc.sections && doc.sections.length > 1 ? doc.sections : [{ label: '', start: 0, count: doc.pageCount }]
  // At least one page always goes out.
  const toggle = (pages: number[], on: boolean) => {
    const next = new Set(chosen)
    for (const p of pages) {
      if (on) next.add(p)
      else next.delete(p)
    }
    if (next.size) onChange(next.size === doc.pageCount ? undefined : [...next].sort((x, y) => x - y))
  }
  return (
    <div className="menu-wrap">
      <Button variant="ghost" icon={<Files size={14} />} onClick={() => setOpen((v) => !v)} title="Choose the pages that go out when you save, preview or drag this document">
        {all ? 'All pages' : `${chosen.size} of ${doc.pageCount} pages`}
      </Button>
      {open && (
        <div className="menu export-pages" onMouseLeave={() => setOpen(false)}>
          <p className="muted">Pages to save, preview and drag to the EHR</p>
          {groups.map((g) => {
            const pages = Array.from({ length: g.count }, (_, i) => g.start + i)
            const on = pages.filter((p) => chosen.has(p)).length
            return (
              <div key={g.start} className="export-group">
                {g.label && (
                  <label className="export-section">
                    <input type="checkbox" checked={on === pages.length} ref={(el) => {
                        if (el) el.indeterminate = on > 0 && on < pages.length
                      }} onChange={(e) => toggle(pages, e.target.checked)} />
                    <span>{g.label}</span>
                  </label>
                )}
                {(pages.length > 1 || !g.label) && (
                  <div className="export-page-list">
                    {pages.map((p) => (
                      <label key={p} title={`Page ${p + 1}`}>
                        <input type="checkbox" checked={chosen.has(p)} onChange={(e) => toggle([p], e.target.checked)} />
                        {p + 1}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {!all && (
            <button className="export-all" onClick={() => onChange(undefined)}>
              Use every page
            </button>
          )}
        </div>
      )}
    </div>
  )
}
