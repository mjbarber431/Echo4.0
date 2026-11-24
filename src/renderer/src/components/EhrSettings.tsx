import { useEffect, useState } from 'react'
import { ExternalLink, Plus, Undo2, X } from 'lucide-react'
import { DEFAULT_EHR_LAYOUT, EHR_LAYOUTS, hostOf, layoutRects, learnedFor, learnedPatch, normalizeEhrUrl, type Ehr, type EhrLayout, type EhrTask, type Learned } from '@shared/ehr'
import { DEFAULT_PLACE_MODEL, PLACE_MODELS } from '@shared/placement'
import { api, uid } from '../lib/util'
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
    void saveSettings({
      ehrs: next
        .filter((e) => e.url.trim())
        .map((e) => ({
          ...e,
          url: normalizeEhrUrl(e.url) ?? e.url.trim(),
          name: e.name.trim(),
          instructions: e.instructions?.trim() || undefined,
          route: e.route?.trim() || undefined,
          previousRoute: e.previousRoute?.trim() || undefined
        }))
    })
  }
  const edit = (id: string, patch: Partial<Ehr>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const saved = settings.ehrs ?? []

  // A run that placed a note may have saved a new route or instructions while this page was open.
  useEffect(() => {
    setRows((rs) =>
      rs.map((r) => {
        const s = (settings.ehrs ?? []).find((e) => e.id === r.id)
        return s
          ? {
              ...r,
              route: s.route,
              instructions: s.instructions,
              previousRoute: s.previousRoute,
              routeTurns: s.routeTurns,
              routeSeconds: s.routeSeconds,
              script: s.script,
              previousScript: s.previousScript
            }
          : r
      })
    )
  }, [settings.ehrs])

  const names = rows.filter((r) => normalizeEhrUrl(r.url)).map((r) => r.name.trim() || hostOf(normalizeEhrUrl(r.url)!))
  const preview = layoutRects(names.length + 1, PREVIEW, layout === 'none' ? 'grid' : layout)

  return (
    <>
      <section className="settings-group">
        <h2>EHRs</h2>
        <p className="fine-print">
          Paste the address of each EHR you chart in, usually its sign-in page. <b>Chart notes</b> (⇧⌘E) opens them in Chrome beside Echo and walks you through each new note;{' '}
          <b>Open EHRs</b> (⌥⌘E) just opens them. While charting, the EHR buttons (or ⌃1, ⌃2…) bring each one forward, and copying a note takes you to the EHR you’ve chosen for
          that client. A tab already open on an EHR is reused. The first time, macOS asks whether Echo may control Chrome.
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

        <Field
          label="Window layout"
          hint={
            layout === 'side'
              ? 'Echo on the left, one Chrome window on the right with a tab for each EHR. On the screen Echo is on.'
              : 'On the screen Echo is on. Echo comes to the front afterwards, ready to copy from.'
          }
        >
          <Segmented<EhrLayout> value={layout} onChange={(ehrLayout) => void saveSettings({ ehrLayout })} options={EHR_LAYOUTS} />
        </Field>
        <div className={`ehr-preview ${layout === 'none' ? 'off' : ''}`} style={{ width: PREVIEW.width, height: PREVIEW.height }} aria-hidden>
          {layout === 'none' ? (
            <span className="muted small">Windows stay where they are</span>
          ) : (
            preview.map((r, i) => (
              <span
                key={i}
                className={i === 0 ? 'echo' : layout === 'side' ? 'tabs' : ''}
                style={{
                  left: r.x,
                  top: r.y,
                  width: r.width,
                  height: r.height
                }}
              >
                {i === 0 ? 'Echo' : layout === 'side' ? <TabStrip names={names} /> : names[i - 1]}
              </span>
            ))
          )}
        </div>
        <Toggle checked={settings.ehrOpenOnChart !== false} onChange={(ehrOpenOnChart) => void saveSettings({ ehrOpenOnChart })} label="Open the EHRs when charting starts" />
        <p className="fine-print">
          <b>Signing in:</b> let Chrome save each EHR’s password when you sign in (and tick “Remember me” or “Trust this device” where the EHR offers it). Chrome then fills it in
          each time, kept in its own password manager and protected by your Mac login. Echo doesn’t store EHR passwords or type them in, and the EHR’s own two-step code stays with
          you.
        </p>
      </section>
      <section className="settings-group">
        <h2>EHR Navigator</h2>
        <PlaceSettings rows={rows} setRows={setRows} save={save} />
      </section>
    </>
  )
}

/** The EHR Navigator: on or off, which model, and what Claude has learned about each EHR, for notes and for plans. */
function PlaceSettings({ rows, setRows, save }: { rows: Ehr[]; setRows(fn: (rs: Ehr[]) => Ehr[]): void; save(next: Ehr[]): void }) {
  const { settings, saveSettings, toast } = useStore()
  const on = !!settings.placeWithClaude
  const edit = (id: string, patch: Partial<Ehr>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const turnOn = async (value: boolean) => {
    await saveSettings({ placeWithClaude: value })
    if (!value) return
    const allowed = await api().placePermissions(true)
    if (!allowed.screen || !allowed.accessibility) {
      const missing = [!allowed.screen && 'Screen Recording', !allowed.accessibility && 'Accessibility'].filter(Boolean).join(' and ')
      toast(`Turn Echo on under System Settings › Privacy & Security › ${missing}, then quit and reopen Echo.`)
    }
  }
  const usable = rows.filter((r) => normalizeEhrUrl(r.url))
  return (
    <div className="place-settings">
      <Toggle
        checked={on}
        onChange={(v) => void turnOn(v)}
        label="Use the EHR Navigator"
        hint="Claude works in your EHR while you watch. In Charting, Place in… clicks through to that session’s note, opens its free-text option and pastes the note there; Chart plan starts a new treatment plan and fills it in from Echo’s. It never signs or saves, and never touches existing plans: you review and sign. Esc or moving the mouse pauses it."
      />
      {on && (
        <>
          <Field
            label="Model"
            hint="Opus finds its way around an unfamiliar EHR most reliably. Once an EHR has a route that works, Sonnet may do just as well for less, and Haiku costs around a cent a run but is more likely to need your help."
          >
            <Segmented
              value={settings.placeModel ?? DEFAULT_PLACE_MODEL}
              onChange={(placeModel) => void saveSettings({ placeModel })}
              options={PLACE_MODELS.map((m) => ({
                value: m.id,
                label: m.label
              }))}
            />
          </Field>
          <p className="fine-print">
            Claude sees only the EHR’s Chrome window, never Echo’s, along with the client’s name and the session’s week (it looks for the most recent appointment Monday to Sunday).
            Echo pastes the note itself, so what lands is exactly what you finalized. For a treatment plan, Claude also gets the plan’s text and the client’s diagnoses (with the
            client’s name taken out) so it can fit them to the EHR’s form, and Echo checks every part landed. macOS asks once to let Echo record the screen and control the pointer.
            Covered by Anthropic’s BAA as computer use on your HIPAA-configured organization.
          </p>
          {usable.map((r) => {
            // What each task has learned here; a change merges into that task's record on the row.
            const change = (task: EhrTask, patch: Learned) => edit(r.id, learnedPatch(task, { ...learnedFor(r, task), ...patch }))
            const commit = (task: EhrTask, patch?: Learned) =>
              save(rows.map((x) => (x.id === r.id && patch ? { ...x, ...learnedPatch(task, { ...learnedFor(x, task), ...patch }) } : x)))
            return (
              <div key={r.id} className="place-ehr">
                <b>{r.name || hostOf(normalizeEhrUrl(r.url)!)}</b>
                <LearnedFields task="note" learned={learnedFor(r, 'note')} change={(p) => change('note', p)} commit={(p) => commit('note', p)} />
                <details className="place-plan" open={!!r.plan?.route || !!r.plan?.instructions}>
                  <summary>Treatment plans</summary>
                  <LearnedFields task="plan" learned={learnedFor(r, 'plan')} change={(p) => change('plan', p)} commit={(p) => commit('plan', p)} />
                </details>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

/** One task's instructions, route and recorded steps in one EHR, editable. */
function LearnedFields({ task, learned: l, change, commit }: { task: EhrTask; learned: Learned; change(patch: Learned): void; commit(patch?: Learned): void }) {
  const what = task === 'note' ? 'places the note' : 'fills in the plan'
  return (
    <>
      <Field label="Your instructions" hint="What you tell Claude while it works is kept here, word for word, and comes first every time. Edit freely.">
        <textarea
          rows={3}
          value={l.instructions ?? ''}
          placeholder={task === 'note' ? 'e.g. Notes are under the appointment, not the client’s chart.' : 'e.g. New plans are under the client’s Documents tab.'}
          onChange={(e) => change({ instructions: e.target.value })}
          onBlur={() => commit()}
        />
      </Field>
      <Field
        label="Route Claude learned"
        hint={
          l.route
            ? `Replaced only when a run ${what} and either fixes a step or does it at least 10% faster${l.routeSeconds !== undefined ? ` (this route’s best: ${l.routeSeconds} seconds, not counting time waiting on you)` : ''}. A route you edit here is kept until Claude finds it wrong. Clear it if the EHR changes.`
            : 'Written by Claude after its first run here.'
        }
      >
        {/* Editing by hand makes it the route to keep: a run replaces it only by fixing it. */}
        <textarea
          rows={6}
          value={l.route ?? ''}
          placeholder="Nothing yet."
          onChange={(e) => change({ route: e.target.value, routeTurns: undefined, routeSeconds: undefined })}
          onBlur={() => commit()}
        />
      </Field>
      {!!l.script?.length && (
        <p className="fine-print">
          Echo replays {l.script.filter((x) => !x.choose).length} of this route’s {l.script.length} recorded steps by itself, finding each button by its text on screen; Claude does
          the {l.script.filter((x) => x.choose).length} that depend on the client{task === 'note' ? ' or session' : ''}.
        </p>
      )}
      {(l.previousRoute || !!l.script?.length) && (
        <div className="row gap">
          {!!l.script?.length && (
            <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => commit({ script: undefined, routeTurns: undefined, routeSeconds: undefined })}>
              Forget the recorded steps
            </Button>
          )}
          {l.previousRoute && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Undo2 size={13} />}
              onClick={() =>
                commit({ route: l.previousRoute, previousRoute: l.route, script: l.previousScript, previousScript: l.script, routeTurns: undefined, routeSeconds: undefined })
              }
            >
              Put back the previous route
            </Button>
          )}
        </div>
      )}
    </>
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
