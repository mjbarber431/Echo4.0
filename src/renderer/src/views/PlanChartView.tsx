import { useEffect, useMemo } from 'react'
import { ExternalLink, LogOut, MousePointerClick } from 'lucide-react'
import { ehrForClient } from '@shared/ehr'
import { formatDateUS } from '@shared/compliance'
import { planToText, textToHtml } from '@shared/format'
import { planPieces } from '@shared/placement'
import { api } from '../lib/util'
import { useStore } from '../store'
import { PlacePanel } from '../components/PlacePanel'
import { Avatar, Button, CopyButton } from '../components/ui'

/**
 * Charting a treatment plan, focused: Echo beside the EHRs, the plan as the Navigator will see it,
 * and a button to have it start a new plan in the client's EHR and fill it in. Existing plans there
 * are never touched. Exit stops a run still going and puts Echo's window back.
 */
export function PlanChartView({ clientId, from }: { clientId: string; from?: 'client' | 'charting' }) {
  const { clients, settings, placement, navigate, showEhr, placePlan, clearPlacement } = useStore()
  const client = clients.find((c) => c.id === clientId)
  const ehr = client && ehrForClient(client, settings.ehrs)
  const pieces = useMemo(() => (client?.plan ? planPieces(client.plan, client.name) : []), [client])
  const mine = placement && placement.kind === 'plan' && placement.clientId === clientId ? placement : null
  const live = !!mine && ['starting', 'running', 'paused', 'asking'].includes(mine.state)
  const busyElsewhere = !!placement && !mine && ['starting', 'running', 'paused', 'asking'].includes(placement.state)
  const canNavigate = !!settings.placeWithClaude && !!ehr && !settings.mockAI

  // The client's EHR beside Echo, as focused note charting does: just the one this plan goes into.
  useEffect(() => {
    if (ehr && settings.ehrOpenOnChart !== false) void showEhr(ehr.id, { beside: true })
  }, [ehr?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const exit = () => {
    if (live) api().placeStop()
    void api().restoreEcho()
    navigate(from === 'client' ? { view: 'client', id: clientId, tab: 'plan' } : { view: 'charting' })
  }

  if (!client) return null
  const plan = client.plan
  const changed = !!plan && (!client.planChartedAt || plan.updatedAt > client.planChartedAt)

  return (
    <div className="page chart">
      {/* Not a drag area, like focused note charting: clicks there must reach the buttons once the window is laid out. */}
      <header className="page-head">
        <h1 className="page-title">Treatment plan</h1>
        <span className="crumb">
          <Avatar id={client.id} name={client.name} size={20} />
          <span>{client.name}</span>
        </span>
        <div className="head-actions">
          {ehr && (
            <button className="ehr-pill mine" onClick={() => void showEhr(ehr.id)} title={`Bring ${ehr.name} forward`}>
              <ExternalLink size={12} />
              <span>{ehr.name}</span>
            </button>
          )}
          <Button size="sm" variant={mine?.state === 'placed' ? 'primary' : 'ghost'} icon={<LogOut size={13} />} onClick={exit} title="Stop and put Echo’s window back">
            Exit
          </Button>
        </div>
      </header>
      <div className="home-body plan-chart">
        {!plan || !pieces.length ? (
          <p className="muted">{client.name} doesn’t have a treatment plan in Echo yet.</p>
        ) : (
          <>
            <section className="chart-start-card">
              <div className="grow">
                <h2>{ehr ? `New plan in ${ehr.name}` : 'Choose this client’s EHR first'}</h2>
                <p className="muted small">
                  {client.planChartedAt
                    ? `Last charted${client.planChartedIn ? ` in ${client.planChartedIn}` : ''} on ${formatDateUS(client.planChartedAt.slice(0, 10))}${changed ? '; changed since.' : '; unchanged since.'}`
                    : 'Not charted into the EHR yet.'}{' '}
                  {canNavigate
                    ? 'The Navigator starts a new plan, fills each field from this one (reformatted to fit the form, wording kept), and checks every part landed. Existing plans are left alone, and nothing is saved or signed.'
                    : ehr
                      ? 'Turn on the EHR Navigator in Settings › EHRs to have Claude fill it in, or copy the plan and paste it yourself.'
                      : 'Pick their EHR on the client’s page.'}
                </p>
              </div>
              <div className="row gap">
                <CopyButton size="sm" variant="ghost" label="Copy plan" text={planToText(plan, client, settings)} html={textToHtml(planToText(plan, client, settings))} />
                {canNavigate && (
                  <Button
                    variant="primary"
                    icon={<MousePointerClick size={14} />}
                    disabled={live || busyElsewhere}
                    title={busyElsewhere ? 'The Navigator is busy with something else.' : undefined}
                    onClick={() => void placePlan(client.id)}
                  >
                    {mine?.state === 'placed' ? 'Chart again' : `Chart in ${ehr!.name}`}
                  </Button>
                )}
              </div>
            </section>
            {mine && <PlacePanel status={mine} onDismiss={clearPlacement} />}
            <section className="today-section">
              <h2>What the Navigator will fill in</h2>
              <div className="list-card plan-pieces">
                {pieces.map((p) => (
                  <div key={p.id} className="list-row">
                    <span className="muted small plan-piece-label">{p.label}</span>
                    <span className="grow">{p.text}</span>
                  </div>
                ))}
              </div>
              {client.diagnoses.length > 0 && <p className="muted small">Diagnoses: {client.diagnoses.map((d) => `${d.code} ${d.description}`).join('; ')}</p>}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
