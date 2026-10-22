import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveEvent } from '../src/shared/coach'

const ready = { value: true }
vi.mock('../src/main/transcriber', () => ({
  transcriberReady: () => ready.value,
  // Echo the PCM length back so each turn's audio can be told apart.
  transcribe: vi.fn(async (_model: string, pcm: ArrayBuffer) => (pcm.byteLength === 6 ? Promise.reject(new Error('boom')) : `turn of ${pcm.byteLength} bytes`))
}))

const { commitLive, sendLiveAudio, startLive, stopLive } = await import('../src/main/live')

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('live transcription on this Mac', () => {
  afterEach(() => {
    stopLive()
    ready.value = true
  })

  it('transcribes each committed turn on its own, chained in the order spoken', async () => {
    const events: LiveEvent[] = []
    startLive('parakeet-tdt-0.6b-v2', (e) => events.push(e))
    sendLiveAudio(new ArrayBuffer(2))
    sendLiveAudio(new ArrayBuffer(2))
    commitLive()
    sendLiveAudio(new ArrayBuffer(8))
    commitLive()
    await flush()
    expect(events).toEqual([
      { type: 'committed', itemId: 'turn-1', previousItemId: null },
      { type: 'committed', itemId: 'turn-2', previousItemId: 'turn-1' },
      { type: 'completed', itemId: 'turn-1', text: 'turn of 4 bytes' },
      { type: 'completed', itemId: 'turn-2', text: 'turn of 8 bytes' }
    ])
  })

  it('reports an empty commit and a failed turn', async () => {
    const events: LiveEvent[] = []
    startLive('parakeet-tdt-0.6b-v2', (e) => events.push(e))
    commitLive()
    sendLiveAudio(new ArrayBuffer(6))
    commitLive()
    await flush()
    expect(events).toEqual([
      { type: 'empty' },
      { type: 'committed', itemId: 'turn-1', previousItemId: null },
      { type: 'failed', itemId: 'turn-1', message: 'boom' }
    ])
  })

  it('refuses to start before the model is loaded, so the recording is transcribed whole instead', () => {
    ready.value = false
    expect(() => startLive('parakeet-tdt-0.6b-v2', () => {})).toThrow(/getting ready/)
  })
})
