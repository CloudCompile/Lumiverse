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

export interface ReadableColorScheme {
  surface: RGB
  text: RGB
  mutedText: RGB
  accent: RGB
  accentText: RGB
}

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
  palette: RGB[]
  diversity: {
    score: number
    isUniform: boolean
    usedFallback: boolean
  }
  ui: {
    dark: ReadableColorScheme
    light: ReadableColorScheme
  }
}

const DEFAULT_FALLBACK_HUE = 263
const MIN_UI_CONTRAST = 3
const MIN_TEXT_CONTRAST = 4.5

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function mixColors(color: RGB, target: RGB, weight: number): RGB {
  const w = clamp(weight, 0, 1)
  return {
    r: Math.round(color.r + (target.r - color.r) * w),
    g: Math.round(color.g + (target.g - color.g) * w),
    b: Math.round(color.b + (target.b - color.b) * w),
  }
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
interface BucketStats { count: number; r: number; g: number; b: number }
interface CandidateColor { color: RGB; score: number }
interface PixelAnalysis {
  dominant: DominantResult
  average: RGB
  diversityScore: number
  candidates: CandidateColor[]
}

function chooseQuantizationStep(avgDeviation: number): number {
  if (avgDeviation < 12) return 36
  if (avgDeviation < 22) return 28
  if (avgDeviation < 36) return 22
  return 16
}

function colorDistance(a: RGB, b: RGB): number {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  const dl = luminance(a.r, a.g, a.b) - luminance(b.r, b.g, b.b)
  return Math.sqrt((dr * dr * 0.35) + (dg * dg * 0.45) + (db * db * 0.2) + (dl * dl * 0.6))
}

function scoreCandidate(color: RGB, weight: number): number {
  const hsl = rgbToHsl(color.r, color.g, color.b)
  const satWeight = 0.45 + (hsl.s / 100) * 0.95
  const lightPenalty = hsl.l < 12 || hsl.l > 92 ? 0.45 : hsl.l < 20 || hsl.l > 84 ? 0.72 : 1
  return Math.sqrt(Math.max(1, weight)) * satWeight * lightPenalty
}

function analyzePixels(data: Uint8ClampedArray): PixelAnalysis {
  let rSum = 0
  let gSum = 0
  let bSum = 0
  let opaqueCount = 0

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    rSum += data[i]
    gSum += data[i + 1]
    bSum += data[i + 2]
    opaqueCount++
  }

  if (opaqueCount === 0) {
    const grey = { r: 128, g: 128, b: 128 }
    return {
      dominant: { color: grey, flatness: 1 },
      average: grey,
      diversityScore: 0,
      candidates: [{ color: grey, score: 1 }],
    }
  }

  const average = {
    r: Math.round(rSum / opaqueCount),
    g: Math.round(gSum / opaqueCount),
    b: Math.round(bSum / opaqueCount),
  }

  let deviationSum = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    deviationSum += Math.abs(data[i] - average.r)
    deviationSum += Math.abs(data[i + 1] - average.g)
    deviationSum += Math.abs(data[i + 2] - average.b)
  }

  const avgDeviation = deviationSum / (opaqueCount * 3)
  const quantStep = chooseQuantizationStep(avgDeviation)
  const buckets = new Map<string, BucketStats>()

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 48) continue
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const qr = Math.round(r / quantStep) * quantStep
    const qg = Math.round(g / quantStep) * quantStep
    const qb = Math.round(b / quantStep) * quantStep
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

  let best: BucketStats | null = null
  buckets.forEach((bucket) => {
    if (!best || bucket.count > best.count) best = bucket
  })

  if (!best || best.count === 0) {
    const grey = { r: 128, g: 128, b: 128 }
    return {
      dominant: { color: grey, flatness: 1 },
      average,
      diversityScore: 0,
      candidates: [{ color: grey, score: 1 }],
    }
  }

  const dominant = {
    color: {
      r: Math.round(best.r / best.count),
      g: Math.round(best.g / best.count),
      b: Math.round(best.b / best.count),
    },
    flatness: best.count / opaqueCount,
  }

  const candidates = Array.from(buckets.values())
    .map((bucket) => {
      const color = {
        r: Math.round(bucket.r / bucket.count),
        g: Math.round(bucket.g / bucket.count),
        b: Math.round(bucket.b / bucket.count),
      }
      return {
        color,
        score: scoreCandidate(color, bucket.count),
      }
    })
    .sort((a, b) => b.score - a.score)

  const bucketSpread = clamp(buckets.size / 24, 0, 1)
  const diversityScore = clamp((avgDeviation / 52) * 0.72 + bucketSpread * 0.28, 0, 1)

  return { dominant, average, diversityScore, candidates }
}

function dominantFromData(data: Uint8ClampedArray): DominantResult {
  return analyzePixels(data).dominant
}

function selectDistinctColors(candidates: CandidateColor[], desiredCount: number, diversityScore: number): RGB[] {
  const chosen: RGB[] = []
  const thresholds = [
    diversityScore > 0.28 ? 68 : diversityScore > 0.16 ? 54 : diversityScore > 0.08 ? 40 : 28,
    diversityScore > 0.28 ? 54 : diversityScore > 0.16 ? 42 : diversityScore > 0.08 ? 30 : 22,
    14,
  ]

  for (const threshold of thresholds) {
    for (const candidate of candidates) {
      if (chosen.length >= desiredCount) return chosen
      if (chosen.some((selected) => colorDistance(selected, candidate.color) < 8)) continue
      if (chosen.length === 0 || chosen.every((selected) => colorDistance(selected, candidate.color) >= threshold)) {
        chosen.push(candidate.color)
      }
    }
  }

  return chosen
}

function pickFallbackHue(dominant: RGB, average: RGB): number {
  const dominantHsl = rgbToHsl(dominant.r, dominant.g, dominant.b)
  if (dominantHsl.s >= 16) return dominantHsl.h
  const averageHsl = rgbToHsl(average.r, average.g, average.b)
  if (averageHsl.s >= 12) return averageHsl.h
  return DEFAULT_FALLBACK_HUE
}

function buildFallbackPalette(dominant: RGB, average: RGB): RGB[] {
  const hue = pickFallbackHue(dominant, average)
  return [
    hslToRgb(hue, 68, 58),
    hslToRgb((hue + 18) % 360, 46, 42),
    hslToRgb((hue + 340) % 360, 34, 72),
    hslToRgb((hue + 160) % 360, 28, 38),
    hslToRgb((hue + 205) % 360, 16, 84),
  ]
}

function pickReadableTextColor(surface: RGB, tint: RGB, minRatio: number): RGB {
  const lightTarget = { r: 247, g: 249, b: 252 }
  const darkTarget = { r: 17, g: 22, b: 28 }
  const candidates = [
    ensureContrast(mixColors(tint, lightTarget, 0.88), surface, minRatio),
    ensureContrast(mixColors(tint, darkTarget, 0.88), surface, minRatio),
    ensureContrast(lightTarget, surface, minRatio),
    ensureContrast(darkTarget, surface, minRatio),
  ]
  const ranked = candidates
    .map((color) => ({ color, ratio: contrastRatio(color, surface) }))
    .sort((a, b) => b.ratio - a.ratio)
  const prefersLightText = relativeLuminance(surface.r, surface.g, surface.b) < 0.36
  const preferred = ranked.find(({ color, ratio }) => {
    if (ratio < minRatio) return false
    return prefersLightText ? relativeLuminance(color.r, color.g, color.b) > 0.5 : relativeLuminance(color.r, color.g, color.b) < 0.2
  })

  if (preferred) return preferred.color
  return ranked[0].color
}

function tuneAccentForSurface(accentBase: RGB, surface: RGB, mode: 'dark' | 'light'): RGB {
  const accentHsl = rgbToHsl(accentBase.r, accentBase.g, accentBase.b)
  const tuned = hslToRgb(
    accentHsl.h,
    clamp(accentHsl.s, 44, 80),
    mode === 'dark' ? clamp(accentHsl.l, 56, 70) : clamp(accentHsl.l, 34, 48)
  )
  return ensureContrast(tuned, surface, MIN_UI_CONTRAST)
}

function deriveReadableScheme(surfaceBase: RGB, accentBase: RGB, mode: 'dark' | 'light'): ReadableColorScheme {
  let surface = mode === 'dark'
    ? mixColors(surfaceBase, { r: 12, g: 15, b: 22 }, 0.84)
    : mixColors(surfaceBase, { r: 248, g: 250, b: 252 }, 0.9)

  surface = mode === 'dark'
    ? constrainLuminance(surface, undefined, 62)
    : constrainLuminance(surface, 225, undefined)

  const accent = tuneAccentForSurface(accentBase, surface, mode)
  const accentText = pickReadableTextColor(accent, surface, MIN_TEXT_CONTRAST)
  const text = pickReadableTextColor(surface, accentBase, MIN_TEXT_CONTRAST)
  const mutedSeed = mixColors(text, surface, 0.28)
  const mutedText = ensureContrast(mutedSeed, surface, 3.6)

  return { surface, text, mutedText, accent, accentText }
}

function deriveUiSchemes(palette: RGB[], dominant: RGB, average: RGB): { dark: ReadableColorScheme; light: ReadableColorScheme } {
  const accentBase = palette[0] ?? dominant
  const surfaceSeed = palette[1] ?? average
  const surfaceBase = mixColors(surfaceSeed, average, 0.35)
  return {
    dark: deriveReadableScheme(surfaceBase, accentBase, 'dark'),
    light: deriveReadableScheme(surfaceBase, accentBase, 'light'),
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
    const fallbackPalette = buildFallbackPalette(grey, grey)
    return {
      dominant: grey,
      regions: { top: grey, center: grey, bottom: grey, left: grey, right: grey },
      flatness: flatRegions,
      average: grey,
      isLight: false,
      palette: fallbackPalette,
      diversity: { score: 0, isUniform: true, usedFallback: true },
      ui: deriveUiSchemes(fallbackPalette, grey, grey),
    }
  }

  canvas.width = SAMPLE_SIZE
  canvas.height = SAMPLE_SIZE
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)

  // Full-image analysis
  const fullData = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
  const fullAnalysis = analyzePixels(fullData)

  // Per-region analysis
  const regionDefs = getRegions(SAMPLE_SIZE, SAMPLE_SIZE)
  const regions = {} as ImagePalette['regions']
  const flatness = { full: fullAnalysis.dominant.flatness } as ImagePalette['flatness']
  const regionCandidates: CandidateColor[] = []
  for (const [name, rect] of Object.entries(regionDefs)) {
    const regionData = ctx.getImageData(rect.x, rect.y, rect.w, rect.h).data
    const result = dominantFromData(regionData)
    ;(regions as any)[name] = result.color
    ;(flatness as any)[name] = result.flatness
    regionCandidates.push({
      color: result.color,
      score: scoreCandidate(result.color, Math.max(1, (rect.w * rect.h) * Math.max(0.35, 1 - result.flatness))),
    })
  }

  const diversePalette = selectDistinctColors(
    [
      ...fullAnalysis.candidates,
      ...regionCandidates,
      { color: fullAnalysis.average, score: scoreCandidate(fullAnalysis.average, SAMPLE_SIZE * SAMPLE_SIZE * 0.18) },
    ],
    5,
    fullAnalysis.diversityScore,
  )

  const isUniform = fullAnalysis.diversityScore < 0.16 || flatness.full > 0.56 || diversePalette.length < 3
  const palette = isUniform
    ? buildFallbackPalette(fullAnalysis.dominant.color, fullAnalysis.average)
    : diversePalette
  const ui = deriveUiSchemes(palette, fullAnalysis.dominant.color, fullAnalysis.average)
  const isLight = luminance(fullAnalysis.dominant.color.r, fullAnalysis.dominant.color.g, fullAnalysis.dominant.color.b) > 152

  return {
    dominant: fullAnalysis.dominant.color,
    regions,
    flatness,
    average: fullAnalysis.average,
    isLight,
    palette,
    diversity: {
      score: Number(fullAnalysis.diversityScore.toFixed(3)),
      isUniform,
      usedFallback: isUniform,
    },
    ui,
  }
}

/**
 * Lightweight single-color extraction (backwards compatible with original).
 */
export async function extractDominantColor(src: string): Promise<RGB> {
  const palette = await extractPalette(src)
  return palette.dominant
}
