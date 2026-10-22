import { useMemo, useState } from 'react'
import { Archive, ChevronRight, ClipboardList, FileText, LogOut, MoreHorizontal, NotebookPen, Pencil, Plus, RotateCcw, Trash2, UserRoundCheck } from 'lucide-react'
import type { Client, Note, NoteType } from '@shared/types'
import { NOTE_TYPE_LABEL } from '@shared/types'
import { noteSortKey, planReviewDue, todayISO } from '@shared/compliance'
import { noteToHtml, noteToText } from '@shared/format'
import { openLoopCount } from '@shared/scratch'
import { relativeDay } from '../lib/util'
import { useStore, type ClientTab } from '../store'
import { ClientModal } from '../components/ClientModal'
import { Scratchpad } from '../components/Scratchpad'
import { AutoTextarea, Avatar, Button, CopyButton, Empty } from '../components/ui'
import { PlanTab } from './PlanTab'

export function ClientView({ clientId, tab = 'notes' }: { clientId: string; tab?: ClientTab }) {
  const { clients, notes, navigate, createNote, saveClient, deleteClient, toast } = useStore()
  const client = clients.find((c) => c.id === clientId)
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState(false)

  const clientNotes = useMemo(
    () => notes.filter((n) => n.clientId === clientId).sort((a, b) => noteSortKey(b).localeCompare(noteSortKey(a))),
    [notes, clientId]
  )

  if (!client) return null

  const hasIntake = clientNotes.some((n) => n.type === 'intake')
  const hasPlan = (client.plan?.goals.length ?? 0) > 0
  const draft = clientNotes.find((n) => n.status === 'draft')
  const reviewDue = planReviewDue(client, todayISO())

  const start = (type: NoteType) => {
    setMenu(false)
    const note = createNote(client.id, type)
    navigate({ view: 'note', id: note.id })
  }

  const primary: NoteType = !hasIntake && !hasPlan ? 'intake' : 'progress'

  return (
    <div className="page">
      <header className="page-head drag client-head">
        <Avatar id={client.id} name={client.name} size={34} />
        <div className="client-title">
          <h1>
            {client.name}
            {client.pronouns && <span className="pronouns">{client.pronouns}</span>}
            {client.status === 'discharged' && <span className="chip chip-muted">Discharged</span>}
          </h1>
          <div className="dx-line">
            {client.diagnoses.length ? (
              client.diagnoses.map((d) => (
                <span key={d.code} className="chip chip-dx" title={d.description}>
                  <b>{d.code}</b> {d.description}
                </span>
              ))
            ) : (
              <button className="link no-drag" onClick={() => setEditing(true)}>
                Add diagnosis
              </button>
            )}
          </div>
        </div>
        <div className="head-actions no-drag">
          {client.status === 'active' ? (
            <Button variant="primary" icon={<NotebookPen size={15} />} onClick={() => (draft ? navigate({ view: 'note', id: draft.id }) : start(primary))}>
              {draft ? (draft.sections.length ? 'Review draft' : 'Resume draft') : primary === 'intake' ? 'Start intake' : 'New progress note'}
            </Button>
          ) : (
            <Button
              icon={<RotateCcw size={14} />}
              onClick={() => {
                saveClient({ ...client, status: 'active' })
                toast('Client reactivated')
              }}
            >
              Reactivate
            </Button>
          )}
          <div className="menu-wrap">
            <button className="icon-btn lg" onClick={() => setMenu((v) => !v)} aria-label="More">
              <MoreHorizontal size={18} />
            </button>
            {menu && (
              <div className="menu" onMouseLeave={() => setMenu(false)}>
                <button onClick={() => start('progress')}>
                  <FileText size={14} /> New progress note
                </button>
                <button onClick={() => start('intake')}>
                  <UserRoundCheck size={14} /> New intake (90791)
                </button>
                <button onClick={() => start('termination')}>
                  <LogOut size={14} /> Discharge summary
                </button>
                <hr />
                <button onClick={() => (setMenu(false), setEditing(true))}>
                  <Pencil size={14} /> Edit client
                </button>
                {client.status === 'active' && (
                  <button onClick={() => (setMenu(false), saveClient({ ...client, status: 'discharged' }), toast('Moved to discharged'))}>
                    <Archive size={14} /> Mark discharged
                  </button>
                )}
                <button
                  className="danger"
                  onClick={() => {
                    setMenu(false)
                    if (window.confirm(`Permanently delete ${client.name} and all of their notes? This cannot be undone.`)) {
                      deleteClient(client.id)
                      navigate({ view: 'queue' })
                    }
                  }}
                >
                  <Trash2 size={14} /> Delete client
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="tabs">
        {(
          [
            ['notes', 'Notes', clientNotes.length],
            ['plan', 'Treatment plan', reviewDue ? '!' : null],
            ['context', 'Clinical context', null],
            ['scratchpad', 'Scratchpad', openLoopCount(client.scratchpad)]
          ] as const
        ).map(([key, label, badge]) => (
          <button
            key={key}
            className={tab === key ? 'on' : ''}
            onClick={() => navigate({ view: 'client', id: client.id, tab: key })}
            title={key === 'scratchpad' ? (badge ? `${badge} open ${badge === 1 ? 'loop' : 'loops'} · ⇧⌘P` : '⇧⌘P') : undefined}
          >
            {label}
            {badge !== null && badge !== 0 && <span className={`tab-badge ${badge === '!' ? 'warn' : ''}`}>{badge === '!' ? 'Review due' : badge}</span>}
          </button>
        ))}
      </nav>

      <div className="page-body">
        <div className={tab === 'scratchpad' ? 'tab-content scratch-tab' : 'tab-content'}>
          {tab === 'notes' && <NotesTab client={client} notes={clientNotes} onStart={start} />}
          {tab === 'plan' && <PlanTab client={client} />}
          {tab === 'context' && <ContextTab client={client} />}
          {tab === 'scratchpad' && <Scratchpad client={client} />}
        </div>
      </div>

      {editing && <ClientModal client={client} onClose={() => setEditing(false)} />}
    </div>
  )
}

function NotesTab({ client, notes, onStart }: { client: Client; notes: Note[]; onStart(type: NoteType): void }) {
  const { navigate, settings, saveNote, jobs, unseen } = useStore()
  // A draft's chip follows what Echo is doing with it in the background.
  const draftChip = (n: Note) => {
    const job = jobs[n.id]
    if (job?.error) return <span className="chip chip-error">Couldn’t write</span>
    if (job) return <span className="chip chip-draft"><span className="activity-orb" aria-hidden /> {job.stage === 'transcribing' ? 'Transcribing…' : job.kind === 'amend' ? 'Applying follow-up…' : 'Writing…'}</span>
    if (unseen[n.id]) return <span className="chip chip-draft">Ready · New</span>
    return <span className="chip chip-draft">Draft</span>
  }
  const today = todayISO()
  if (notes.length === 0) {
    return (
      <Empty icon={<ClipboardList size={26} />} title="No notes yet">
        <p>Start with an intake, or a progress note if you’re already seeing this client.</p>
        <div className="row gap">
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => onStart('intake')}>
            Intake (90791)
          </Button>
          <Button onClick={() => onStart('progress')}>Progress note</Button>
        </div>
      </Empty>
    )
  }
  // Notes arrive newest first; group consecutive ones by session month so a long history scans easily.
  const groups: { month: string; notes: Note[] }[] = []
  for (const n of notes) {
    const month = n.session.date ? new Date(`${n.session.date.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'Undated'
    const last = groups[groups.length - 1]
    if (last?.month === month) last.notes.push(n)
    else groups.push({ month, notes: [n] })
  }
  return (
    <div className="note-list">
      {groups.map((g) => (
        <section key={g.month} className="note-group">
          <h4 className="note-group-head">
            {g.month}
            <span>{g.notes.length}</span>
          </h4>
          <div className="note-group-rows">
            {g.notes.map((n) => {
              const preview = n.sections[0]?.body ?? n.dictation
              return (
                <div key={n.id} className="note-row" onClick={() => navigate({ view: 'note', id: n.id })} role="button" tabIndex={0}>
                  <div className="note-date">{relativeDay(n.session.date, today)}</div>
                  <div className="note-info">
                    <div className="note-title">
                      {NOTE_TYPE_LABEL[n.type]}
                      {n.session.cpt !== 'none' && <span className="note-cpt">{n.session.cpt}</span>}
                      {n.status === 'draft' ? draftChip(n) : !n.copiedAt ? <span className="chip chip-warn">Not copied</span> : null}
                    </div>
                    <p className="note-preview">{jobs[n.id] && !jobs[n.id].error && !n.sections.length ? 'Echo is writing this note. Start your next one whenever you’re ready.' : preview || 'Empty draft'}</p>
                  </div>
                  {n.sections.length > 0 && (
                    <div className="note-actions" onClick={(e) => e.stopPropagation()}>
                      <CopyButton
                        text={noteToText(n, client, settings)}
                        html={noteToHtml(n, client, settings)}
                        onCopied={() => void saveNote({ ...n, copiedAt: new Date().toISOString() })}
                      />
                    </div>
                  )}
                  <ChevronRight size={16} className="note-chevron" />
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

function ContextTab({ client }: { client: Client }) {
  const { saveClient } = useStore()
  const [text, setText] = useState(client.context)
  // The context the text was loaded from. When it changes underneath (a background rebuild), unedited text follows it.
  const [base, setBase] = useState(client.context)
  if (base !== client.context) {
    setBase(client.context)
    if (text === base) setText(client.context)
  }
  const dirty = text !== client.context
  return (
    <div className="context-tab">
      <div className="explainer">
        <h3>Clinical context</h3>
        <p className="muted">
          A rolling summary Echo refreshes each time you finalize a note, so you never have to repeat background. It’s included (without the client’s name) when
          generating notes. Edit anything that’s off.
        </p>
      </div>
      <AutoTextarea className="context-edit" value={text} minRows={10} onChange={(e) => setText(e.target.value)} placeholder="Nothing yet. This fills in after your first finalized note or treatment plan." />
      {dirty && (
        <div className="row gap">
          <Button variant="primary" onClick={() => saveClient({ ...client, context: text })}>
            Save context
          </Button>
          <Button variant="ghost" onClick={() => setText(client.context)}>
            Revert
          </Button>
        </div>
      )}
    </div>
  )
}
