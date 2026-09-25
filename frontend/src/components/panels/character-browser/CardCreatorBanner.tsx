import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { cardCreatorApi } from '@/api/card-creator'
import LazyImage from '@/components/shared/LazyImage'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import type { Character, CharacterSummary } from '@/types/api'
import styles from './CardCreatorBanner.module.css'

interface CardCreatorBannerProps {
  onOpen: (character: Character | CharacterSummary) => void
}

/**
 * Pinned entry for the Card Creator at the top of the library.
 *
 * The creator is a real character, but it is deliberately kept out of the
 * ordinary list (see STANDARD_CARD_PREDICATE, which filters it out
 * server-side). Pinning it here is what makes it reachable: clicking opens a
 * normal chat, and that chat is the surface where the card tools are live.
 */
export default function CardCreatorBanner({ onOpen }: CardCreatorBannerProps) {
  const { t } = useTranslation('panels')
  const [creator, setCreator] = useState<Character | null>(null)

  useEffect(() => {
    let cancelled = false
    cardCreatorApi
      .getCreator()
      .then((res) => {
        if (!cancelled) setCreator(res.character)
      })
      .catch(() => {
        // The endpoint creates the creator on demand, so a failure here is
        // transient (e.g. offline); the library still works without the pin.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!creator) return null

  const avatarUrl = getCharacterAvatarThumbUrl(creator) ?? ''

  return (
    <button
      type="button"
      className={styles.banner}
      onClick={() => onOpen(creator)}
      aria-label={t('cardCreator.open', { defaultValue: 'Chat with the Card Creator' })}
    >
      <span className={styles.avatar}>
        <LazyImage
          src={avatarUrl}
          alt={creator.name}
          className={styles.avatarImg}
          fallback={<span className={styles.avatarFallback}>{creator.name[0]?.toUpperCase()}</span>}
        />
      </span>
      <span className={styles.text}>
        <span className={styles.titleRow}>
          <span className={styles.title}>{creator.name}</span>
          <span className={styles.badge}>
            <Sparkles size={10} />
            {t('cardCreator.badge', { defaultValue: 'Built-in' })}
          </span>
        </span>
        <span className={styles.subtitle}>
          {t('cardCreator.subtitle', {
            defaultValue: 'Review your cards and propose edits in a chat',
          })}
        </span>
      </span>
    </button>
  )
}
