import { useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Mic, Search, UserPlus } from 'lucide-react'
import type { Client } from '@shared/types'
import { useStore } from '../store'
import { Avatar, Kbd } from './ui'

/** ⌘K finder. In "note" mode, Enter starts a progress note for the chosen client. */
export function CommandPalette({ mode, onClose, onNewClient, onStartNote }: {
  mode: 'find' | 'note'
  onClose(): void
  onNewClient(name: string): void
  onStartNote(client: Client): void
}) {
  const { clients, navigate } = useStore()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = clients.filter((c) => (mode === 'note' ? c.status === 'active' : true))
    const matched = q ? list.filter((c) => c.name.toLowerCase().includes(q)) : list
    return matched.sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1
      return ap - bp || (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) || a.name.localeCompare(b.name)
    })
  }, [clients, query, mode])

  useEffect(() => setIndex(0), [query])

  const choose = (c: Client, startNote: boolean) => {
    onClose()
    if (startNote) onStartNote(c)
    else navigate({ view: 'client', id: c.id })
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(i + 1, results.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const c = results[index]
      if (c) choose(c, mode === 'note' || e.metaKey)
      else if (query.trim()) {
        onClose()
        onNewClient(query.trim())
      }
    } else if (e.key === 'Escape') onClose()
  }

  return (
    <div className="overlay overlay-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <div className="palette-input">
          {mode === 'note' ? <Mic size={16} /> : <Search size={16} />}
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={mode === 'note' ? 'New note for which client?' : 'Find a client…'}
          />
        </div>
        <div className="palette-list">
          {results.map((c, i) => (
            <button
              key={c.id}
              className={`palette-row ${i === index ? 'sel' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={(e) => choose(c, mode === 'note' || e.metaKey)}
            >
              <Avatar id={c.id} name={c.name} size={26} />
              <span className="palette-name">{c.name}</span>
              {c.status === 'discharged' && <span className="chip chip-muted">Discharged</span>}
              {i === index && (
                <span className="palette-hint">
                  {mode === 'note' ? 'Start note' : 'Open'} <CornerDownLeft size={12} />
                </span>
              )}
            </button>
          ))}
          {query.trim() && (
            <button className={`palette-row ${index === results.length ? 'sel' : ''}`} onMouseEnter={() => setIndex(results.length)} onClick={() => (onClose(), onNewClient(query.trim()))}>
              <span className="palette-new">
                <UserPlus size={14} />
              </span>
              <span className="palette-name">
                New client “{query.trim()}”
              </span>
            </button>
          )}
          {!query.trim() && results.length === 0 && <div className="palette-empty">No clients yet. Type a name to add one.</div>}
        </div>
        {mode === 'find' && (
          <div className="palette-foot">
            <span>
              <Kbd>↵</Kbd> open
            </span>
            <span>
              <Kbd>⌘↵</Kbd> new progress note
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
