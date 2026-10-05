import { afterEach, describe, expect, test } from 'bun:test'
import { createFrontendSTTAPI } from './stt-api'
import type { STTConfig, STTEngine, STTEngineStatus, STTResult, STTAudioFrame } from '../sttEngine'
import type { SpindleSTTTranscript } from 'lumiverse-spindle-types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

class Engine implements STTEngine {
  starts = 0
  stops = 0
  destroys = 0
  listening = false
  startup = deferred<void>()
  result!: (value: STTResult) => void
  error!: (error: Error) => void
  ended!: () => void
  status!: (status: STTEngineStatus) => void
  audio!: (frame: STTAudioFrame) => void
  start() { this.starts++; this.listening = true; return this.startup.promise }
  stop() { this.stops++; this.listening = false }
  destroy() { this.destroys++; this.listening = false }
  isListening() { return this.listening }
  onResult(cb: typeof this.result) { this.result = cb }
  onError(cb: typeof this.error) { this.error = cb }
  onStop(cb: typeof this.ended) { this.ended = cb }
  onStatus(cb: typeof this.status) { this.status = cb }
  onAudioFrame(cb: typeof this.audio) { this.audio = cb }
}

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function fixture() {
  const engine = new Engine()
  let active = true
  let granted = true
  let captures = 0
  let prepared = 0
  let config: STTConfig | undefined
  let operationSignal: AbortSignal | undefined
  const transcription = deferred<SpindleSTTTranscript>()
  const teardown: Array<() => void> = []
  const bridge = createFrontendSTTAPI({
    assertActive() { if (!active) throw new Error('SPINDLE_FRONTEND_INACTIVE') },
    requirePermission(permission) { expect(permission).toBe('media'); if (!granted) throw new Error('PERMISSION_DENIED:media') },
    onTeardown(cb) { teardown.push(cb); return () => {} },
    getConfig: () => ({ provider: 'whistle', language: 'en-US', continuous: true, interimResults: true, connectionId: 'connection-1' }),
    listProviders: () => [{ id: 'whistle', name: 'Whistle', onDevice: true, available: true, supportsAudioTranscription: true, languages: ['en'] }],
    createEngine(value) { captures++; config = value; return engine },
    async prepare(value, signal, status) { prepared++; config = value; operationSignal = signal; status?.({ phase: 'loading', progress: 0.5 }) },
    transcribe(_audio, value, signal) { config = value; operationSignal = signal; return transcription.promise },
  })
  cleanups.push(bridge.dispose)
  return { ...bridge, engine, teardown, transcription,
    deny: () => { granted = false }, deactivate: () => { active = false },
    config: () => config, captures: () => captures, prepared: () => prepared, signal: () => operationSignal,
  }
}

describe('extension speech lifecycle', () => {
  test('discovery is free, detached, and requests no capture or model', () => {
    const f = fixture(); f.deny()
    const first = f.api.listProviders()
    ;(first[0].languages as string[]).push('fr')
    expect(f.api.listProviders()[0].languages).toEqual(['en'])
    expect(f.captures()).toBe(0); expect(f.prepared()).toBe(0)
    expect(() => f.api.start()).toThrow('PERMISSION_DENIED:media')
  })

  test('preparation requires media and never constructs a recorder', async () => {
    const f = fixture(); const statuses: number[] = []
    await f.api.prepare({ provider: 'whistle', onStatus: (status) => statuses.push(status.progress!) })
    expect(statuses).toEqual([0.5]); expect(f.captures()).toBe(0)
    f.deny(); await expect(f.api.prepare()).rejects.toThrow('PERMISSION_DENIED:media')
    expect(f.prepared()).toBe(1)
  })

  test('starts in the user gesture and returns final segments without duplicating interim text', async () => {
    const f = fixture(); const updates: STTResult[] = []
    const session = f.api.start({ onResult: (update) => updates.push(update) })
    expect(f.engine.starts).toBe(1)
    expect(f.config()).toMatchObject({ provider: 'whistle', continuous: false, autoSubmitOnSilence: true })
    f.engine.startup.resolve(); await session.ready
    f.engine.result({ text: 'hello', isFinal: false })
    f.engine.result({ text: 'hello world', isFinal: false })
    f.engine.result({ text: 'hello world', isFinal: true })
    f.engine.result({ text: 'again', isFinal: true })
    const result = session.stop()
    expect(session.stop()).toBe(result); expect(f.engine.stops).toBe(1)
    f.engine.ended()
    await expect(result).resolves.toMatchObject({ text: 'hello world again', provider: 'whistle' })
    expect(updates).toHaveLength(4); expect(f.engine.destroys).toBe(1)
  })

  test('stop while starting waits for capture startup and then stops exactly once', async () => {
    const f = fixture(); const session = f.api.start({ provider: 'connection', connectionId: 'other', continuous: true })
    const result = session.stop(); expect(f.engine.stops).toBe(0)
    f.engine.startup.resolve(); await session.ready
    expect(f.engine.stops).toBe(1)
    expect(f.config()).toMatchObject({ provider: 'connection', connectionId: 'other', continuous: true, autoSubmitOnSilence: false })
    f.engine.ended(); await result
  })

  test('cancels pending startup immediately and suppresses stale callbacks', async () => {
    const f = fixture(); const updates: STTResult[] = []
    const session = f.api.start({ onResult: (update) => updates.push(update) })
    session.cancel()
    await expect(session.ready).rejects.toMatchObject({ name: 'AbortError' })
    await expect(session.result).rejects.toMatchObject({ name: 'AbortError' })
    f.engine.startup.resolve(); f.engine.result({ text: 'stale', isFinal: true }); f.engine.ended()
    expect(updates).toEqual([]); expect(f.engine.destroys).toBe(1)
  })

  test('permission revocation aborts supplied transcription without waiting for inference', async () => {
    const f = fixture(); const pending = f.api.transcribe(new Blob(['audio']))
    f.deny(); f.revoke()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.signal()?.aborted).toBe(true)
    f.transcription.resolve({ text: 'stale', provider: 'whistle' })
  })

  test('revocation releases microphone ownership and does not cancel another extension', async () => {
    const first = fixture(); const second = fixture()
    const recording = first.api.start()
    expect(() => second.api.start()).toThrow('STT_BUSY')
    first.revoke()
    await expect(recording.result).rejects.toMatchObject({ name: 'AbortError' })
    const other = second.api.start()
    first.revoke(); expect(second.engine.destroys).toBe(0)
    other.cancel(); await expect(other.result).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('teardown cancels capture and stale API references reject', async () => {
    const f = fixture(); const session = f.api.start()
    f.teardown.forEach((teardown) => teardown())
    await expect(session.result).rejects.toMatchObject({ name: 'AbortError' })
    expect(() => f.api.start()).toThrow('SPINDLE_FRONTEND_INACTIVE')
    expect(() => f.api.listProviders()).toThrow('SPINDLE_FRONTEND_INACTIVE')
  })

  test('checks permissions again before delivering a transcript', async () => {
    const f = fixture(); const pending = f.api.transcribe(new Blob(['audio']))
    f.deny(); f.transcription.resolve({ text: 'private', provider: 'whistle' })
    await expect(pending).rejects.toThrow('PERMISSION_DENIED:media')
  })

  test('external abort cancels capture, while already-aborted signals never start', async () => {
    const f = fixture(); const controller = new AbortController()
    const session = f.api.start({ signal: controller.signal })
    controller.abort(); await expect(session.result).rejects.toMatchObject({ name: 'AbortError' })
    expect(() => f.api.start({ signal: controller.signal })).toThrow('cancelled')
    expect(f.captures()).toBe(1)
  })

  test('engine failure settles both promises and allows a later recording', async () => {
    const f = fixture(); const session = f.api.start()
    f.engine.error(new Error('microphone denied'))
    await expect(session.ready).rejects.toThrow('microphone denied')
    await expect(session.result).rejects.toThrow('microphone denied')
    const next = fixture().api.start(); next.cancel()
    await expect(next.result).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('rechecks authorization during audio callbacks even before revocation event delivery', async () => {
    const f = fixture(); let frames = 0
    const session = f.api.start({ onAudioFrame: () => { frames++ } })
    f.deny(); f.engine.audio({ amplitude: 1, peak: 1, frequencies: [1] })
    await expect(session.result).rejects.toThrow('PERMISSION_DENIED:media')
    expect(frames).toBe(0); expect(f.engine.destroys).toBe(1)
  })
})
