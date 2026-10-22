import { useState } from 'react'
import { ArrowRight, Lock, Mic, Sparkles, ClipboardCheck } from 'lucide-react'
import type { NoteFormat } from '@shared/types'
import { useStore } from '../store'
import { Button, Field, Segmented } from '../components/ui'

export function Onboarding() {
  const { saveSettings, setApiKey, settings } = useStore()
  const [name, setName] = useState(settings.clinicianName)
  const [credentials, setCredentials] = useState(settings.credentials)
  const [format, setFormat] = useState<NoteFormat>(settings.noteFormat)
  const [key, setKey] = useState('')

  const finish = async () => {
    if (key.trim()) await setApiKey(key)
    await saveSettings({ clinicianName: name.trim(), credentials: credentials.trim(), noteFormat: format, onboarded: true })
  }

  return (
    <div className="onboarding">
      <div className="drag onboarding-drag" />
      <div className="onboarding-card">
        <div className="brand-mark lg">e</div>
        <h1 className="display">Welcome to Echo</h1>
        <p className="lede">Talk through the session. Paste a finished, audit-ready note into your EHR.</p>
        <div className="flow">
          <span>
            <Mic size={15} /> Dictate
          </span>
          <ArrowRight size={14} />
          <span>
            <Sparkles size={15} /> Echo writes
          </span>
          <ArrowRight size={14} />
          <span>
            <ClipboardCheck size={15} /> Copy to EHR
          </span>
        </div>
        <div className="form">
          <div className="settings-grid">
            <Field label="Your name">
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Rivera" />
            </Field>
            <Field label="Credentials">
              <input value={credentials} onChange={(e) => setCredentials(e.target.value)} placeholder="LCSW" />
            </Field>
          </div>
          <Field label="Progress note format">
            <Segmented<NoteFormat>
              value={format}
              onChange={setFormat}
              options={[
                { value: 'SOAP', label: 'SOAP' },
                { value: 'DAP', label: 'DAP' },
                { value: 'BIRP', label: 'BIRP' },
                { value: 'Narrative', label: 'Narrative' }
              ]}
            />
          </Field>
          <Field label="Anthropic API key" hint="From your HIPAA-configured Anthropic organization, the one your BAA covers. You can add it later in Settings.">
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={settings.hasApiKey ? 'Saved' : 'sk-ant-…'} />
          </Field>
        </div>
        <Button variant="primary" size="lg" onClick={finish}>
          Get started
        </Button>
        <p className="fine-print center">
          <Lock size={11} /> Your data stays on this Mac, encrypted. Dictation is transcribed on this Mac, and client names are removed before notes are written.
        </p>
      </div>
    </div>
  )
}
