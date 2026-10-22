// The local transcriber takes 16 kHz mono 16-bit PCM. MediaRecorder produces
// WebM/Opus, which Chromium decodes; decoding through a 16 kHz offline context
// also resamples.

const RATE = 16000

export async function toPcm16k(blob: Blob): Promise<ArrayBuffer> {
  const audio = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await blob.arrayBuffer())
  const out = new Int16Array(audio.length)
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i))
  for (let i = 0; i < audio.length; i++) {
    let sum = 0
    for (const channel of channels) sum += channel[i]
    const s = Math.max(-1, Math.min(1, sum / channels.length))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}
