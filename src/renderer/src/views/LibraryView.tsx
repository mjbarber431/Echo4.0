import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ClipboardCheck, ExternalLink, FileAudio, FileText, FolderOpen, Image, Lightbulb, ListChecks, NotebookTabs, PlayCircle, Search, Sparkles } from 'lucide-react'
import { findResources, KIND_LABEL, RESOURCES, resourceWhere, TOPICS, type Resource, type ResourceKind } from '@shared/resources'
import { api } from '../lib/util'
import { useCommand, useStore } from '../store'
import { Button, Empty } from '../components/ui'

export const KIND_ICON: Record<ResourceKind, typeof FileText> = {
  assessment: ClipboardCheck,
  handout: FileText,
  worksheet: ListChecks,
  workbook: BookOpen,
  clinician: NotebookTabs,
  article: FileText,
  visual: Image,
  audio: FileAudio,
  exercise: Sparkles,
  metaphor: Lightbulb,
  protocol: NotebookTabs,
  video: PlayCircle
}

/** Opens a resource in Echo's viewer. */
export function useOpenResource(): (id: string) => void {
  return useStore().viewResource
}

/** The practice's worksheets, handouts and measures, plus ACBS resources. */
export function LibraryView() {
  const [query, setQuery] = useState('')
  const [topic, setTopic] = useState<string | null>(null)
  const [source, setSource] = useState<'all' | 'mine' | 'acbs'>('all')
  const [folder, setFolder] = useState<{ path: string; found: boolean } | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const open = useOpenResource()

  useEffect(() => void api().resourceFolder().then(setFolder), [])
  useCommand('find-in-library', () => search.current?.focus())

  const found = useMemo(() => {
    const filtered = RESOURCES.filter((r) => (!topic || r.topic === topic) && (source === 'all' || (source === 'acbs') === (r.source === 'acbs')))
    return findResources(query, filtered)
  }, [query, topic, source])
  const shown = found.items

  const groups = useMemo(() => {
    if (query.trim() && !shown.length) return []
    if (query.trim()) return [{ topic: found.partial ? `Nothing fits every word · ${shown.length} close ${shown.length === 1 ? 'match' : 'matches'}` : `${shown.length} ${shown.length === 1 ? 'match' : 'matches'}`, items: shown }]
    return TOPICS.map((t) => ({ topic: t, items: shown.filter((r) => r.topic === t) })).filter((g) => g.items.length)
  }, [shown, found.partial, query])

  const counts = useMemo(() => Object.fromEntries(TOPICS.map((t) => [t, RESOURCES.filter((r) => r.topic === t).length])), [])
  const local = RESOURCES.some((r) => r.path)

  return (
    <div className="page">
      <header className="page-head drag">
        <h1>Library</h1>
        <div className="lib-search no-drag">
          <Search size={14} />
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${RESOURCES.length} resources`}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            autoFocus
          />
        </div>
      </header>

      {local && folder && !folder.found && (
        <div className="lib-folder">
          <FolderOpen size={16} />
          <span>Echo needs your ClinicalResources folder to show your files and ACBS downloads. Choose it once and Echo remembers it.</span>
          <Button
            size="sm"
            onClick={async () => {
              const next = await api().chooseResourceFolder()
              if (next) setFolder(next)
            }}
          >
            Choose folder…
          </Button>
        </div>
      )}

      <div className="lib-filters">
        <button className={!topic ? 'on' : ''} onClick={() => setTopic(null)}>
          All
        </button>
        {TOPICS.map((t) => (
          <button key={t} className={topic === t ? 'on' : ''} onClick={() => setTopic(topic === t ? null : t)}>
            {t} <span>{counts[t]}</span>
          </button>
        ))}
        <span className="lib-filters-gap" />
        <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} aria-label="Source">
          <option value="all">All sources</option>
          <option value="mine">My files</option>
          <option value="acbs">ACBS</option>
        </select>
      </div>

      <div className="page-body">
        <div className="tab-content lib-body">
          {groups.length === 0 && (
            <Empty icon={<Search size={24} />} title="Nothing matches">
              <p>Try fewer words, or clear the topic filter.</p>
            </Empty>
          )}
          {groups.map((g) => (
            <section key={g.topic} className="lib-group">
              <h4 className="note-group-head">
                {g.topic}
                <span>{g.items.length}</span>
              </h4>
              <div className="lib-rows">
                {g.items.map((r) => (
                  <ResourceRow key={r.id} r={r} onOpen={() => open(r.id)} canReveal={!!folder?.found} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

function ResourceRow({ r, onOpen, canReveal }: { r: Resource; onOpen(): void; canReveal: boolean }) {
  const Icon = KIND_ICON[r.kind]
  const where = resourceWhere(r)
  return (
    <div className="lib-row" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <span className={`lib-icon kind-${r.kind}`}>
        <Icon size={15} />
      </span>
      <div className="lib-info">
        <div className="lib-title">{r.title}</div>
        <div className="lib-meta">
          {KIND_LABEL[r.kind]}
          {r.audience !== 'adults' && ` · ${r.audience[0].toUpperCase()}${r.audience.slice(1)}`}
          {where && ` · ${where}`}
          {r.parts && r.parts.length > 1 && ` · ${r.parts.length - (r.parts[0].label === 'Overview' ? 1 : 0)} files`}
          {r.note && <span className="lib-note"> · {r.note}</span>}
        </div>
      </div>
      <div className="lib-actions" onClick={(e) => e.stopPropagation()}>
        {!r.parts ? (
          <span className="lib-web" title="Opens on the web">
            <ExternalLink size={13} />
          </span>
        ) : (
          canReveal && (
            <button className="icon-btn" onClick={() => api().revealResource(r.id)} title="Show in Finder" aria-label="Show in Finder">
              <FolderOpen size={14} />
            </button>
          )
        )}
      </div>
    </div>
  )
}
