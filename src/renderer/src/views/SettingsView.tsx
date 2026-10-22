import { useEffect, useState } from 'react'
import { Download, History, KeyRound, Loader2, PlugZap, ShieldCheck, Upload } from 'lucide-react'
import { TRANSCRIBE_MODELS, WRITING_MODELS, type NoteFormat, type ReasoningEffort, type Settings, type TranscriberStatus } from '@shared/types'
import { useStore } from '../store'
import { BackupModal } from '../components/BackupModal'
import { LegacyImportModal } from '../components/LegacyImportModal'
import { AutoTextarea, Button, Field, Segmented, Toggle } from '../components/ui'
import { IphoneSettings } from '../components/IphoneSettings'

export function SettingsView() {
  const { settings, saveSettings, setApiKey, toast } = useStore()
  const [key, setKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; message: string; models: string[] } | null>(null)
  const [touchId, setTouchId] = useState(false)
  const [backup, setBackup] = useState<'export' | 'import' | null>(null)
  const [legacyImport, setLegacyImport] = useState(false)
  const [instructions, setInstructions] = useState(settings.customInstructions)
  const [speech, setSpeech] = useState<TranscriberStatus | null>(null)
  const listed = WRITING_MODELS.some((m) => m.id === settings.textModel)
  const [customModel, setCustomModel] = useState(!listed)

  useEffect(() => {
    void window.echo.canUseTouchId().then(setTouchId)
    void window.echo.transcriberStatus().then(setSpeech)
    return window.echo.onTranscriber(setSpeech)
  }, [])

  const set = (patch: Partial<Settings>) => void saveSettings(patch)

  const runTest = async () => {
    setTesting(true)
    setTest(await window.echo.testConnection())
    setTesting(false)
  }

  return (
    <div className="page">
      <header className="page-head drag">
        <h1 className="page-title">Settings</h1>
      </header>
      <div className="settings">
        <section className="settings-group">
          <h2>You</h2>
          <div className="settings-grid">
            <Field label="Name">
              <input defaultValue={settings.clinicianName} onBlur={(e) => set({ clinicianName: e.target.value })} placeholder="Alex Rivera" />
            </Field>
            <Field label="Credentials">
              <input defaultValue={settings.credentials} onBlur={(e) => set({ credentials: e.target.value })} placeholder="LCSW" />
            </Field>
          </div>
        </section>

        <section className="settings-group">
          <h2>Notes</h2>
          <Field label="Progress note format">
            <Segmented<NoteFormat>
              value={settings.noteFormat}
              onChange={(noteFormat) => set({ noteFormat })}
              options={[
                { value: 'SOAP', label: 'SOAP' },
                { value: 'DAP', label: 'DAP' },
                { value: 'BIRP', label: 'BIRP' },
                { value: 'Narrative', label: 'Narrative' }
              ]}
            />
          </Field>
          <div className="settings-grid">
            <Field label="Usual session length" hint="Sets the default service code for new notes. 53+ minutes is 90837.">
              <div className="input-suffix">
                <input type="number" min={16} max={180} defaultValue={settings.sessionMinutes} onBlur={(e) => set({ sessionMinutes: Math.max(16, Number(e.target.value) || 55) })} />
                <span>min</span>
              </div>
            </Field>
            <Field label="Telehealth platform (optional)" hint="Named in telehealth notes, e.g. “HIPAA-compliant video platform”.">
              <input defaultValue={settings.telehealthPlatform} onBlur={(e) => set({ telehealthPlatform: e.target.value })} />
            </Field>
            <Field label="Treatment plan review every" hint="Check what your payers require. 90 days is common.">
              <div className="input-suffix">
                <input type="number" min={14} max={365} defaultValue={settings.planReviewDays} onBlur={(e) => set({ planReviewDays: Math.max(14, Number(e.target.value) || 90) })} />
                <span>days</span>
              </div>
            </Field>
          </div>
          <Field label="Your style preferences (optional)" hint="Sent with every note. e.g. “Use ‘client’ lowercase. Keep the plan section to 2–3 sentences. I mostly use ACT and IFS.”">
            <AutoTextarea value={instructions} minRows={3} onChange={(e) => setInstructions(e.target.value)} onBlur={() => instructions !== settings.customInstructions && set({ customInstructions: instructions })} />
          </Field>
        </section>

        <section className="settings-group">
          <h2>Copying to your EHR</h2>
          <Toggle checked={settings.includeHeader} onChange={(includeHeader) => set({ includeHeader })} label="Include session header" hint="Date, CPT, place of service, diagnosis. Turn off if your EHR already has those fields." />
          <Toggle checked={settings.includeSignature} onChange={(includeSignature) => set({ includeSignature })} label="Include clinician line" hint="Adds your name and credentials at the end. Sign in your EHR as usual." />
          <Field label="Section headings">
            <Segmented
              value={settings.headingStyle}
              onChange={(headingStyle) => set({ headingStyle })}
              options={[
                { value: 'caps', label: 'SUBJECTIVE:' },
                { value: 'title', label: 'Subjective:' }
              ]}
            />
          </Field>
        </section>

        <section className="settings-group">
          <h2>Claude</h2>
          {settings.mockAI && <p className="notice">Demo mode is on. Notes are generated by a built-in sample, and nothing is sent to Anthropic.</p>}
          <Field label="API key" hint={settings.hasApiKey ? 'A key is saved in Echo’s encrypted storage. Enter a new one to replace it.' : 'Use a key from your HIPAA-configured Anthropic organization, the one your BAA covers. Keys from any other organization aren’t covered.'}>
            <div className="row gap">
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={settings.hasApiKey ? '••••••••••••••••' : 'sk-ant-…'} className="grow" />
              <Button
                icon={<KeyRound size={14} />}
                disabled={!key.trim()}
                onClick={async () => {
                  await setApiKey(key)
                  setKey('')
                  toast('API key saved', 'success')
                }}
              >
                Save key
              </Button>
            </div>
          </Field>
          <div className="settings-grid">
            <Field label="Writing model" hint={(!customModel && WRITING_MODELS.find((m) => m.id === settings.textModel)?.hint) || 'Any Claude model ID. Test connection lists the ones your key can use.'}>
              <select
                value={customModel ? 'other' : settings.textModel}
                onChange={(e) => {
                  const other = e.target.value === 'other'
                  setCustomModel(other)
                  if (!other) set({ textModel: e.target.value })
                }}
              >
                {WRITING_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                <option value="other">Other…</option>
              </select>
              {customModel && (
                <input
                  key={settings.textModel}
                  defaultValue={listed ? '' : settings.textModel}
                  onBlur={(e) => e.target.value.trim().startsWith('claude-') && set({ textModel: e.target.value.trim() })}
                  list="model-list"
                  placeholder="claude-…"
                  autoFocus={listed}
                />
              )}
            </Field>
            <Field label="Effort" hint="Higher can be more thorough but is slower and costs more. “Default” lets the model decide: medium on Haiku and Opus, high on Sonnet.">
              <select value={settings.reasoningEffort} onChange={(e) => set({ reasoningEffort: e.target.value as ReasoningEffort })}>
                {(['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((r) => (
                  <option key={r} value={r}>
                    {r === 'xhigh' ? 'Extra high' : r[0].toUpperCase() + r.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Toggle
            checked={settings.liveCoverage}
            onChange={(liveCoverage) => set({ liveCoverage })}
            label="Live feedback while dictating (beta)"
            hint="Transcribes as you talk, straight into the text, and shows what the note still needs. The checks are sent to Claude Haiku every few seconds while you dictate, with the client’s name removed."
          />
          <datalist id="model-list">
            {test?.models.map((m) => <option key={m} value={m} />)}
          </datalist>
          <div className="row gap">
            <Button icon={testing ? <Loader2 size={14} className="spin" /> : <PlugZap size={14} />} onClick={runTest} disabled={testing || (!settings.hasApiKey && !settings.mockAI)}>
              Test connection
            </Button>
            {test && <span className={test.ok ? 'ok small' : 'error small'}>{test.message}</span>}
          </div>
          <p className="fine-print">
            Echo uses only Anthropic’s Messages API (with structured outputs and prompt caching) and Models API, the features the Anthropic BAA covers in a HIPAA-configured
            organization. The client’s name is replaced with “Client” in everything sent, and scratchpads are never sent. Anthropic retains requests according to your
            organization’s HIPAA configuration.
          </p>
        </section>

        <section className="settings-group">
          <h2>Transcription</h2>
          <Field label="Speech model" hint="Runs on this Mac’s Neural Engine. Audio never leaves your computer.">
            <select value={settings.transcribeModel} onChange={(e) => set({ transcribeModel: e.target.value })}>
              {TRANSCRIBE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          {speech && <p className={speech.state === 'error' ? 'error small' : 'fine-print'}>{speechStatus(speech)}</p>}
        </section>

        <IphoneSettings />

        <section className="settings-group">
          <h2>Privacy &amp; data</h2>
          <Toggle
            checked={settings.lockEnabled}
            disabled={!touchId}
            onChange={(lockEnabled) => set({ lockEnabled })}
            label="Lock with Touch ID"
            hint={touchId ? 'Locks when your Mac sleeps or locks, and after inactivity.' : 'Touch ID isn’t available on this Mac.'}
          />
          {settings.lockEnabled && (
            <Field label="Lock after">
              <div className="input-suffix">
                <input type="number" min={1} max={120} defaultValue={settings.lockMinutes} onBlur={(e) => set({ lockMinutes: Math.max(1, Number(e.target.value) || 10) })} />
                <span>minutes idle</span>
              </div>
            </Field>
          )}
          <p className="fine-print">
            <ShieldCheck size={12} /> Everything is stored on this Mac in a file encrypted with AES-256, with its key held in your macOS Keychain. Echo keeps 14 days of
            encrypted daily snapshots. Keep FileVault on.
          </p>
          <div className="row gap">
            <Button icon={<Download size={14} />} onClick={() => setBackup('export')}>
              Export encrypted backup
            </Button>
            <Button variant="ghost" icon={<Upload size={14} />} onClick={() => setBackup('import')}>
              Restore from backup
            </Button>
            <Button variant="ghost" icon={<History size={14} />} onClick={() => setLegacyImport(true)}>
              Import from previous Echo
            </Button>
          </div>
        </section>
      </div>
      {backup && <BackupModal mode={backup} onClose={() => setBackup(null)} />}
      {legacyImport && <LegacyImportModal onClose={() => setLegacyImport(false)} />}
    </div>
  )
}

function speechStatus(s: TranscriberStatus): string {
  if (s.state === 'ready') return 'Ready.'
  // FluidAudio reports this phase while checking cached files too, so it isn't always a real download.
  if (s.state === 'downloading') return `Getting the speech model ready (the first time, this downloads about 450 MB)… ${Math.round(s.progress * 100)}%`
  if (s.state === 'loading') return 'Loading the speech model…'
  if (s.state === 'error') return `The speech model couldn’t load: ${s.message}`
  return 'The speech model loads when Echo starts.'
}
