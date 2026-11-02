import { useEffect, useState } from 'react'
import { AppWindow, ArrowUpRight, Eye, FolderOpen, Globe, Layers, X } from 'lucide-react'
import { KIND_LABEL, partLabel, partUrl, resourceById, resourceWhere, type Resource, type ResourcePart } from '@shared/resources'
import { api, errorMessage } from '../lib/util'
import { useStore } from '../store'
import { KIND_ICON } from '../views/LibraryView'
import { Button } from './ui'
import { AssignToClient } from './Documents'
import { canAssign } from '@shared/documents'

const APP_FOR: Record<string, string> = { pdf: 'Preview', doc: 'Word', docx: 'Word', rtf: 'TextEdit', ppt: 'Keynote', pptx: 'Keynote', xls: 'Numbers', xlsx: 'Numbers', mp3: 'Music', m4a: 'Music' }
const extOf = (file: string) => file.split('.').pop()?.toLowerCase() ?? ''

/** Shows a Library resource inside Echo: PDFs, pages, Word files, slides, audio. */
export function ResourceViewer() {
  const { viewing, viewResource, toast } = useStore()
  const r = viewing ? resourceById(viewing) : undefined
  const [index, setIndex] = useState(0)

  // An ACBS resource opens on its first attachment, the real content; its page text is one tab away.
  useEffect(() => {
    const parts = viewing ? (resourceById(viewing)?.parts ?? []) : []
    setIndex(Math.max(0, parts.findIndex((p) => p.label !== 'Overview')))
  }, [viewing])
  useEffect(() => {
    if (!r) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && viewResource(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [r, viewResource])

  if (!r) return null
  const parts = r.parts ?? []
  const part = parts[index]
  const Icon = KIND_ICON[r.kind]
  const parent = r.parent ? resourceById(r.parent) : undefined
  const fail = (err: unknown) => toast(errorMessage(err), 'error')
  const original = part ? (part.original ?? part.file) : ''

  return (
    <div className="viewer-scrim" onMouseDown={(e) => e.target === e.currentTarget && viewResource(null)}>
      <aside className="viewer" role="dialog" aria-label={r.title}>
        <header className="viewer-head">
          <span className={`lib-icon kind-${r.kind}`}>
            <Icon size={15} />
          </span>
          <div className="viewer-title">
            <h2>{r.title}</h2>
            <div className="lib-meta">
              {[KIND_LABEL[r.kind], r.topic, r.source === 'acbs' ? 'ACBS' : resourceWhere(r)].filter(Boolean).join(' · ')}
            </div>
          </div>
          <div className="viewer-actions">
            {canAssign(r) && <AssignToClient resourceId={r.id} />}
            {parent && (
              <Button size="sm" variant="ghost" icon={<Layers size={14} />} onClick={() => viewResource(parent.id)} title={`Open all of ${parent.title}`}>
                Whole document
              </Button>
            )}
            {part && (part.format !== 'html' || part.original) && (
              <Button size="sm" variant="ghost" icon={<AppWindow size={14} />} onClick={() => api().openResourceApp(r.id, index).catch(fail)} title="Open the original file">
                Open in {APP_FOR[extOf(original)] ?? 'app'}
              </Button>
            )}
            {part && (
              <button className="icon-btn" onClick={() => api().revealResource(r.id)} title="Show in Finder" aria-label="Show in Finder">
                <FolderOpen size={15} />
              </button>
            )}
            {r.url && (
              <button className="icon-btn" onClick={() => api().openResourceWeb(r.id).catch(fail)} title={r.source === 'acbs' ? 'Open on contextualscience.org' : 'Open the website'} aria-label="Open on the web">
                <Globe size={15} />
              </button>
            )}
            <button className="icon-btn" onClick={() => viewResource(null)} aria-label="Close" title="Close (Esc)">
              <X size={16} />
            </button>
          </div>
        </header>

        {parts.length > 1 && (
          <nav className="viewer-parts">
            {parts.map((p, i) => (
              <button key={i} className={i === index ? 'on' : ''} onClick={() => setIndex(i)} title={p.label}>
                {partLabel(p)}
                {p.format !== 'html' && <span>{extOf(p.original ?? p.file)}</span>}
              </button>
            ))}
          </nav>
        )}

        <div className="viewer-body">
          {part ? <PartView key={`${r.id}-${index}`} r={r} part={part} index={index} onQuickLook={() => api().quickLookResource(r.id, index).catch(fail)} /> : <WebOnly r={r} onOpen={() => api().openResourceWeb(r.id).catch(fail)} />}
        </div>
      </aside>
    </div>
  )
}

function PartView({ r, part, index, onQuickLook }: { r: Resource; part: ResourcePart; index: number; onQuickLook(): void }) {
  const src = partUrl(r.id, index)
  switch (part.format) {
    case 'pdf':
      return <iframe className="viewer-frame" src={src} title={part.label} />
    case 'html':
      // No scripts; links open in the browser.
      return <iframe className="viewer-frame page" src={src} title={part.label} sandbox="allow-popups allow-popups-to-escape-sandbox" />
    case 'image':
      return (
        <div className="viewer-media">
          <img src={src} alt={part.label} />
        </div>
      )
    case 'audio':
      return (
        <div className="viewer-media audio">
          <p>{part.label.replace(/\.[a-z0-9]+$/i, '')}</p>
          <audio controls src={src} />
        </div>
      )
    case 'office':
      return (
        <div className="viewer-media office">
          {part.thumb ? <img src={partUrl(r.id, index, true)} alt={`First page of ${part.label}`} /> : <p className="muted">No preview of this file yet.</p>}
          <Button variant="primary" icon={<Eye size={15} />} onClick={onQuickLook}>
            Preview every page
          </Button>
        </div>
      )
    default:
      return (
        <div className="viewer-media">
          <p className="muted">Echo can’t show this kind of file. Open it in its app instead.</p>
        </div>
      )
  }
}

function WebOnly({ r, onOpen }: { r: Resource; onOpen(): void }) {
  return (
    <div className="viewer-media web">
      {r.note && <p>{r.note}</p>}
      <p className="muted">{r.source === 'acbs' ? 'This ACBS resource has no attachment; its content is on the ACBS page.' : 'This is a website rather than a document.'}</p>
      <Button variant="primary" icon={<ArrowUpRight size={15} />} onClick={onOpen}>
        Open {r.source === 'acbs' ? 'on contextualscience.org' : 'the website'}
      </Button>
    </div>
  )
}
