function varint(value: number) {
  const bytes: number[] = []
  while (value >= 128) {
    bytes.push((value % 128) | 128)
    value = Math.floor(value / 128)
  }
  bytes.push(value)
  return bytes
}

function field(tag: number, bytes: Uint8Array) {
  const length = varint(bytes.length)
  const field = new Uint8Array(1 + length.length + bytes.length)
  field[0] = (tag << 3) | 2
  field.set(length, 1)
  field.set(bytes, 1 + length.length)
  return field
}

// The verified Cursor stream uses 24 kHz signed little-endian PCM. Each
// upload starts at a whole input sample and spans a bounded block.
function resample(pcm: ArrayBuffer) {
  const input = new DataView(pcm)
  const samples = pcm.byteLength / 2
  const output = new Uint8Array(Math.round(samples * 1.5) * 2)
  const data = new DataView(output.buffer)
  for (let i = 0; i < output.length / 2; i++) {
    const position = i * 2 / 3
    const left = Math.floor(position)
    const right = Math.min(left + 1, samples - 1)
    const start = input.getInt16(left * 2, true)
    const end = input.getInt16(right * 2, true)
    data.setInt16(i * 2, Math.round(start + (end - start) * (position - left)), true)
  }
  return output
}

export function cursorAudioMessage(sequence: number, pcm: ArrayBuffer) {
  if (sequence === 0) return field(1, new Uint8Array([4 << 3, ...varint(24_000)]))
  if (!pcm.byteLength) return field(3, new Uint8Array([1 << 3, 1]))
  return field(2, field(1, resample(pcm)))
}

export function cursorTranscriptRequest(requestId: string) {
  const data = new TextEncoder().encode(JSON.stringify({ requestId }))
  const envelope = new Uint8Array(5 + data.length)
  new DataView(envelope.buffer).setUint32(1, data.length)
  envelope.set(data, 5)
  return envelope
}
