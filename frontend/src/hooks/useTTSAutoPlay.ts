import { useEffect, useRef } from 'react'
import { useStore } from '@/store'
import { getSpokenText } from '@/lib/speechDetection'
import { speak, stop, setTTSVolume, setTTSSpeed, installTTSAudioPrimer } from '@/lib/ttsAudio'
import { ttsApi } from '@/api/tts'

/**
 * Watches for generation completion and auto-speaks the AI response
 * when TTS auto-play is enabled.
 *
 * Detects the streaming → not-streaming transition to trigger TTS.
 *
 * Also installs a global one-time listener that primes the AudioContext on
 * the first user gesture, so generation-triggered playback (which isn't a
 * gesture itself) isn't blocked by browser autoplay policy.
 */
export function useTTSAutoPlay() {
  const wasStreamingRef = useRef(false)

  // Install the primer once per app session. Handler removes itself after the
  // first user interaction, so the cost is effectively zero steady-state.
  useEffect(() => installTTSAudioPrimer(), [])

  useEffect(() => {
    const unsub = useStore.subscribe((state) => {
      const isStreaming = state.isStreaming

      if (wasStreamingRef.current && !isStreaming) {
        // Generation just ended
        const { voiceSettings, messages } = useStore.getState()

        if (!voiceSettings.ttsEnabled || !voiceSettings.ttsAutoPlay || !voiceSettings.ttsConnectionId) {
          wasStreamingRef.current = false
          return
        }

        // Get the last non-user message
        const lastMsg = messages[messages.length - 1]
        if (!lastMsg || lastMsg.is_user) {
          wasStreamingRef.current = false
          return
        }

        // Apply speech detection rules
        const text = getSpokenText(lastMsg.content, voiceSettings.speechDetectionRules)
        if (!text) {
          wasStreamingRef.current = false
          return
        }

        // Stop any currently playing TTS
        stop()

        // Configure audio pipeline
        setTTSVolume(voiceSettings.ttsVolume)
        setTTSSpeed(voiceSettings.ttsSpeed)

        // Request synthesis and play
        const targetId = lastMsg.id
        ttsApi
          .synthesize(voiceSettings.ttsConnectionId, text, {
            speed: voiceSettings.ttsSpeed,
          })
          .then(async (response) => {
            if (!response.ok) return
            const buffer = await response.arrayBuffer()
            speak(buffer, targetId)
          })
          .catch((err) => {
            console.error('[TTS AutoPlay] Synthesis failed:', err)
          })
      }

      wasStreamingRef.current = isStreaming
    })

    return unsub
  }, [])
}
