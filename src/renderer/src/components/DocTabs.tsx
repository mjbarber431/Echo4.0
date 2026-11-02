import { useState } from 'react'
import { openingSection, type ClientDocument, type DocSection } from '@shared/documents'

/**
 * The tab on screen in a document made from a Library resource with several tabs,
 * and the pages the editor shows for it. Starts on `initial`, else the real content.
 */
export function useDocTab(doc: ClientDocument | null | undefined, initial?: number): { sections: DocSection[]; index: number; setIndex(i: number): void; pages?: { start: number; count: number } } {
  const [tab, setTab] = useState<{ docId: string; index: number } | null>(null)
  const sections = doc?.sections && doc.sections.length > 1 ? doc.sections : []
  const index = tab && tab.docId === doc?.id && sections[tab.index] ? tab.index : initial !== undefined && sections[initial] ? initial : openingSection(sections)
  const section = sections[index]
  return {
    sections,
    index,
    setIndex: (i) => doc && setTab({ docId: doc.id, index: i }),
    pages: section ? { start: section.start, count: section.count } : undefined
  }
}

/** The document's tabs, in the main window and the presentation window alike. */
export function DocTabs({ sections, index, onPick }: { sections: DocSection[]; index: number; onPick(i: number): void }) {
  if (!sections.length) return null
  return (
    <nav className="viewer-parts doc-parts" aria-label="Parts of this document">
      {sections.map((s, i) => (
        <button key={i} className={i === index ? 'on' : ''} onClick={() => onPick(i)} title={`${s.label}: ${s.count === 1 ? `page ${s.start + 1}` : `pages ${s.start + 1}–${s.start + s.count}`}`}>
          {s.label}
        </button>
      ))}
    </nav>
  )
}
