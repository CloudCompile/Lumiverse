/**
 * Multi-region color extraction from images.
 *
 * Samples several regions of an image and returns a rich palette:
 *   - dominant: overall most common color
 *   - regions: per-region dominant colors (top, center, bottom, left, right)
 *   - average: simple average across all sampled pixels
 *   - isLight: whether the dominant color is perceived as light
 */

export type RGB = { r: number; g: number; b: number }

export interface ImagePalette {
  dominant: RGB
  regions: {
    top: RGB
    center: RGB
    bottom: RGB
    left: RGB
    right: RGB
  }
  /** Per-region flatness score (0–1). High values indicate a monotone/solid
   *  background region that should be deprioritized for color sampling. */
  flatness: {
    top: number
    center: number
    bottom: number
    left: number
    right: number
    full: number
  }
  average: RGB
  isLight: boolean
}

// ── Public helpers ──

export function luminance(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722
}

export function shiftTowards(color: RGB, target: RGB, weight: number): RGB {
  const w = Math.max(0, Math.min(1, weight))
  return {
    r: Math.round(color.r + (target.r - color.r) * w),
    g: Math.round(color.g + (target.g - color.g) * w),
    b: Math.round(color.b + (target.b - color.b) * w),
  }
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max - min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  s /= 100
  l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return {
    r: Math.round(f(0) * 255),
    g: Math.round(f(8) * 255),
    b: Math.round(f(4) * 255),
  }
}

/** WCAG 2.1 relative luminance (gamma-corrected). */
export function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    c = c / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
}

/** WCAG 2.1 contrast ratio between two RGB colors. */
export function contrastRatio(rgb1: RGB, rgb2: RGB): number {
  const l1 = relativeLuminance(rgb1.r, rgb1.g, rgb1.b)
  const l2 = relativeLuminance(rgb2.r, rgb2.g, rgb2.b)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Adjust a foreground color until it meets a minimum contrast ratio against
 * the given background. Modifies lightness in HSL space while preserving hue
 * and saturation, which keeps the color's character intact.
 */
export function ensureContrast(
  foreground: RGB,
  background: RGB,
  minRatio: number
): RGB {
  const current = contrastRatio(foreground, background)
  if (current >= minRatio) return foreground

  const bgHsl = rgbToHsl(background.r, background.g, background.b)
  const fgHsl = rgbToHsl(foreground.r, foreground.g, foreground.b)

  // Lighten if bg is dark, darken if bg is light
  const step = bgHsl.l < 50 ? 1 : -1
  let bestCandidate = foreground
  let bestRatio = current

  for (let l = fgHsl.l; l >= 0 && l <= 100; l += step) {
    const candidate = hslToRgb(fgHsl.h, fgHsl.s, l)
    const ratio = contrastRatio(candidate, background)
    if (ratio >= minRatio) return candidate
    if (ratio > bestRatio) {
      bestRatio = ratio
      bestCandidate = candidate
    }
  }

  return bestCandidate
}

/**
 * Adjust a color until its perceptual luminance stays within the requested
 * [minLum, maxLum] bounds (0–255 scale).  This is useful for eye-comfort
 * clamping: dark-mode colors can be capped so they are never blinding, and
 * light-mode colors can be floored so they are never too harsh.
 *
 * The algorithm walks lightness in HSL space (preserving hue/saturation) until
 * the luminance constraint is satisfied.
 */
export function constrainLuminance(
  color: RGB,
  minLum?: number,
  maxLum?: number
): RGB {
  const lum = luminance(color.r, color.g, color.b)

  if (
    (minLum === undefined || lum >= minLum) &&
    (maxLum === undefined || lum <= maxLum)
  ) {
    return color
  }

  const hsl = rgbToHsl(color.r, color.g, color.b)

  // Too dark — lighten
  if (minLum !== undefined && lum < minLum) {
    for (let l = hsl.l + 1; l <= 100; l++) {
      const candidate = hslToRgb(hsl.h, hsl.s, l)
      if (luminance(candidate.r, candidate.g, candidate.b) >= minLum) {
        return candidate
      }
    }
    return { r: 255, g: 255, b: 255 }
  }

  // Too bright — darken
  if (maxLum !== undefined && lum > maxLum) {
    for (let l = hsl.l - 1; l >= 0; l--) {
      const candidate = hslToRgb(hsl.h, hsl.s, l)
      if (luminance(candidate.r, candidate.g, candidate.b) <= maxLum) {
        return candidate
      }
    }
    return { r: 0, g: 0, b: 0 }
  }

  return color
}

/**
 * Parse a CSS colour value into an RGB object.
 * Supports `rgb(r, g, b)`, `rgba(r, g, b, a)`, `#rrggbb`, and `#rgb`.
 * Returns `null` for unrecognised values.
 */
export function parseCssColor(value: string): RGB | null {
  if (!value) return null

  const rgbMatch = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1], 10),
      g: parseInt(rgbMatch[2], 10),
      b: parseInt(rgbMatch[3], 10),
    }
  }

  const hexMatch = value.match(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/)
  if (hexMatch) {
    const hex = hexMatch[1]
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      }
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    }
  }

  return null
}

/**
 * Read the effective opaque backing-surface colour of an element by walking
 * up the DOM tree until a non-transparent `background-color` is found.
 * Returns `null` if no opaque surface is found (e.g. everything is transparent).
 */
export function getSurfaceColor(element: Element): RGB | null {
  let el: Element | null = element
  while (el) {
    const style = window.getComputedStyle(el as HTMLElement)
    const bg = style.backgroundColor
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      const parsed = parseCssColor(bg)
      if (parsed) return parsed
    }
    el = el.parentElement
  }
  return null
}

// ── Image loading ──

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

// ── Dominant color from pixel data ──

interface DominantResult { color: RGB; flatness: number }

function dominantFromData(data: Uint8ClampedArray): DominantResult {
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>()
  let totalOpaque = 0

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    totalOpaque++
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const qr = Math.round(r / 24) * 24
    const qg = Math.round(g / 24) * 24
    const qb = Math.round(b / 24) * 24
    const key = `${qr}-${qg}-${qb}`
    const hit = buckets.get(key)
    if (hit) {
      hit.count += 1
      hit.r += r
      hit.g += g
      hit.b += b
    } else {
      buckets.set(key, { count: 1, r, g, b })
    }
  }

  let best: { count: number; r: number; g: number; b: number } | null = null
  buckets.forEach((bucket) => {
    if (!best || bucket.count > best.count) best = bucket
  })

  if (!best || best.count === 0) return { color: { r: 128, g: 128, b: 128 }, flatness: 1 }
  // Flatness = what fraction of opaque pixels fell into the winning bucket.
  // >0.5 is a strong monotone signal (solid bg). <0.25 is varied/interesting.
  const flatness = totalOpaque > 0 ? best.count / totalOpaque : 1
  return {
    color: {
      r: Math.round(best.r / best.count),
      g: Math.round(best.g / best.count),
      b: Math.round(best.b / best.count),
    },
    flatness,
  }
}

function averageFromData(data: Uint8ClampedArray): RGB {
  let rSum = 0, gSum = 0, bSum = 0, count = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    rSum += data[i]
    gSum += data[i + 1]
    bSum += data[i + 2]
    count++
  }
  if (count === 0) return { r: 128, g: 128, b: 128 }
  return {
    r: Math.round(rSum / count),
    g: Math.round(gSum / count),
    b: Math.round(bSum / count),
  }
}

// ── Region sampling ──

const SAMPLE_SIZE = 48

interface Region { x: number; y: number; w: number; h: number }

function getRegions(w: number, h: number): Record<string, Region> {
  const third_w = Math.floor(w / 3)
  const third_h = Math.floor(h / 3)
  return {
    top:    { x: third_w, y: 0, w: third_w, h: third_h },
    center: { x: third_w, y: third_h, w: third_w, h: third_h },
    bottom: { x: third_w, y: third_h * 2, w: third_w, h: third_h },
    left:   { x: 0, y: third_h, w: third_w, h: third_h },
    right:  { x: third_w * 2, y: third_h, w: third_w, h: third_h },
  }
}

// ── Main extraction ──

export async function extractPalette(src: string): Promise<ImagePalette> {
  const img = await loadImage(src)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    const grey: RGB = { r: 128, g: 128, b: 128 }
    const flatRegions = { top: 1, center: 1, bottom: 1, left: 1, right: 1, full: 1 }
    return { dominant: grey, regions: { top: grey, center: grey, bottom: grey, left: grey, right: grey }, flatness: flatRegions, average: grey, isLight: false }
  }

  canvas.width = SAMPLE_SIZE
  canvas.height = SAMPLE_SIZE
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)

  // Full-image analysis
  const fullData = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
  const fullResult = dominantFromData(fullData)
  const average = averageFromData(fullData)

  // Per-region analysis
  const regionDefs = getRegions(SAMPLE_SIZE, SAMPLE_SIZE)
  const regions = {} as ImagePalette['regions']
  const flatness = { full: fullResult.flatness } as ImagePalette['flatness']
  for (const [name, rect] of Object.entries(regionDefs)) {
    const regionData = ctx.getImageData(rect.x, rect.y, rect.w, rect.h).data
    const result = dominantFromData(regionData)
    ;(regions as any)[name] = result.color
    ;(flatness as any)[name] = result.flatness
  }

  const isLight = luminance(fullResult.color.r, fullResult.color.g, fullResult.color.b) > 152

  return { dominant: fullResult.color, regions, flatness, average, isLight }
}

/**
 * Lightweight single-color extraction (backwards compatible with original).
 */
export async function extractDominantColor(src: string): Promise<RGB> {
  const palette = await extractPalette(src)
  return palette.dominant
}
