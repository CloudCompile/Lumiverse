import { describe, expect, test } from 'bun:test'
import type { Character } from '@/types/api'
import { previewAppearanceMetadata } from './avatarBindings'

function character(): Character {
  return {
    id: 'char-1',
    name: 'Character',
    avatar_path: null,
    image_id: 'primary-image',
    description: '',
    personality: '',
    scenario: '',
    first_mes: 'Hello',
    mes_example: '',
    creator: '',
    creator_notes: '',
    library_scope: 'mine',
    system_prompt: '',
    post_history_instructions: '',
    folder: '',
    tags: [],
    alternate_greetings: ['Winter hello'],
    talkativeness: 0.5,
    extensions: {
      alternate_avatars: [{ id: 'winter-avatar', image_id: 'winter-image', label: 'Winter' }],
      avatar_bindings: {
        'winter-avatar': { description: 'winter-desc', personality: null, greeting_index: 1 },
      },
    },
    created_at: 0,
    updated_at: 0,
  }
}

describe('avatar appearance previews', () => {
  test('applies the complete binding before the request resolves', () => {
    const metadata = previewAppearanceMetadata(character(), {
      alternate_field_selections: { personality: 'old-personality' },
    }, { type: 'avatar', avatar_entry_id: 'winter-avatar' })

    expect(metadata.active_avatar_id).toBe('winter-image')
    expect(metadata.active_avatar_entry_id).toBe('winter-avatar')
    expect(metadata.alternate_field_selections).toEqual({ description: 'winter-desc' })
    expect(metadata.activeGreetingIndex).toBe(1)
  })

  test('keeps group member appearance isolated', () => {
    const metadata = previewAppearanceMetadata(character(), {
      group: true,
      character_ids: ['char-1', 'char-2'],
      group_active_avatar_ids: { 'char-2': 'other-image' },
    }, { type: 'field', field: 'description', variant_id: 'winter-desc', character_id: 'char-1' })

    expect(metadata.group_active_avatar_ids).toEqual({
      'char-1': 'winter-image',
      'char-2': 'other-image',
    })
    expect(metadata.group_alternate_field_selections['char-1']).toEqual({ description: 'winter-desc' })
  })
})
