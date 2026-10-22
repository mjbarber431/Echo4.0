import type { LiveEvent } from '../shared/coach'
import { transcribe, transcriberReady } from './transcriber'

// Live transcription, on this Mac. The renderer streams 16 kHz PCM and commits
// each turn after a pause; every committed turn is transcribed on its own by the
// local model and comes back as the committed and completed events the
// renderer's transcript code reads. Only one stream is open at a time. The
// renderer keeps a local recording and falls back to transcribing it whole if
// the stream couldn't open.

type Emit = (event: LiveEvent) => void

interface Session {
  model: string
  emit: Emit
  chunks: Buffer[]
  turns: number
  previous: string | null
  /** Turns are transcribed in the order they were spoken. */
  queue: Promise<void>
}

let session: Session | null = null

export function startLive(model: string, emit: Emit): void {
  stopLive()
  // Live text has to keep up with speech, so it doesn't wait for a first-time download.
  if (!transcriberReady(model)) throw new Error('The speech model is still getting ready.')
  session = { model, emit, chunks: [], turns: 0, previous: null, queue: Promise.resolve() }
}

export function sendLiveAudio(pcm: ArrayBuffer): void {
  session?.chunks.push(Buffer.from(pcm))
}

export function commitLive(): void {
  const s = session
  if (!s) return
  const audio = Buffer.concat(s.chunks.splice(0))
  if (!audio.length) return s.emit({ type: 'empty' })
  const itemId = `turn-${++s.turns}`
  s.emit({ type: 'committed', itemId, previousItemId: s.previous })
  s.previous = itemId
  const pcm = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer
  s.queue = s.queue.then(async () => {
    try {
      const text = await transcribe(s.model, pcm)
      s.emit({ type: 'completed', itemId, text })
    } catch (err) {
      s.emit({ type: 'failed', itemId, message: (err as Error).message })
    }
  })
}

/** Closes the stream. The renderer waits for its last turns before calling this. */
export function stopLive(): void {
  session = null
}
