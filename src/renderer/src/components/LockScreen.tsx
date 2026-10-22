import { useEffect, useState } from 'react'
import { Fingerprint } from 'lucide-react'
import { Button } from './ui'

export function LockScreen({ onUnlock }: { onUnlock(): void }) {
  const [failed, setFailed] = useState(false)
  const attempt = async () => {
    setFailed(false)
    if (await window.echo.unlock()) onUnlock()
    else setFailed(true)
  }
  useEffect(() => {
    void attempt()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="lock">
      <div className="drag lock-drag" />
      <div className="lock-card">
        <div className="brand-mark lg">e</div>
        <h1>Echo is locked</h1>
        <p>Client information is hidden.</p>
        <Button variant="primary" size="lg" icon={<Fingerprint size={18} />} onClick={attempt}>
          Unlock with Touch ID
        </Button>
        {failed && <p className="muted small">Not unlocked. Try again.</p>}
      </div>
    </div>
  )
}
