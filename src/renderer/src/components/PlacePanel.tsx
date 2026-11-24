import { useState } from 'react'
import { AlertTriangle, Check, Pause, Play, Square, X } from 'lucide-react'
import type { PlaceStatus } from '@shared/placement'
import { api } from '../lib/util'
import { Button } from './ui'

const PLACE_TITLE: Record<PlaceStatus['state'], string> = {
  starting: 'Starting…',
  running: 'Claude is working in',
  paused: 'Paused in',
  asking: 'Claude has a question in',
  placed: 'Done in',
  stopped: 'Stopped in',
  failed: 'Couldn’t finish in'
}

/** The Navigator at work in an EHR: what it's doing, and pause, guidance and stop while it runs. */
export function PlacePanel({ status, onDismiss }: { status: PlaceStatus; onDismiss(): void }) {
  const [guidance, setGuidance] = useState('')
  const live = status.state === 'starting' || status.state === 'running'
  const waiting = status.state === 'paused' || status.state === 'asking'
  const ended = !live && !waiting
  const carryOn = () => {
    api().placeResume(guidance)
    setGuidance('')
  }
  return (
    <div className={`place-panel ${status.state}`} role="status" aria-live="polite">
      <div className="place-head">
        {live ? (
          <span className="dot-writing" aria-hidden />
        ) : status.state === 'placed' ? (
          <Check size={15} className="ok" />
        ) : waiting ? (
          <Pause size={14} className="warn" />
        ) : (
          <AlertTriangle size={14} className="warn" />
        )}
        <b className="grow">
          {PLACE_TITLE[status.state]}
          {status.state === 'starting' ? '' : ` ${status.ehrName}`}
        </b>
        {live && (
          <>
            <span className="muted small">Esc pauses</span>
            <Button size="sm" variant="ghost" icon={<Pause size={13} />} onClick={() => api().placePause()}>
              Pause
            </Button>
          </>
        )}
        {!ended && (
          <Button size="sm" variant="ghost" icon={<Square size={12} />} onClick={() => api().placeStop()}>
            Stop
          </Button>
        )}
        {ended && (
          <button className="icon-btn" onClick={onDismiss} title="Dismiss" aria-label="Dismiss">
            <X size={14} />
          </button>
        )}
      </div>
      {status.message && <p className={status.state === 'asking' ? 'place-question' : 'place-message'}>{status.message}</p>}
      {waiting && (
        <div className="place-guide">
          <textarea
            value={guidance}
            autoFocus
            rows={2}
            placeholder={status.state === 'asking' ? 'Your answer' : 'Tell Claude what to do (kept for next time), or just carry on. You can also click in the EHR yourself first.'}
            onChange={(e) => setGuidance(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || !e.shiftKey)) {
                e.preventDefault()
                carryOn()
              }
            }}
          />
          <Button size="sm" variant="primary" icon={<Play size={13} />} onClick={carryOn}>
            Carry on
          </Button>
        </div>
      )}
      {status.log.length > 0 && (
        <ol className="place-log" aria-label="What Claude has done">
          {status.log.slice(-8).map((line, k) => (
            <li key={status.log.length - 8 + k}>{line}</li>
          ))}
        </ol>
      )}
    </div>
  )
}
