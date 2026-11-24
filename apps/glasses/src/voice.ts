import { MAX_RECORDING_MS, Recording } from './asr/stt.ts'

export class PushToTalk {
  private recording?: Recording
  private timer?: ReturnType<typeof setTimeout>
  private pending = Promise.resolve(true)
  private cycle = 0

  private readonly mic: (enabled: boolean) => Promise<boolean>
  private readonly stopped: (wav: Blob | undefined, micStoppedAt: number) => void
  private readonly failed: (message: string) => void

  constructor(mic: PushToTalk['mic'], stopped: PushToTalk['stopped'], failed: PushToTalk['failed']) {
    this.mic = mic
    this.stopped = stopped
    this.failed = failed
  }

  get active() { return Boolean(this.recording) }

  press() {
    if (this.recording) return
    this.cycle++
    const recording = this.recording = new Recording()
    this.timer = setTimeout(() => {
      this.cancel()
      this.failed('30-second limit reached. Hold again to retry.')
    }, MAX_RECORDING_MS)
    void this.toggle(true).then(ok => {
      if (!ok && this.recording === recording) {
        this.cancel()
        this.failed('Microphone unavailable. Check the glasses connection and permissions.')
      }
    })
  }

  audio(pcm: Uint8Array) {
    this.recording?.push(pcm)
  }

  async release() {
    if (!this.recording) return
    const recording = this.recording
    const cycle = this.cycle
    this.clear()
    const start = this.pending
    const stop = this.toggle(false)
    const [started, ok] = await Promise.all([start, stop])
    if (cycle !== this.cycle) return
    if (!ok) this.failed('Microphone stop failed. Close the app to reset it.')
    else if (!started) this.failed('Microphone unavailable. Check the glasses connection and permissions.')
    else {
      const micStoppedAt = performance.now()
      this.stopped(recording.finish(), micStoppedAt)
    }
  }

  cancel() {
    const active = this.active
    this.cycle++
    this.clear()
    if (active) void this.toggle(false)
  }

  private clear() {
    this.recording = undefined
    clearTimeout(this.timer)
  }

  private toggle(on: boolean) {
    this.pending = this.pending.then(async () => {
      const accepted = await this.mic(on).catch(() => false)
      return accepted || (!on && await this.mic(false).catch(() => false))
    })
    return this.pending
  }
}
