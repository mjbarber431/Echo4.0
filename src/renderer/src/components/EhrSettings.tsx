import { useState } from 'react'
import { ExternalLink, Plus, X } from 'lucide-react'
import { DEFAULT_EHR_LAYOUT, EHR_LAYOUTS, hostOf, layoutRects, normalizeEhrUrl, type Ehr, type EhrLayout } from '@shared/ehr'
import { uid } from '../lib/util'
import { useStore } from '../store'
import { Button, Field, Segmented, Toggle } from './ui'

/** The preview is drawn on a screen this shape (a MacBook's work area, roughly). */
const PREVIEW = { x: 0, y: 0, width: 240, height: 150 }

/** Settings › EHRs: the EHRs Echo opens when it's time to chart, and how the windows are arranged. */
export function EhrSettings() {
  const { settings, saveSettings, openEhrs } = useStore()
  const [rows, setRows] = useState<Ehr[]>(() => (settings.ehrs?.length ? settings.ehrs : []))
  const layout = settings.ehrLayout ?? DEFAULT_EHR_LAYOUT

  /** Saves the rows that have an address; a half-typed row stays on screen until it has one. */
  const save = (next: Ehr[]) => {
    setRows(next)
    void saveSettings({ ehrs: next.filter((e) => e.url.trim()).map((e) => ({ ...e, url: normalizeEhrUrl(e.url) ?? e.url.trim(), name: e.name.trim() })) })
  }
  const edit = (id: string, patch: Partial<Ehr>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const saved = settings.ehrs ?? []

  const names = rows.filter((r) => normalizeEhrUrl(r.url)).map((r) => r.name.trim() || hostOf(normalizeEhrUrl(r.url)!))
  const preview = layoutRects(names.length + 1, PREVIEW, layout === 'none' ? 'grid' : layout)

  return (
    <section className="settings-group">
      <h2>EHRs</h2>
      <p className="fine-print">
        Paste the address of each EHR you chart in, usually its sign-in page. <b>Chart notes</b> (⇧⌘E) opens them in Chrome beside Echo and walks you through
        each new note; <b>Open EHRs</b> (⌥⌘E) just opens them. While charting, the EHR buttons (or ⌃1, ⌃2…) bring each one forward, and copying a note
        takes you to the EHR you’ve chosen for that client. A tab already open on an EHR is reused. The first time, macOS asks whether Echo may control Chrome.
      </p>
      <div className="ehr-rows">
        {rows.map((r) => {
          const bad = !!r.url.trim() && !normalizeEhrUrl(r.url)
          return (
            <div key={r.id} className="ehr-row">
              <input
                className="ehr-name"
                value={r.name}
                placeholder="Name"
                aria-label="EHR name"
                onChange={(e) => edit(r.id, { name: e.target.value })}
                onBlur={() => save(rows)}
              />
              <input
                className={`grow ${bad ? 'invalid' : ''}`}
                value={r.url}
                placeholder="https://…"
                aria-label="EHR address"
                spellCheck={false}
                onChange={(e) => edit(r.id, { url: e.target.value })}
                onBlur={() => save(rows.map((x) => (x.id === r.id && normalizeEhrUrl(x.url) ? { ...x, url: normalizeEhrUrl(x.url)! } : x)))}
              />
              <button className="icon-btn" title="Remove" aria-label={`Remove ${r.name || 'EHR'}`} onClick={() => save(rows.filter((x) => x.id !== r.id))}>
                <X size={14} />
              </button>
              {bad && <span className="error small ehr-error">Needs a full https:// address.</span>}
            </div>
          )
        })}
      </div>
      <div className="row gap">
        <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => setRows((rs) => [...rs, { id: uid(), name: '', url: '' }])} disabled={rows.length >= 8}>
          Add EHR
        </Button>
        <Button size="sm" icon={<ExternalLink size={13} />} onClick={() => void openEhrs()} disabled={!saved.length}>
          Open EHRs now
        </Button>
      </div>

      <Field label="Window layout" hint={layout === 'side' ? 'Echo on the left, one Chrome window on the right with a tab for each EHR. On the screen Echo is on.' : 'On the screen Echo is on. Echo comes to the front afterwards, ready to copy from.'}>
        <Segmented<EhrLayout> value={layout} onChange={(ehrLayout) => void saveSettings({ ehrLayout })} options={EHR_LAYOUTS} />
      </Field>
      <div className={`ehr-preview ${layout === 'none' ? 'off' : ''}`} style={{ width: PREVIEW.width, height: PREVIEW.height }} aria-hidden>
        {layout === 'none' ? (
          <span className="muted small">Windows stay where they are</span>
        ) : (
          preview.map((r, i) => (
            <span key={i} className={i === 0 ? 'echo' : layout === 'side' ? 'tabs' : ''} style={{ left: r.x, top: r.y, width: r.width, height: r.height }}>
              {i === 0 ? 'Echo' : layout === 'side' ? <TabStrip names={names} /> : names[i - 1]}
            </span>
          ))
        )}
      </div>
      <Toggle
        checked={settings.ehrOpenOnChart !== false}
        onChange={(ehrOpenOnChart) => void saveSettings({ ehrOpenOnChart })}
        label="Open the EHRs when charting starts"
      />
      <p className="fine-print">
        <b>Signing in:</b> let Chrome save each EHR’s password when you sign in (and tick “Remember me” or “Trust this device” where the EHR offers it). Chrome then
        fills it in each time, kept in its own password manager and protected by your Mac login. Echo doesn’t store EHR passwords or type into the EHR, and the
        EHR’s own two-step code stays with you.
      </p>
    </section>
  )
}

/** The EHRs' window in the side-by-side preview: one tab per EHR. */
function TabStrip({ names }: { names: string[] }) {
  return (
    <>
      <span className="ehr-tabstrip">
        {(names.length ? names : ['EHR']).map((n, i) => (
          <i key={i} className={i === 0 ? 'on' : ''}>
            {n}
          </i>
        ))}
      </span>
      <span className="ehr-tabpage">{names[0] ?? 'EHR'}</span>
    </>
  )
}
