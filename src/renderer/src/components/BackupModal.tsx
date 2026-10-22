import { useState } from 'react'
import { errorMessage } from '../lib/util'
import { useStore } from '../store'
import { Button, Field, Modal } from './ui'

export function BackupModal({ mode, onClose }: { mode: 'export' | 'import'; onClose(): void }) {
  const { toast, replaceState } = useStore()
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const valid = mode === 'import' ? pass.length > 0 : pass.length >= 8 && pass === confirm

  const run = async () => {
    setBusy(true)
    try {
      if (mode === 'export') {
        const path = await window.echo.exportBackup(pass)
        if (path) toast('Encrypted backup saved', 'success')
      } else {
        const state = await window.echo.importBackup(pass)
        if (state) {
          replaceState(state)
          toast('Backup restored', 'success')
        }
      }
      onClose()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={mode === 'export' ? 'Export encrypted backup' : 'Restore from backup'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={mode === 'import' ? 'danger' : 'primary'} disabled={!valid || busy} onClick={run}>
            {mode === 'export' ? 'Choose location…' : 'Choose backup & restore…'}
          </Button>
        </>
      }
    >
      <div className="form">
        <p className="muted">
          {mode === 'export'
            ? 'Creates a single file with all clients, notes, and plans, encrypted with your passphrase. Store it somewhere safe; without the passphrase it cannot be opened.'
            : 'Replaces everything in Echo with the contents of the backup. Echo also keeps 14 days of encrypted daily snapshots in its data folder.'}
        </p>
        <Field label="Passphrase" hint={mode === 'export' ? 'At least 8 characters.' : undefined}>
          <input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
        </Field>
        {mode === 'export' && (
          <Field label="Confirm passphrase">
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  )
}
