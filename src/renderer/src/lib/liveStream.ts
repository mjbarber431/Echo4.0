// A real file, not an inlined data: URL, which the page's CSP blocks for worklets.
import workletUrl from './pcm-worklet.js?url&no-inline'
import { applyLive, emptyLive, liveText, takeDone } from '@shared/coach'
import { api, errorMessage } from './util'

// Streams the microphone to the main process as 16 kHz PCM for live
// transcription on this Mac, and hands back each finished turn in the order it
// was spoken. A turn is committed after a short pause. A long stretch without one is committed at the next
// quiet moment, never mid-word: each turn is transcribed on its own.

const SPEECH_RMS = 0.012
const PAUSE_MS = 700
const MAX_TURN_MS = 15_000
const CHUNK_MS = 100
/** How long to wait for the last turns after the clinician stops. */
const DRAIN_MS = 5000

export interface LiveHandlers {
  /** A finished turn's text, in the order spoken. */
  onTurn(text: string): void
  /** Text of the turns still being transcribed. */
  onPartial(text: string): void
  /** Worth mentioning, but the stream carries on. */
  onWarn(message: string): void
  /** The stream couldn't open (`opened` false) or stopped working. Everything heard so far has been handed on. */
  onFail(message: string, opened: boolean): void
}

export interface LiveStream {
  /** True once the stream is open; false if there's none (demo mode) or it couldn't open. */
  ready: Promise<boolean>
  /** Stop listening, wait for the last turns, then close. */
  end(): Promise<void>
}

export function openLiveStream(stream: MediaStream, on: LiveHandlers): LiveStream {
  let transcript = emptyLive()
  let open = false
  let stopped = false // no more audio
  let finished = false // closed or failed; nothing more is handed on
  let awaiting = 0 // commits whose turn hasn't been announced yet
  let drained: (() => void) | null = null
  // Audio from before the socket opens is held, so the first words aren't lost.
  const held: (ArrayBuffer | 'commit')[] = []
  const send = (item: ArrayBuffer | 'commit') => (item === 'commit' ? api().liveCommit() : api().liveAudio(item))
  const push = (item: ArrayBuffer | 'commit') => (open ? send(item) : held.push(item))

  const flush = (all = false) => {
    const { texts, rest } = takeDone(transcript, all)
    transcript = rest
    texts.forEach(on.onTurn)
    on.onPartial(liveText(transcript))
    if (drained && !awaiting && !transcript.order.length) drained()
  }

  const ctx = new AudioContext({ sampleRate: 16000 })
  let node: AudioWorkletNode | null = null
  const disconnect = () => {
    stopped = true
    if (node) node.port.onmessage = null
    node?.disconnect()
  }
  const close = () => {
    finished = true
    disconnect()
    unsubscribe()
    void ctx.close()
    void api().liveStop()
    drained?.()
  }
  const fail = (message: string) => {
    if (finished) return
    flush(true)
    close()
    on.onFail(message, open)
  }

  const unsubscribe = api().onLive((e) => {
    if (finished) return
    if (e.type === 'committed' || e.type === 'empty') awaiting = Math.max(0, awaiting - 1)
    if (e.type === 'closed') return fail('Live transcription stopped.')
    if (e.type === 'error') return on.onWarn(`Live transcription: ${e.message}`)
    if (e.type === 'failed') on.onWarn(`A few seconds of dictation couldn't be transcribed: ${e.message}`)
    transcript = applyLive(transcript, e)
    flush()
  })

  let heard = false
  let quietMs = 0
  let turnMs = 0
  const commit = () => {
    if (heard) {
      awaiting++
      push('commit')
    }
    heard = false
    quietMs = 0
    turnMs = 0
  }

  const audio = ctx.audioWorklet.addModule(workletUrl).then(() => {
    if (stopped) return
    node = new AudioWorkletNode(ctx, 'pcm-chunker')
    ctx.createMediaStreamSource(stream).connect(node)
    node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      push(e.data.pcm)
      turnMs += CHUNK_MS
      const loud = e.data.rms >= SPEECH_RMS
      if (loud) {
        heard = true
        quietMs = 0
      } else quietMs += CHUNK_MS
      if (heard && (quietMs >= PAUSE_MS || (turnMs >= MAX_TURN_MS && !loud))) commit()
    }
  })

  const ready = Promise.all([api().liveStart(), audio]).then(
    ([started]) => {
      if (finished) return false
      if (!started) {
        // Nothing to stream to. Not a failure: the recording is transcribed the regular way.
        close()
        return false
      }
      open = true
      held.splice(0).forEach(send)
      return true
    },
    (err) => {
      fail(`Live transcription is unavailable: ${errorMessage(err)}`)
      return false
    }
  )

  let ending: Promise<void> | null = null
  return {
    ready,
    end: () =>
      (ending ??= (async () => {
        disconnect()
        commit() // the turn in progress
        if (!(await ready) || finished) return
        await new Promise<void>((resolve) => {
          drained = resolve
          window.setTimeout(resolve, DRAIN_MS)
          flush()
        })
        if (finished) return
        // Out of time: keep what arrived of any turn still unfinished.
        flush(true)
        close()
      })())
  }
}
