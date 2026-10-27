import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileDown, ImagePlus, Trash2 } from 'lucide-react'
import type { Client } from '@shared/types'
import { todayISO } from '@shared/compliance'
import { letterToDocumentHtml, signerLabel, type Letter, type Letterhead } from '@shared/letter'
import { errorMessage } from '../lib/util'
import { useStore } from '../store'
import { AutoTextarea, Button, Field, Modal } from './ui'

/** Writes a letter on the practice letterhead, with a live preview of the page, and saves it as a PDF. */
export function LetterModal({ client, onClose }: { client: Client; onClose(): void }) {
  const { settings, toast } = useStore()
  const [letterhead, setLetterhead] = useState<Letterhead | null>(null)
  const [setup, setSetup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [letter, setLetter] = useState<Letter>({
    date: todayISO(),
    recipient: '',
    subject: client.name,
    salutation: 'To whom it may concern,',
    body: '',
    closing: 'Sincerely,',
    signerIds: []
  })
  const loaded = useRef(false)

  useEffect(() => {
    void window.echo.getLetterhead().then((lh) => {
      setLetterhead(lh)
      // Signed by whoever is using Echo, if they're one of the signers.
      const me = lh.signers.find((s) => s.name.trim() && settings.clinicianName.toLowerCase().includes(s.name.trim().toLowerCase())) ?? lh.signers[0]
      setLetter((l) => ({ ...l, signerIds: me ? [me.id] : [] }))
      // Nothing to sign with yet: open the setup so the images can be added first.
      setSetup(!lh.logo || lh.signers.every((s) => !s.signature))
    })
  }, [settings.clinicianName])

  // Letterhead edits save as they're made.
  useEffect(() => {
    if (!letterhead) return
    if (!loaded.current) {
      loaded.current = true
      return
    }
    const t = window.setTimeout(() => void window.echo.saveLetterhead(letterhead), 400)
    return () => window.clearTimeout(t)
  }, [letterhead])

  const html = useMemo(() => (letterhead ? letterToDocumentHtml(letter, letterhead, true) : ''), [letter, letterhead])

  const close = () => {
    if (letter.body.trim() && !window.confirm('Discard this letter? It isn’t saved anywhere until you save the PDF.')) return
    onClose()
  }

  const set = (patch: Partial<Letter>) => setLetter((l) => ({ ...l, ...patch }))
  const setHead = (patch: Partial<Letterhead>) => setLetterhead((lh) => (lh ? { ...lh, ...patch } : lh))

  const chooseImage = async (kind: 'logo' | 'signature', signerId?: string) => {
    try {
      const url = await window.echo.chooseLetterheadImage(kind)
      if (!url) return
      if (kind === 'logo') setHead({ logo: url })
      else setLetterhead((lh) => (lh ? { ...lh, signers: lh.signers.map((s) => (s.id === signerId ? { ...s, signature: url } : s)) } : lh))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      // The PDF is drawn from the saved letterhead, so make sure the latest edits are in.
      if (letterhead) await window.echo.saveLetterhead(letterhead)
      const path = await window.echo.saveLetterPdf(letter, client.name)
      if (path) {
        toast('Letter saved as PDF', 'success')
        onClose()
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Letter on letterhead"
      onClose={close}
      width={1020}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" icon={<FileDown size={14} />} disabled={!letterhead || !letter.body.trim() || busy} onClick={save}>
            Save PDF…
          </Button>
        </>
      }
    >
      {letterhead && (
        <div className="letter-editor">
          <div className="form letter-form">
            {letterhead.signers.length > 0 && (
              <div className="field">
                <span className="field-label">Signed by</span>
                <div className="letter-signers">
                  {letterhead.signers.map((s) => {
                    const on = letter.signerIds.includes(s.id)
                    return (
                      <button
                        key={s.id}
                        className={`chip-toggle ${on ? 'on' : ''}`}
                        aria-pressed={on}
                        // Kept in letterhead order so the signature blocks don't reorder as they're toggled.
                        onClick={() => set({ signerIds: letterhead.signers.filter((x) => (x.id === s.id ? !on : letter.signerIds.includes(x.id))).map((x) => x.id) })}
                      >
                        {signerLabel(s) || 'Unnamed'}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            <Field label="Date">
              <input type="date" value={letter.date} onChange={(e) => set({ date: e.target.value })} />
            </Field>
            <Field label="To" hint="Name and address, one per line. Optional.">
              <AutoTextarea value={letter.recipient} minRows={2} onChange={(e) => set({ recipient: e.target.value })} placeholder={'Ms. Jordan Lee\nRiverside Middle School'} />
            </Field>
            <Field label="Re">
              <input value={letter.subject} onChange={(e) => set({ subject: e.target.value })} />
            </Field>
            <Field label="Greeting">
              <input value={letter.salutation} onChange={(e) => set({ salutation: e.target.value })} />
            </Field>
            <Field label="Letter" hint="Leave a blank line between paragraphs.">
              <AutoTextarea value={letter.body} minRows={8} autoFocus onChange={(e) => set({ body: e.target.value })} />
            </Field>
            <Field label="Closing">
              <input value={letter.closing} onChange={(e) => set({ closing: e.target.value })} />
            </Field>

            <button className="letter-setup-toggle" onClick={() => setSetup((v) => !v)}>
              {setup ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Letterhead &amp; signatures
            </button>
            {setup && (
              <div className="form letter-setup">
                <p className="muted small">Shared by every letter. The logo and signatures are kept in Echo’s encrypted data, never in the app itself.</p>
                <ImageRow label="Logo" src={letterhead.logo} onChoose={() => chooseImage('logo')} onRemove={() => setHead({ logo: '' })} />
                <Field label="Practice name">
                  <input value={letterhead.practiceName} onChange={(e) => setHead({ practiceName: e.target.value })} />
                </Field>
                <Field label="Tagline">
                  <input value={letterhead.tagline} onChange={(e) => setHead({ tagline: e.target.value })} />
                </Field>
                <Field label="Contact" hint="One line each, top right.">
                  <AutoTextarea value={letterhead.contact} minRows={3} onChange={(e) => setHead({ contact: e.target.value })} />
                </Field>
                <Field label="Footer">
                  <input value={letterhead.footer} onChange={(e) => setHead({ footer: e.target.value })} />
                </Field>
                {letterhead.signers.map((s) => {
                  const update = (patch: Partial<typeof s>) => setHead({ signers: letterhead.signers.map((x) => (x.id === s.id ? { ...x, ...patch } : x)) })
                  return (
                    <div key={s.id} className="letter-signer-setup">
                      <div className="row gap">
                        <Field label="Name">
                          <input value={s.name} onChange={(e) => update({ name: e.target.value })} />
                        </Field>
                        <Field label="Credentials">
                          <input value={s.credentials} onChange={(e) => update({ credentials: e.target.value })} />
                        </Field>
                      </div>
                      <Field label="Title">
                        <input value={s.title} onChange={(e) => update({ title: e.target.value })} />
                      </Field>
                      <ImageRow label="Signature" src={s.signature} onChoose={() => chooseImage('signature', s.id)} onRemove={() => update({ signature: '' })} />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          <div className="letter-preview" aria-label="Preview">
            <iframe title="Letter preview" sandbox="" srcDoc={html} tabIndex={-1} />
          </div>
        </div>
      )}
    </Modal>
  )
}

function ImageRow({ label, src, onChoose, onRemove }: { label: string; src: string; onChoose(): void; onRemove(): void }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="letter-image-row">
        <div className="letter-image">{src ? <img src={src} alt="" /> : <span className="muted small">None</span>}</div>
        <Button size="sm" icon={<ImagePlus size={14} />} onClick={onChoose}>
          {src ? 'Replace…' : 'Choose…'}
        </Button>
        {src && <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={onRemove} aria-label={`Remove ${label.toLowerCase()}`} />}
      </div>
    </div>
  )
}
