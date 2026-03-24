import { charactersApi } from '@/api/characters'
import { imagesApi } from '@/api/images'
import { personasApi } from '@/api/personas'

type AvatarEntity = {
  id: string
  image_id?: string | null
} | null | undefined

function resolveAvatarUrl(
  id: string | null | undefined,
  imageId: string | null | undefined,
  fallback: (id: string) => string
) {
  if (!id) return null
  return imageId ? imagesApi.url(imageId) : fallback(id)
}

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
