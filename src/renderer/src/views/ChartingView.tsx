import { useMemo } from 'react'
import { CheckCircle2, ClipboardList, ExternalLink, FileText, Loader2, Target, Wand2, X } from 'lucide-react'
import { NOTE_TYPE_LABEL } from '@shared/types'
import { todayISO } from '@shared/compliance'
import { ehrForClient, usableEhrs } from '@shared/ehr'
import { notesToPlace, placeAll, placeAllLabel, PLACE_ALL_TITLE } from '../lib/placeAll'
import { buildQueue, chartNotes, chartStatus, plansToChart } from '@shared/queue'
import { useStore } from '../store'
import { relativeDay } from '../lib/util'
import { Avatar, Button, Kbd } from '../components/ui'
import { PlaceBatchCard } from '../components/PlaceBatchCard'

/**
 * Charting: getting notes into the EHR. Opens on the notes not yet there (drafts to review and finalized
 * notes not yet copied or placed). Starting goes into focused charting, one note at a time with the EHRs
 * beside Echo, where the Navigator can place each one. Treatment plans Echo has freshly drafted or updated
 * and that aren't charted yet wait here too; otherwise plans are charted from the client's Plan tab.
 * Nothing here opens the EHRs by itself.
 */
export function ChartingView() {
  const store = useStore()
  const { notes, clients, jobs, settings, charting, navigate, startCharting, stopCharting, openEhrs, saveClient, placeBatch, placement } = store
  const today = todayISO()
  const byId = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients])
  const q = useMemo(() => buildQueue(notes, clients, jobs, today), [notes, clients, jobs, today])
  // Notes still waiting their turn in a batch show in the batch, not twice.
  const inBatch = new Set(placeBatch && !placeBatch.done ? placeBatch.items.map((i) => i.noteId) : [])
  const list = chartNotes(q).filter((n) => !inBatch.has(n.id))
  const writing = q.writing.length
  const ehrs = usableEhrs(settings.ehrs)
  const charted = charting ? notes.filter((n) => charting.includes(n.id)) : []
  const resume = charted.find((n) => chartStatus(n) !== 'done') ?? charted[0]
  const plans = plansToChart(clients)
  // The notes the Navigator can chart by itself, one after another.
  const navigating = !!placement && ['starting', 'running', 'paused', 'asking'].includes(placement.state)
  const placeable = notesToPlace(list, byId, settings, jobs)

  return (
    <div className="page">
      <header className="page-head drag">
        <h1 className="page-title">Charting</h1>
        <div className="head-actions no-drag">
          {ehrs.length > 0 && (
            <Button size="sm" variant="ghost" icon={<ExternalLink size={14} />} onClick={() => void openEhrs()} title="⌥⌘E">
              Open EHRs
            </Button>
          )}
        </div>
      </header>
      <div className="home-body">
        {placeBatch ? (
          <PlaceBatchCard />
        ) : (
          <section className="chart-start-card">
            <div className="grow">
              <h2>{list.length ? `${list.length} note${list.length === 1 ? '' : 's'} to chart` : 'Nothing to chart'}</h2>
              <p className="muted small">
                {list.length
                  ? `Go through them one at a time${ehrs.length ? ' with your EHRs beside Echo' : ''}${settings.placeWithClaude ? ', and have the Navigator place each one' : ''}.`
                  : writing
                    ? 'Notes still writing will be ready to chart when they’re done.'
                    : 'Every note is finalized and in the EHR.'}
                {writing > 0 && list.length > 0 && ` ${writing} more writing.`}
                {placeable.length > 0 &&
                  ` Or let the Navigator chart ${placeable.length === 1 ? 'it' : `all ${placeable.length}`} while you step away, each in its own tab, and sign them when you’re back.`}
              </p>
            </div>
            <div className="chart-start-actions">
              {placeable.length > 0 && (
                <Button variant="primary" icon={<Wand2 size={15} />} onClick={() => void placeAll(store, placeable)} disabled={navigating} title={PLACE_ALL_TITLE}>
                  {placeAllLabel(placeable.length)}
                </Button>
              )}
              {charting ? (
                <div className="row gap">
                  <Button variant="ghost" onClick={stopCharting}>
                    Stop
                  </Button>
                  <Button variant={placeable.length ? 'secondary' : 'primary'} icon={<ClipboardList size={15} />} onClick={() => navigate({ view: 'chart', id: resume?.id })}>
                    Resume charting
                  </Button>
                </div>
              ) : (
                (list.length > 0 || writing > 0) && (
                  <Button variant={placeable.length ? 'secondary' : 'primary'} icon={<ClipboardList size={15} />} onClick={() => startCharting()} title="⇧⌘E">
                    {placeable.length ? 'Chart myself' : 'Start charting'}
                  </Button>
                )
              )}
            </div>
          </section>
        )}

        {list.length > 0 && (
          <section className="today-section">
            <h2>Notes</h2>
            <div className="list-card">
              {list.map((n) => {
                const c = byId.get(n.clientId)!
                const draft = n.status === 'draft'
                return (
                  <div key={n.id} className="list-row" role="button" onClick={() => startCharting(n.id)} title="Start charting here">
                    {draft ? <FileText size={16} className="accent" /> : <CheckCircle2 size={16} className="warn" />}
                    <Avatar id={c.id} name={c.name} size={24} />
                    <span className="grow">
                      <b>{c.name}</b> · {NOTE_TYPE_LABEL[n.type]} <span className="muted">{draft ? 'to review' : 'finalized, not in the EHR yet'}</span>
                    </span>
                    <span className="muted small">{relativeDay(n.session.date, today)}</span>
                  </div>
                )
              })}
            </div>
          </section>
        )}
        {plans.length > 0 && (
          <section className="today-section">
            <h2>Treatment plans</h2>
            <div className="list-card">
              {plans.map((c) => {
                const ehr = ehrForClient(c, settings.ehrs)
                return (
                  <div key={c.id} className="list-row" role="button" onClick={() => navigate({ view: 'chart-plan', clientId: c.id, from: 'charting' })} title="Chart this plan">
                    <Target size={16} className="accent" />
                    <Avatar id={c.id} name={c.name} size={24} />
                    <span className="grow">
                      <b>{c.name}</b> · <span className="muted">new treatment plan, not in the EHR yet</span>
                    </span>
                    <span className="muted small">{ehr ? ehr.name : 'No EHR chosen'}</span>
                    <button
                      className="icon-btn"
                      title="Don’t chart this plan"
                      aria-label="Don’t chart this plan"
                      onClick={(e) => {
                        e.stopPropagation()
                        saveClient({ ...c, planChartDue: false })
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        )}
        {writing > 0 && (
          <p className="muted small row gap">
            <Loader2 size={13} className="spin" /> {writing} note
            {writing === 1 ? '' : 's'} writing
          </p>
        )}
        {list.length > 0 && !charting && (
          <p className="muted small">
            <Kbd>⇧⌘E</Kbd> starts charting from anywhere.
          </p>
        )}
      </div>
    </div>
  )
}
