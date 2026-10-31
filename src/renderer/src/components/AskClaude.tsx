import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, BookOpen, ChevronRight, Loader2, Lock, MessageSquarePlus, Mic, RotateCcw, Sparkles, Square, Trash2 } from 'lucide-react'
import type { Client } from '@shared/types'
import { CHAT_MODELS, CHAT_STARTERS, chatToHtml, formatCost, splitResourceTokens, threadCost, type ChatSummary, type ChatThread, type ChatTurn } from '@shared/chat'
import { KIND_LABEL, resourceById, resourceWhere, searchResources } from '@shared/resources'
import { KIND_ICON, useOpenResource } from '../views/LibraryView'
import { todayISO } from '@shared/compliance'
import { formatElapsed, useDictation } from '../lib/useDictation'
import { api, errorMessage, relativeDay } from '../lib/util'
import { useCommand, useStore } from '../store'
import { AutoTextarea, CopyButton, Segmented } from './ui'

/** The chat last open for each client this session, so leaving the tab and coming back returns to it. */
const lastOpen = new Map<string, string | null>()

interface Live {
  threadId: string
  thinking: string
  text: string
}

/** A consultation chat with Claude about one client. Private, and never part of the record. */
export function AskClaude({ client }: { client: Client }) {
  const { settings, saveSettings, notes, toast } = useStore()
  const [list, setList] = useState<ChatSummary[]>([])
  const [listed, setListed] = useState(false)
  const [thread, setThread] = useState<ChatThread | null>(null)
  // Coming back to a chat: hold the welcome screen until it loads, so it doesn't flash.
  const [opening, setOpening] = useState(() => !!lastOpen.get(client.id))
  const [model, setModel] = useState(settings.chatModel)
  const [draft, setDraft] = useState('')
  const [live, setLive] = useState<Live | null>(null)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ notes: number; cost: number } | null>(null)
  const [picker, setPicker] = useState(false)
  const openResource = useOpenResource()
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const pinned = useRef(true)
  const lastTop = useRef(0)
  const threadRef = useRef(thread)
  threadRef.current = thread

  const refreshList = useCallback(
    () =>
      void api()
        .listChats(client.id)
        .then((l) => {
          setList(l)
          setListed(true)
        }),
    [client.id]
  )

  const open = useCallback(
    async (id: string | null) => {
      lastOpen.set(client.id, id)
      setError('')
      setLive(null)
      pinned.current = true
      const next = id ? await api().getChat(id) : null
      setThread(next)
      setOpening(false)
      if (next) setModel(next.model)
      input.current?.focus()
    },
    [client.id]
  )

  useEffect(() => {
    refreshList()
    void open(lastOpen.get(client.id) ?? null)
  }, [client.id, refreshList, open])

  useEffect(() => {
    if (thread) return
    let current = true
    api()
      .chatPreview(client.id, model)
      .then((p) => current && setPreview(p))
      .catch(() => {})
    return () => {
      current = false
    }
  }, [client.id, model, thread])

  useEffect(
    () =>
      api().onChat((event) => {
        if (event.threadId !== threadRef.current?.id) {
          if (event.type === 'done' || event.type === 'error') refreshList()
          return
        }
        if (event.type === 'done' || event.type === 'error') {
          setLive(null)
          if (event.thread) setThread(event.thread)
          if (event.type === 'error') setError(event.message)
          refreshList()
          return
        }
        const { type, text } = event
        setLive((l) => {
          const base = l?.threadId === event.threadId ? l : { threadId: event.threadId, thinking: '', text: '' }
          return { ...base, [type]: base[type] + text }
        })
      }),
    [refreshList]
  )

  // Follow the reply as it streams, unless the clinician has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [thread, live])

  const busy = !!live
  const send = async (text: string, retry = false) => {
    if (busy || (!retry && !text.trim())) return
    setError('')
    pinned.current = true
    try {
      const next = await api().sendChat(client.id, thread?.id ?? null, text, model, retry)
      setThread(next)
      setLive({ threadId: next.id, thinking: '', text: '' })
      lastOpen.set(client.id, next.id)
      if (!retry) setDraft('')
      refreshList()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const dictation = useDictation(
    (text) => setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text)),
    (message) => toast(message, 'error'),
    settings.liveCoverage
  )
  useCommand('record', dictation.toggle)
  useCommand('generate', () => void send(draft))

  const chooseModel = async (id: string) => {
    setModel(id)
    // The choice carries over to new chats.
    void saveSettings({ chatModel: id })
    if (thread) setThread(await api().setChatModel(thread.id, id))
  }

  const removeChat = async (id: string) => {
    if (!window.confirm('Delete this chat? This cannot be undone.')) return
    await api().deleteChat(id)
    if (thread?.id === id) void open(null)
    refreshList()
  }

  const removeAll = async () => {
    if (!window.confirm(`Delete all ${list.length} chats about ${client.name}? This cannot be undone.`)) return
    const n = await api().deleteAllChats(client.id)
    void open(null)
    refreshList()
    toast(`Deleted ${n} ${n === 1 ? 'chat' : 'chats'}`)
  }

  const finalized = notes.filter((n) => n.clientId === client.id && n.status === 'final')
  const unseen = thread ? finalized.filter((n) => !thread.noteIds.includes(n.id)).length : 0
  const first = client.name.trim().split(/\s+/)[0]
  const last = thread?.turns[thread.turns.length - 1]
  const cost = thread ? threadCost(thread) : 0
  const modelLabel = (id?: string) => CHAT_MODELS.find((m) => m.id === id)?.label ?? id ?? ''

  return (
    <div className="ask">
      <aside className="ask-rail">
        <button className={`ask-new ${!thread ? 'on' : ''}`} onClick={() => void open(null)}>
          <MessageSquarePlus size={15} /> New chat
        </button>
        <div className="ask-list">
          {list.map((t) => (
            <div key={t.id} className={`ask-item ${thread?.id === t.id ? 'on' : ''}`} onClick={() => void open(t.id)} role="button" tabIndex={0}>
              <span className="ask-item-title">{t.title}</span>
              <span className="ask-item-meta">
                {relativeDay(t.updatedAt.slice(0, 10), todayISO())} · {modelLabel(t.model)}
              </span>
              <button className="icon-btn ask-item-del" onClick={(e) => (e.stopPropagation(), void removeChat(t.id))} aria-label="Delete chat" title="Delete chat">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {listed && list.length === 0 && <p className="rail-empty">Chats you start are saved here, encrypted with the rest of Echo’s data.</p>}
        </div>
        {list.length > 0 && (
          <button className="ask-clear" onClick={() => void removeAll()}>
            <Trash2 size={13} /> Delete all chats
          </button>
        )}
      </aside>

      <section className="ask-main">
        <header className="ask-head">
          <div className="ask-title" style={opening ? { visibility: 'hidden' } : undefined}>
            <h3>{thread?.title ?? 'New chat'}</h3>
            <span className="ask-seen">
              <Lock size={11} />
              {thread
                ? `Claude sees the plan, context and ${thread.seen.notes} ${thread.seen.notes === 1 ? 'note' : 'notes'} as of ${relativeDay(thread.seen.asOf.slice(0, 10), todayISO()).toLowerCase()}`
                : `Claude will see the plan, context and ${preview?.notes ?? finalized.length} finalized ${finalized.length === 1 ? 'note' : 'notes'}`}
              {' · name removed · not part of the record'}
              {cost > 0 && ` · ${formatCost(cost)} so far`}
            </span>
          </div>
          <Segmented value={model} options={CHAT_MODELS.map((m) => ({ value: m.id, label: m.label }))} onChange={(v) => void chooseModel(v)} />
        </header>

        <div
          className="ask-scroll"
          ref={scroller}
          onClick={(e) => {
            const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-res]')
            if (chip?.dataset.res) openResource(chip.dataset.res)
          }}
          onWheel={(e) => {
            if (e.deltaY < 0) pinned.current = false
          }}
          onScroll={(e) => {
            // Any move up lets the clinician read; reaching the bottom again resumes following.
            const el = e.currentTarget
            if (el.scrollTop < lastTop.current - 1) pinned.current = false
            else if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) pinned.current = true
            lastTop.current = el.scrollTop
          }}
        >
          <div className="ask-thread">
            {!thread && !opening && (
              <div className="ask-welcome">
                <div className="ask-mark">
                  <Sparkles size={22} />
                </div>
                <h2>Think through {first}’s care with Claude</h2>
                <p className="muted">
                  Claude reads {first}’s treatment plan, clinical context and every finalized note, with the name removed, and knows your Library, so it can point you to a measure, metaphor or worksheet. The scratchpad is never included.
                  {preview && preview.notes > 0 && ` Starting a chat reads the full record once (about ${formatCost(preview.cost)} on ${modelLabel(model)}); follow-ups cost a little each.`}
                </p>
                <div className="ask-starters">
                  {CHAT_STARTERS.map((s) => (
                    <button key={s.label} onClick={() => void send(s.prompt)} disabled={busy}>
                      <span>{s.label}</span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {thread?.turns.map((turn) => <Turn key={turn.id} turn={turn} modelLabel={modelLabel(turn.model)} />)}

            {live && (
              <div className="ask-msg assistant">
                <div className="ask-by">
                  <Sparkles size={12} /> {modelLabel(model)}
                </div>
                {live.thinking && !live.text && <p className="ask-thinking-live">{lastLine(live.thinking)}</p>}
                {live.text ? (
                  <div className="ask-body" dangerouslySetInnerHTML={{ __html: chatToHtml(live.text) }} />
                ) : (
                  <div className="ask-wait">
                    <span />
                    <span />
                    <span />
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="ask-error">
                <span>{error}</span>
                {last?.role === 'user' && (
                  <button className="link" onClick={() => void send('', true)}>
                    Try again
                  </button>
                )}
              </div>
            )}

            {!live && last?.role === 'assistant' && (
              <div className="ask-actions">
                <CopyButton text={last.text} html={chatToHtml(last.text)} />
                <button className="btn btn-ghost btn-sm" onClick={() => void send('', true)} title="Ask Claude to answer the last question again">
                  <RotateCcw size={13} />
                  <span>Answer again</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <footer className="ask-compose-wrap">
          {unseen > 0 && (
            <p className="ask-notice">
              {unseen === 1 ? 'A note was' : `${unseen} notes were`} finalized since this chat started. {unseen === 1 ? 'It goes' : 'They go'} to Claude with your next message.
            </p>
          )}
          {picker && (
            <ResourcePicker
              onPick={(id) => {
                setPicker(false)
                setDraft((d) => `${d.trimEnd()}${d.trim() ? ' ' : ''}[[r:${id}]] `)
                input.current?.focus()
              }}
              onClose={() => setPicker(false)}
            />
          )}
          <div className={`ask-compose ${dictation.state === 'recording' ? 'rec' : ''}`}>
            <AutoTextarea
              ref={input}
              value={draft + (dictation.heard ? `${draft.trim() ? ' ' : ''}${dictation.heard}` : '')}
              minRows={1}
              placeholder={thread ? 'Reply…' : `Ask about ${first}…`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send(draft)
                }
              }}
              autoFocus
            />
            <div className="ask-compose-tools">
              <button className={`icon-btn ask-lib ${picker ? 'on' : ''}`} onClick={() => setPicker((v) => !v)} title="Attach a resource from the Library" aria-label="Attach a resource">
                <BookOpen size={16} />
              </button>
              <button
                className={`icon-btn ask-mic ${dictation.state === 'recording' ? 'rec' : ''}`}
                onClick={dictation.toggle}
                disabled={dictation.state === 'starting'}
                title={dictation.state === 'recording' ? 'Stop dictation (⌘R)' : 'Dictate (⌘R). Transcribed on this Mac.'}
                aria-label={dictation.state === 'recording' ? 'Stop dictation' : 'Dictate'}
              >
                {dictation.state === 'starting' || dictation.pending > 0 ? <Loader2 size={16} className="spin" /> : <Mic size={16} />}
                {dictation.state === 'recording' && <span className="ask-elapsed">{formatElapsed(dictation.elapsed)}</span>}
              </button>
              {busy ? (
                <button className="ask-send stop" onClick={() => thread && api().stopChat(thread.id)} aria-label="Stop" title="Stop">
                  <Square size={12} fill="currentColor" />
                </button>
              ) : (
                <button className="ask-send" onClick={() => void send(draft)} disabled={!draft.trim()} aria-label="Send" title="Send (↵)">
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
          <p className="ask-hint">↵ to send · ⇧↵ new line · ⌘R to dictate · Claude can be wrong; you make the clinical calls.</p>
        </footer>
      </section>
    </div>
  )
}

function Turn({ turn, modelLabel }: { turn: ChatTurn; modelLabel: string }) {
  const [showThinking, setShowThinking] = useState(false)
  if (turn.role === 'user') {
    return (
      <div className="ask-msg user">
        {turn.addedNotes && <span className="ask-added">+ {turn.addedNotes} new {turn.addedNotes === 1 ? 'note' : 'notes'} shared</span>}
        <div className="ask-bubble">
          {splitResourceTokens(turn.text).map((part, i) => {
            if ('text' in part) return part.text
            const r = resourceById(part.id)
            return (
              <button key={i} type="button" className="res-chip on-accent" data-res={part.id}>
                {r ? r.title : 'resource not found'}
              </button>
            )
          })}
        </div>
      </div>
    )
  }
  return (
    <div className="ask-msg assistant">
      <div className="ask-by">
        <Sparkles size={12} /> {modelLabel}
        {turn.thinking && (
          <button className={`ask-thought-toggle ${showThinking ? 'open' : ''}`} onClick={() => setShowThinking((v) => !v)}>
            <ChevronRight size={12} /> Thought process
          </button>
        )}
      </div>
      {showThinking && turn.thinking && <div className="ask-thought">{turn.thinking}</div>}
      <div className="ask-body" dangerouslySetInnerHTML={{ __html: chatToHtml(turn.text) }} />
      {turn.stopped && <p className="ask-stopped">Stopped before Claude finished.</p>}
    </div>
  )
}

/** Search the Library and attach a resource to the message. */
function ResourcePicker({ onPick, onClose }: { onPick(id: string): void; onClose(): void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const results = searchResources(query).slice(0, 40)
  useEffect(() => setActive(0), [query])
  return (
    <div className="res-picker" onMouseDown={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find a worksheet, measure, metaphor…"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          else if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, results.length - 1)))
          else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)))
          else if (e.key === 'Enter' && results[active]) (e.preventDefault(), onPick(results[active].id))
        }}
      />
      <div className="res-picker-list">
        {results.map((r, i) => {
          const Icon = KIND_ICON[r.kind]
          return (
            <button key={r.id} className={i === active ? 'on' : ''} onMouseEnter={() => setActive(i)} onClick={() => onPick(r.id)}>
              <Icon size={14} />
              <span className="res-picker-title">{r.title}</span>
              <span className="res-picker-meta">{[KIND_LABEL[r.kind], r.topic, resourceWhere(r)].filter(Boolean).join(' · ')}</span>
            </button>
          )
        })}
        {results.length === 0 && <p className="rail-empty">Nothing matches.</p>}
      </div>
    </div>
  )
}

/** The newest line of the reasoning summary, shown while Claude thinks. */
function lastLine(text: string): string {
  const lines = text.trim().split('\n').filter((l) => l.trim())
  return (lines[lines.length - 1] ?? '').replace(/^[#*\s]+|\*+$/g, '')
}
