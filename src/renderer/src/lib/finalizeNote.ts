import type { Client, Note } from '@shared/types'
import { auditChecks } from '@shared/compliance'
import { finalizeClient } from '@shared/finalize'
import { noteToHtml, noteToText } from '@shared/format'
import { api, nowISO, uid } from './util'
import type { useStore } from '../store'

type Store = ReturnType<typeof useStore>

/** Puts the note on the clipboard the way the EHR takes it, and records when. Returns the saved note. */
export async function copyNote(store: Store, note: Note, client: Client): Promise<Note> {
  await api().copy(noteToText(note, client, store.settings), noteToHtml(note, client, store.settings))
  const next = { ...note, copiedAt: nowISO() }
  await store.saveNote(next)
  return next
}

/**
 * Finalizes the note: the client's goals and clinical context take its updates, and a discharge summary discharges them.
 * Asks first if an audit check fails. Returns the saved note, or null if the clinician backed out.
 */
export async function finalizeNote(store: Store, note: Note, client: Client, andCopy: boolean): Promise<Note | null> {
  const blocking = auditChecks(note, client).filter((c) => c.level === 'error')
  if (blocking.length && !window.confirm(`Audit check: ${blocking.map((c) => c.label).join('; ')}.\n\nFinalize anyway?`)) return null
  const now = nowISO()
  store.dismissJob(note.id)
  if (!note.finalizedAt) store.saveClient(finalizeClient(note, client, store.settings, uid, now))
  const next: Note = { ...note, status: 'final', finalizedAt: note.finalizedAt ?? now }
  await store.saveNote(next)
  return andCopy ? copyNote(store, next, client) : next
}

export const finalizedMessage = (note: Note) =>
  note.type === 'termination' ? 'Finalized and copied. Client moved to discharged.' : 'Finalized and copied. Plan and context updated.'
