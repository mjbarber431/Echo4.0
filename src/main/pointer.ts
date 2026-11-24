import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Rect } from '../shared/ehr'

// The EchoPointer helper (native/pointer): captures the EHR's Chrome window and clicks and
// types in it, for placing notes with Claude. JSON lines over stdin/stdout, started for a run
// and stopped after it. Screenshots stay in memory; nothing is written to disk or logged.

interface Reply {
  id: number
  ok: boolean
  error?: string
  [key: string]: unknown
}

function helperPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'EchoPointer') : join(app.getAppPath(), 'native/pointer/dist/EchoPointer')
}

let child: ChildProcessWithoutNullStreams | null = null
let nextId = 1
const pending = new Map<number, { resolve(r: Reply): void; reject(e: Error): void }>()

function start(): ChildProcessWithoutNullStreams {
  if (child) return child
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
    pending.delete(reply.id)
    if (reply.ok) waiting.resolve(reply)
    else waiting.reject(new Error(reply.error || 'The pointer helper failed.'))
  })
  const gone = (message: string) => {
    if (child === proc) child = null
    for (const [, p] of pending) p.reject(new Error(message))
    pending.clear()
  }
  proc.on('error', () => gone('Echo’s pointer helper couldn’t start. Reinstall Echo, or run npm run build:pointer in development.'))
  proc.on('exit', () => gone('Echo’s pointer helper stopped.'))
  return proc
}

function call(cmd: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const proc = start()
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    proc.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`)
  })
}

export function stopPointer(): void {
  child?.kill()
  child = null
}

export async function permissions(prompt = false): Promise<{ screen: boolean; accessibility: boolean }> {
  const r = await call('permissions', { prompt })
  return { screen: !!r.screen, accessibility: !!r.accessibility }
}

/** The CGWindowID of the Chrome window Chrome reported at these bounds. */
export async function findWindow(bounds: Rect): Promise<number> {
  const r = await call('find', { bounds })
  return r.window as number
}

export interface Screenshot {
  png: string
  width: number
  height: number
  frame: Rect
}

export async function capture(window: number, maxEdge: number): Promise<Screenshot> {
  const r = await call('capture', { window, maxEdge })
  return { png: r.png as string, width: r.width as number, height: r.height as number, frame: r.frame as Rect }
}

export interface TextMatch {
  text: string
  exact: boolean
  box: Rect
}

/** Where some text appears in the window, read with the Mac's own text recognition (on this Mac). */
export async function findText(window: number, text: string): Promise<TextMatch[]> {
  const r = await call('findText', { window, text })
  return (r.found as TextMatch[]) ?? []
}

/** The text under a point (a word or two, inside one button), or null on an icon or blank space. */
export async function labelAt(window: number, point: { x: number; y: number }): Promise<string | null> {
  const r = await call('labelAt', { window, point })
  return typeof r.label === 'string' && r.label.trim() ? r.label.trim() : null
}

export async function mouse(): Promise<{ x: number; y: number }> {
  const r = await call('mouse')
  return { x: r.x as number, y: r.y as number }
}

type Point = { x: number; y: number }

export const pointer = {
  move: (window: number, point: Point) => call('move', { window, point }),
  click: (window: number, point: Point, button: 'left' | 'right' | 'middle', count: number, modifiers?: string) => call('click', { window, point, button, count, modifiers }),
  button: (window: number, down: boolean) => call('button', { window, down }),
  drag: (window: number, from: Point, to: Point, modifiers?: string) => call('drag', { window, from, to, modifiers }),
  scroll: (window: number, point: Point, dx: number, dy: number, modifiers?: string) => call('scroll', { window, point, dx, dy, modifiers }),
  key: (window: number, combo: string, repeat = 1) => call('key', { window, combo, repeat }),
  hold: (window: number, combo: string, seconds: number) => call('hold', { window, combo, seconds }),
  type: (window: number, text: string) => call('type', { window, text })
}
