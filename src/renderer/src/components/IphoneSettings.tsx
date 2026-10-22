import { useEffect, useState } from 'react'
import { QrCode, Smartphone, Unlink } from 'lucide-react'
import type { MobileLinkStatus } from '@shared/types'
import { errorMessage } from '../lib/util'
import { useStore } from '../store'
import { Button, Modal } from './ui'

/** Settings › iPhone: pair the Echo iPhone app so recordings made away from the desk arrive in the Queue. */
export function IphoneSettings() {
  const { toast } = useStore()
  const [status, setStatus] = useState<MobileLinkStatus | null>(null)
  const [pairing, setPairing] = useState(false)

  useEffect(() => {
    void window.echo.linkStatus().then(setStatus)
    return window.echo.onLink(setStatus)
  }, [])

  const unpair = async () => {
    if (!window.confirm('Unpair your iPhone? Recordings still on it won’t arrive until you pair again.')) return
    setStatus(await window.echo.linkUnpair())
  }

  return (
    <section className="settings-group">
      <h2>iPhone</h2>
      <p className="fine-print">
        Record a session summary on your iPhone after a session away from your desk. The Echo iPhone app transcribes it on the phone, and the text arrives in your Queue
        the next time the phone and this Mac are on the same Wi-Fi. Start each recording with the client’s name; Echo suggests the client and you confirm it.
      </p>
      {status && status.state !== 'off' && (
        <p className={status.state === 'error' ? 'error small' : 'small'}>
          <Smartphone size={13} className="inline-icon" />{' '}
          {status.state === 'waiting' && 'Waiting for your iPhone to scan the pairing code.'}
          {status.state === 'paired' && `Paired with ${status.deviceName ?? 'your iPhone'}${status.lastSeenAt ? `. Last connected ${lastSeen(status.lastSeenAt)}.` : '.'}`}
          {status.state === 'error' && status.message}
        </p>
      )}
      <div className="row gap">
        <Button icon={<QrCode size={14} />} onClick={() => setPairing(true)}>
          {status?.state === 'paired' ? 'Show pairing code' : 'Pair iPhone'}
        </Button>
        {status && status.state !== 'off' && (
          <Button variant="ghost" icon={<Unlink size={14} />} onClick={() => void unpair().catch((err) => toast(errorMessage(err), 'error'))}>
            Unpair
          </Button>
        )}
      </div>
      {pairing && <PairModal onClose={() => setPairing(false)} paired={status?.state === 'paired'} />}
    </section>
  )
}

function PairModal({ onClose, paired: pairedAtOpen }: { onClose(): void; paired: boolean }) {
  // Whether it was already paired when this opened; the prop turns true along with the status below.
  const [paired] = useState(pairedAtOpen)
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<MobileLinkStatus | null>(null)

  useEffect(() => {
    window.echo.linkPairingCode().then(setSvg, (err) => setError(errorMessage(err)))
    return window.echo.onLink(setStatus)
  }, [])

  // The phone connects right after scanning, which closes this with a confirmation.
  const justPaired = !paired && status?.state === 'paired'

  return (
    <Modal title="Pair your iPhone" onClose={onClose} width={440}>
      {justPaired ? (
        <div className="pair-done">
          <Smartphone size={28} className="ok" />
          <p>
            <b>{status.deviceName ?? 'Your iPhone'}</b> is paired.
          </p>
          <p className="muted small">Recordings arrive in the Queue whenever the phone and this Mac are on the same Wi-Fi with Echo open.</p>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <div className="pair">
          <ol className="pair-steps">
            <li>Open Echo on your iPhone.</li>
            <li>Tap <b>Pair with Mac</b> and point the camera at this code.</li>
          </ol>
          <div className="pair-code">{svg ? <img src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} alt="Pairing code" /> : <span className="muted small">{error || 'Making a code…'}</span>}</div>
          <p className="fine-print">
            The code holds a secret key that lets the phone send to this Mac. Only show it to your own phone. Everything sent between them is encrypted with that key and
            stays on your local network. If macOS asks whether Echo may accept incoming connections, choose Allow.
          </p>
        </div>
      )}
    </Modal>
  )
}

function lastSeen(iso: string): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? `today at ${time}` : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`
}
