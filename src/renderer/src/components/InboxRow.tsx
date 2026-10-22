import { useMemo, useState } from 'react'
import { FilePen, Sparkles, Trash2 } from 'lucide-react'
import type { MobileMemo } from '@shared/types'
import { matchClients } from '@shared/mobile'
import { useStore } from '../store'
import { Avatar, Button } from './ui'

/**
 * One recording from the iPhone. Echo preselects the client whose name it heard
 * at the start; nothing is written until the clinician confirms the client.
 */
export function InboxRow({ memo }: { memo: MobileMemo }) {
  const { clients, takeMemo, discardMemo, navigate } = useStore()
  const matches = useMemo(() => matchClients(memo.transcript, clients), [memo.transcript, clients])
  const [clientId, setClientId] = useState(() => (matches[0]?.likely ? matches[0].clientId : ''))
  const [expanded, setExpanded] = useState(false)

  const client = clients.find((c) => c.id === clientId)
  const suggested = new Set(matches.map((m) => m.clientId))
  const others = [...clients].filter((c) => !suggested.has(c.id)).sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active') || a.name.localeCompare(b.name))
  const heard = matches.find((m) => m.clientId === clientId)?.heard ?? []

  const take = (write: boolean) => {
    const note = takeMemo(memo.id, clientId, heard, write)
    if (note && !write) navigate({ view: 'note', id: note.id })
  }

  return (
    <div className="list-row inbox-row">
      {client ? <Avatar id={client.id} name={client.name} size={24} /> : <span className="avatar inbox-unknown">?</span>}
      <div className="grow inbox-main">
        <div className="inbox-head">
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client" className={clientId ? '' : 'inbox-unset'}>
            <option value="">Choose client…</option>
            {matches.length > 0 && (
              <optgroup label="Heard in the recording">
                {matches.map((m) => (
                  <option key={m.clientId} value={m.clientId}>
                    {clients.find((c) => c.id === m.clientId)?.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label={matches.length ? 'Everyone else' : 'Clients'}>
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.status === 'discharged' ? ' (discharged)' : ''}
                </option>
              ))}
            </optgroup>
          </select>
          {matches[0]?.likely && clientId === matches[0].clientId && <span className="chip chip-draft">Matched by name</span>}
          <span className="muted small">
            {recordedLabel(memo.recordedAt)} · {durationLabel(memo.durationSec)}
          </span>
        </div>
        <button className={`inbox-text ${expanded ? 'open' : ''}`} onClick={() => setExpanded((v) => !v)} title={expanded ? 'Show less' : 'Show the whole transcript'}>
          {memo.transcript}
        </button>
      </div>
      <div className="row gap">
        <Button size="sm" variant="primary" icon={<Sparkles size={13} />} disabled={!client} onClick={() => take(true)} title="Make this the client’s draft and write the note">
          Write note
        </Button>
        <Button size="sm" variant="ghost" icon={<FilePen size={13} />} disabled={!client} onClick={() => take(false)} title="Open as a draft without writing it yet">
          Open draft
        </Button>
        <button className="icon-btn" aria-label="Discard recording" title="Discard recording" onClick={() => window.confirm('Discard this recording? It can’t be recovered.') && discardMemo(memo.id)}>
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

function recordedLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return `Today ${time}`
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`
}

function durationLabel(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} sec`
  return `${Math.round(sec / 60)} min`
}
