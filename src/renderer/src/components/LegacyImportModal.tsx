import { useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Search } from 'lucide-react'
import type { LegacyClientSummary } from '@shared/legacy'
import { formatDateUS } from '@shared/compliance'
import { errorMessage } from '../lib/util'
import { useStore } from '../store'
import { Avatar, Button, Field, Modal } from './ui'

/** Import clients one at a time from a backup exported by the previous Echo app. */
export function LegacyImportModal({ onClose }: { onClose(): void }) {
  const { toast, addImported, navigate } = useStore()
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [rows, setRows] = useState<LegacyClientSummary[] | null>(null)
  const [query, setQuery] = useState('')

  // The decrypted backup lives in the main process only while this is open.
  useEffect(() => () => void window.echo.closeLegacyBackup(), [])

  const open = async () => {
    setBusy('open')
    try {
      const list = await window.echo.openLegacyBackup(pass)
      if (list) setRows(list)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const importClient = async (row: LegacyClientSummary) => {
    setBusy(row.id)
    try {
      const { clients, notes, report, summaries } = await window.echo.importLegacyClient(row.id)
      addImported(clients, notes)
      setRows(summaries)
      const parts = [report.notesAdded && `${report.notesAdded} note${report.notesAdded === 1 ? '' : 's'}`, report.plansAdded && 'treatment plan'].filter(Boolean)
      toast(parts.length ? `${row.name}: imported ${parts.join(' and ')}` : `${row.name} is already up to date`, 'success', {
        label: 'Open',
        run: () => (onClose(), navigate({ view: 'client', id: row.id }))
      })
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (rows ?? []).filter((r) => !q || r.name.toLowerCase().includes(q))
  }, [rows, query])

  if (!rows) {
    return (
      <Modal
        title="Import from previous Echo"
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!pass || !!busy} onClick={open} icon={busy ? <Loader2 size={14} className="spin" /> : undefined}>
              Choose backup…
            </Button>
          </>
        }
      >
        <div className="form">
          <p className="muted">
            In the previous Echo, open Settings and export a backup. Choose that file here, then pick which clients to bring over. Nothing is imported until you
            choose a client, and nothing already in this Echo is changed.
          </p>
          <Field label="Backup password" hint="The password you set when exporting from the previous Echo.">
            <input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pass && open()} />
          </Field>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title="Import from previous Echo"
      onClose={onClose}
      width={560}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="form">
        <p className="muted small">
          Notes arrive finalized, as history: they won’t appear on Queue. Contact details and date of birth go to the client’s scratchpad, which is never sent to
          the AI. Plan review dates start from when the plan was last updated, so older plans will show as due.
        </p>
        <div className="palette-input">
          <Search size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${rows.length} clients…`} autoFocus />
        </div>
        <div className="list-card">
          {shown.map((r) => (
            <div key={r.id} className="list-row">
              <Avatar id={r.id} name={r.name} size={26} />
              <div className="grow">
                <div>{r.name}</div>
                <div className="muted small">
                  {r.noteCount} note{r.noteCount === 1 ? '' : 's'}
                  {r.hasPlan && ' · plan'}
                  {r.lastSession && ` · last ${formatDateUS(r.lastSession)}`}
                  {r.nameMatch && ' · a client with this name is already here'}
                </div>
              </div>
              {r.imported && r.newNotes === 0 ? (
                <span className="chip chip-ok">
                  <Check size={12} /> Imported
                </span>
              ) : (
                <Button size="sm" variant={r.imported ? 'ghost' : 'secondary'} disabled={!!busy} onClick={() => importClient(r)} icon={busy === r.id ? <Loader2 size={14} className="spin" /> : undefined}>
                  {r.imported ? `Add ${r.newNotes} new note${r.newNotes === 1 ? '' : 's'}` : 'Import'}
                </Button>
              )}
            </div>
          ))}
          {shown.length === 0 && <div className="palette-empty">No matching clients.</div>}
        </div>
      </div>
    </Modal>
  )
}
