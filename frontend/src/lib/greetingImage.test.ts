import { describe, expect, test } from 'bun:test'
import type { Character } from '@/types/api'
import {
  containsGreetingImageMarkup,
  findEmbeddedGreetingImageSource,
  getGreetingCellImageUrl,
  resolveEmbeddedGreetingImage,
} from './greetingImage'

describe('greeting images', () => {
  test('recognizes and selects the first embedded greeting image', () => {
    const content = [
      'Opening text ![scene](https://images.example/scene.webp)',
      '<img src="https://images.example/later.png">',
    ].join('\n')

    expect(containsGreetingImageMarkup(content)).toBe(true)
    expect(findEmbeddedGreetingImageSource(content)).toBe('https://images.example/scene.webp')
  })

  test('resolves gallery and Risu image references through the character asset map', () => {
    expect(resolveEmbeddedGreetingImage(
      '![Scene](gallery://image-2)',
      { 'gallery://image-2': 'gallery-image-id' },
    )).toEqual({ imageId: 'gallery-image-id' })

    expect(resolveEmbeddedGreetingImage(
      '<img="embeded://opening.webp">',
      { opening: 'risu-image-id' },
    )).toEqual({ imageId: 'risu-image-id' })
  })

  test('uses embedded art as a fallback while explicit greeting art takes precedence', () => {
    const character = {
      extensions: {
        greeting_backgrounds: { 0: 'explicit-image-id' },
        risu_asset_map: { 'gallery://image-1': 'embedded-image-id' },
      },
    } as unknown as Character
    const content = '![Opening](gallery://image-1)'

    expect(getGreetingCellImageUrl(character, 0, content)).toContain('/images/explicit-image-id?size=sm')
    expect(getGreetingCellImageUrl(character, 1, content)).toContain('/images/embedded-image-id?size=sm')
  })
})
