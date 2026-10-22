import { useCallback, useEffect, useRef, useState } from 'react'
import { openLiveStream, type LiveStream } from './liveStream'
import { toPcm16k } from './pcm'
import { api, errorMessage } from './util'

// Records the microphone and transcribes it on this Mac through the main
// process. Long dictations are split into ~10-minute segments, transcribed in
// order, so text arrives while the clinician keeps talking and no single chunk
// of audio grows large. With `live`, each turn is transcribed as soon as the
// clinician pauses and lands in the text right away. The segments are still
// recorded but only transcribed if the live stream couldn't open or dropped.

const SEGMENT_MS = 10 * 60 * 1000
const MIME = 'audio/webm;codecs=opus'

export type DictationState = 'idle' | 'starting' | 'recording'
/** A new recording or batch segment starts a paragraph; a live turn continues the one before it. */
export type TextJoin = 'paragraph' | 'continue'

interface LiveSession {
  stream: LiveStream
  /** The stream dropped: segments recorded from here on are transcribed whole. */
  failed: boolean
  /** Discard the segment being recorded when the stream dropped; live already covered it. */
  skip: boolean
  turns: number
  ended?: Promise<void>
}

export function useDictation(onText: (text: string, join: TextJoin) => void, onError: (message: string) => void, live = false) {
  const [state, setState] = useState<DictationState>('idle')
  const [partial, setPartial] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [pending, setPending] = useState(0)

  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const audioCtx = useRef<AudioContext | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const timers = useRef<{ tick?: number; rotate?: number; raf?: number }>({})
  const startedAt = useRef(0)
  const stopping = useRef(false)
  /** Set on unmount. Writing a note navigates away right after ⌘↵, possibly while the mic is still opening. */
  const disposed = useRef(false)
  const stateRef = useRef(state)
  stateRef.current = state
  // Resolves when the current segment's onstop has queued its audio. MediaRecorder reports
  // 'inactive' as soon as stop() is called, but the last blob arrives only in onstop.
  const segmentDone = useRef<Promise<void>>(Promise.resolve())
  /** The current (or last) recording's live stream. Outlives the recording until its last turns arrive. */
  const session = useRef<LiveSession | null>(null)
  /** One warning per recording is enough. */
  const liveWarned = useRef(false)
  const cbs = useRef({ onText, onError })
  cbs.current = { onText, onError }

  const enqueue = useCallback((blob: Blob) => {
    if (blob.size < 2000) return // nothing meaningful recorded
    setPending((p) => p + 1)
    queue.current = queue.current.then(async () => {
      try {
        const text = await api().transcribe(await toPcm16k(blob))
        if (text) cbs.current.onText(text, 'paragraph')
      } catch (err) {
        cbs.current.onError(`Transcription failed: ${errorMessage(err)}`)
      } finally {
        setPending((p) => p - 1)
      }
    })
  }, [])

  const startSegment = useCallback(() => {
    if (!stream.current) return
    const chunks: Blob[] = []
    const rec = new MediaRecorder(stream.current, { mimeType: MIME, audioBitsPerSecond: 48000 })
    let done = () => {}
    segmentDone.current = new Promise((resolve) => (done = resolve))
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: MIME })
      const s = session.current
      if (!s) {
        enqueue(blob)
        done()
      } else if (s.skip) {
        s.skip = false
        done()
      } else {
        // Transcribed only if live didn't cover it. finish() waits for the decision.
        void s.stream.ready.then((ok) => {
          if (!ok || s.failed) enqueue(blob)
          done()
        })
      }
      if (!stopping.current) startSegment()
    }
    rec.start(1000)
    recorder.current = rec
    timers.current.rotate = window.setTimeout(() => rec.state === 'recording' && rec.stop(), SEGMENT_MS)
  }, [enqueue])

  /** Stop streaming; the last turns keep arriving until finish() has them. */
  const endLive = useCallback(() => {
    const s = session.current
    if (!s || s.ended) return
    setPending((p) => p + 1)
    s.ended = s.stream.end().finally(() => setPending((p) => p - 1))
    const before = queue.current
    queue.current = Promise.all([before, s.ended]).then(() => {})
  }, [])

  const cleanup = useCallback(() => {
    endLive()
    window.clearInterval(timers.current.tick)
    window.clearTimeout(timers.current.rotate)
    if (timers.current.raf) cancelAnimationFrame(timers.current.raf)
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    void audioCtx.current?.close()
    audioCtx.current = null
    setLevel(0)
  }, [endLive])

  const start = useCallback(async () => {
    if (state !== 'idle') return
    setState('starting')
    try {
      // One live stream at a time: let the last recording's final turns arrive first.
      await session.current?.ended
      if (!(await api().requestMic())) {
        throw new Error('Microphone access is off. Enable Echo in System Settings › Privacy & Security › Microphone.')
      }
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
      if (disposed.current) {
        cleanup()
        return
      }
      stopping.current = false

      // Level meter.
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream.current).connect(analyser)
      audioCtx.current = ctx
      const buf = new Uint8Array(analyser.fftSize)
      const loop = () => {
        analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (const v of buf) sum += ((v - 128) / 128) ** 2
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4))
        timers.current.raf = requestAnimationFrame(loop)
      }
      loop()

      startedAt.current = Date.now()
      setElapsed(0)
      timers.current.tick = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 250)
      session.current = null
      if (live) {
        liveWarned.current = false
        const s: LiveSession = { failed: false, skip: false, turns: 0 } as LiveSession
        s.stream = openLiveStream(stream.current, {
          onTurn: (text) => cbs.current.onText(text, s.turns++ ? 'continue' : 'paragraph'),
          onPartial: setPartial,
          onWarn: (message) => {
            if (liveWarned.current) return
            liveWarned.current = true
            cbs.current.onError(message)
          },
          onFail: (message, opened) => {
            s.failed = true
            const rec = recorder.current
            const recording = session.current === s && !stopping.current && rec?.state === 'recording'
            // Mid-recording: start a fresh segment for what's still to come, and drop the one live covered.
            if (opened && recording) {
              s.skip = true
              window.clearTimeout(timers.current.rotate)
              rec.stop()
            }
            cbs.current.onError(!opened ? `${message} Echo will transcribe this recording when you stop.` : recording ? `${message} The last few seconds before it dropped may be missing; Echo will transcribe the rest when you stop.` : message)
          }
        })
        session.current = s
      }
      startSegment()
      setState('recording')
    } catch (err) {
      cleanup()
      setState('idle')
      cbs.current.onError(errorMessage(err))
    }
  }, [state, startSegment, cleanup, live])

  const stop = useCallback(() => {
    if (state !== 'recording') return
    stopping.current = true
    window.clearTimeout(timers.current.rotate)
    if (recorder.current?.state === 'recording') recorder.current.stop()
    cleanup()
    setState('idle')
  }, [state, cleanup])

  const toggle = useCallback(() => (state === 'recording' ? stop() : void start()), [state, start, stop])

  /** Stop if recording and resolve once every segment has been transcribed and handed to onText. */
  const finish = useCallback(async () => {
    // A press while the mic is still opening: wait for it, then stop.
    for (let i = 0; stateRef.current === 'starting' && !disposed.current && i < 100; i++) await new Promise((r) => setTimeout(r, 50))
    if (stateRef.current === 'recording') {
      stopping.current = true
      window.clearTimeout(timers.current.rotate)
      if (recorder.current?.state === 'recording') recorder.current.stop()
      cleanup()
      setState('idle')
    }
    await segmentDone.current
    await queue.current
  }, [cleanup])

  useEffect(() => {
    disposed.current = false
    return () => {
      disposed.current = true
      stopping.current = true
      if (recorder.current?.state === 'recording') recorder.current.stop()
      cleanup()
    }
  }, [cleanup])

  /** Live text still being transcribed, not yet in the text. Empty unless `live`. */
  return { state, elapsed, level, pending, start, stop, toggle, finish, heard: partial }
}

export function formatElapsed(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export type DictationController = ReturnType<typeof useDictation>
