import { useEffect } from 'react'
import { useStore } from '@/store'
import { getSpokenText } from '@/lib/speechDetection'
import { speak, stop, setTTSVolume, setTTSSpeed, installTTSAudioPrimer } from '@/lib/ttsAudio'
import { ttsApi } from '@/api/tts'

/**
 * Trigger auto-play for a completed assistant message using the final content
 * delivered by the backend, rather than reading from the in-flight message store.
 */
export function triggerTTSAutoPlay(messageId: string, content: string): void {
  const { voiceSettings } = useStore.getState()

  if (!voiceSettings.ttsEnabled || !voiceSettings.ttsAutoPlay || !voiceSettings.ttsConnectionId) {
    return
  }

  const text = getSpokenText(content, voiceSettings.speechDetectionRules)
  if (!text) return

  stop()
  setTTSVolume(voiceSettings.ttsVolume)
  setTTSSpeed(voiceSettings.ttsSpeed)

  ttsApi
    .synthesize(voiceSettings.ttsConnectionId, text, {
      speed: voiceSettings.ttsSpeed,
    })
    .then(async (response) => {
      if (!response.ok) {
        console.error('[TTS AutoPlay] Synthesis failed:', response.status, await response.text().catch(() => ''))
        return
      }

      const buffer = await response.arrayBuffer()
      speak(buffer, messageId)
    })
    .catch((err) => {
      console.error('[TTS AutoPlay] Synthesis failed:', err)
    })
}

/**
 * Installs a global one-time listener that primes the AudioContext on the
 * first user gesture, so generation-triggered playback isn't blocked by the
 * browser's autoplay policy.
 */
export function useTTSAutoPlay() {
  useEffect(() => installTTSAudioPrimer(), [])
}
