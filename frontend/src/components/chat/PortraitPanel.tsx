import { useState, useEffect, useCallback } from 'react'
import { motion } from 'motion/react'
import { X } from 'lucide-react'
import { useStore } from '@/store'
import { charactersApi } from '@/api/characters'
import { characterGalleryApi } from '@/api/character-gallery'
import { getCharacterAvatarLargeUrl } from '@/lib/avatarUrls'
import { imagesApi } from '@/api/images'
import LazyImage from '@/components/shared/LazyImage'
import ImageLightbox from './ImageLightbox'
import AvatarSwitcherPopover from './AvatarSwitcherPopover'
import type { Character, CharacterGalleryItem } from '@/types/api'
import styles from './PortraitPanel.module.css'
import clsx from 'clsx'

interface PortraitPanelProps {
  side?: 'left' | 'right'
}

export default function PortraitPanel({ side = 'right' }: PortraitPanelProps) {
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeChatAvatarId = useStore((s) => s.activeChatAvatarId)
  const characters = useStore((s) => s.characters)
  const togglePortraitPanel = useStore((s) => s.togglePortraitPanel)
  const storedCharacter = activeCharacterId
    ? characters.find((entry) => entry.id === activeCharacterId) ?? null
    : null
  const [character, setCharacter] = useState<Character | null>(null)
  const [gallery, setGallery] = useState<CharacterGalleryItem[]>([])
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  useEffect(() => {
    if (storedCharacter) setCharacter(storedCharacter)
  }, [storedCharacter])

  useEffect(() => {
    if (!activeCharacterId) return
    charactersApi
      .get(activeCharacterId)
      .then(setCharacter)
      .catch(() => setCharacter(null))
    characterGalleryApi
      .list(activeCharacterId)
      .then(setGallery)
      .catch(() => setGallery([]))
  }, [activeCharacterId])

  const closeLightbox = useCallback(() => setLightboxSrc(null), [])

  // Resolve lightbox URL — use original quality (no size tier) for full aspect ratio
  const getLightboxUrl = useCallback(() => {
    if (activeChatAvatarId) {
      // Active alternate override — check if it has an original (uncropped) image
      const alts = character?.extensions?.alternate_avatars as Array<{ image_id: string; original_image_id?: string }> | undefined
      const altEntry = alts?.find((a) => a.image_id === activeChatAvatarId)
      if (altEntry?.original_image_id) return imagesApi.url(altEntry.original_image_id)
      return imagesApi.url(activeChatAvatarId)
    }
    // Primary avatar — the character card image is already stored at full size
    if (character?.image_id) return imagesApi.url(character.image_id)
    return null
  }, [character, activeChatAvatarId])

  if (!activeCharacterId) return null

  const avatarUrl = activeChatAvatarId
    ? imagesApi.largeUrl(activeChatAvatarId)
    : (getCharacterAvatarLargeUrl(character) ?? '')
  const charName = character?.name || ''

  return (
    <motion.div
      className={clsx(styles.panelOuter, side === 'left' ? styles.panelOuterLeft : styles.panelOuterRight)}
      initial={{ width: 0 }}
      animate={{ width: 220 }}
      exit={{ width: 0 }}
      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
    >
      <motion.div
        className={styles.panel}
        initial={{ opacity: 0, x: side === 'left' ? -12 : 12 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: side === 'left' ? -12 : 12 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        <button
          onClick={togglePortraitPanel}
          type="button"
          className={styles.closeBtn}
          aria-label="Close portrait panel"
        >
          <X size={14} />
        </button>

        <AvatarSwitcherPopover chatId={activeChatId || ''}>
          <div className={styles.frame} onClick={() => setLightboxSrc(getLightboxUrl())}>
            <LazyImage
              src={avatarUrl}
              alt={charName}
              containerClassName={styles.portrait}
              style={{ objectFit: 'contain', width: '100%', height: 'auto' }}
              fallback={
                <div className={styles.placeholder}>
                  {(charName || '?')[0].toUpperCase()}
                </div>
              }
            />
          </div>
        </AvatarSwitcherPopover>

        <span className={styles.name}>{charName}</span>

        {gallery.length > 0 && (
          <div className={styles.mosaic}>
            {gallery.map((item, i) => {
              const ar = (item.width && item.height) ? item.width / item.height : 1
              // Assign span class based on aspect ratio and position for visual variety
              let span = styles.mosaicCell
              if (ar >= 1.4) {
                span = clsx(styles.mosaicCell, styles.mosaicWide)
              } else if (ar <= 0.7) {
                span = clsx(styles.mosaicCell, styles.mosaicTall)
              } else if (i % 5 === 0) {
                span = clsx(styles.mosaicCell, styles.mosaicLarge)
              }

              return (
                <div
                  key={item.id}
                  className={span}
                  onClick={() => setLightboxSrc(characterGalleryApi.imageUrl(item.image_id))}
                >
                  <LazyImage
                    src={characterGalleryApi.smallUrl(item.image_id)}
                    alt={item.caption || ''}
                    className={styles.mosaicImg}
                    fallback={<div className={styles.mosaicPlaceholder} />}
                  />
                </div>
              )
            })}
          </div>
        )}
      </motion.div>

      <ImageLightbox src={lightboxSrc} onClose={closeLightbox} />
    </motion.div>
  )
}
