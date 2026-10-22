import { useState } from 'react'
import { AlertTriangle, CalendarCheck, Check, FileDown, History, Pencil, Plus, Sparkles, Target, Trash2, Wand2, X } from 'lucide-react'
import type { Client, Goal, GoalStatus, TreatmentPlan } from '@shared/types'
import { GOAL_STATUS_LABEL } from '@shared/types'
import { formatDateUS, nextReviewDate, planReviewDue, todayISO } from '@shared/compliance'
import { planToText, textToHtml } from '@shared/format'
import { applyPlanResult, emptyPlan, newGoal } from '@shared/finalize'
import { api, errorMessage, nowISO, uid } from '../lib/util'
import { useStore } from '../store'
import { Dictation } from '../components/Dictation'
import { AutoTextarea, Button, CopyButton, Empty, Field } from '../components/ui'

const STATUSES = Object.keys(GOAL_STATUS_LABEL) as GoalStatus[]

export function PlanTab({ client }: { client: Client }) {
  const { saveClient, settings, toast } = useStore()
  const [drafting, setDrafting] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [planReview, setPlanReview] = useState<string[]>([])
  const plan = client.plan
  const today = todayISO()

  const savePlan = (next: TreatmentPlan, reason?: string) => {
    const history = reason && plan ? [{ savedAt: nowISO(), reason, plan }, ...client.planHistory].slice(0, 50) : client.planHistory
    saveClient({ ...client, plan: { ...next, updatedAt: nowISO() }, planHistory: history })
  }

  const updateGoal = (goal: Goal) => plan && savePlan({ ...plan, goals: plan.goals.map((g) => (g.id === goal.id ? { ...goal, updatedAt: nowISO() } : g)) })

  if (!plan || plan.goals.length === 0) {
    return drafting ? (
      <AiPlanPanel client={client} onClose={() => setDrafting(false)} onDone={(items) => (setPlanReview(items), setDrafting(false))} />
    ) : (
      <Empty icon={<Target size={26} />} title="No treatment plan yet">
        <p>Plans are drafted automatically from an intake note. For an existing client, dictate a quick summary or let Echo work from their notes, and it drafts SMART goals.</p>
        <div className="row gap">
          <Button variant="primary" icon={<Wand2 size={14} />} onClick={() => setDrafting(true)}>
            Draft with AI
          </Button>
          <Button
            icon={<Plus size={14} />}
            onClick={() => {
              const now = nowISO()
              const base = emptyPlan(now)
              savePlan({
                ...base,
                goals: [newGoal(uid, now, { problem: '', goal: 'New goal', objectives: [''], interventions: '' })],
                reviewDate: nextReviewDate(today, settings.planReviewDays),
                lastReviewed: today
              })
            }}
          >
            Write it myself
          </Button>
        </div>
      </Empty>
    )
  }

  const due = planReviewDue(client, today)

  return (
    <div className="plan">
      <div className="plan-bar">
        <div className="plan-bar-group">
          <div className={`review-pill ${due ? 'due' : ''}`}>
            <CalendarCheck size={14} />
            {plan.reviewDate ? `${due ? 'Review was due' : 'Next review'} ${formatDateUS(plan.reviewDate)}` : 'No review date'}
          </div>
          <Button
            size="sm"
            variant={due ? 'primary' : 'secondary'}
            icon={<Check size={13} />}
            onClick={() => {
              savePlan({ ...plan, lastReviewed: today, reviewDate: nextReviewDate(today, settings.planReviewDays) }, 'Plan reviewed')
              toast(`Plan marked reviewed. Next review ${formatDateUS(nextReviewDate(today, settings.planReviewDays))}.`, 'success')
            }}
          >
            Mark reviewed
          </Button>
        </div>
        <div className="plan-bar-group">
          <Button size="sm" variant="ghost" icon={<Sparkles size={13} />} onClick={() => setDrafting(true)}>
            Update with AI
          </Button>
          {client.planHistory.length > 0 && (
            <Button size="sm" variant="ghost" icon={<History size={13} />} onClick={() => setShowHistory((v) => !v)}>
              History
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<FileDown size={13} />}
            onClick={async () => {
              try {
                const path = await api().savePlanPdf(client.id)
                if (path) toast(`Saved ${path.split('/').pop()}`, 'success')
              } catch (err) {
                toast(errorMessage(err), 'error')
              }
            }}
          >
            Save PDF
          </Button>
          <CopyButton size="sm" variant="ghost" label="Copy plan" text={planToText(plan, client, settings)} html={textToHtml(planToText(plan, client, settings))} />
        </div>
      </div>

      {drafting && <AiPlanPanel client={client} onClose={() => setDrafting(false)} onDone={(items) => (setPlanReview(items), setDrafting(false))} />}

      {planReview.length > 0 && (
        <div className="card review-inline">
          <p>
            <AlertTriangle size={14} className="warn" /> Please review the drafted plan:
          </p>
          <ul>
            {planReview.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          <Button size="sm" onClick={() => setPlanReview([])}>
            Done
          </Button>
        </div>
      )}

      {showHistory && (
        <div className="card history">
          <h4>Previous versions</h4>
          {client.planHistory.map((h, i) => (
            <div key={i} className="history-row">
              <span>
                {new Date(h.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · <span className="muted">{h.reason}</span> · {h.plan.goals.length} goals
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (window.confirm('Restore this version? The current plan is saved to history first.')) {
                    savePlan(h.plan, 'Before restoring an older version')
                    setShowHistory(false)
                  }
                }}
              >
                Restore
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="goals">
        {plan.goals.map((g, i) => (
          <GoalCard
            key={g.id}
            goal={g}
            index={i}
            onChange={updateGoal}
            onDelete={() => window.confirm('Remove this goal from the plan?') && savePlan({ ...plan, goals: plan.goals.filter((x) => x.id !== g.id) }, `Removed goal ${i + 1}`)}
          />
        ))}
        <button
          className="add-goal"
          onClick={() => savePlan({ ...plan, goals: [...plan.goals, newGoal(uid, nowISO(), { problem: '', goal: 'New goal', objectives: [''], interventions: '' })] })}
        >
          <Plus size={14} /> Add goal
        </button>
      </div>

      <h4 className="plan-section-head">Plan details</h4>
      <div className="card plan-meta">
        <PlanMetaField label="Frequency" value={plan.frequency} onSave={(frequency) => savePlan({ ...plan, frequency })} />
        <PlanMetaField label="Modalities" value={plan.modalities} onSave={(modalities) => savePlan({ ...plan, modalities })} />
        <PlanMetaField label="Discharge criteria" value={plan.dischargeCriteria} onSave={(dischargeCriteria) => savePlan({ ...plan, dischargeCriteria })} />
        <label className="meta-field">
          <span>Next review</span>
          <input type="date" value={plan.reviewDate ?? ''} onChange={(e) => savePlan({ ...plan, reviewDate: e.target.value || null })} />
        </label>
      </div>
    </div>
  )
}

function PlanMetaField({ label, value, onSave }: { label: string; value: string; onSave(v: string): void }) {
  const [text, setText] = useState(value)
  return (
    <label className="meta-field">
      <span>{label}</span>
      <AutoTextarea value={text} minRows={1} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onSave(text)} />
    </label>
  )
}

function GoalCard({ goal, index, onChange, onDelete }: { goal: Goal; index: number; onChange(g: Goal): void; onDelete(): void }) {
  const [editing, setEditing] = useState(goal.goal === 'New goal')
  const [draft, setDraft] = useState(goal)

  if (editing) {
    return (
      <div className="card goal-card editing">
        <div className="goal-head">
          <span className="goal-num">Goal {index + 1}</span>
        </div>
        <div className="form">
          <Field label="Problem">
            <AutoTextarea value={draft.problem} minRows={1} onChange={(e) => setDraft({ ...draft, problem: e.target.value })} placeholder="Clinical problem tied to the diagnosis and functional impairment" />
          </Field>
          <Field label="Goal">
            <AutoTextarea value={draft.goal === 'New goal' ? '' : draft.goal} minRows={1} onChange={(e) => setDraft({ ...draft, goal: e.target.value })} placeholder="Client-centered long-term goal" autoFocus />
          </Field>
          <Field label="Measurable objectives">
            {draft.objectives.map((o, j) => (
              <div key={o.id} className="objective-edit">
                <span className="obj-label">
                  {index + 1}
                  {String.fromCharCode(97 + j)}
                </span>
                <input
                  value={o.text}
                  placeholder="e.g. Reduce panic attacks from 4/week to ≤1/week"
                  onChange={(e) => setDraft({ ...draft, objectives: draft.objectives.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)) })}
                />
                <button className="icon-btn" onClick={() => setDraft({ ...draft, objectives: draft.objectives.filter((x) => x.id !== o.id) })} aria-label="Remove objective">
                  <X size={13} />
                </button>
              </div>
            ))}
            <button className="link" onClick={() => setDraft({ ...draft, objectives: [...draft.objectives, { id: uid(), text: '', status: 'not_started' }] })}>
              + Add objective
            </button>
          </Field>
          <Field label="Interventions">
            <AutoTextarea value={draft.interventions} minRows={1} onChange={(e) => setDraft({ ...draft, interventions: e.target.value })} placeholder="e.g. CBT cognitive restructuring, exposure, DBT distress tolerance" />
          </Field>
          <Field label="Target date (optional)">
            <input type="date" value={draft.targetDate ?? ''} onChange={(e) => setDraft({ ...draft, targetDate: e.target.value || null })} />
          </Field>
        </div>
        <div className="row gap end">
          <Button variant="ghost" icon={<Trash2 size={13} />} onClick={onDelete}>
            Remove
          </Button>
          <div className="spacer" />
          <Button variant="ghost" onClick={() => (setDraft(goal), setEditing(false))}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onChange({ ...draft, goal: draft.goal.trim() || 'Untitled goal', objectives: draft.objectives.filter((o) => o.text.trim()) })
              setEditing(false)
            }}
          >
            Save goal
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={`card goal-card status-${goal.status}`}>
      <div className="goal-head">
        <span className="goal-num">Goal {index + 1}</span>
        <select className={`status-select s-${goal.status}`} value={goal.status} onChange={(e) => onChange({ ...goal, status: e.target.value as GoalStatus })}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {GOAL_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <button className="icon-btn" onClick={() => (setDraft(goal), setEditing(true))} aria-label="Edit goal">
          <Pencil size={14} />
        </button>
      </div>
      <h4 className="goal-text">{goal.goal}</h4>
      {goal.problem && <p className="goal-problem">{goal.problem}</p>}
      <ul className="objectives">
        {goal.objectives.map((o, j) => (
          <li key={o.id}>
            <span className="obj-label">
              {index + 1}
              {String.fromCharCode(97 + j)}
            </span>
            <span className="obj-text">{o.text}</span>
            <select
              className={`status-select mini s-${o.status}`}
              value={o.status}
              onChange={(e) => onChange({ ...goal, objectives: goal.objectives.map((x) => (x.id === o.id ? { ...x, status: e.target.value as GoalStatus } : x)) })}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {GOAL_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      {(goal.interventions || goal.progress || goal.targetDate) && (
        <div className="goal-foot">
          {goal.interventions && (
            <div className="goal-meta">
              <b>Interventions</b> {goal.interventions}
            </div>
          )}
          {goal.progress && (
            <div className="goal-meta">
              <b>Latest progress</b> {goal.progress}
            </div>
          )}
          {goal.targetDate && (
            <div className="goal-meta">
              <b>Target date</b> {formatDateUS(goal.targetDate)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AiPlanPanel({ client, onClose, onDone }: { client: Client; onClose(): void; onDone(reviewItems: string[]): void }) {
  const { notes, saveClient, settings, toast } = useStore()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const existing = (client.plan?.goals.length ?? 0) > 0
  // With no dictation, the plan is deduced from the finalized notes.
  const hasNotes = notes.some((n) => n.clientId === client.id && n.status === 'final')
  const fromRecord = !text.trim()

  const run = async () => {
    setBusy(true)
    try {
      const result = await api().generatePlan(client.id, text)
      saveClient(applyPlanResult(client, result, settings, uid, nowISO()))
      toast(existing ? 'Treatment plan updated. Previous version saved to history.' : 'Treatment plan drafted', 'success')
      onDone(result.review_items)
    } catch (err) {
      toast(errorMessage(err), 'error')
      setBusy(false)
    }
  }

  return (
    <section className="card ai-plan">
      <div className="card-head">
        <h3>
          <Sparkles size={16} /> {existing ? 'Update the plan' : 'Draft a treatment plan'}
        </h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <X size={15} />
        </button>
      </div>
      <Dictation
        compact
        value={text}
        onChange={setText}
        placeholder={
          existing
            ? hasNotes
              ? 'Optional: what’s changed? e.g. “Goal 1 is met, panic attacks are rare now. Add a goal around assertiveness with their partner.” Leave blank and Echo works it out from the notes since the last plan review.'
              : 'What’s changed? e.g. “Goal 1 is met, panic attacks are rare now. Add a goal around assertiveness with their partner, and move to every other week.”'
            : hasNotes
              ? 'Optional: background, presenting concerns, and the goals you have in mind. Leave blank and Echo drafts the plan from this client’s notes.'
              : 'Background, presenting concerns, what you’ve been working on, and the goals you have in mind. A minute or two is plenty.'
        }
      />
      <div className="generate-row">
        <Button variant="primary" icon={<Wand2 size={15} />} disabled={(fromRecord && !hasNotes) || busy} onClick={run}>
          {busy ? 'Drafting…' : fromRecord ? (existing ? 'Update from record' : 'Draft from record') : existing ? 'Update plan' : 'Draft plan'}
        </Button>
      </div>
    </section>
  )
}
