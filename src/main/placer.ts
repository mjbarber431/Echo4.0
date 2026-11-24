import Anthropic from '@anthropic-ai/sdk'
import { clipboard, ClipboardItem, globalShortcut, powerSaveBlocker } from 'electron'
import { ehrForClient, learnedFor, learnedPatch, type Ehr, type EhrTask, type Learned } from '../shared/ehr'
import { noteToHtml, noteToText } from '../shared/format'
import {
  addInstruction,
  betterRoute,
  buildScript,
  DEFAULT_PLACE_MODEL,
  describeAction,
  fillTemplate,
  nextChoose,
  pickMatch,
  scriptLine,
  STEP_WAIT_MS,
  unsafeLabel,
  type ScriptStep,
  keepable,
  macCombo,
  MAX_PLACE_TURNS,
  PLACE_MODELS,
  pickTimeOffsets,
  PLACE_SYSTEM,
  placeTask,
  PLAN_SYSTEM,
  planPieces,
  planTask,
  unplacedPieces,
  type PlanPiece,
  SCREENSHOT_MAX_EDGE,
  toScreen,
  type PlaceBatch,
  type PlaceBatchSignIn,
  type PlaceState,
  MAX_SIGNIN_TURNS,
  SIGNIN_SYSTEM,
  signInTask,
  type PlaceStatus,
  UNATTENDED_NOTE,
  type Shot
} from '../shared/placement'
import { NOTE_TYPE_LABEL, type Client, type Note, type Settings } from '../shared/types'
import type { Rect } from '../shared/ehr'
import { anthropic, friendly } from './ai'
import { showEhr } from './ehr'
import { capture, findText, findWindow, labelAt, mouse, permissions, pointer, stopPointer } from './pointer'

// The EHR Navigator: places a finalized note, or charts a new treatment plan, in the client's EHR
// with Claude computer use. (Plans: Claude fills the new plan's fields from Echo's plan, reformatted
// to fit the form, and Echo checks every piece landed somewhere.)
//
// Claude clicks through the EHR's schedule to the session's note and its free-text box; Echo
// pastes the note itself, so what lands is exactly the finalized text. Claude never signs or
// saves. The clinician watches: Esc (or moving the mouse) pauses, and while paused they can
// type guidance or do a step themselves. What they type is kept, word for word, as the EHR's
// standing instructions; Claude writes down the route that worked, step by step with each button's
// text and position, so the next run can replay stretches of it with run_steps (Echo finds each
// label on screen with on-device text recognition before clicking). A route is replaced only by a
// run that placed the note and fixed it or took fewer requests; the one before is kept to put back.
//
// Covered by the BAA: computer use on a HIPAA-configured API organization, and the Messages API
// with prompt caching. No betas. Screenshots show only Chrome's windows (the EHR), never Echo's,
// and stay in memory for the run.

export interface PlaceContext {
  apiKey: string
  settings: Settings
  client: Client
  /** The note to place. Without one, the run charts the client's treatment plan. */
  note?: Note
  emit(status: PlaceStatus): void
  /** Saves changes to one EHR in Settings (its route or instructions) and returns them all. */
  updateEhr(id: string, patch: Partial<Ehr>): Ehr[]
  /** One of a batch: nobody is watching, so a question ends the run (left for the clinician) instead of waiting. */
  unattended?: boolean
  /** Opens the EHR in a new tab rather than reusing the one already open, which holds an earlier note of the batch. */
  newTab?: boolean
  /** Chrome has come forward (raising all its windows): put Echo back beside it, where it doesn't cover the EHR. */
  keepEchoBeside?(chrome: Rect): void
  /** Brings the EHR forward with Echo laid out beside it (a batch: only the EHR this note needs). Without it, the EHR's window stays where it is. */
  showBeside?(ehrId: string, newTab: boolean): Promise<Rect | undefined>
}

/** A run's context. A sign-in check has no client: it's about the EHR, not a note. */
type RunContext = Omit<PlaceContext, 'client'> & { client?: Client; signin?: boolean }

/** What a run does: place a note, chart a plan, or check the clinician is signed in to the EHR. */
type RunTask = EhrTask | 'signin'

/** The tools both tasks use. */
const CUSTOM_TOOLS: Anthropic.Tool[] = [
  {
    name: 'ask_clinician',
    description:
      'Pauses and asks the therapist, who is watching, a short specific question. Their answer comes back as the result, with a fresh screenshot (they may have clicked something themselves).',
    strict: true,
    input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'], additionalProperties: false }
  },
  {
    name: 'run_steps',
    description:
      'Runs several steps in a row, across screens, without a screenshot after each: for stretches of the saved route you know. ' +
      'click and double_click: label is the exact visible text of what to click, and x, y where it was last time in screenshot pixels (0, 0 if unknown). Echo finds the label on screen, waiting up to a few seconds for it to appear, and clicks it there. ' +
      'type: text is typed where the cursor is. key: text is a key or combination such as "return" or "cmd+a". wait: pauses for seconds. ' +
      'Unused fields are "" or 0. Returns one screenshot at the end, or stops at the first step it can’t do and says why. It won’t click anything that could sign, save, send or delete.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['click', 'double_click', 'type', 'key', 'wait'] },
              label: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              text: { type: 'string' },
              seconds: { type: 'number' }
            },
            required: ['action', 'label', 'x', 'y', 'text', 'seconds'],
            additionalProperties: false
          }
        }
      },
      required: ['steps'],
      additionalProperties: false
    }
  },
  {
    name: 'resume_script',
    description:
      'After you’ve done a choose step of the saved script: Echo carries on replaying the script by itself from step from (numbered from 1) until the next choose step or the end, then returns a screenshot.',
    strict: true,
    input_schema: { type: 'object', properties: { from: { type: 'integer' } }, required: ['from'], additionalProperties: false }
  },
  {
    name: 'done',
    description:
      'Ends the run. placed: whether the note is now in the free-text box. summary: one or two sentences for the therapist. route: the steps that worked in this EHR, in the form the instructions give, with no client names, dates, weekdays, service codes or details. fixed: true only if the saved route was wrong or incomplete, or you found a quicker way, and this route corrects it. path: the recorded steps (by number) that made up the working route, in order, each marked choose if it depends on this client or session, with what saying what to do (no client details) for those.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        placed: { type: 'boolean' },
        summary: { type: 'string' },
        route: { type: 'string' },
        fixed: { type: 'boolean' },
        path: {
          type: 'array',
          items: { type: 'object', properties: { step: { type: 'integer' }, choose: { type: 'boolean' }, what: { type: 'string' } }, required: ['step', 'choose', 'what'], additionalProperties: false }
        }
      },
      required: ['placed', 'summary', 'route', 'fixed', 'path'],
      additionalProperties: false
    }
  }
]

interface Step {
  action: 'click' | 'double_click' | 'type' | 'key' | 'wait'
  label: string
  x: number
  y: number
  text: string
  seconds: number
}

const PASTE_NOTE: Anthropic.Tool = {
  name: 'paste_note',
  description: 'Pastes the finished note, exactly as the therapist finalized it, at the text cursor. Call it once the cursor is in the free-text box of the right session’s note.',
  strict: true,
  input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false }
}

const FILL_FIELD: Anthropic.Tool = {
  name: 'fill_field',
  description: 'Pastes text into the field the cursor is in: click into the field first. For the plan’s text fields; the text is pasted exactly as given.',
  strict: true,
  input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
}

// Zoom is off: screenshots are already legible at this size, and the helper captures whole windows only.
const COMPUTER: Anthropic.ToolUnion = { type: 'computer_toolset_20260801', configs: { zoom: { enabled: false } } }

const SIGNED_IN: Anthropic.Tool = {
  name: 'done',
  description: 'Ends the check. signed_in: whether the EHR is now signed in (past its sign-in page). summary: a sentence for the therapist.',
  strict: true,
  input_schema: { type: 'object', properties: { signed_in: { type: 'boolean' }, summary: { type: 'string' } }, required: ['signed_in', 'summary'], additionalProperties: false }
}

const ASK = CUSTOM_TOOLS.find((t) => t.name === 'ask_clinician')!

const TOOLS: Record<RunTask, Anthropic.ToolUnion[]> = {
  note: [COMPUTER, PASTE_NOTE, ...CUSTOM_TOOLS],
  plan: [COMPUTER, FILL_FIELD, ...CUSTOM_TOOLS],
  // Signing in: look, click and press keys, ask, done. No replayed routes or pasting.
  signin: [COMPUTER, ASK, SIGNED_IN]
}

/** Price per million tokens (input, output). Cache reads are 0.05× input and 5-minute cache writes 1.25×. */
const PRICES: Record<string, [number, number]> = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Stopped extends Error {}

let current: Run | null = null
/** The batch under way, if any: Stop ends it as well as the run. */
let batch: { stopped: boolean } | null = null
/** A batch has left notes open in the EHR's tabs, waiting to be signed: from now on every run opens its own tab, so none is navigated away from. */
let tabsHeld = false

export function placing(): boolean {
  return !!current || !!batch
}

class Run {
  private status: PlaceStatus
  private abort = new AbortController()
  private stopped = false
  private pauseRequested = ''
  private resumeWith: ((guidance: string) => void) | null = null
  /** Guidance waiting to go with the next message, when it was typed while Claude was working. */
  private pendingGuidance = ''
  private window = 0
  /** Where the EHR's Chrome window is, for keeping Echo in front beside it. */
  private chrome: Rect | null = null
  private shot: Shot | null = null
  /**
   * Where Echo last put the pointer, to notice the clinician moving it. Null until Claude has moved it itself,
   * at the start and after every pause, so taking a hand off the trackpad after clicking Place or Carry on doesn't count.
   */
  private lastPointer: { x: number; y: number } | null = null
  private sendingKeys = false
  private savedClipboard: ClipboardItem[] | null = null
  private cost = 0
  /** When the run started, and how long it has spent waiting on the clinician (paused or asked), which doesn't count toward its time. */
  private startedAt = Date.now()
  private waitedMs = 0
  /** Every action this run, in order, as Claude did it or Echo replayed it: what the saved script is built from. */
  private trace: ScriptStep[] = []
  private readonly model: string
  private readonly ehr: Ehr
  /** Placing a note, charting the client's treatment plan, or checking the EHR is signed in. */
  private readonly task: RunTask
  /** What this task has learned in this EHR: instructions, route and recorded steps. */
  private learned: Learned
  /** Plans: the plan in pieces, what's been pasted into fields, and whether Claude has been told what's missing. */
  private pieces: PlanPiece[] = []
  private filled: string[] = []
  private checkedCoverage = false
  private listedTrace = false

  constructor(
    private ctx: RunContext,
    ehr: Ehr
  ) {
    this.ehr = ehr
    this.task = ctx.signin ? 'signin' : ctx.note ? 'note' : 'plan'
    this.learned = this.task === 'signin' ? {} : learnedFor(ehr, this.task)
    const wanted = ctx.settings.placeModel
    this.model = PLACE_MODELS.some((m) => m.id === wanted) ? wanted! : DEFAULT_PLACE_MODEL
    this.status = { kind: this.task, noteId: ctx.note?.id ?? '', clientId: ctx.client?.id ?? '', ehrName: ehr.name, state: 'starting', log: [], message: '' }
  }

  /** How the run is going, or how it ended. */
  get result(): PlaceStatus {
    return this.status
  }

  /** What's being placed, in words. */
  private get what(): string {
    return this.task === 'note' ? 'the note' : this.task === 'plan' ? 'the treatment plan' : 'the sign-in'
  }

  private set(state: PlaceState, message = this.status.message) {
    this.status = { ...this.status, state, message }
    this.ctx.emit(this.status)
  }

  private log(line: string) {
    this.status = { ...this.status, log: [...this.status.log, line].slice(-200) }
    this.ctx.emit(this.status)
  }

  pause(reason: string) {
    if (this.stopped || this.status.state === 'paused' || this.status.state === 'asking') return
    this.pauseRequested = reason
    this.set(this.status.state, `Pausing after this step…`)
  }

  resume(guidance: string) {
    const text = guidance.trim()
    if (this.resumeWith) {
      const go = this.resumeWith
      this.resumeWith = null
      go(text)
    } else if (text) {
      this.pendingGuidance = this.pendingGuidance ? `${this.pendingGuidance}\n${text}` : text
    }
  }

  stop() {
    this.stopped = true
    this.abort.abort()
    const go = this.resumeWith
    this.resumeWith = null
    go?.('')
  }

  private check() {
    if (this.stopped) throw new Stopped()
  }

  /** Waits for the clinician to carry on. Resolves with what they typed. */
  private wait(state: 'paused' | 'asking', message: string): Promise<string> {
    this.set(state, message)
    const from = Date.now()
    return new Promise((resolve) => {
      this.resumeWith = (text) => {
        this.waitedMs += Date.now() - from
        if (!this.stopped) this.set('running', '')
        resolve(text)
      }
    })
  }

  /** If a pause was asked for, waits for the clinician, keeps their guidance, and passes it on. */
  private async pauseIfAsked(onGuidance: (guidance: string) => void) {
    if (!this.pauseRequested) return
    const reason = this.pauseRequested
    this.pauseRequested = ''
    this.log('Paused')
    const guidance = await this.wait('paused', reason)
    this.check()
    this.lastPointer = null
    this.keepGuidance(guidance)
    onGuidance(guidance)
  }

  /** Seconds the run has taken so far, leaving out time spent waiting on the clinician. */
  private activeSeconds(): number {
    return Math.round((Date.now() - this.startedAt - this.waitedMs) / 1000)
  }

  /** Keeps what the clinician typed as the EHR's standing instructions (name removed), and logs it. */
  private keepGuidance(text: string) {
    if (!text) return
    this.log(`You: ${text}`)
    // Sign-in guidance is for this time only (and may mention the account).
    if (this.task === 'signin' || !this.ctx.client) return
    const line = keepable(text, this.ctx.client.name, 500)
    this.saveLearned({ instructions: addInstruction(this.learned.instructions, line) })
  }

  /** Saves what this task has learned in the EHR. */
  private saveLearned(patch: Learned) {
    if (this.task === 'signin') return
    this.learned = { ...this.learned, ...patch }
    this.saveEhr(learnedPatch(this.task, this.learned))
  }

  private saveEhr(patch: Partial<Ehr>) {
    this.status = { ...this.status, ehrs: this.ctx.updateEhr(this.ehr.id, patch) }
    this.ctx.emit(this.status)
  }

  private async screenshot(): Promise<Anthropic.ImageBlockParam> {
    const s = await capture(this.window, SCREENSHOT_MAX_EDGE)
    this.shot = s
    return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: s.png } }
  }

  /** Pauses if the clinician has moved the pointer since Echo last put it somewhere. */
  private async noticeMouse() {
    if (!this.lastPointer) return
    const now = await mouse()
    // A real move, not a trackpad's drift.
    if (Math.hypot(now.x - this.lastPointer.x, now.y - this.lastPointer.y) > 40) {
      this.lastPointer = null
      if (!this.pauseRequested) this.pauseRequested = 'You moved the mouse, so Claude paused.'
    }
  }

  private point(coordinate: unknown) {
    if (!this.shot) throw new Error('No screenshot yet: take one first.')
    const p = toScreen(coordinate, this.shot)
    if (!p) throw new Error('That position is outside the screenshot.')
    return p
  }

  private async keys<T>(fn: () => Promise<T>): Promise<T> {
    this.sendingKeys = true
    try {
      return await fn()
    } finally {
      // Let the key events settle before Esc means "pause" again.
      await sleep(150)
      this.sendingKeys = false
    }
  }

  /** Carries out one computer action. Returns the result's content. */
  private async act(name: string, input: Record<string, unknown>): Promise<Anthropic.ToolResultBlockParam['content']> {
    const w = this.window
    const mods = typeof input.text === 'string' && input.text ? macCombo(input.text) : undefined
    // lastPointer is set only once an action has moved the pointer, never before: a refused click leaves it where it was.
    const at = async (coordinate: unknown) => (coordinate === undefined ? null : this.point(coordinate))
    switch (name) {
      case 'screenshot':
        return [await this.screenshot()]
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click': {
        const p = (await at(input.coordinate)) ?? (await mouse())
        const button = name === 'right_click' ? 'right' : name === 'middle_click' ? 'middle' : 'left'
        const count = name === 'double_click' ? 2 : name === 'triple_click' ? 3 : 1
        const plain = (name === 'left_click' || name === 'double_click') && !mods
        const label = plain ? await this.labelFor(p) : ''
        await pointer.click(w, p, button, count, mods)
        this.lastPointer = p
        if (plain) this.record({ action: name === 'double_click' ? 'double_click' : 'click', label, ...this.toShot(p) })
        else this.record({ action: 'other', text: describeAction(name, input), ...this.toShot(p) })
        break
      }
      case 'left_click_drag': {
        const from = this.point(input.start_coordinate)
        const to = this.point(input.coordinate)
        await pointer.drag(w, from, to, mods)
        this.lastPointer = to
        this.record({ action: 'other', text: 'drag', ...this.toShot(from) })
        break
      }
      case 'mouse_move': {
        const p = this.point(input.coordinate)
        await pointer.move(w, p)
        this.lastPointer = p
        break
      }
      case 'left_mouse_down':
      case 'left_mouse_up':
        await pointer.button(w, name === 'left_mouse_down')
        break
      case 'cursor_position': {
        const p = await mouse()
        const s = this.shot
        if (!s) return 'Take a screenshot first.'
        return `[${Math.round(((p.x - s.frame.x) * s.width) / s.frame.width)}, ${Math.round(((p.y - s.frame.y) * s.height) / s.frame.height)}]`
      }
      case 'scroll': {
        const p = (await at(input.coordinate)) ?? (await mouse())
        const n = Math.max(1, Math.min(Number(input.scroll_amount) || 3, 30))
        const dir = String(input.scroll_direction)
        await pointer.scroll(w, p, dir === 'left' ? -n : dir === 'right' ? n : 0, dir === 'up' ? -n : dir === 'down' ? n : 0, mods)
        this.lastPointer = p
        this.record(mods ? { action: 'other', text: describeAction(name, input) } : { action: 'scroll', text: dir, amount: n, ...this.toShot(p) })
        break
      }
      case 'type':
        await this.keys(() => pointer.type(w, String(input.text ?? '')))
        this.record({ action: 'type', text: String(input.text ?? '') })
        break
      case 'key': {
        const repeat = Math.max(1, Number(input.repeat) || 1)
        await this.keys(() => pointer.key(w, macCombo(String(input.text ?? '')), repeat))
        for (let i = 0; i < Math.min(repeat, 20); i++) this.record({ action: 'key', text: String(input.text ?? '') })
        break
      }
      case 'hold_key':
        await this.keys(() => pointer.hold(w, macCombo(String(input.text ?? '')), Math.min(Number(input.duration) || 0.5, 10)))
        this.record({ action: 'other', text: describeAction(name, input) })
        break
      case 'wait':
        await sleep(Math.max(0, Math.min(Number(input.duration) || 1, 10)) * 1000)
        break
      default:
        throw new Error(`${name} isn’t available here.`)
    }
    // Pages react after a moment: give clicks and keys time to land before the next action.
    await sleep(name === 'type' ? 150 : 350)
    return 'OK'
  }

  /** Screenshot pixels for a point on screen, for recording where something was. */
  private toShot(p: { x: number; y: number }): { x: number; y: number } {
    const s = this.shot
    if (!s) return { x: 0, y: 0 }
    return { x: Math.round(((p.x - s.frame.x) * s.width) / s.frame.width), y: Math.round(((p.y - s.frame.y) * s.height) / s.frame.height) }
  }

  private record(step: Partial<ScriptStep> & Pick<ScriptStep, 'action'>) {
    this.trace.push({ label: '', x: 0, y: 0, text: '', amount: 0, choose: false, what: '', ...step })
  }

  /** The text under a click, read before clicking (after, the page may have changed). Empty on an icon, or if reading fails. */
  private async labelFor(p: { x: number; y: number }): Promise<string> {
    return (await labelAt(this.window, p).catch(() => null)) ?? ''
  }

  /**
   * Replays the saved script from step from until the next choose step (Claude's) or the end, finding
   * each click's label on screen. Returns where it stopped, and why if a step didn't work.
   */
  private async replay(script: ScriptStep[], from: number): Promise<{ next: number; problem?: string }> {
    const stop = nextChoose(script, from)
    for (let i = from; i < stop; i++) {
      this.check()
      await this.noticeMouse()
      if (this.pauseRequested) return { next: i, problem: 'the therapist paused' }
      const step = script[i]
      try {
        if (step.action === 'click' || step.action === 'double_click') {
          if (unsafeLabel(step.label)) return { next: i, problem: `“${step.label}” could sign, save, send or delete, so Echo won’t click it` }
          const hint = this.shot ? toScreen([step.x, step.y], this.shot) : null
          const target = await this.locate(step.label, hint)
          if ('error' in target) return { next: i, problem: `“${step.label}” is ${target.error}` }
          this.log(`Replayed: clicked “${step.label}”`)
          await pointer.click(this.window, target, 'left', step.action === 'double_click' ? 2 : 1)
          this.lastPointer = target
          this.record({ action: step.action, label: step.label, ...this.toShot(target) })
          await sleep(350)
        } else if (step.action === 'type') {
          const text = fillTemplate(step.text, this.ctx.client?.name ?? '')
          this.log(`Replayed: typed`)
          await this.keys(() => pointer.type(this.window, text))
          this.record({ action: 'type', text })
          await sleep(150)
        } else if (step.action === 'key') {
          this.log(`Replayed: ${describeAction('key', { text: step.text }).toLowerCase()}`)
          await this.keys(() => pointer.key(this.window, macCombo(step.text)))
          this.record({ action: 'key', text: step.text })
          await sleep(350)
        } else if (step.action === 'scroll') {
          const p = this.shot ? toScreen([step.x, step.y], this.shot) : null
          if (!p) return { next: i, problem: 'the place to scroll is off the window' }
          const n = Math.max(1, Math.min(step.amount || 3, 30))
          const dir = step.text
          await pointer.scroll(this.window, p, dir === 'left' ? -n : dir === 'right' ? n : 0, dir === 'up' ? -n : dir === 'down' ? n : 0)
          this.lastPointer = p
          this.record({ action: 'scroll', x: step.x, y: step.y, text: dir, amount: n })
          await sleep(350)
        } else {
          return { next: i, problem: 'Echo can’t replay that step' }
        }
      } catch (err) {
        if (err instanceof Stopped || this.stopped) throw new Stopped()
        return { next: i, problem: ((err as Error).message || 'that step failed').replace(/\.$/, '') }
      }
    }
    return { next: stop }
  }

  /** What comes after the recorded steps. */
  private get endOfScript(): string {
    return this.task === 'note'
      ? 'Check it’s the right client and session, put the cursor in the free-text box if it isn’t there, and call paste_note.'
      : 'Check it’s the right client and a new, empty plan, then fill in the form.'
  }

  /** What Claude is told after Echo replays part of the script. */
  private replayReport(script: ScriptStep[], from: number, r: { next: number; problem?: string }): string {
    const did = r.next > from ? `Echo replayed steps ${from + 1}–${r.next} by itself. ` : ''
    if (r.problem) return `${did}Step ${r.next + 1} (${scriptLine(script[r.next], r.next).replace(/^\d+\. /, '')}) didn’t work: ${r.problem}. Carry on yourself from what's on screen.`
    if (r.next >= script.length) return `${did}That's the end of the saved script. Check it's the right client and session, put the cursor in the free-text box if it isn't there, and call paste_note.`
    // This choose step and any right after it are Claude's; then Echo can carry on.
    let end = r.next
    while (end < script.length && script[end].choose) end++
    const yours = script
      .slice(r.next, end)
      .map((x, i) => `${r.next + i + 1}. ${x.what}`)
      .join('; ')
    const then =
      end < script.length
        ? ` Then call resume_script with from ${end + 1}.`
        : ' That’s the last step of the script: then check it’s the right client and session, put the cursor in the free-text box, and call paste_note.'
    return `${did}${end - r.next > 1 ? 'These steps are yours' : 'This step is yours'}: ${yours}.${then}`
  }

  /**
   * run_steps: clicks each step's label where it is on screen now, found by on-device text recognition,
   * so a remembered route can be replayed without asking Claude between steps. Stops at the first
   * step it can't do (and on a pause), and ends with one screenshot either way.
   */
  private async runSteps(steps: Step[]): Promise<Anthropic.ToolResultBlockParam['content']> {
    const done: string[] = []
    const finish = async (problem?: string) => {
      await sleep(problem ? 0 : 600)
      const summary = problem
        ? `${done.length ? `Did steps 1–${done.length}. ` : ''}Stopped at step ${done.length + 1}: ${problem}. Here's the EHR now.`
        : `Did all ${steps.length} steps. Here's the EHR now.`
      return [{ type: 'text' as const, text: summary }, await this.screenshot()]
    }
    for (const step of steps) {
      this.check()
      await this.noticeMouse()
      if (this.pauseRequested) return finish('the therapist paused you')
      try {
        if (step.action === 'click' || step.action === 'double_click') {
          const label = step.label.trim()
          if (!label) return finish('a click needs the visible text of what to click; use a normal click for targets without text')
          if (unsafeLabel(label)) return finish(`“${label}” could sign, save, send or delete, so Echo won’t click it`)
          const hint = this.shot && (step.x || step.y) ? toScreen([step.x, step.y], this.shot) : null
          const target = await this.locate(label, hint)
          if ('error' in target) return finish(`“${label}” is ${target.error}`)
          this.log(`Clicked “${label}”`)
          await pointer.click(this.window, target, 'left', step.action === 'double_click' ? 2 : 1)
          this.lastPointer = target
          this.record({ action: step.action, label, ...this.toShot(target) })
          await sleep(350)
        } else if (step.action === 'type') {
          this.log(describeAction('type', { text: step.text }))
          await this.keys(() => pointer.type(this.window, step.text))
          this.record({ action: 'type', text: step.text })
          await sleep(150)
        } else if (step.action === 'key') {
          this.log(describeAction('key', { text: step.text }))
          await this.keys(() => pointer.key(this.window, macCombo(step.text)))
          this.record({ action: 'key', text: step.text })
          await sleep(350)
        } else {
          await sleep(Math.max(0, Math.min(step.seconds || 1, 10)) * 1000)
        }
        done.push(step.action)
      } catch (err) {
        if (err instanceof Stopped || this.stopped) throw new Stopped()
        const message = (err as Error).message || 'that step failed'
        this.log(`Couldn’t: ${message}`)
        return finish(message.replace(/\.$/, ''))
      }
    }
    return finish()
  }

  /** Where a label is on screen, waiting for it to load. */
  private async locate(label: string, hint: { x: number; y: number } | null): Promise<{ x: number; y: number } | { error: string }> {
    const until = Date.now() + STEP_WAIT_MS
    let last: { x: number; y: number } | { error: string } = { error: 'not on screen' }
    for (;;) {
      this.check()
      last = pickMatch(await findText(this.window, label), hint)
      // Found it, or found it in more than one place (waiting won't help that).
      if (!('error' in last) || last.error !== 'not on screen' || Date.now() > until) return last
      await sleep(400)
    }
  }

  /** Puts the note on the clipboard, pastes it, and keeps what was on the clipboard to put back afterwards. */
  private async paste() {
    const { note, client, settings } = this.ctx
    if (!note || !client) throw new Error('There’s no note to paste in this run.')
    if (!this.savedClipboard) this.savedClipboard = await clipboard.read().catch(() => [])
    await clipboard.write([new ClipboardItem({ 'text/plain': noteToText(note, client, settings), 'text/html': noteToHtml(note, client, settings) })])
    await this.keys(() => pointer.key(this.window, 'cmd+v'))
    await sleep(800)
    this.status = { ...this.status, placedAt: new Date().toISOString() }
    this.ctx.emit(this.status)
  }

  /** Plans: pastes one field's text at the cursor, as plain text, and keeps it for the check at the end. */
  private async fill(text: string) {
    if (!this.savedClipboard) this.savedClipboard = await clipboard.read().catch(() => [])
    clipboard.writeText(text)
    await this.keys(() => pointer.key(this.window, 'cmd+v'))
    await sleep(400)
    this.filled.push(text)
  }

  /** Puts back whatever was on the clipboard before the paste (text, a link, an image…). */
  private restoreClipboard() {
    const saved = this.savedClipboard
    if (!saved) return
    this.savedClipboard = null
    if (saved.length) void clipboard.write(saved).catch(() => clipboard.clear())
    else clipboard.clear()
  }

  private addCost(usage: Anthropic.Usage) {
    const [inPrice, outPrice] = PRICES[this.model] ?? [4, 20]
    const fresh = usage.input_tokens ?? 0
    const read = usage.cache_read_input_tokens ?? 0
    const written = usage.cache_creation_input_tokens ?? 0
    this.cost += ((fresh + read * 0.05 + written * 1.25) * inPrice + (usage.output_tokens ?? 0) * outPrice) / 1e6
  }

  async run(): Promise<void> {
    const { note, settings } = this.ctx
    const client = this.ctx.client
    if (this.task === 'plan' && client?.plan) this.pieces = planPieces(client.plan, client.name)
    this.ctx.emit(this.status)
    try {
      const missing = await missingPermissions()
      if (missing) throw new Error(missing)

      // Escape pauses, unless it's Claude pressing it in the EHR.
      globalShortcut.register('Escape', () => {
        if (!this.sendingKeys) this.pause('You pressed Esc, so Claude paused.')
      })

      const bounds = this.ctx.showBeside ? await this.ctx.showBeside(this.ehr.id, !!this.ctx.newTab) : await showEhr(settings.ehrs, this.ehr.id, !!this.ctx.newTab)
      if (!bounds) throw new Error('The Navigator needs Google Chrome.')
      this.chrome = bounds
      // A new tab starts loading from scratch.
      await sleep(this.ctx.newTab ? 2000 : 900)
      this.window = await findWindow(bounds)
      this.check()

      const task = this.task === 'signin'
        ? signInTask(this.ehr.name)
        : note && client
        ? placeTask({
            ehrName: this.ehr.name,
            clientName: client.name,
            noteLabel: `${NOTE_TYPE_LABEL[note.type]}${note.session.cpt ? ` (${note.session.cpt})` : ''}`,
            sessionDate: note.session.date,
            today: localToday(),
            now: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
            details: { cpt: note.session.cpt, setting: note.session.setting, ...pickTimeOffsets() },
            instructions: this.learned.instructions,
            route: this.learned.route
          })
        : planTask({
            ehrName: this.ehr.name,
            clientName: client!.name,
            today: localToday(),
            pieces: this.pieces,
            diagnoses: client!.diagnoses,
            instructions: this.learned.instructions,
            route: this.learned.route
          })
      this.set('running', '')
      // Timed from here: opening Chrome takes the same time whatever the route.
      this.startedAt = Date.now()
      await this.screenshot()

      // With a recorded script, Echo goes as far as it can by itself before asking Claude anything.
      const script = this.learned.script ?? []
      let intro = ''
      if (script.length) {
        this.log(`Replaying the ${script.length} recorded steps in ${this.ehr.name}`)
        const r = await this.replay(script, 0)
        intro = `\n\nThe saved script, as Echo recorded it (steps marked choose are yours):\n${script.map(scriptLine).join('\n')}\n\n${this.replayReport(script, 0, r)}`
        await this.pauseIfAsked((g) => (intro += g ? `\nThe therapist paused Echo and says: ${g}` : '\nThe therapist paused Echo, and may have done a step themselves.'))
      } else {
        this.log(this.task === 'signin' ? `Checking you’re signed in to ${this.ehr.name}` : this.learned.route ? `Following the saved route in ${this.ehr.name}` : `Finding the way in ${this.ehr.name} for the first time`)
      }
      const first = await this.screenshot()
      const unattended = this.ctx.unattended ? UNATTENDED_NOTE : ''
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: [{ type: 'text', text: task + unattended + intro }, first] }]

      const api = anthropic(this.ctx.apiKey)
      const maxTurns = this.task === 'signin' ? MAX_SIGNIN_TURNS : MAX_PLACE_TURNS
      for (let turn = 0; turn < maxTurns; turn++) {
        this.check()
        // Anything that came up over Echo (another app, Chrome's other windows) goes back behind it.
        if (this.chrome) this.ctx.keepEchoBeside?.(this.chrome)
        let response: Anthropic.Message
        try {
          const stream = api.messages.stream(
            {
              model: this.model,
              max_tokens: 32000,
              // The conversation only grows, so each request reads the one before it from the cache.
              cache_control: { type: 'ephemeral' },
              system: this.task === 'note' ? PLACE_SYSTEM : this.task === 'plan' ? PLAN_SYSTEM : SIGNIN_SYSTEM,
              tools: TOOLS[this.task],
              output_config: { effort: 'medium' },
              messages
            },
            { signal: this.abort.signal }
          )
          response = await stream.finalMessage()
        } catch (err) {
          if (this.stopped) throw new Stopped()
          throw friendly(err)
        }
        this.addCost(response.usage)
        if (response.stop_reason === 'refusal') throw new Error(`Claude declined to continue. Chart ${this.what} by hand.`)
        messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] })

        for (const block of response.content) if (block.type === 'text' && block.text.trim()) this.log(`Claude: ${block.text.trim()}`)
        const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        if (!calls.length) {
          if (response.stop_reason === 'max_tokens') throw new Error('Claude ran out of room to answer. Try again.')
          throw new Error('Claude stopped without finishing.')
        }

        const results: Anthropic.ContentBlockParam[] = []
        let halted = ''
        let finished: { placed: boolean; summary: string } | null = null
        for (const call of calls) {
          const input = (call.input ?? {}) as Record<string, unknown>
          const isComputer = call.toolset_name === 'computer'
          const result = (content: Anthropic.ToolResultBlockParam['content'], isError = false): Anthropic.ToolResultBlockParam => ({
            type: 'tool_result',
            tool_use_id: call.id,
            ...(isComputer ? { toolset_name: 'computer' } : {}),
            content,
            ...(isError ? { is_error: true } : {})
          })
          if (halted || this.stopped) {
            results.push(result(`Not executed: ${halted || 'the therapist stopped the run.'}`, true))
            continue
          }
          if (isComputer && call.name !== 'screenshot') await this.noticeMouse()
          if (this.pauseRequested) {
            halted = 'the therapist paused you before this action. Look at the new screenshot before carrying on.'
            results.push(result(`Not executed: ${halted}`, true))
            continue
          }
          try {
            if (isComputer) {
              this.log(describeAction(call.name, input))
              results.push(result(await this.act(call.name, input)))
            } else if (call.name === 'run_steps') {
              const steps = (Array.isArray(input.steps) ? input.steps : []) as Step[]
              results.push(result(steps.length ? await this.runSteps(steps) : 'No steps given.'))
            } else if (call.name === 'resume_script') {
              const script = this.learned.script ?? []
              const from = Math.max(1, Math.floor(Number(input.from) || 1)) - 1
              if (!script.length || from >= script.length) {
                results.push(result(script.length ? `The script has ${script.length} steps.` : 'There’s no saved script this time: carry on yourself.', true))
              } else {
                const r = await this.replay(script, from)
                results.push(result([{ type: 'text', text: this.replayReport(script, from, r) }, await this.screenshot()]))
              }
            } else if (call.name === 'fill_field' && this.task === 'plan') {
              const text = String(input.text ?? '')
              this.log(`Filled a field (${text.length} characters)`)
              await this.fill(text)
              // The first fill marks the end of getting there: Claude gets the recorded steps for done's path now.
              const steps = this.listedTrace ? '' : `\n\nThe steps Echo recorded getting here, for done's path (number them as here):\n${this.trace.map(scriptLine).join('\n') || '(none)'}`
              this.listedTrace = true
              this.record({ action: 'other', text: 'filled a field' })
              results.push(result(`Pasted.${steps}`))
            } else if (call.name === 'paste_note' && this.task === 'note') {
              this.log('Pasted the note')
              await this.paste()
              const steps = this.trace.map(scriptLine).join('\n') || '(none)'
              results.push(result(`Pasted. Take a screenshot to check the note is in the box, then call done.\n\nThe steps Echo recorded this run, for done's path (number them as here):\n${steps}`))
            } else if (call.name === 'ask_clinician' && this.ctx.unattended) {
              // Nobody to answer in a batch: leave this note where it is for the clinician and move on.
              const question = String(input.question ?? '').trim()
              this.log(`Claude asked: ${question}`)
              finished = { placed: false, summary: question ? `Claude needs you: ${question}` : 'Claude needs you to finish this one.' }
              halted = 'the run ended.'
              results.push(result('Echo has left this note for the therapist.'))
            } else if (call.name === 'ask_clinician') {
              const question = String(input.question ?? '').trim()
              this.log(`Claude asked: ${question}`)
              const answer = await this.wait('asking', question)
              this.check()
              if (answer) this.log(`You: ${answer}`)
              this.lastPointer = null
              results.push(
                result([
                  { type: 'text', text: answer ? `The therapist says: ${answer}` : 'The therapist carried on without answering. They may have done the step themselves: look at the screenshot.' },
                  await this.screenshot()
                ])
              )
            } else if (call.name === 'done' && this.task === 'signin') {
              finished = { placed: !!input.signed_in, summary: String(input.summary ?? '').trim() }
              results.push(result('OK'))
            } else if (call.name === 'done' && this.task === 'plan' && input.placed && !this.checkedCoverage && unplacedPieces(this.pieces, this.filled).length) {
              // Once: before finishing a plan, Claude hears which pieces aren't in the form anywhere.
              this.checkedCoverage = true
              const missing = unplacedPieces(this.pieces, this.filled)
              this.log(`Echo found ${missing.length} part${missing.length === 1 ? '' : 's'} of the plan not filled in yet`)
              results.push(
                result(
                  `Not done yet. These parts of the plan aren't in the form anywhere: ${missing.map((m) => `[${m.id}] ${m.label}`).join('; ')}. Place each one where it belongs, then call done again. If the form truly has nowhere for one, call done again and name it in the summary.`,
                  true
                )
              )
            } else if (call.name === 'done') {
              finished = { placed: !!input.placed, summary: String(input.summary ?? '').trim() }
              const route = keepable(String(input.route ?? ''), client!.name)
              const path = (Array.isArray(input.path) ? input.path : []) as { step: number; choose: boolean; what: string }[]
              const script = buildScript(this.trace, path, client!.name)
              const turns = turn + 1
              const seconds = this.activeSeconds()
              const saved = this.learned
              const better = betterRoute({
                placed: finished.placed,
                route,
                fixed: !!input.fixed,
                turns,
                seconds,
                saved: saved.route,
                savedTurns: saved.routeTurns,
                savedSeconds: saved.routeSeconds,
                script: script.length > 0,
                savedScript: !!saved.script?.length
              })
              if (better) {
                const previousRoute = saved.route || undefined
                const why = !previousRoute
                  ? ''
                  : input.fixed
                    ? ', corrected'
                    : script.length && !saved.script?.length
                      ? ', with steps Echo can replay'
                      : saved.routeSeconds !== undefined
                        ? `, ${seconds} s instead of ${saved.routeSeconds} s`
                        : `, ${turns} requests instead of ${saved.routeTurns}`
                const replayable = script.filter((x) => !x.choose).length
                this.log(
                  `${previousRoute ? `Saved a better route${why}` : `Saved the route for next time (${seconds} s)`}${script.length ? `: Echo can replay ${replayable} of its ${script.length} steps` : ''}`
                )
                const patch = {
                  route,
                  previousRoute,
                  routeTurns: turns,
                  routeSeconds: seconds,
                  // No path this time: keep the recorded steps, unless the route was corrected (they'd be out of date).
                  script: script.length ? script : input.fixed ? undefined : saved.script,
                  previousScript: saved.script
                }
                this.saveLearned(patch)
              } else if (saved.route) {
                this.log(finished.placed ? `Kept the saved route (${seconds} s${saved.routeSeconds !== undefined ? `; its best is ${saved.routeSeconds} s` : ''})` : 'Kept the saved route')
                // The first placed run on a route without a time gives it one, for later runs to beat.
                if (finished.placed && saved.routeSeconds === undefined) {
                  const patch = { routeTurns: turns, routeSeconds: seconds }
                  this.saveLearned(patch)
                }
              }
              results.push(result('OK'))
            } else {
              results.push(result(`There's no tool called ${call.name}.`, true))
            }
          } catch (err) {
            if (err instanceof Stopped || this.stopped) throw new Stopped()
            halted = 'an earlier action in this turn failed.'
            const message = (err as Error).message || 'That action failed.'
            this.log(`Couldn’t: ${message}`)
            results.push(result(message, true))
          }
        }

        if (finished) {
          if (finished.placed) {
            if (this.task === 'signin') {
              this.set('placed', `Signed in to ${this.ehr.name}.${this.costNote()}`)
            } else if (this.task === 'plan') {
              // Plans count as charted once Claude has filled in the form (a note, once it's pasted).
              this.status = { ...this.status, placedAt: new Date().toISOString() }
              const missing = unplacedPieces(this.pieces, this.filled)
              const gaps = missing.length ? ` Not filled in anywhere: ${missing.map((m) => m.label).join('; ')}.` : ''
              this.set('placed', `${finished.summary || `The plan is filled in in ${this.ehr.name}.`}${gaps} Review it and sign it there.${this.costNote()}`)
            } else {
              this.set('placed', `${finished.summary || `The note is in ${this.ehr.name}.`} Review it and sign it there.${this.costNote()}`)
            }
          } else {
            this.set('failed', `${finished.summary || `Claude couldn’t chart ${this.what}.`}${this.costNote()}`)
          }
          return
        }

        // Paused: wait for the clinician, then carry on from what's on screen now.
        if (this.pauseRequested) {
          const reason = this.pauseRequested
          this.pauseRequested = ''
          this.log('Paused')
          const guidance = await this.wait('paused', reason)
          this.check()
          this.lastPointer = null
          this.keepGuidance(guidance)
          results.push({
            type: 'text',
            text: guidance
              ? `The therapist paused you and says: ${guidance}\nThey may also have clicked something themselves. Here's the EHR now.`
              : 'The therapist paused you and carried on. They may have done a step themselves. Here’s the EHR now.'
          })
          results.push(await this.screenshot())
        } else if (this.pendingGuidance) {
          const guidance = this.pendingGuidance
          this.pendingGuidance = ''
          this.keepGuidance(guidance)
          results.push({ type: 'text', text: `The therapist says: ${guidance}` })
        }
        messages.push({ role: 'user', content: results })
      }
      throw new Error(
        this.task === 'signin' ? `Claude couldn’t sign in to ${this.ehr.name}. Sign in yourself, then try again.` : `Claude took too many steps, so Echo stopped it. Chart ${this.what} by hand, or try again.`
      )
    } catch (err) {
      if (err instanceof Stopped || this.stopped) this.set('stopped', `Stopped.${this.costNote()}`)
      else this.set('failed', `${screenMessage((err as Error).message)}${this.costNote()}`)
    } finally {
      globalShortcut.unregister('Escape')
      // Give the paste time to finish before the clipboard goes back to what it was.
      setTimeout(() => this.restoreClipboard(), 1500)
      stopPointer()
    }
  }

  private costNote(): string {
    return this.cost > 0.005 ? ` (about $${this.cost.toFixed(2)})` : ''
  }
}

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The EHR a client's notes go into: the one chosen for them, or the only one there is. */
export function ehrFor(client: Client, settings: Settings): Ehr | undefined {
  return ehrForClient(client, settings.ehrs)
}

/** Why Echo can't work in the EHR yet (asking macOS for what's missing), or '' when it can. */
async function missingPermissions(): Promise<string> {
  const allowed = await permissions(false)
  if (allowed.screen && allowed.accessibility) return ''
  await permissions(true)
  const missing = [!allowed.screen && 'Screen Recording', !allowed.accessibility && 'Accessibility'].filter(Boolean).join(' and ')
  return `Echo needs ${missing} to work in your EHR. Turn Echo on under System Settings › Privacy & Security › ${missing}, then quit and reopen Echo.`
}

/** Screen capture finds no display while the Mac is locked or its display is asleep: say so plainly. */
function screenMessage(message: string): string {
  return /no display found/i.test(message) ? 'The Mac’s screen was locked or asleep, so Echo couldn’t see the EHR. Unlock it and try again.' : message
}

/** The EHR to place in, or why the Navigator can't start. */
function readyToPlace(ctx: PlaceContext): Ehr {
  if (ctx.note && ctx.note.status !== 'final') throw new Error('Finalize the note before placing it.')
  if (!ctx.note && !ctx.client.plan?.goals.length) throw new Error('This client doesn’t have a treatment plan in Echo yet.')
  const ehr = ehrFor(ctx.client, ctx.settings)
  if (!ehr) throw new Error('Choose which EHR this client is charted in first.')
  return ehr
}

export async function placeNote(ctx: PlaceContext): Promise<void> {
  if (current || batch) throw new Error('The Navigator is already working in an EHR.')
  const ehr = readyToPlace(ctx)
  const run = new Run({ ...ctx, newTab: ctx.newTab || tabsHeld }, { ...ehr })
  current = run
  void run.run().finally(() => {
    if (current === run) current = null
  })
}

/**
 * Places several notes one after another without stopping in between. First, while the clinician is still at
 * the Mac, each EHR the notes need is checked for being signed in (Claude signs in with Chrome's saved password,
 * and asks the clinician for any two-step code). Then each note gets its own Chrome tab (the first in each EHR
 * reuses the one already open), left on the note for the clinician to review and sign. A question ends that
 * note's run and the batch moves on. contextFor reads the note afresh when its turn comes, so later notes use the
 * route earlier ones saved. Resolves once the batch has started.
 */
export async function placeNotes(noteIds: string[], contextFor: (noteId: string) => PlaceContext, emit: (batch: PlaceBatch) => void): Promise<void> {
  if (current || batch) throw new Error('The Navigator is already working in an EHR.')
  if (!noteIds.length) throw new Error('There are no finalized notes to place.')
  const missing = await missingPermissions()
  if (missing) throw new Error(missing)
  const items = noteIds.map((id) => {
    const ctx = contextFor(id)
    const ehr = ehrFor(ctx.client, ctx.settings)
    return { noteId: id, clientId: ctx.client.id, ehrId: ehr?.id ?? '', ehrName: ehr?.name ?? '', state: 'waiting' as const, message: '' }
  })
  // Each EHR once, in the order the notes need them, with the first note that needs it (for its context).
  const needed = new Map<string, { ehrName: string; noteId: string }>()
  for (const item of items) if (item.ehrId && !needed.has(item.ehrId)) needed.set(item.ehrId, { ehrName: item.ehrName, noteId: item.noteId })
  const state: PlaceBatch = {
    done: false,
    signIns: [...needed].map(([ehrId, { ehrName }]) => ({ ehrId, ehrName, state: 'waiting' as const, message: '' })),
    items: items.map(({ ehrId: _, ...item }) => item)
  }
  const me = { stopped: false }
  batch = me
  const update = (i: number, patch: Partial<PlaceBatch['items'][number]>) => {
    state.items = state.items.map((item, k) => (k === i ? { ...item, ...patch } : item))
    emit({ ...state })
  }
  const updateSignIn = (i: number, patch: Partial<PlaceBatchSignIn>) => {
    state.signIns = state.signIns.map((s, k) => (k === i ? { ...s, ...patch } : s))
    emit({ ...state })
  }
  emit({ ...state })

  void (async () => {
    const opened = new Set<string>()
    // The clinician steps away: keep the display awake (and so the Mac unlocked) until the batch ends, or every note would fail on a locked screen.
    const awake = powerSaveBlocker.start('prevent-display-sleep')
    try {
      // Signed in to each EHR first, while the clinician can still answer.
      for (let i = 0; i < state.signIns.length && !me.stopped; i++) {
        const { ehrId } = state.signIns[i]
        let run: Run
        try {
          const ctx = contextFor(needed.get(ehrId)!.noteId)
          const ehr = ehrFor(ctx.client, ctx.settings)
          if (!ehr || ehr.id !== ehrId) throw new Error('This EHR isn’t in Settings › EHRs any more.')
          // Attended, in the tab already open: it only looks, and clicks only on a sign-in page.
          run = new Run(
            {
              ...ctx,
              client: undefined,
              note: undefined,
              signin: true,
              unattended: false,
              newTab: false,
              emit: (status) => {
                ctx.emit(status)
                // Asking for a code shows on the EHR's row as well as in the panel.
                if (state.signIns[i].state !== status.state) updateSignIn(i, { state: status.state })
              }
            },
            { ...ehr }
          )
        } catch (err) {
          updateSignIn(i, { state: 'failed', message: (err as Error).message })
          continue
        }
        updateSignIn(i, { state: 'starting' })
        current = run
        await run.run()
        if (current === run) current = null
        updateSignIn(i, { state: run.result.state, message: run.result.message })
        if (run.result.state === 'stopped') me.stopped = true
      }
      // A note whose EHR isn't signed in waits for the clinician.
      state.signIns.forEach((s) => {
        if (s.state === 'placed' || me.stopped) return
        const why = s.message.replace(/\s*\(about \$[\d.]+\)\s*$/, '')
        state.items = state.items.map((item, k) =>
          items[k].ehrId === s.ehrId && item.state === 'waiting' ? { ...item, state: 'failed', message: `Not signed in to ${s.ehrName}${why ? `: ${why}` : '.'}` } : item
        )
      })
      emit({ ...state })

      for (let i = 0; i < state.items.length && !me.stopped; i++) {
        if (state.items[i].state !== 'waiting') continue
        if (opened.size) await sleep(1000)
        if (me.stopped) break
        let run: Run
        try {
          const ctx = contextFor(state.items[i].noteId)
          const ehr = readyToPlace(ctx)
          const newTab = tabsHeld || opened.has(ehr.id)
          opened.add(ehr.id)
          run = new Run(
            {
              ...ctx,
              unattended: true,
              newTab,
              emit: (status) => {
                ctx.emit(status)
                if (state.items[i].state !== status.state) update(i, { state: status.state })
              }
            },
            { ...ehr }
          )
        } catch (err) {
          update(i, { state: 'failed', message: (err as Error).message })
          continue
        }
        current = run
        await run.run()
        if (current === run) current = null
        update(i, { state: run.result.state, message: run.result.message })
        if (run.result.placedAt) tabsHeld = true
      }
    } finally {
      powerSaveBlocker.stop(awake)
      if (batch === me) batch = null
      state.done = true
      emit({ ...state })
    }
  })()
}

export const placeControls = {
  pause: () => current?.pause('Paused.'),
  resume: (guidance?: string) => current?.resume(guidance ?? ''),
  stop: () => {
    if (batch) batch.stopped = true
    current?.stop()
  }
}
