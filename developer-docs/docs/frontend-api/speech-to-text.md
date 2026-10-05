# Speech-to-text

`ctx.stt` exposes Lumiverse's speech stack to frontend extensions. Choose `whistle`
for transcription entirely on the device, `webspeech` for the browser's Web Speech
API, or `connection` for a configured STT connection. Omitting `provider` uses the
user's current Voice & Speech selection. These calls do not change that selection.

Whistle's model and runtime ship with Lumiverse. They download from the current
Lumiverse instance and share the same cache and worker used by chat. No API key,
external service, or separate model installation is needed for Whistle.

## Availability and permission

Feature-detect `ctx.stt` and `ctx.host.capabilities['speech-to-text-v1'] >= 1`.
`lumiverse-spindle-types` 0.6.39 declares the optional API and exports its options,
session, transcript, provider, PCM, audio frame, and status types. It remains
optional for compatibility with older hosts and API mocks.

Declare `"media"` in `spindle.json`. `listProviders()` is free; `prepare()`,
`start()`, and `transcribe()` require that permission. Recording also uses the
browser or desktop webview's normal microphone permission. Provider discovery
and preparation never request microphone access. Microphone access remains
disabled inside sandboxed extension iframes; call the host API from the extension
frontend and forward the resulting text to the iframe when needed.

```ts
const stt = ctx.stt;
if (!stt || (ctx.host.capabilities['speech-to-text-v1'] ?? 0) < 1) return;

const whistle = stt.listProviders().find((provider) => provider.id === 'whistle');
if (!whistle?.available) return;

// Optional: prepare while the extension UI is idle, without opening the microphone.
void stt.prepare({ provider: 'whistle' }).catch(showError);

let session: ReturnType<typeof stt.start> | undefined;
recordButton.addEventListener('click', () => {
  try {
    session = stt.start({
      provider: 'whistle',
      language: 'en',
      continuous: true,
      onStatus: (status) => updateStatus(status.phase, status.progress),
      onAudioFrame: (frame) => updateMeter(frame.amplitude),
    });
    void session.ready.catch(showError);
    void session.result.then(({ text }) => updateInput(text)).catch((error) => {
      if (error.name !== 'AbortError') showError(error);
    });
  } catch (error) { showError(error); }
});
stopButton.addEventListener('click', () => { void session?.stop().catch(showError); });
cancelButton.addEventListener('click', () => session?.cancel());
```

Call `start()` directly in the user's button handler so audio startup keeps the
browser's user gesture. Microphone capture begins independently of Whistle model
preparation, preserving opening speech while the model loads. A slow or missing
AudioWorklet uses the same fallback capture as chat.

## API

| Method | Behavior |
| --- | --- |
| `listProviders()` | Returns fresh provider descriptors: `id`, `name`, `onDevice`, `available`, optional `unavailableReason` and `languages`, and `supportsAudioTranscription`. Availability describes microphone capture with current settings; explicit connection overrides and supplied audio are validated separately. |
| `prepare(options?)` | Prepares Whistle's shared runtime/model without a microphone request. Other providers validate availability and require no model preparation. |
| `start(options?)` | Starts capture immediately and returns a session with `provider`, `ready`, `result`, `stop()`, and `cancel()`. |
| `transcribe(audio, options?)` | Transcribes supplied audio without a microphone request. Whistle accepts a browser-decodable `Blob` or `{ samples: Float32Array, sampleRate: number }` mono PCM. Connections accept a `Blob`. Web Speech does not support supplied audio. |

All processing methods accept `provider`, `language`, `connectionId`, `signal`,
and `onStatus`. Language and connection default to the user's Voice settings.
Whistle supports `en`, `de`, `fr`, `es`, `it`, `nl`, and `pl`; locale suffixes such
as `en-US` are normalized; `auto` and unsupported languages use automatic detection.

Capture also accepts `continuous`, `interimResults`, `onResult`, and
`onAudioFrame`. `continuous` defaults to `false`, finishing after confirmed speech
followed by silence. Set it to `true` for explicit stop-button recording.
`interimResults` defaults to the user's preference. `onResult` delivers engine
segments: append final segments and replace the pending segment on each interim
update. `session.result` assembles the complete transcript for you. Status phases
are `loading`, `listening`, and `processing`; loading may include progress from
zero to one. Transcripts contain `text`, `provider`, and optional `language`.

```ts
const transcript = await ctx.stt!.transcribe(audioBlob, {
  provider: 'whistle',
  language: 'en',
  signal: abortController.signal,
});

// PCM is copied/resampled; the caller's buffer is never transferred or detached.
const fromPcm = await ctx.stt!.transcribe({
  samples: monoSamples,
  sampleRate: 48000,
}, { provider: 'whistle' });
```

Whistle supplied audio is limited to ten minutes and 64 MiB for encoded input.
PCM sample rates must be between 8 kHz and 192 kHz. Long audio uses sequential
bounded windows with overlap. Encoded format support follows the host's audio
decoder. Whistle processes audio locally; STT connections send audio to the
configured provider and Web Speech's processing location depends on the browser.

## Cleanup and cancellation

`stop()` is idempotent: it stops capture and waits for the final transcript.
Stopping during startup finishes immediately after the microphone becomes ready.
`cancel()` releases capture immediately, discards pending results, and rejects
pending session promises with `AbortError`. An `AbortSignal` cancels the local
operation without cancelling another consumer's shared Whistle preparation.

Only one extension recording session can own the microphone in a document at a
time; another start fails with `STT_BUSY`. Supplied-audio transcription does not
claim microphone ownership. Unload, reload, tab takeover, and `media` permission
revocation cancel pending operations and suppress late transcripts. Retained
API references from an unloaded extension reject with `SPINDLE_FRONTEND_INACTIVE`.

This API is frontend-only. Backend extension workers can communicate with their
frontend using the existing frontend messaging API when they need transcripts.
