export const MAX_RECORDING_MS = 30_000
const SAMPLE_RATE = 16_000
const MAX_BYTES = SAMPLE_RATE * 2 * MAX_RECORDING_MS / 1000
const MIN_BYTES = SAMPLE_RATE * 2 * 0.12

export class Recording {
  private size = 0
  private chunks: Uint8Array[] = []

  push(pcm: Uint8Array) {
    const remaining = MAX_BYTES - this.size
    if (remaining <= 0 || pcm.length === 0) return
    const chunk = pcm.slice(0, remaining)
    this.chunks.push(chunk)
    this.size += chunk.length
  }

  finish(): Blob | undefined {
    const size = this.size - (this.size % 2)
    if (size < MIN_BYTES) return
    const wav = new ArrayBuffer(size + 44)
    const header = new DataView(wav)
    const bytes = new Uint8Array(wav)
    const encoder = new TextEncoder()
    bytes.set(encoder.encode('RIFF'), 0)
    header.setUint32(4, size + 36, true)
    bytes.set(encoder.encode('WAVEfmt '), 8)
    header.setUint32(16, 16, true)
    header.setUint16(20, 1, true)
    header.setUint16(22, 1, true)
    header.setUint32(24, SAMPLE_RATE, true)
    header.setUint32(28, SAMPLE_RATE * 2, true)
    header.setUint16(32, 2, true)
    header.setUint16(34, 16, true)
    bytes.set(encoder.encode('data'), 36)
    header.setUint32(40, size, true)
    let offset = 44
    for (const chunk of this.chunks) {
      const part = chunk.subarray(0, wav.byteLength - offset)
      bytes.set(part, offset)
      offset += part.length
    }
    return new Blob([wav], { type: 'audio/wav' })
  }
}
