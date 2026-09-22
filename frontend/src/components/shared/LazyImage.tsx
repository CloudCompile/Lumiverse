import { useState, useCallback, useEffect, useRef, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react'
import { Spinner } from '@/components/shared/Spinner'
import { isImageDecoded, onImageDecoded, rememberImageDecoded } from '@/lib/imageDecodeCache'
import { isMacTauriWebView } from '@/lib/desktopWebView'

interface LazyImageProps {
  src?: string | null
  alt?: string
  style?: CSSProperties
  objectPosition?: string
  className?: string
  fallback?: ReactNode
  spinnerSize?: number
  containerClassName?: string
  containerStyle?: CSSProperties
  [key: string]: any
}

const LOADING_INDICATOR_DELAY_MS = 120

export default function LazyImage({
  src,
  alt = '',
  style = {},
  objectPosition = 'center',
  className = '',
  fallback = null,
  spinnerSize = 24,
  containerClassName = '',
  containerStyle = {},
  decoding = 'async',
  loading = 'lazy',
  onLoad,
  onError,
  ...props
}: LazyImageProps) {
  // A detached image decode is only a metadata hint. WKWebView can report that
  // decode as complete while a newly mounted <img> still has no paintable
  // backing surface, which briefly exposes a black image layer. On macOS
  // desktop, keep this particular element hidden until its own load and decode.
  const requiresMountedDecode = isMacTauriWebView()
  // Skip the spinner when the image is already decoded in the cache — it'll
  // paint within one frame, so showing/hiding a spinner just adds flicker.
  const [isLoading, setIsLoading] = useState(() => {
    if (!src) return false
    if (requiresMountedDecode) return true
    if (isImageDecoded(src)) return false
    return true
  })
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false)
  const [hasError, setHasError] = useState(false)
  const prevSrcRef = useRef(src)
  const imageRef = useRef<HTMLImageElement>(null)
  const currentSrcRef = useRef(src)
  currentSrcRef.current = src

  useEffect(() => {
    if (src !== prevSrcRef.current) {
      prevSrcRef.current = src
      const decoded = Boolean(src && !requiresMountedDecode && isImageDecoded(src))
      setIsLoading(!decoded)
      setShowLoadingIndicator(false)
      setHasError(false)
    }
  }, [requiresMountedDecode, src])

  // A near-viewport prefetch may finish before this element's load event.
  // Subscribe to that decode, but do not launch a second detached image here:
  // the mounted <img> is already doing the required fetch and decode.
  useEffect(() => {
    if (!src || !isLoading) return
    if (requiresMountedDecode) return
    if (isImageDecoded(src)) {
      setIsLoading(false)
      return
    }
    return onImageDecoded(src, () => {
      if (isImageDecoded(src)) {
        setIsLoading(false)
        setShowLoadingIndicator(false)
      }
    })
  }, [requiresMountedDecode, src, isLoading])

  // Cached images commonly settle within a frame or two. Avoid flashing a
  // spinner for that fast path while still providing feedback for real waits.
  useEffect(() => {
    if (!isLoading) return
    const timer = window.setTimeout(() => setShowLoadingIndicator(true), LOADING_INDICATOR_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [isLoading, src])

  const finishLoad = useCallback((image: HTMLImageElement) => {
    if (imageRef.current !== image || currentSrcRef.current !== src) return
    if (src) {
      rememberImageDecoded(src)
    }
    setIsLoading(false)
    setShowLoadingIndicator(false)
  }, [src])

  const handleLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    onLoad?.(event)
    const image = event.currentTarget
    if (!requiresMountedDecode || typeof image.decode !== 'function') {
      finishLoad(image)
      return
    }

    // decode() belongs to the mounted element here, rather than the detached
    // prefetch object. It therefore gates presentation without expanding the
    // set of images WKWebView chooses to lazy-load near the viewport.
    void image.decode().catch(() => {}).then(() => {
      window.requestAnimationFrame(() => finishLoad(image))
    })
  }, [finishLoad, onLoad, requiresMountedDecode])
  const handleError = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    setIsLoading(false)
    setShowLoadingIndicator(false)
    setHasError(true)
    onError?.(event)
  }, [onError])

  if (hasError || !src) return <>{fallback}</>

  const containerInline: CSSProperties = containerClassName
    ? { position: 'relative', overflow: 'hidden', ...containerStyle }
    : { position: 'relative', width: '100%', height: '100%', ...containerStyle }

  return (
    <div style={containerInline} className={containerClassName || undefined}>
      {isLoading && showLoadingIndicator && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--lumiverse-primary, #9370db)',
            opacity: 0.6,
          }}
        >
          <Spinner size={spinnerSize} />
        </div>
      )}
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        draggable={false}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transition: requiresMountedDecode
            ? 'transform var(--lazy-image-transform-transition, 0ms)'
            : 'opacity 0.2s ease, transform var(--lazy-image-transform-transition, 0ms)',
          objectPosition,
          opacity: requiresMountedDecode ? 1 : isLoading ? 0 : 1,
          visibility: requiresMountedDecode && isLoading ? 'hidden' : 'visible',
          ...style,
        }}
        className={className}
        decoding={decoding}
        loading={loading}
        onLoad={handleLoad}
        onError={handleError}
        {...props}
      />
    </div>
  )
}
