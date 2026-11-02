import { useMemo, useRef, useState, type DragEvent } from 'react'
import { BookOpen, Check, ClipboardList, Download, Eye, FileCheck2, FilePlus2, FileText, FileUp, GripVertical, Mail, MonitorUp, MoreHorizontal, RotateCcw, Search, Trash2, UserPlus } from 'lucide-react'
import type { Client } from '@shared/types'
import { todayISO } from '@shared/compliance'
import { canAssign, doneLabel, isFilledIn, isMeasure, originLabel, scoreHistory, type ClientDocument } from '@shared/documents'
import { findResources, KIND_LABEL, RESOURCES, resourceById, TOPICS, topicsForDiagnoses, type ResourceKind } from '@shared/resources'
import { api, errorMessage, localDay, relativeDay } from '../lib/util'
import { useStore } from '../store'
import { KIND_ICON } from '../views/LibraryView'
import { Button, Empty, Modal } from './ui'

const ASSIGNABLE = RESOURCES.filter(canAssign)

/** The kinds of thing the Assign picker filters by, as plurals, with how many of each can be assigned. */
const KIND_PLURAL: Record<ResourceKind, string> = {
  assessment: 'Measures',
  handout: 'Handouts',
  worksheet: 'Worksheets',
  workbook: 'Workbooks',
  clinician: 'Clinician guides',
  article: 'Articles',
  visual: 'Visuals',
  audio: 'Audio',
  exercise: 'Exercises',
  metaphor: 'Metaphors',
  protocol: 'Protocols',
  video: 'Videos'
}
const ASSIGN_KINDS = (['assessment', 'worksheet', 'handout', 'exercise', 'metaphor', 'workbook', 'clinician', 'protocol', 'article', 'visual', 'audio', 'video'] as ResourceKind[])
  .map((k) => ({ kind: k, count: ASSIGNABLE.filter((r) => r.kind === k).length }))
  .filter((k) => k.count > 0)

export function docIcon(doc: ClientDocument) {
  if (doc.origin.kind === 'library') {
    const r = resourceById(doc.origin.resourceId)
    return r ? KIND_ICON[r.kind] : BookOpen
  }
  return doc.origin.kind === 'letter' ? Mail : doc.origin.kind === 'plan' ? ClipboardList : FileUp
}

/** The client's documents: what's been given to them to complete, and everything kept for them. */
export function DocumentsTab({ client }: { client: Client }) {
  const { documents, addDocuments, toast } = useStore()
  const [assigning, setAssigning] = useState(false)
  const [dropping, setDropping] = useState(false)
  const docs = useMemo(() => documents.filter((d) => d.clientId === client.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [documents, client.id])
  const todo = docs.filter((d) => d.status === 'todo')
  const done = docs.filter((d) => d.status === 'done')

  const addFiles = async (run: () => Promise<ClientDocument[]>) => {
    try {
      const added = await run()
      if (!added.length) return
      addDocuments(added)
      toast(added.length === 1 ? `Added ${added[0].title}` : `Added ${added.length} documents`, 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  // Files dragged in from Finder (a scanned consent, a PDF from email).
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDropping(false)
    const paths = [...e.dataTransfer.files].map((f) => api().pathForFile(f)).filter(Boolean)
    if (paths.length) void addFiles(() => api().addDocumentFiles(client.id, paths))
  }
  const fromOutside = (e: DragEvent) => e.dataTransfer.types.includes('Files')

  return (
    <div
      className={`docs-tab ${dropping ? 'dropping' : ''}`}
      onDragOver={(e) => {
        if (!fromOutside(e)) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
      onDrop={onDrop}
    >
      <div className="docs-head">
        <p className="muted">
          Worksheets and measures from the Library, filled in right here, plus anything else you keep for {client.name.split(' ')[0]}. Drag a document into your EHR to upload it.
        </p>
        <div className="row gap">
          <Button icon={<FilePlus2 size={14} />} onClick={() => void addFiles(() => api().chooseDocumentFiles(client.id))}>
            Add file…
          </Button>
          <Button variant="primary" icon={<BookOpen size={14} />} onClick={() => setAssigning(true)}>
            Assign from Library
          </Button>
        </div>
      </div>

      {docs.length === 0 ? (
        <Empty icon={<FileText size={26} />} title="No documents yet">
          <p>Assign a measure or worksheet from the Library to fill it in together, or drop in a PDF or scan to keep it with the client.</p>
        </Empty>
      ) : (
        <>
          {todo.length > 0 && <DocGroup title="To complete" docs={todo} all={docs} />}
          {done.length > 0 && <DocGroup title={todo.length ? 'Completed and kept' : 'Documents'} docs={done} all={docs} />}
        </>
      )}
      {dropping && <div className="docs-drop">Drop PDFs or images to add them</div>}
      {assigning && <AssignModal client={client} onClose={() => setAssigning(false)} />}
    </div>
  )
}

function DocGroup({ title, docs, all }: { title: string; docs: ClientDocument[]; all: ClientDocument[] }) {
  return (
    <section className="note-group">
      <h4 className="note-group-head">
        {title}
        <span>{docs.length}</span>
      </h4>
      <div className="note-group-rows">
        {docs.map((d) => (
          <DocRow key={d.id} doc={d} all={all} />
        ))}
      </div>
    </section>
  )
}

function DocRow({ doc, all }: { doc: ClientDocument; all: ClientDocument[] }) {
  const { navigate, saveDocument, deleteDocument, presenting, toast } = useStore()
  const [menu, setMenu] = useState(false)
  const Icon = docIcon(doc)
  const today = todayISO()
  const fail = (err: unknown) => toast(errorMessage(err), 'error')
  const history = isMeasure(doc) ? scoreHistory(all, doc) : []
  const open = () => navigate({ view: 'document', id: doc.id })
  const meta = [
    originLabel(doc),
    doc.status === 'done' && doc.completedAt && doneLabel(doc) === 'Completed' ? `Completed ${relativeDay(localDay(doc.completedAt), today)}` : `Added ${relativeDay(localDay(doc.createdAt), today)}`,
    doc.pageCount > 1 ? `${doc.pageCount} pages` : ''
  ].filter(Boolean)

  return (
    <div className="note-row doc-row" onClick={open} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()}>
      <DragOut doc={doc} />
      <span className={`lib-icon ${doc.origin.kind === 'library' ? `kind-${resourceById(doc.origin.resourceId)?.kind ?? 'handout'}` : 'kind-file'}`}>
        <Icon size={15} />
      </span>
      <div className="note-info">
        <div className="note-title">
          {doc.title}
          {doc.score.trim() && <span className="chip chip-score" title={history.length > 1 ? history.map((h) => `${h.date}: ${h.score}`).join('\n') : 'Score'}>{history.length > 1 ? history.map((h) => h.score).join(' → ') : `Score ${doc.score}`}</span>}
          {presenting.includes(doc.id) && <span className="chip chip-draft">On screen</span>}
          {doc.status === 'todo' && isFilledIn(doc) && <span className="chip chip-muted">Started</span>}
        </div>
        <p className="note-preview">{meta.join(' · ')}</p>
      </div>
      <div className="note-actions doc-actions-row" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="Show on screen to the client" aria-label="Present" onClick={() => api().presentDocument(doc.id).catch(fail)}>
          <MonitorUp size={15} />
        </button>
        <button
          className="icon-btn"
          title="Save as PDF…"
          aria-label="Save as PDF"
          onClick={async () => {
            try {
              const path = await api().exportDocument(doc.id)
              if (path) toast(`Saved ${path.split('/').pop()}`, 'success')
            } catch (err) {
              fail(err)
            }
          }}
        >
          <Download size={15} />
        </button>
        <div className="menu-wrap">
          <button className="icon-btn" onClick={() => setMenu((v) => !v)} aria-label="More">
            <MoreHorizontal size={15} />
          </button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => (setMenu(false), void api().openDocument(doc.id).catch(fail))}>
                <Eye size={14} /> Open in Preview
              </button>
              {doc.status === 'todo' ? (
                <button onClick={() => (setMenu(false), saveDocument({ ...doc, status: 'done', completedAt: new Date().toISOString() }))}>
                  <FileCheck2 size={14} /> Mark complete
                </button>
              ) : (
                <button onClick={() => (setMenu(false), saveDocument({ ...doc, status: 'todo', completedAt: null }))}>
                  <RotateCcw size={14} /> Move to To complete
                </button>
              )}
              <hr />
              <button
                className="danger"
                onClick={() => {
                  setMenu(false)
                  if (window.confirm(`Delete ${doc.title}${isFilledIn(doc) ? ' and everything filled in on it' : ''}? This can’t be undone.`)) deleteDocument(doc.id)
                }}
              >
                <Trash2 size={14} /> Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * A grip that drags the finished PDF out of Echo: into an EHR's upload box in the browser,
 * Finder or Mail. The file is written when the pointer reaches the grip, so the drag starts at once.
 */
export function DragOut({ doc, label }: { doc: ClientDocument; label?: string }) {
  const { toast } = useStore()
  const ready = useRef('')
  const prepare = () => {
    if (ready.current === doc.updatedAt) return
    api()
      .prepareDocumentDrag(doc.id)
      .then(() => (ready.current = doc.updatedAt))
      .catch((err) => toast(errorMessage(err), 'error'))
  }
  return (
    <span
      className={label ? 'doc-drag labeled' : 'doc-drag'}
      draggable
      title="Drag into your EHR, Finder or an email to attach the PDF"
      onMouseEnter={prepare}
      onClick={(e) => e.stopPropagation()}
      onDragStart={(e) => {
        e.preventDefault()
        if (ready.current !== doc.updatedAt) {
          prepare()
          toast('Getting the PDF ready. Drag again in a moment.')
          return
        }
        api().dragDocument(doc.id)
      }}
    >
      <GripVertical size={14} />
      {label && <span>{label}</span>}
    </span>
  )
}

/** Picks Library items to give the client. Several can be assigned in one go (a PHQ-9 and a GAD-7, say). */
function AssignModal({ client, onClose }: { client: Client; onClose(): void }) {
  const { documents, addDocuments, toast, viewResource } = useStore()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [assigned, setAssigned] = useState<string[]>([])

  // With no search, the items this practice assigns most come first.
  const frequent = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of documents) if (d.origin.kind === 'library') counts.set(d.origin.resourceId, (counts.get(d.origin.resourceId) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).flatMap(([id]) => ASSIGNABLE.filter((r) => r.id === id)).slice(0, 8)
  }, [documents])
  const [kind, setKind] = useState<ResourceKind | null>(null)
  const [topic, setTopic] = useState<string | null>(null)
  // Topics that fit the client's diagnoses lead the topic menu and the suggestions.
  const fitting = useMemo(() => topicsForDiagnoses(client.diagnoses), [client.diagnoses])
  const pool = useMemo(() => ASSIGNABLE.filter((r) => (!kind || r.kind === kind) && (!topic || r.topic === topic)), [kind, topic])
  const filtering = !!(kind || topic)
  const found = useMemo(() => (query.trim() ? findResources(query, pool) : null), [query, pool])
  const results = found ? found.items.slice(0, 60) : filtering ? pool : null
  const measures = ASSIGNABLE.filter((r) => r.kind === 'assessment' && r.source !== 'acbs').slice(0, 40)
  const suggested = fitting.map((t) => ({
    topic: t,
    items: ASSIGNABLE.filter((r) => r.topic === t && r.source !== 'acbs' && !frequent.includes(r))
      .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind))
      .slice(0, 6)
  }))
  const shownElsewhere = new Set([...frequent, ...suggested.flatMap((g) => g.items)])

  const assign = async (resourceId: string) => {
    const r = resourceById(resourceId)
    if (!r) return
    setBusy(resourceId)
    try {
      const doc = await api().assignDocument(client.id, resourceId)
      addDocuments([doc])
      setAssigned((a) => [...a, resourceId])
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const row = (r: (typeof ASSIGNABLE)[number]) => {
    const Icon = KIND_ICON[r.kind]
    const done = assigned.includes(r.id)
    return (
      <div key={r.id} className="assign-row">
        <span className={`lib-icon kind-${r.kind}`}>
          <Icon size={14} />
        </span>
        <div className="lib-info">
          <div className="lib-title">{r.title}</div>
          <div className="lib-meta">
            {KIND_LABEL[r.kind]} · {r.topic}
            {r.source === 'acbs' ? ' · ACBS' : ''}
          </div>
        </div>
        <button className="icon-btn" title="Preview" aria-label="Preview" onClick={() => viewResource(r.id)}>
          <Eye size={14} />
        </button>
        <Button size="sm" variant={done ? 'ghost' : 'secondary'} icon={done ? <Check size={13} /> : undefined} disabled={busy === r.id} onClick={() => void assign(r.id)}>
          {busy === r.id ? 'Adding…' : done ? 'Assigned' : 'Assign'}
        </Button>
      </div>
    )
  }

  return (
    <Modal
      title={`Assign to ${client.name}`}
      onClose={onClose}
      width={620}
      footer={
        <Button variant="primary" onClick={onClose}>
          {assigned.length ? `Done (${assigned.length} assigned)` : 'Done'}
        </Button>
      }
    >
      <div className="lib-search assign-search">
        <Search size={14} />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && query && (e.stopPropagation(), setQuery(''))}
          placeholder="Search by name, problem or kind: “anxious teen worksheet”, “PHQ”…"
        />
      </div>
      <div className="lib-filters assign-filters">
        <button className={!kind ? 'on' : ''} onClick={() => setKind(null)}>
          All
        </button>
        {ASSIGN_KINDS.map((k) => (
          <button key={k.kind} className={kind === k.kind ? 'on' : ''} onClick={() => setKind(kind === k.kind ? null : k.kind)}>
            {KIND_PLURAL[k.kind]} <span>{k.count}</span>
          </button>
        ))}
        <span className="lib-filters-gap" />
        <select value={topic ?? ''} onChange={(e) => setTopic(e.target.value || null)} aria-label="Topic">
          <option value="">All topics</option>
          {fitting.length > 0 && (
            <optgroup label={`Fits ${client.name.split(' ')[0]}’s diagnoses`}>
              {fitting.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label={fitting.length ? 'Other topics' : 'Topics'}>
            {TOPICS.filter((t) => !fitting.includes(t)).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      <div className="assign-list">
        {results ? (
          results.length ? (
            <>
              {found?.partial && <h5>Nothing fits every word. Closest matches</h5>}
              {results.map(row)}
            </>
          ) : (
            <p className="muted assign-empty">
              Nothing matches{filtering ? ' with these filters' : ''}. Slides, audio and web-only resources can’t be assigned.
              {filtering && (
                <>
                  {' '}
                  <button
                    className="link"
                    onClick={() => {
                      setKind(null)
                      setTopic(null)
                    }}
                  >
                    Clear filters
                  </button>
                </>
              )}
            </p>
          )
        ) : (
          <>
            {frequent.length > 0 && <h5>Assigned most</h5>}
            {frequent.map(row)}
            {suggested.map(
              (g) =>
                g.items.length > 0 && (
                  <div key={g.topic}>
                    <h5>For {g.topic.toLowerCase().replace('ptsd', 'PTSD')}</h5>
                    {g.items.map(row)}
                  </div>
                )
            )}
            <h5>Measures</h5>
            {measures.filter((r) => !shownElsewhere.has(r)).map(row)}
          </>
        )}
      </div>
    </Modal>
  )
}

/** Suggestions lead with things to fill in: measures, then worksheets and handouts. */
function kindOrder(k: ResourceKind): number {
  const i = ['assessment', 'worksheet', 'handout', 'exercise', 'metaphor'].indexOf(k)
  return i < 0 ? 9 : i
}

/** "Assign to client" in the Library viewer: the client on screen first, or any other. */
export function AssignToClient({ resourceId }: { resourceId: string }) {
  const { clients, route, notes, documents, addDocuments, toast, navigate, viewResource } = useStore()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const current =
    route.view === 'client' ? route.id : route.view === 'note' ? notes.find((n) => n.id === route.id)?.clientId : route.view === 'document' ? documents.find((d) => d.id === route.id)?.clientId : undefined
  const active = clients.filter((c) => c.status === 'active')
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = active
    .filter((c) => words.every((w) => c.name.toLowerCase().includes(w)))
    .sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : a.name.localeCompare(b.name)))
    .slice(0, 8)

  const assign = async (client: Client) => {
    setOpen(false)
    try {
      const doc = await api().assignDocument(client.id, resourceId)
      addDocuments([doc])
      toast(`Assigned to ${client.name}`, 'success', {
        label: 'Fill in',
        run: () => {
          viewResource(null)
          navigate({ view: 'document', id: doc.id })
        }
      })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <div className="menu-wrap">
      <Button size="sm" variant="ghost" icon={<UserPlus size={14} />} onClick={() => setOpen((v) => !v)} title="Copy this into a client’s documents to fill in or keep">
        Assign to client
      </Button>
      {open && (
        <div className="menu assign-menu" onMouseLeave={() => setOpen(false)}>
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Client…" onKeyDown={(e) => e.key === 'Enter' && shown[0] && void assign(shown[0])} />
          {shown.map((c) => (
            <button key={c.id} onClick={() => void assign(c)}>
              {c.name}
              {c.id === current && <span className="menu-hint">current</span>}
            </button>
          ))}
          {!shown.length && <p className="muted">No active client matches.</p>}
        </div>
      )}
    </div>
  )
}
