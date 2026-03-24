import { charactersApi } from '@/api/characters'
import { imagesApi, type ImageSize } from '@/api/images'
import { personasApi } from '@/api/personas'

type AvatarEntity = {
  id: string
  image_id?: string | null
} | null | undefined

function resolveAvatarUrl(
  id: string | null | undefined,
  imageId: string | null | undefined,
  fallback: (id: string) => string,
  size?: ImageSize
) {
  if (!id) return null
  if (imageId) {
    if (size === 'sm') return imagesApi.smallUrl(imageId)
    if (size === 'lg') return imagesApi.largeUrl(imageId)
    return imagesApi.url(imageId)
  }
  return fallback(id) + (size ? `?size=${size}` : '')
}

// ---- Full-size variants (lightbox, export) ----

export function getCharacterAvatarUrl(entity: AvatarEntity) {
  return getCharacterAvatarUrlById(entity?.id, entity?.image_id)
}

export function getCharacterAvatarUrlById(characterId?: string | null, imageId?: string | null) {
  return resolveAvatarUrl(characterId, imageId, charactersApi.avatarUrl)
}

export function getPersonaAvatarUrl(entity: AvatarEntity) {
  return getPersonaAvatarUrlById(entity?.id, entity?.image_id)
}

export function getPersonaAvatarUrlById(personaId?: string | null, imageId?: string | null) {
  return resolveAvatarUrl(personaId, imageId, personasApi.avatarUrl)
}

export function getActiveAvatarUrl(
  entity: AvatarEntity,
  chatMetadata?: Record<string, any> | null
) {
  const overrideImageId = chatMetadata?.active_avatar_id as string | undefined
  if (overrideImageId) return imagesApi.url(overrideImageId)
  return getCharacterAvatarUrl(entity)
}

// ---- Small tier (cards, message bubbles, small UI, ~300px) ----

export function getCharacterAvatarThumbUrl(entity: AvatarEntity) {
  return getCharacterAvatarThumbUrlById(entity?.id, entity?.image_id)
}

export function getCharacterAvatarThumbUrlById(characterId?: string | null, imageId?: string | null) {
  return resolveAvatarUrl(characterId, imageId, charactersApi.avatarUrl, 'sm')
}

export function getPersonaAvatarThumbUrl(entity: AvatarEntity) {
  return getPersonaAvatarThumbUrlById(entity?.id, entity?.image_id)
}

export function getPersonaAvatarThumbUrlById(personaId?: string | null, imageId?: string | null) {
  return resolveAvatarUrl(personaId, imageId, personasApi.avatarUrl, 'sm')
}

export function getActiveAvatarThumbUrl(
  entity: AvatarEntity,
  chatMetadata?: Record<string, any> | null
) {
  const overrideImageId = chatMetadata?.active_avatar_id as string | undefined
  if (overrideImageId) return imagesApi.smallUrl(overrideImageId)
  return getCharacterAvatarThumbUrl(entity)
}

// ---- Large tier (portrait panel, editor preview, ~700px) ----

export function getCharacterAvatarLargeUrl(entity: AvatarEntity) {
  return getCharacterAvatarLargeUrlById(entity?.id, entity?.image_id)
}

export function getCharacterAvatarLargeUrlById(characterId?: string | null, imageId?: string | null) {
  return resolveAvatarUrl(characterId, imageId, charactersApi.avatarUrl, 'lg')
}

export function getPersonaAvatarLargeUrl(entity: AvatarEntity) {
  return getPersonaAvatarLargeUrlById(entity?.id, entity?.image_id)
}

export function getPersonaAvatarLargeUrlById(personaId?: string | null, imageId?: string | null) {
  return resolveAvatarUrl(personaId, imageId, personasApi.avatarUrl, 'lg')
}

export function getActiveAvatarLargeUrl(
  entity: AvatarEntity,
  chatMetadata?: Record<string, any> | null
) {
  const overrideImageId = chatMetadata?.active_avatar_id as string | undefined
  if (overrideImageId) return imagesApi.largeUrl(overrideImageId)
  return getCharacterAvatarLargeUrl(entity)
}
