import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Runs the real helper. Needs `npm run build:transcriber` and a folder of
// downloaded models in ECHO_TRANSCRIBER_MODELS (the parent of
// parakeet-tdt-0.6b-v2); skipped otherwise.
const root = resolve(__dirname, '..')
const models = process.env.ECHO_TRANSCRIBER_MODELS
const runnable = !!models && existsSync(join(root, 'native/transcriber/dist/EchoTranscriber')) && existsSync(join(models, 'parakeet-tdt-0.6b-v2'))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => root, getPath: () => resolve(models ?? '', '..') }
}))

/** Synthetic speech as 16 kHz mono 16-bit PCM, made with macOS's own tools. */
function speech(text: string): ArrayBuffer {
  const dir = mkdtempSync(join(tmpdir(), 'echo-test-'))
  execFileSync('say', ['-o', join(dir, 'a.aiff'), text])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(dir, 'a.aiff'), join(dir, 'a.wav')])
  const wav = readFileSync(join(dir, 'a.wav'))
  const data = wav.indexOf('data') + 8
  return wav.buffer.slice(wav.byteOffset + data, wav.byteOffset + wav.byteLength) as ArrayBuffer
}

describe.runIf(runnable)('local transcriber', () => {
  it('loads the model, transcribes, and survives the helper crashing', async () => {
    const t = await import('../src/main/transcriber')
    const states: string[] = []
    t.onTranscriberStatus((s) => states.push(s.state))
    // getPath('userData') + '/models' must be the models folder.
    expect(join(resolve(models!, '..'), 'models')).toBe(resolve(models!))

    const audio = speech('Client reported passive SI without plan, and we reviewed the safety plan.')
    await t.prepareTranscriber('parakeet-tdt-0.6b-v2')
    expect(states.at(-1)).toBe('ready')
    expect(await t.transcribe('parakeet-tdt-0.6b-v2', audio)).toMatch(/passive SI.*safety plan/i)

    // Kill the helper with a request in flight: the request is retried on a fresh helper.
    states.length = 0
    const pending = t.transcribe('parakeet-tdt-0.6b-v2', audio)
    execFileSync('pkill', ['-f', 'native/transcriber/dist/EchoTranscriber'])
    expect(await pending).toMatch(/safety plan/i)
    // The helper died (idle), restarted and reloaded the model before answering.
    expect([states[0], states.at(-1)]).toEqual(['idle', 'ready'])
    t.stopTranscriber()
  }, 120_000)
})
