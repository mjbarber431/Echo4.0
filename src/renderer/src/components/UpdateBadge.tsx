import { useEffect, useState } from 'react'
import { Download, RotateCw } from 'lucide-react'
import type { UpdateStatus } from '@shared/types'

/** A new version downloading in the background, then a restart to install it. Hidden otherwise. */
export function UpdateBadge() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    void window.echo.updateStatus().then(setStatus)
    return window.echo.onUpdate(setStatus)
  }, [])
  if (!status || status.state === 'idle') return null

  if (status.state === 'ready') {
    return (
      <button className="update-badge ready" onClick={() => window.echo.installUpdate()} title="Echo restarts to install it. Drafts are saved.">
        <RotateCw size={14} />
        <span className="update-text">
          <span>Update ready</span>
          <small>Restart to install {status.version}</small>
        </span>
      </button>
    )
  }
  const pct = Math.round(status.progress * 100)
  return (
    <div className="update-badge" role="status" aria-live="polite">
      <Download size={14} />
      <span className="update-text">
        <span>Downloading update{pct ? ` · ${pct}%` : '…'}</span>
        <small>Echo {status.version}</small>
        <span className="update-bar" aria-hidden>
          <span style={{ width: `${Math.max(pct, 3)}%` }} />
        </span>
      </span>
    </div>
  )
}
