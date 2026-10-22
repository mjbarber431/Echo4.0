import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { TranscriberStatus } from '../shared/types'

// Speech-to-text on this Mac. The EchoTranscriber helper (native/transcriber)
// runs Parakeet on the Neural Engine; audio never leaves the computer. It's one
// long-lived child process that keeps the model loaded, talking JSON lines over
// stdin/stdout, so nothing listens on a port. If it exits, the next request
// starts a fresh one. The model is downloaded once into Echo's data folder.

interface Reply {
  id: number
  type: 'progress' | 'result'
  ok?: boolean
  text?: string
  error?: string
  fraction?: number
  /** FluidAudio's phase: listing, downloading(…) or compiling(…). */
  phase?: string
}

interface Pending {
  resolve(reply: Reply): void
  reject(err: Error): void
  progress?(reply: Reply): void
}

/** The helper process went away mid-request (as opposed to reporting an error). */
class HelperExited extends Error {}

type Listener = (status: TranscriberStatus) => void

function helperPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'EchoTranscriber') : join(app.getAppPath(), 'native/transcriber/dist/EchoTranscriber')
}

let child: ChildProcessWithoutNullStreams | null = null
let nextId = 1
const pending = new Map<number, Pending>()
/** The model the running helper has loaded (or is loading), and the promise for it. */
let preparing: { model: string; done: Promise<void> } | null = null
let status: TranscriberStatus = { state: 'idle', model: '', progress: 0, message: '' }
let listener: Listener = () => {}

function setStatus(next: Partial<TranscriberStatus>): void {
  status = { ...status, ...next }
  listener(status)
}

export function onTranscriberStatus(fn: Listener): void {
  listener = fn
}

export function transcriberStatus(): TranscriberStatus {
  return status
}

function start(): ChildProcessWithoutNullStreams {
  if (child) return child
  // stderr is discarded: the helper writes nothing there by design, and a dependency's warning has no place in a log.
  const proc = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'ignore'] }) as unknown as ChildProcessWithoutNullStreams
  child = proc
  createInterface({ input: proc.stdout }).on('line', (line) => {
    let reply: Reply
    try {
      reply = JSON.parse(line) as Reply
    } catch {
      return
    }
    const waiting = pending.get(reply.id)
    if (!waiting) return
    if (reply.type === 'progress') waiting.progress?.(reply)
    else {
      pending.delete(reply.id)
      waiting.resolve(reply)
    }
  })
  const gone = (message: string) => {
    if (child !== proc) return
    child = null
    preparing = null
    for (const waiting of pending.values()) waiting.reject(new HelperExited(message))
    pending.clear()
    if (status.state !== 'error') setStatus({ state: 'idle' })
  }
  proc.on('error', (err) => gone(`The transcriber couldn't start: ${err.message}`))
  proc.on('exit', () => gone('The transcriber stopped unexpectedly. Try again.'))
  proc.stdin.on('error', () => {}) // a write after exit; 'exit' reports it
  return proc
}

function request(body: Record<string, unknown>, progress?: (reply: Reply) => void): Promise<Reply> {
  const proc = start()
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, progress })
    proc.stdin.write(`${JSON.stringify({ id, ...body })}\n`)
  }).then((reply) => {
    const r = reply as Reply
    if (!r.ok) throw new Error(r.error || 'Transcription failed.')
    return r
  })
}

/** Download (first time only) and load the model. Safe to call repeatedly; concurrent calls share one load. */
export function prepareTranscriber(model: string): Promise<void> {
  if (preparing?.model === model) return preparing.done
  setStatus({ state: 'loading', model, progress: 0, message: '' })
  const done = request({ op: 'prepare', dir: join(app.getPath('userData'), 'models'), model }, (reply) =>
    // Only a download is worth a percentage; listing and compiling are brief.
    setStatus(reply.phase?.startsWith('downloading') ? { state: 'downloading', progress: reply.fraction ?? 0 } : { state: 'loading' })
  )
    .then(() => setStatus({ state: 'ready', progress: 1, message: '' }))
    .catch((err: Error) => {
      if (preparing?.done === done) preparing = null
      setStatus({ state: 'error', message: err.message })
      throw err
    })
  preparing = { model, done }
  return done
}

export function transcriberReady(model: string): boolean {
  return status.state === 'ready' && status.model === model && !!child
}

/** 16 kHz mono 16-bit PCM in, text out. Waits for the model if it's still loading. */
export async function transcribe(model: string, pcm: ArrayBuffer, retried = false): Promise<string> {
  try {
    await prepareTranscriber(model)
    const reply = await request({ op: 'transcribe', pcm: Buffer.from(pcm).toString('base64') })
    return reply.text ?? ''
  } catch (err) {
    // A crashed helper restarts in well under a second; don't lose a whole recording to it.
    if (err instanceof HelperExited && !retried) return transcribe(model, pcm, true)
    throw err
  }
}

export function stopTranscriber(): void {
  child?.kill()
  child = null
  preparing = null
}
