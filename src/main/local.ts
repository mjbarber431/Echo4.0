import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MODEL_FAILURE } from '../shared/queue'
import { LOCAL_MODEL } from '../shared/types'
import type { AiNoteResult, Client, GoalStatus, Note, Settings } from '../shared/types'
import { buildAmendMessages, buildNoteMessages, NOTE_SCHEMA, sectionsFor, type ChatMessage } from '../shared/prompts'

// EXPERIMENTAL, and separate from the Claude pipeline in ai.ts: notes written
// by Qwen3.5-9B (4-bit, MLX) on this Mac, through mlx-lm's OpenAI-compatible
// server. Nothing leaves the computer. Only notes and amendments come here;
// plans, context rebuilds and live coverage stay on Claude.
//
// To remove: delete this file, LOCAL_MODEL and the two optional settings in
// types.ts, the lines that mention `local` in index.ts, and the Experimental
// group in SettingsView.tsx.
//
// Needs mlx-lm (`pipx install mlx-lm`). The model (about 6 GB) is downloaded
// into the Hugging Face cache the first time it's used. To free the space:
//   hf cache delete
// (Deleting only the models--… folder isn't enough: newer huggingface_hub keeps the weights in hub/blobs.)

export class LocalError extends Error {}

/** Qwen can get stuck in a thinking loop. Past this much thinking, the note is written again without it. */
const THINKING_BUDGET_CHARS = 16_000
class ThinkingOverrun extends Error {}

/** mlx_lm.server isn't on the PATH of an app opened from Finder, so the usual install locations are tried. */
function serverPath(): string {
  const found = [join(homedir(), '.local/bin/mlx_lm.server'), '/opt/homebrew/bin/mlx_lm.server', '/usr/local/bin/mlx_lm.server'].find((p) => existsSync(p))
  if (!found) throw new LocalError('mlx-lm isn’t installed. In Terminal, run: pipx install mlx-lm')
  return found
}

let download: Promise<void> | null = null

/**
 * Makes sure the model is in the Hugging Face cache, downloading what's missing, using
 * mlx-lm's own Python. Only the model files are fetched; no note text is involved.
 * When there's no connection, a complete cached copy is used as is.
 */
export function ensureModel(): Promise<void> {
  if (download) return download
  download = new Promise<void>((resolve, reject) => {
    const python = readFileSync(serverPath(), 'utf8').split('\n')[0].replace(/^#!/, '').trim()
    const script = `import sys
from huggingface_hub import snapshot_download
try:
    snapshot_download(sys.argv[1])
except Exception:
    snapshot_download(sys.argv[1], local_files_only=True)`
    const proc = spawn(python, ['-c', script, LOCAL_MODEL.repo], { env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
    proc.once('error', (err) => reject(new LocalError(`Couldn’t download the local model: ${err.message}`)))
    proc.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new LocalError(`Couldn’t download the local model (about 6 GB). Check your internet connection and try again.${stderr.trim() ? ` ${stderr.trim().split('\n').pop()}` : ''}`))
    })
  }).finally(() => {
    download = null
  })
  return download
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

let child: ChildProcess | null = null
let ready: Promise<string> | null = null
let idleTimer: NodeJS.Timeout | null = null

/** The model holds about 6 GB of memory, so the server stops after a while unused. */
const IDLE_MS = 10 * 60_000

function touch(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(stopLocal, IDLE_MS)
}

export function stopLocal(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  child?.kill()
  child = null
  ready = null
}

/** Starts the server on first use and resolves with its base URL once the model has loaded. */
function server(): Promise<string> {
  if (ready) return ready
  ready = (async () => {
    await ensureModel()
    const port = await freePort()
    const proc = spawn(
      serverPath(),
      // Loopback only, and no CORS origin is allowed, so web pages in a browser can't use it.
      ['--model', LOCAL_MODEL.repo, '--host', '127.0.0.1', '--port', String(port), '--allowed-origins', 'none', '--log-level', 'WARNING'],
      // Offline: the model must already be downloaded, and nothing is fetched or reported while notes are written.
      { env: { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' }, stdio: ['ignore', 'ignore', 'pipe'] }
    )
    child = proc
    // Kept in memory only, for a startup error message. Never logged.
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
    let exited = false
    proc.once('exit', () => {
      exited = true
      if (child === proc) stopLocal()
    })
    const base = `http://127.0.0.1:${port}`
    for (const started = Date.now(); Date.now() - started < 180_000; ) {
      if (exited) throw new LocalError(startupError(stderr))
      try {
        if ((await fetch(`${base}/health`)).ok) return base
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    stopLocal()
    throw new LocalError('The local model took too long to start.')
  })()
  ready.catch(() => stopLocal())
  return ready
}

function startupError(stderr: string): string {
  if (/LocalEntryNotFound|offline mode|snapshot_download|not found in.*cache/i.test(stderr)) {
    return 'The local model’s download is incomplete. Try again to finish it.'
  }
  const last = stderr.trim().split('\n').pop()
  return `The local model couldn’t start${last ? `: ${last}` : '.'}`
}

/** Without schema-constrained decoding, the schema goes in the instructions and the reply is checked afterwards. */
function withJsonInstructions(messages: ChatMessage[]): ChatMessage[] {
  const rules = `OUTPUT FORMAT\nReply with a single JSON object and nothing else: no markdown fences, no commentary. It must match this JSON Schema exactly:\n${JSON.stringify(NOTE_SCHEMA)}`
  return messages.map((m) => (m.role === 'system' ? { ...m, content: `${m.content}\n\n${rules}` } : m))
}

/** Streams a chat completion and returns the answer text. Streaming keeps a long note from hitting fetch's header timeout. */
async function complete(messages: ChatMessage[], thinking: boolean): Promise<string> {
  const base = await server()
  touch()
  // Qwen's recommended sampling for each mode. The presence penalty also discourages loops.
  const sampling = thinking ? { temperature: 1.0, top_p: 0.95, top_k: 20, presence_penalty: 1.5 } : { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 }
  // Aborting the request is how the server is told to stop generating.
  const abort = new AbortController()
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    signal: abort.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LOCAL_MODEL.repo,
      messages,
      stream: true,
      max_tokens: thinking ? 12000 : 8000,
      ...sampling,
      chat_template_kwargs: { enable_thinking: thinking }
    })
  }).catch(() => {
    throw new LocalError('Couldn’t reach the local model. Try again.')
  })
  if (!res.ok || !res.body) throw new LocalError(`The local model returned an error (${res.status}).`)

  let text = ''
  let reasoning = 0
  let finish: string | null = null
  let buffer = ''
  const decoder = new TextDecoder()
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      const choice = (JSON.parse(data) as { choices?: { delta?: { content?: string; reasoning?: string }; finish_reason?: string | null }[] }).choices?.[0]
      // Thinking arrives as delta.reasoning. Only its length is kept.
      reasoning += choice?.delta?.reasoning?.length ?? 0
      if (reasoning > THINKING_BUDGET_CHARS) {
        abort.abort()
        throw new ThinkingOverrun()
      }
      text += choice?.delta?.content ?? ''
      finish = choice?.finish_reason ?? finish
    }
  }
  touch()
  if (finish === 'length') throw new LocalError(MODEL_FAILURE.cutOff)
  if (!text.trim()) throw new LocalError(MODEL_FAILURE.empty)
  return text
}

/** The outermost JSON object in the reply, past any stray thinking or code fences. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new LocalError('The reply had no JSON object.')
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch (err) {
    throw new LocalError(`The reply wasn’t valid JSON (${(err as Error).message}).`)
  }
}

const GOAL_STATUSES: GoalStatus[] = ['not_started', 'in_progress', 'partially_met', 'met', 'discontinued']
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/**
 * Coerces a parsed reply into the shape NOTE_SCHEMA would have guaranteed. Throws only when
 * the note itself is unusable (a required section missing), so the request can be retried.
 */
export function normalizeNote(raw: unknown, headings: string[], client: Client): AiNoteResult {
  const r = obj(raw)
  const key = (h: string) => h.trim().toLowerCase().replace(/:$/, '')
  const given = list(r.sections).map(obj)
  const missing: string[] = []
  const sections = headings.map((heading) => {
    const found = given.find((s) => key(str(s.heading)) === key(heading))
    if (!found || !str(found.body).trim()) missing.push(heading)
    return { heading, body: str(found?.body) }
  })
  if (missing.length) throw new LocalError(`The reply was missing these sections: ${missing.join(', ')}.`)

  const goalIds = new Set(client.plan?.goals.map((g) => g.id) ?? [])
  const meta = r.plan_meta && typeof r.plan_meta === 'object' ? obj(r.plan_meta) : null
  return {
    sections,
    goal_updates: list(r.goal_updates)
      .map(obj)
      .filter((u) => goalIds.has(str(u.goal_id)) && GOAL_STATUSES.includes(str(u.status) as GoalStatus))
      .map((u) => ({ goal_id: str(u.goal_id), status: str(u.status) as GoalStatus, progress: str(u.progress) })),
    new_goals: list(r.new_goals)
      .map(obj)
      .filter((g) => str(g.goal).trim())
      .map((g) => ({ problem: str(g.problem), goal: str(g.goal), objectives: list(g.objectives).map(str).filter(Boolean), interventions: str(g.interventions) })),
    plan_meta: meta ? { frequency: str(meta.frequency), modalities: str(meta.modalities), discharge_criteria: str(meta.discharge_criteria) } : null,
    diagnoses: list(r.diagnoses)
      .map(obj)
      .filter((d) => str(d.code).trim())
      .map((d) => ({ code: str(d.code), description: str(d.description) })),
    context_update: str(r.context_update),
    // Always flagged, so a local draft is never mistaken for one Claude wrote.
    review_items: [`Written by ${LOCAL_MODEL.label} on this Mac (experimental). Check it carefully.`, ...list(r.review_items).map(str).filter((x) => x.trim())]
  }
}

/** One retry, with the problem fed back, before giving up. */
async function writeNote(messages: ChatMessage[], headings: string[], client: Client, settings: Settings): Promise<AiNoteResult> {
  const prompt = withJsonInstructions(messages)
  let thinking = !!settings.localThinking
  let overran = false
  let problem = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const retry: ChatMessage[] = problem
      ? [{ role: 'user', content: `Your previous reply couldn’t be used: ${problem} Reply again with the complete JSON object only, with every required section.` }]
      : []
    let text: string
    try {
      text = await complete([...prompt, ...retry], thinking)
    } catch (err) {
      if (!(err instanceof ThinkingOverrun)) throw err
      // A loop isn't a bad reply, so it doesn't use up the retry.
      thinking = false
      overran = true
      attempt--
      continue
    }
    try {
      const result = normalizeNote(extractJson(text), headings, client)
      if (overran) result.review_items.splice(1, 0, 'The local model’s thinking ran too long, so this note was written without it.')
      return result
    } catch (err) {
      if (!(err instanceof LocalError)) throw err
      problem = err.message
    }
  }
  throw new LocalError(`The local model’s reply couldn’t be used: ${problem} Try again, or switch the local model off in Settings.`)
}

export async function generateNote(settings: Settings, note: Note, client: Client, priorNotes: Note[]): Promise<AiNoteResult> {
  return writeNote(buildNoteMessages({ note, client, settings, priorNotes }), sectionsFor(note.type, note.format), client, settings)
}

export async function amendNote(settings: Settings, note: Note, client: Client, priorNotes: Note[], followUp: string, flagged: string[]): Promise<AiNoteResult> {
  return writeNote(
    buildAmendMessages({ note, client, settings, priorNotes, followUp, flagged }),
    note.sections.map((s) => s.heading),
    client,
    settings
  )
}
