// Runs on the audio thread. The AudioContext is created at 16 kHz, so input is
// already at the rate the speech model expects; this converts it to 16-bit PCM
// and posts 100 ms chunks with their loudness for pause detection.

const CHUNK = 1600

class PcmChunker extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Int16Array(CHUNK)
    this.n = 0
    this.sum = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]))
      this.sum += s * s
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (this.n === CHUNK) {
        const pcm = this.buf.buffer
        this.port.postMessage({ pcm, rms: Math.sqrt(this.sum / CHUNK) }, [pcm])
        this.buf = new Int16Array(CHUNK)
        this.n = 0
        this.sum = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-chunker', PcmChunker)
