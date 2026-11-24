import { useState } from 'react'
import type { Client } from '@shared/types'
import type { Ehr } from '@shared/ehr'
import { Avatar, Button, Modal } from './ui'

/**
 * Before the Navigator charts a batch: the clients it can't place yet because no EHR is chosen for them.
 * Each choice is remembered for the client. Skipping one leaves their notes out of this batch.
 */
export function ChooseEhrModal({ clients, ehrs, onCancel, onDone }: { clients: Client[]; ehrs: Ehr[]; onCancel(): void; onDone(choices: Map<string, string>): void }) {
  const [choice, setChoice] = useState<Record<string, string>>({})
  const chosen = clients.filter((c) => choice[c.id]).length
  const skip = '__skip'
  const ready = clients.every((c) => choice[c.id])
  const skipping = clients.some((c) => choice[c.id] === skip)
  return (
    <Modal
      title="Which EHR is each client in?"
      onClose={onCancel}
      width={520}
      footer={
        <>
          <span className="muted small grow">{ready ? '' : `${clients.length - chosen} left to choose`}</span>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => onDone(new Map(clients.flatMap((c) => (choice[c.id] && choice[c.id] !== skip ? [[c.id, choice[c.id]] as [string, string]] : []))))}
          >
            {skipping ? 'Continue without the skipped' : 'Continue'}
          </Button>
        </>
      }
    >
      <p className="muted small">The Navigator needs to know where these clients are charted. Echo remembers your choice for each one.</p>
      <div className="choose-ehr-list">
        {clients.map((c) => (
          <label key={c.id} className="choose-ehr-row">
            <Avatar id={c.id} name={c.name} size={24} />
            <b className="grow">{c.name}</b>
            <select value={choice[c.id] ?? ''} onChange={(e) => setChoice((x) => ({ ...x, [c.id]: e.target.value }))} autoFocus={c === clients[0]}>
              <option value="" disabled>
                Choose an EHR…
              </option>
              {ehrs.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
              <option value={skip}>Skip for now</option>
            </select>
          </label>
        ))}
      </div>
    </Modal>
  )
}
