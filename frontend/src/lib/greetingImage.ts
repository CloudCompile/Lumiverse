import { imagesApi } from '@/api/images'
import type { Character } from '@/types/api'
import { resolveGalleryImageId } from './galleryImageReference'

const RISU_IMAGE_RE = /<img\s*=\s*["']([^"']+)["'][^>]*>/gi
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi
const MARKDOWN_IMAGE_RE = /!\[[^\]]*]\(\s*(?:<([^>]+)>|([^\s)]+))/g

function assetStem(name: string): string {
  const base = name.split('/').pop() || name
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

export function containsGreetingImageMarkup(content: string): boolean {
  return /<img\b/i.test(content) || /!\[[^\]]*]\([^)]*\)/.test(content)
}

export function findEmbeddedGreetingImageSource(content: string): string | null {
  const matches: Array<{ index: number; source: string }> = []
  const collect = (pattern: RegExp, sourceGroup: number) => {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      const source = match[sourceGroup]?.trim()
      if (source) matches.push({ index: match.index, source })
    }
  }

  collect(RISU_IMAGE_RE, 1)
  collect(HTML_IMAGE_RE, 1)

  MARKDOWN_IMAGE_RE.lastIndex = 0
  let markdownMatch: RegExpExecArray | null
  while ((markdownMatch = MARKDOWN_IMAGE_RE.exec(content)) !== null) {
    const source = (markdownMatch[1] || markdownMatch[2])?.trim()
    if (source) matches.push({ index: markdownMatch.index, source })
  }

  matches.sort((a, b) => a.index - b.index)
  return matches[0]?.source ?? null
}

export function resolveEmbeddedGreetingImage(
  content: string,
  assetMap: unknown,
): { imageId: string } | { url: string } | null {
  const source = findEmbeddedGreetingImageSource(content)
  if (!source) return null

  if (assetMap && typeof assetMap === 'object' && !Array.isArray(assetMap)) {
    const map = assetMap as Record<string, string>
    const galleryImageId = resolveGalleryImageId(source, map)
    const cleaned = source.startsWith('embeded://') ? source.slice('embeded://'.length) : source
    const imageId = galleryImageId || map[cleaned] || map[assetStem(cleaned)]
    if (typeof imageId === 'string' && imageId) return { imageId }
  }

  if (/^(?:https?:\/\/|\/|data:image\/|blob:)/i.test(source)) return { url: source }
  return null
}

export function getGreetingCellImageUrl(
  character: Character,
  greetingIndex: number,
  content: string,
): string | null {
  const backgrounds = character.extensions?.greeting_backgrounds
  if (backgrounds && typeof backgrounds === 'object' && !Array.isArray(backgrounds)) {
    const explicitImageId = backgrounds[greetingIndex]
    if (typeof explicitImageId === 'string' && explicitImageId) {
      return imagesApi.smallUrl(explicitImageId)
    }
  }

  const embedded = resolveEmbeddedGreetingImage(content, character.extensions?.risu_asset_map)
  if (!embedded) return null
  return 'imageId' in embedded ? imagesApi.smallUrl(embedded.imageId) : embedded.url
}
