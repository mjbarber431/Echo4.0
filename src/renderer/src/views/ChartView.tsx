import { useEffect, useMemo } from 'react'
import { AlertTriangle, ArrowRight, Check, ChevronLeft, Copy, ExternalLink, FileText, LayoutPanelLeft, LogOut, MousePointerClick, PencilLine, Wand2 } from 'lucide-react'
import type { Note } from '@shared/types'
import { NOTE_TYPE_LABEL } from '@shared/types'
import { auditChecks, todayISO } from '@shared/compliance'
import { headerLines, sectionHtml, sectionText, signatureLine } from '@shared/format'
import { usableEhrs } from '@shared/ehr'
import { buildQueue, chartStatus, nextToChart, type ChartStatus } from '@shared/queue'
import { api, nowISO, relativeDay } from '../lib/util'
import { copyNote, finalizedMessage, finalizeNote } from '../lib/finalizeNote'
import { useCommand, useStore } from '../store'
import { PlacePanel } from '../components/PlacePanel'
import { PlaceBatchCard } from '../components/PlaceBatchCard'
import { notesToPlace, placeAll, placeAllLabel, PLACE_ALL_TITLE } from '../lib/placeAll'
import { Avatar, Button, CopyButton, Kbd } from '../components/ui'

const STATUS_LABEL: Record<ChartStatus, string> = { review: 'To review', copy: 'Finalized, not copied', done: 'Copied' }

function StatusIcon({ status }: { status: ChartStatus }) {
  if (status === 'done') return <Check size={13} className="ok" />
  if (status === 'copy') return <Copy size={12} className="warn" />
  return <FileText size={13} className="accent" />
}

/**
 * Charting: the batch of new notes, one at a time, showing exactly what goes into the EHR.
 * Finalize and copy (⌘S), jump to the client's EHR, paste, then on to the next (⌘]).
 * Anything that needs real editing opens in the full note.
 */
export function ChartView({ noteId }: { noteId?: string }) {
  const store = useStore()
  const { charting, notes, clients, jobs, settings, navigate, stopCharting, startCharting, openEhrs, showEhr, toast, saveClient, placement, placeNote, clearPlacement, placeBatch, clearPlaceBatch } = store
  const today = todayISO()
  const byClient = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients])
  const list = useMemo(() => (charting ?? []).flatMap((id) => notes.filter((n) => n.id === id)), [charting, notes])
  const writing = useMemo(() => buildQueue(notes, clients, jobs).writing.length, [notes, clients, jobs])
  const ehrs = usableEhrs(settings.ehrs)

  const note = list.find((n) => n.id === noteId) ?? list.find((n) => chartStatus(n) !== 'done') ?? list[0]
  const client = note && byClient.get(note.clientId)
  const i = note ? list.indexOf(note) : -1
  const ehr = (client?.ehrId && ehrs.find((e) => e.id === client.ehrId)) || (ehrs.length === 1 ? ehrs[0] : undefined)
  const job = note && jobs[note.id]
  const busy = !!job && !job.error
  const status = note ? chartStatus(note) : 'review'
  const done = list.filter((n) => chartStatus(n) === 'done').length
  const next = charting && note ? nextToChart(charting, notes, note.id) : null

  // A batch under way (or its summary) takes the main pane until it's dismissed.
  const batchRunning = !!placeBatch && !placeBatch.done
  const go = (n: Note | null | undefined) => {
    if (!n || batchRunning) return
    if (placeBatch) clearPlaceBatch()
    navigate({ view: 'chart', id: n.id })
  }
  const finish = () => {
    stopCharting()
    navigate({ view: 'charting' })
  }

  /** The main action: finalize (if it's still a draft) and copy, then bring the client's EHR forward to paste into. */
  const send = async () => {
    if (!note || !client || busy) return
    const saved = note.status === 'draft' ? await finalizeNote(store, note, client, true) : await copyNote(store, note, client)
    if (!saved) return
    if (ehr) void showEhr(ehr.id)
    toast(ehr ? `Copied. Paste into ${ehr.name} with ⌘V.` : note.status === 'draft' ? finalizedMessage(note) : 'Copied. Paste into your EHR with ⌘V.', 'success')
  }
  const copyOnly = async () => {
    if (!note || !client || busy) return
    await copyNote(store, note, client)
    toast('Copied. Paste into your EHR with ⌘V.', 'success')
  }

  const placingNow = !!placement && ['starting', 'running', 'paused', 'asking'].includes(placement.state)
  const placeable = notesToPlace(list, byClient, settings, jobs)
  const canPlace = !!settings.placeWithClaude && !!ehr && !settings.mockAI
  /** Finalizes a draft if need be, then has Claude click through the EHR to the note and paste it there. */
  const place = async () => {
    if (!note || !client || busy || placingNow) return
    const saved = note.status === 'draft' ? await finalizeNote(store, note, client, false) : note
    if (!saved) return
    await placeNote(saved.id)
  }

  useCommand('finalize', () => void send())
  useCommand('copy-note', () => void copyOnly())
  useCommand('chart-prev', () => go(list[i - 1]))
  useCommand('chart-next', () => go(next ?? list[i + 1]))

  // ⌃1, ⌃2… bring each EHR forward.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey) return
      const k = Number(e.key)
      if (k >= 1 && k <= ehrs.length) {
        e.preventDefault()
        void showEhr(ehrs[k - 1].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ehrs, showEhr])

  // Focused charting needs a batch: without one, Charting's own page is where it starts.
  if (!charting) return <Redirect to={() => navigate({ view: 'charting' })} />

  const flagged = note && note.status === 'draft' ? [...note.reviewItems, ...auditChecks(note, client!).filter((c) => c.level === 'error').map((c) => (c.detail ? `${c.label}: ${c.detail}` : c.label))] : []
  const primaryLabel = status === 'review' ? 'Finalize & copy' : status === 'copy' ? 'Copy' : 'Copy again'

  return (
    <div className="page chart">
      {/* Not a drag area: after Echo's window is laid out beside the EHRs, macOS can take clicks on a title-bar drag area as drags, so its buttons did nothing. */}
      <header className="page-head">
        <h1 className="page-title">Charting</h1>
        <span className="muted small chart-progress">
          {list.length ? `${done} of ${list.length} copied` : 'Waiting for notes'}
          {writing > 0 && ` · ${writing} writing`}
        </span>
        <div className="head-actions chart-head-actions no-drag">
          <div className="ehr-pills">
            {ehrs.map((e, k) => (
              <button key={e.id} className={`ehr-pill ${ehr?.id === e.id ? 'mine' : ''}`} onClick={() => void showEhr(e.id)} title={`Bring ${e.name} forward (⌃${k + 1})`}>
                <ExternalLink size={12} />
                <span>{e.name}</span>
              </button>
            ))}
          </div>
          {ehrs.length > 0 && (
            <button className="icon-btn" onClick={() => void openEhrs()} title="Open all EHRs and arrange the windows (⌥⌘E)" aria-label="Open and arrange EHRs">
              <LayoutPanelLeft size={15} />
            </button>
          )}
          <Button size="sm" variant={list.length > 0 && done === list.length && !writing ? 'primary' : 'ghost'} icon={<LogOut size={13} />} onClick={finish} title="Stop charting and put Echo’s window back">
            Exit
          </Button>
        </div>
      </header>

      <div className="chart-body">
        <nav className="chart-rail" aria-label="Notes to chart">
          {placeable.length > 0 && !placeBatch && (
            <button className="chart-navigate" onClick={() => void placeAll(store, placeable)} disabled={placingNow} title={PLACE_ALL_TITLE}>
              <Wand2 size={15} />
              <span>
                <b>{placeable.length === 1 ? 'Chart it for me' : `Chart all ${placeable.length} for me`}</b>
                <small>Each in its own tab. You sign.</small>
              </span>
            </button>
          )}
          {list.map((n) => {
            const s = chartStatus(n)
            const name = byClient.get(n.clientId)?.name ?? ''
            return (
              <button key={n.id} className={`chart-item ${s} ${n.id === note?.id && !placeBatch ? 'current' : ''}`} onClick={() => go(n)} disabled={batchRunning} title={`${name}: ${STATUS_LABEL[s]}`} aria-current={n.id === note?.id ? 'true' : undefined}>
                <StatusIcon status={s} />
                <span className="chart-item-text">
                  <b>{name}</b>
                  <small>
                    {NOTE_TYPE_LABEL[n.type]} · {relativeDay(n.session.date, today)}
                  </small>
                </span>
              </button>
            )
          })}
          {writing > 0 && (
            <div className="chart-item writing">
              <span className="dot-writing" aria-hidden />
              <span className="chart-item-text">
                <small>
                  {writing} still writing. {writing === 1 ? 'It joins' : 'They join'} the list when done.
                </small>
              </span>
            </div>
          )}
        </nav>

        <div className="chart-main">
          {placeBatch ? (
            <div className="chart-batch">
              <PlaceBatchCard onDone={(id) => id && navigate({ view: 'chart', id })} />
            </div>
          ) : !note || !client ? (
            <div className="chart-empty">
              <span className="dot-writing" aria-hidden />
              <p className="muted">Notes still being written appear here when they’re done.</p>
            </div>
          ) : (
            <div className="chart-note" key={note.id}>
              <div className="chart-note-head">
                <Avatar id={client.id} name={client.name} size={34} />
                <div className="grow">
                  <h2>{client.name}</h2>
                  <span className="muted small">
                    {NOTE_TYPE_LABEL[note.type]} · {relativeDay(note.session.date, today)} · {note.session.cpt || 'No CPT'}
                  </span>
                </div>
                <span className={`chip ${status === 'done' ? 'chip-ok' : status === 'copy' ? 'chip-warn' : 'chip-draft'}`}>
                  {note.placedAt ? `In ${note.placedIn ?? 'the EHR'}, sign it there` : STATUS_LABEL[status]}
                </span>
              </div>

              {ehrs.length > 1 && (
                <label className="chart-ehr">
                  <span className="muted small">Charted in</span>
                  <select value={client.ehrId ?? ''} onChange={(e) => saveClient({ ...client, ehrId: e.target.value || undefined, updatedAt: nowISO() })}>
                    <option value="">Choose an EHR…</option>
                    {ehrs.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                  <span className="muted small">Remembered for {client.name.split(' ')[0]}.</span>
                </label>
              )}

              {busy && <p className="notice">Applying a follow-up to this note…</p>}

              {placement && placement.kind === 'note' && placement.noteId === note.id && <PlacePanel status={placement} onDismiss={clearPlacement} />}

              {flagged.length > 0 && (
                <div className="chart-flags">
                  <AlertTriangle size={15} className="warn" />
                  <div className="grow">
                    <b>Check before finalizing</b>
                    <ul>
                      {flagged.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  </div>
                  <Button size="sm" variant="ghost" icon={<PencilLine size={13} />} onClick={() => navigate({ view: 'note', id: note.id })}>
                    Open note
                  </Button>
                </div>
              )}

              <article className="chart-doc" aria-label="The note as it will be pasted">
                {settings.includeHeader && (
                  <div className="chart-doc-header">
                    {headerLines(note, client, settings).map((l) => (
                      <div key={l}>{l}</div>
                    ))}
                  </div>
                )}
                {note.sections.map((s, k) => (
                  <section key={k} className="chart-sec">
                    <div className="chart-sec-head">
                      <h4>{s.heading}</h4>
                      <CopyButton text={sectionText(s, settings).split('\n').slice(1).join('\n')} html={sectionHtml(s, settings)} label="" title={`Copy ${s.heading.toLowerCase()} only`} />
                    </div>
                    <div className="chart-sec-body">{s.body}</div>
                  </section>
                ))}
                {settings.includeSignature && <div className="chart-doc-sign">{signatureLine(settings)}</div>}
              </article>
            </div>
          )}
        </div>
      </div>

      {note && client && !placeBatch && (
        <footer className="chart-actions no-drag">
          <button className="icon-btn" onClick={() => go(list[i - 1])} disabled={i <= 0} title="Previous note (⌘[)" aria-label="Previous note">
            <ChevronLeft size={16} />
          </button>
          <Button variant="primary" icon={status === 'review' ? <Check size={15} /> : <Copy size={14} />} onClick={() => void send()} disabled={busy} title="⌘S">
            {primaryLabel}
            {ehr && <span className="wide-only"> → {ehr.name}</span>}
          </Button>
          <Kbd>⌘S</Kbd>
          {canPlace && (
            <Button icon={<MousePointerClick size={14} />} onClick={() => void place()} disabled={busy || placingNow} title={`Claude clicks through ${ehr!.name} to this session’s note and pastes it there. You review and sign.`}>
              {note.placedAt ? 'Place again' : 'Place'}
              {!note.placedAt && <span className="wide-only"> in {ehr!.name}</span>}
            </Button>
          )}
          {status === 'review' && (
            <Button variant="ghost" className="icon-when-narrow" icon={<Copy size={13} />} onClick={() => void copyOnly()} disabled={busy} title="Copy without finalizing (⇧⌘C)" aria-label="Copy draft">
              Copy draft
            </Button>
          )}
          <Button variant="ghost" className="icon-when-narrow" icon={<PencilLine size={13} />} onClick={() => navigate({ view: 'note', id: note.id })} title="Edit the note" aria-label="Edit">
            Edit
          </Button>
          <span className="grow" />
          {next ? (
            <Button icon={<ArrowRight size={14} />} onClick={() => go(next)} title="Next note (⌘])">
              <span className="chart-next-name">
                Next<span className="wide-only">: {byClient.get(next.clientId)?.name}</span>
              </span>
            </Button>
          ) : (
            list.length > 0 && done === list.length && <span className="ok small">All copied{writing ? '. More on the way.' : '.'}</span>
          )}
        </footer>
      )}
    </div>
  )
}

function Redirect({ to }: { to(): void }) {
  useEffect(() => to(), []) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}
