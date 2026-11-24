import type { Client, Note, Settings } from '@shared/types'
import { auditChecks } from '@shared/compliance'
import { usableEhrs } from '@shared/ehr'
import { chartStatus } from '@shared/queue'
import { finalizeNow } from './finalizeNote'
import type { useStore } from '../store'

type Store = ReturnType<typeof useStore>

export const PLACE_ALL_TITLE =
  'The Navigator finalizes any drafts and checks you’re signed in to each EHR, then places each note in its own Chrome tab, one after another, so you can step away. Nothing is signed: you review and sign each one.'

/**
 * The notes the Navigator can chart on its own, in order: not yet in the EHR and not being rewritten. Drafts count:
 * placing finalizes them first, as placing one note does. A client without an EHR chosen counts too: they're asked
 * for before the Navigator starts (clientsWithoutEhr).
 */
export function notesToPlace(notes: Note[], clientById: Map<string, Client>, settings: Settings & { mockAI?: boolean }, jobs: Record<string, unknown>): Note[] {
  if (!settings.placeWithClaude || settings.mockAI || !usableEhrs(settings.ehrs).length) return []
  return notes.filter((n) => {
    const c = clientById.get(n.clientId)
    return !!c && chartStatus(n) !== 'done' && !jobs[n.id]
  })
}



/**
 * Finalizes any drafts (asking once if audit checks fail), then has the Navigator place every note, one after another.
 * ehrIds: the EHR just chosen for clients that had none (clientsWithoutEhr in @shared/ehr), saved for each before their drafts are finalized (which saves the client too).
 */
export async function placeAll(store: Store, notes: Note[], ehrIds?: Map<string, string>): Promise<void> {
  const clients = new Map(store.clients.map((c) => [c.id, c]))
  for (const [id, ehrId] of ehrIds ?? []) {
    const c = clients.get(id)
    if (!c) continue
    const next = { ...c, ehrId }
    clients.set(id, next)
    store.saveClient(next)
  }
  const flagged = notes.filter((n) => n.status === 'draft' && auditChecks(n, clients.get(n.clientId)!).some((c) => c.level === 'error'))
  if (flagged.length) {
    const lines = flagged.map((n) => {
      const c = clients.get(n.clientId)!
      return `${c.name}: ${auditChecks(n, c)
        .filter((x) => x.level === 'error')
        .map((x) => x.label)
        .join('; ')}`
    })
    if (!window.confirm(`Audit checks:\n${lines.join('\n')}\n\nFinalize and place anyway?`)) return
  }
  const ids: string[] = []
  for (const n of notes) {
    if (n.status === 'draft') {
      // One client's notes finalize in turn, each on top of the last one's changes.
      const done = await finalizeNow(store, n, clients.get(n.clientId)!)
      clients.set(done.client.id, done.client)
    }
    ids.push(n.id)
  }
  // The focused view. Only the EHR each note needs is opened, beside Echo, when that note's turn comes.
  if (!store.charting) store.startCharting(ids[0])
  await store.placeNotes(ids)
}
