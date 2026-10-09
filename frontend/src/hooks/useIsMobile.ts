import { useState, useEffect } from 'react'
import { isMobileViewportOrDevice, MOBILE_VIEWPORT_BREAKPOINT } from '@/lib/mobile'

const pointerQuery = typeof window !== 'undefined'
  ? window.matchMedia('(pointer: coarse)')
  : null

export default function useIsMobile(breakpoint = MOBILE_VIEWPORT_BREAKPOINT) {
  const [isMobile, setIsMobile] = useState(() => isMobileViewportOrDevice(breakpoint))

  useEffect(() => {
    const update = () => {
      const next = isMobileViewportOrDevice(breakpoint)
      setIsMobile((prev) => (prev !== next ? next : prev))
    }

    window.addEventListener('resize', update)
    pointerQuery?.addEventListener('change', update)
    return () => {
      window.removeEventListener('resize', update)
      pointerQuery?.removeEventListener('change', update)
    }
  }, [breakpoint])

  return isMobile
}
