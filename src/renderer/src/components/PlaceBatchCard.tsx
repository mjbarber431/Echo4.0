import { useMemo, useState } from 'react'
import { AlertTriangle, Check, Circle, Loader2, Pause, Square } from 'lucide-react'
import { NOTE_TYPE_LABEL } from '@shared/types'
import { batchCounts, type PlaceBatchItem } from '@shared/placement'
import { api } from '../lib/util'
import { useStore } from '../store'
import { Avatar, Button } from './ui'
import { PlacePanel } from './PlacePanel'

const LIVE = ['starting', 'running', 'paused', 'asking']

/**
 * Charting: several notes being placed one after another, then what came of each. Each placed note is left
 * open in its own Chrome tab for the clinician to review and sign; one Claude couldn't finish says why.
 */
export function PlaceBatchCard({ onDone }: { onDone?: (notPlacedId?: string) => void } = {}) {
  const { placeBatch: batch, placement, clients, notes, clearPlaceBatch } = useStore()
  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients])
  const noteById = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes])
  if (!batch) return null

  const { placed } = batchCounts(batch)
  const total = batch.items.length
  const liveAt = batch.items.findIndex((i) => LIVE.includes(i.state))
  const live = liveAt >= 0 ? batch.items[liveAt] : null
  // Between notes nothing is live for a moment: count the one about to start.
  const at = liveAt >= 0 ? liveAt : Math.max(0, batch.items.findIndex((i) => i.state === 'waiting'))
  // The current run's own status: its latest step, and pause guidance when it's paused.
  const run = live && placement?.kind === 'note' && placement.noteId === live.noteId ? placement : null
  const stopped = batch.done && batch.items.some((i) => i.state === 'stopped' || i.state === 'waiting')
  // Paused or asking: the panel below has the controls, so the header keeps quiet.
  const held = !!run && (run.state === 'paused' || run.state === 'asking')
  const left = total - placed

  const title = !batch.done ? `${held ? 'Paused' : 'Placing notes'} · ${at + 1} of ${total}` : placed === total ? `${total} note${total === 1 ? '' : 's'} ready to sign` : `${placed} of ${total} placed`
  const subtitle = !batch.done
    ? held
      ? 'The rest wait until you carry on or stop.'
      : 'Each note goes into its own Chrome tab. You can step away; Esc or moving the mouse pauses.'
    : placed
      ? `${placed === 1 ? 'It’s open in its own Chrome tab. Review and sign it there.' : 'Each is open in its own Chrome tab. Review and sign them there.'}${left ? ` ${left === 1 ? 'The other one is' : `The other ${left} are`} still in your notes to chart.` : ''}`
      : stopped
        ? 'Stopped before any were placed.'
        : 'None were placed. The reasons are below.'

  return (
    <section className="place-batch" aria-live="polite">
      <div className="place-batch-head">
        {held ? <Pause size={16} className="warn" /> : !batch.done ? <Loader2 size={16} className="spin accent" /> : placed === total ? <Check size={16} className="ok" /> : <AlertTriangle size={15} className="warn" />}
        <div className="grow">
          <h2>{title}</h2>
          <p className="muted small">{subtitle}</p>
        </div>
        <div className="place-batch-actions">
          {batch.done ? (
            <Button
              size="sm"
              variant={placed ? 'primary' : 'ghost'}
              onClick={() => {
                // Go on to the first note that still needs the clinician, if any.
                const left = batch.items.find((i) => i.state !== 'placed')?.noteId
                clearPlaceBatch()
                onDone?.(left)
              }}
            >
              Done
            </Button>
          ) : held ? null : (
            <>
              {/* Stays put between notes, so it doesn't flicker as each one opens. */}
              <Button size="sm" variant="ghost" icon={<Pause size={13} />} disabled={live?.state !== 'running'} onClick={() => api().placePause()}>
                Pause
              </Button>
              <Button size="sm" variant="ghost" icon={<Square size={12} />} onClick={() => api().placeStop()} title="Stop this note and skip the rest">
                Stop
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="list-card">
        {batch.items.map((item) => {
          const c = clientById.get(item.clientId)
          const n = noteById.get(item.noteId)
          return (
            <div key={item.noteId} className={`list-row place-batch-row ${item.state}`}>
              <ItemIcon item={item} />
              {c && <Avatar id={c.id} name={c.name} size={24} />}
              <span className="grow">
                <b>{c?.name ?? 'Deleted note'}</b>
                {n && <> · {NOTE_TYPE_LABEL[n.type]}</>}
                <Status text={itemStatus(item, batch.done, item === live && run ? run.log[run.log.length - 1] : undefined)} long={item.state === 'failed'} />
              </span>
            </div>
          )
        })}
      </div>

      {run && held && <PlacePanel status={run} onDismiss={() => {}} />}
    </section>
  )
}

/** The line under a note. Claude's reason for stopping can run long: two lines, then More. */
function Status({ text, long }: { text: string; long: boolean }) {
  const [open, setOpen] = useState(false)
  const clamp = long && text.length > 140
  return (
    <>
      <small className={`place-batch-status${clamp && !open ? ' clamped' : ''}`}>{text}</small>
      {clamp && (
        <button type="button" className="place-batch-more" onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'More'}
        </button>
      )}
    </>
  )
}

function ItemIcon({ item }: { item: PlaceBatchItem }) {
  switch (item.state) {
    case 'waiting':
      return <Circle size={14} className="muted" />
    case 'starting':
    case 'running':
      return <Loader2 size={14} className="spin accent" />
    case 'paused':
    case 'asking':
      return <Pause size={14} className="warn" />
    case 'placed':
      return <Check size={14} className="ok" />
    default:
      return <AlertTriangle size={14} className="warn" />
  }
}

/** One line under the client's name: where the note is, or why it isn't there. */
function itemStatus(item: PlaceBatchItem, done: boolean, step?: string): string {
  switch (item.state) {
    case 'waiting':
      return done ? 'Not started' : 'Waiting'
    case 'starting':
      return `Opening ${item.ehrName}…`
    case 'running':
      return step ?? `Working in ${item.ehrName}…`
    case 'paused':
      return 'Paused'
    case 'asking':
      return 'Waiting for you'
    case 'placed':
      return `In ${item.ehrName}, ready to review and sign`
    case 'stopped':
      return 'Stopped'
    default:
      // Claude's own words, without the cost note at the end.
      return item.message.replace(/\s*\(about \$[\d.]+\)\s*$/, '') || 'Couldn’t finish'
  }
}
