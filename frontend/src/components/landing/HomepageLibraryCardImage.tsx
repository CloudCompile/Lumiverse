import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { isMacTauriWebView, isTauriDesktop } from '@/lib/desktopWebView'

interface HomepageLibraryCardImageProps {
  src: string
  alt: string
}

/**
 * Keep the unvirtualized library memory-bounded by withholding image requests
 * until their cards approach the viewport in every Tauri shell. macOS adds a
 * mounted synchronous-decode and paint guard for WKWebView; Windows and Linux
 * retain asynchronous decoding. This avoids materializing all 60 card bitmaps
 * and compositor copies at once.
 */
export default function HomepageLibraryCardImage({ src, alt }: HomepageLibraryCardImageProps) {
  const tauriDesktop = isTauriDesktop()
  const requiresMountedDecode = isMacTauriWebView()
  const [shouldRequest, setShouldRequest] = useState(() => !tauriDesktop)
  const [readySrc, setReadySrc] = useState<string | null>(() => (
    requiresMountedDecode ? null : src
  ))
  const imageRef = useRef<HTMLImageElement>(null)
  const currentSrcRef = useRef(src)
  const revealFrameRef = useRef<number | null>(null)
  currentSrcRef.current = src

  useEffect(() => {
    if (!tauriDesktop || shouldRequest) return
    const image = imageRef.current
    if (!image || typeof IntersectionObserver === 'undefined') {
      setShouldRequest(true)
      return
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return
      setShouldRequest(true)
      observer.disconnect()
    }, { rootMargin: '320px 0px' })
    observer.observe(image)
    return () => observer.disconnect()
  }, [shouldRequest, tauriDesktop])

  useEffect(() => () => {
    if (revealFrameRef.current !== null) window.cancelAnimationFrame(revealFrameRef.current)
  }, [])

  const reveal = useCallback((image: HTMLImageElement) => {
    if (imageRef.current !== image || currentSrcRef.current !== src) return
    // Give WebKit one paint after decode before making the element visible.
    // This avoids presenting the element while its compositor surface is
    // still being attached during the route transform.
    revealFrameRef.current = window.requestAnimationFrame(() => {
      revealFrameRef.current = null
      if (imageRef.current === image && currentSrcRef.current === src) setReadySrc(src)
    })
  }, [src])

  const handleLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    if (!requiresMountedDecode) return
    const image = event.currentTarget
    if (typeof image.decode !== 'function') {
      reveal(image)
      return
    }
    void image.decode().catch(() => {}).then(() => reveal(image))
  }, [requiresMountedDecode, reveal])

  const hidden = tauriDesktop && (
    !shouldRequest || (requiresMountedDecode && readySrc !== src)
  )

  return (
    <img
      ref={imageRef}
      src={shouldRequest ? src : undefined}
      alt={alt}
      loading={tauriDesktop ? 'eager' : 'lazy'}
      decoding={requiresMountedDecode ? 'sync' : tauriDesktop ? 'async' : undefined}
      onLoad={handleLoad}
      onError={(event) => reveal(event.currentTarget)}
      style={tauriDesktop ? { visibility: hidden ? 'hidden' : 'visible' } : undefined}
    />
  )
}
