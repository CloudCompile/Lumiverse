/**
 * TTS AudioContext playback pipeline.
 *
 * Uses Web Audio API for precise volume/speed control and sequential
 * queue management. Separate from the notification HTMLAudioElement
 * singleton in notificationAudio.ts.
 *
 * Call unlockTTSAudio() during a user gesture (e.g. send button click)
 * to create/resume the AudioContext.
 */

let ctx: AudioContext | null = null
let gainNode: GainNode | null = null
let currentSource: AudioBufferSourceNode | null = null
let queue: ArrayBuffer[] = []
let playing = false
let paused = false
let volume = 0.8
let speed = 1.0

let onStartCb: (() => void) | null = null
let onEndCb: (() => void) | null = null
let onErrorCb: ((err: Error) => void) | null = null

function ensureContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    gainNode = ctx.createGain()
    gainNode.gain.value = volume
    gainNode.connect(ctx.destination)
  }
  return ctx
}

/** Create/resume AudioContext during a user gesture to satisfy autoplay policy. */
export function unlockTTSAudio(): void {
  const c = ensureContext()
  if (c.state === 'suspended') {
    c.resume().catch(() => {})
  }
}

export function setTTSVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v))
  if (gainNode) {
    gainNode.gain.value = volume
  }
}

export function setTTSSpeed(s: number): void {
  speed = Math.max(0.25, Math.min(4, s))
  if (currentSource) {
    currentSource.playbackRate.value = speed
  }
}

function playNext(): void {
  if (paused) return

  const data = queue.shift()
  if (!data) {
    playing = false
    currentSource = null
    onEndCb?.()
    return
  }

  const c = ensureContext()
  c.decodeAudioData(data.slice(0))
    .then((buffer) => {
      if (paused) return

      const source = c.createBufferSource()
      source.buffer = buffer
      source.playbackRate.value = speed
      source.connect(gainNode!)
      source.onended = () => {
        if (currentSource === source) {
          currentSource = null
          playNext()
        }
      }

      currentSource = source
      source.start()
    })
    .catch((err) => {
      onErrorCb?.(err instanceof Error ? err : new Error(String(err)))
      playNext()
    })
}

/** Enqueue audio data for sequential playback. */
export function speak(audioData: ArrayBuffer): void {
  queue.push(audioData)
  if (!playing) {
    playing = true
    paused = false
    onStartCb?.()
    playNext()
  }
}

/** Consume a streaming Response and play audio chunks sequentially. */
export async function speakStream(response: Response): Promise<void> {
  if (!response.body) {
    throw new Error('No response body for streaming TTS')
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalLength = 0

  // Accumulate all chunks then play as a single buffer
  // (AudioContext.decodeAudioData needs a complete audio file)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      totalLength += value.length
    }
  } finally {
    reader.cancel().catch(() => {})
  }

  // Concatenate into single ArrayBuffer
  const combined = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }

  speak(combined.buffer)
}

/** Stop all playback and clear the queue. */
export function stop(): void {
  queue = []
  paused = false
  if (currentSource) {
    try {
      currentSource.stop()
    } catch {
      // Already stopped
    }
    currentSource = null
  }
  playing = false
}

/** Pause playback by suspending the AudioContext. */
export function pause(): void {
  if (ctx && playing) {
    paused = true
    ctx.suspend()
  }
}

/** Resume playback after pause. */
export function resume(): void {
  if (ctx && paused) {
    paused = false
    ctx.resume().then(() => {
      if (!currentSource && queue.length > 0) {
        playNext()
      }
    })
  }
}

export function isSpeaking(): boolean {
  return playing
}

export function onTTSEvent(event: 'start' | 'end' | 'error', cb: (() => void) | ((err: Error) => void)): void {
  if (event === 'start') onStartCb = cb as () => void
  else if (event === 'end') onEndCb = cb as () => void
  else if (event === 'error') onErrorCb = cb as (err: Error) => void
}
