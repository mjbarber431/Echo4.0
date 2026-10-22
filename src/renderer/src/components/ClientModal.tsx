import { useState } from 'react'
import type { Client, Diagnosis, SessionSetting } from '@shared/types'
import { DEFAULT_CLIENT_SETTING, SETTING_LABEL } from '@shared/compliance'
import { useStore } from '../store'
import { DiagnosisPicker } from './DiagnosisPicker'
import { Button, Field, Modal, Segmented } from './ui'

export type ClientStart = 'intake' | 'existing'

/** Create or edit a client. Deliberately minimal: a name is all that's required. */
export function ClientModal({ client, initialName = '', onClose, onCreated }: {
  client?: Client
  initialName?: string
  onClose(): void
  onCreated?(client: Client, start: ClientStart): void
}) {
  const { createClient, saveClient } = useStore()
  const [name, setName] = useState(client?.name ?? initialName)
  const [pronouns, setPronouns] = useState(client?.pronouns ?? '')
  const [setting, setSetting] = useState<SessionSetting>(client?.setting ?? DEFAULT_CLIENT_SETTING)
  const [diagnoses, setDiagnoses] = useState<Diagnosis[]>(client?.diagnoses ?? [])
  const [start, setStart] = useState<ClientStart>('intake')

  const submit = () => {
    if (!name.trim()) return
    if (client) {
      saveClient({ ...client, name: name.trim(), pronouns: pronouns.trim(), setting, diagnoses })
      onClose()
      return
    }
    const created = createClient({ name, pronouns, setting, diagnoses })
    onClose()
    onCreated?.(created, start)
  }

  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  return (
    <Modal
      title={client ? 'Edit client' : 'New client'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={submit}>
            {client ? 'Save' : 'Add client'}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Name" hint="Shown only in Echo. The name is stripped from anything sent to the AI for writing.">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={submitOnEnter} placeholder="e.g. Jordan M." />
        </Field>
        <Field label="Pronouns (optional)">
          <input value={pronouns} onChange={(e) => setPronouns(e.target.value)} onKeyDown={submitOnEnter} placeholder="she/her, he/him, they/them…" />
        </Field>
        <Field label="Sessions">
          <select value={setting} onChange={(e) => setSetting(e.target.value as SessionSetting)}>
            {Object.entries(SETTING_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Diagnosis (optional)" hint={client ? undefined : 'Optional. The intake’s diagnosis replaces it when you finalize.'}>
          <DiagnosisPicker value={diagnoses} onChange={setDiagnoses} />
        </Field>
        {!client && (
          <Field label="Start with">
            <Segmented<ClientStart>
              value={start}
              onChange={setStart}
              options={[
                { value: 'intake', label: 'Intake (90791)' },
                { value: 'existing', label: 'Existing client' }
              ]}
            />
            <span className="field-hint">
              {start === 'intake'
                ? 'Opens an intake note. The treatment plan is drafted from it.'
                : 'Dictate a quick background and the goals you’re working on. Echo drafts the treatment plan and clinical context.'}
            </span>
          </Field>
        )}
      </div>
    </Modal>
  )
}
