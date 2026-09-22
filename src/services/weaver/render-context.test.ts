import { describe, expect, test } from 'bun:test'
import { getBuildRegistry } from './build-registry'
import { getField, groupFieldsIntoDependencyWaves, type WeaverFieldDef } from './fields'
import { buildFieldRenderUserMessage } from './prompts'
import type { WeaverBibleSpine } from '../../types/weaver'

const reg = getBuildRegistry('character')
const spine: WeaverBibleSpine = {
  brief: 'A disgraced cartographer.',
  entries: [
    { slot: 'name', content: 'Vesna' },
    { slot: 'voice', content: 'Clipped, dry, allergic to sincerity.' },
  ],
  causal_links: [],
  dynamic: [],
} as unknown as WeaverBibleSpine

function renderUserFor(fieldId: string, established?: Map<string, string>): string {
  const field = getField(reg.fieldDefs, fieldId)!
  return buildFieldRenderUserMessage(reg, { field, spine, established })
}

describe('first_mes render context', () => {
  test('first_mes declares a dependency on the scenario it is written inside', () => {
    expect(getField(reg.fieldDefs, 'first_mes')?.dependsOn).toContain('scenario')
    expect(getField(reg.fieldDefs, 'first_mes')?.order ?? 0)
      .toBeGreaterThan(getField(reg.fieldDefs, 'scenario')?.order ?? 0)
  })

  test('carries the rendered scenario into the first_mes prompt', () => {
    const scenario = 'Vesna is bent over a torn chart at the harbour wall, mid-argument.'
    const user = renderUserFor('first_mes', new Map([['scenario', scenario]]))

    expect(user).toContain(scenario)
    expect(user).toContain('ALREADY WRITTEN')
  })

  test('omits the block entirely when no dependency has rendered yet', () => {
    const user = renderUserFor('first_mes')

    expect(user).not.toContain('ALREADY WRITTEN')
    expect(user).toContain('Now write the First message field.')
  })

  test('ignores blank dependency content rather than emitting an empty block', () => {
    const user = renderUserFor('first_mes', new Map([['scenario', '   ']]))

    expect(user).not.toContain('ALREADY WRITTEN')
  })

  test('does not leak dependency content into fields that declare none', () => {
    const user = renderUserFor('personality', new Map([['scenario', 'SECRET SCENE TEXT']]))

    expect(user).not.toContain('SECRET SCENE TEXT')
  })
})

describe('dependency wave scheduling', () => {
  const def = (id: string, order: number, dependsOn?: string[]): WeaverFieldDef =>
    ({ id, label: id, order, dependsOn } as WeaverFieldDef)

  const waveIndexOf = (waves: WeaverFieldDef[][], id: string): number =>
    waves.findIndex((wave) => wave.some((d) => d.id === id))

  test('holds every character field that depends on another until a later wave', () => {
    const waves = groupFieldsIntoDependencyWaves(reg.fieldDefs)

    expect(waveIndexOf(waves, 'first_mes')).toBeGreaterThan(waveIndexOf(waves, 'scenario'))
  })

  test('holds the world opening until after its scenario', () => {
    const world = getBuildRegistry('world')
    const waves = groupFieldsIntoDependencyWaves(world.fieldDefs)

    expect(waveIndexOf(waves, 'first_mes')).toBeGreaterThan(waveIndexOf(waves, 'scenario'))
  })

  test('holds world alternate greetings until the main opening is written', () => {
    const world = getBuildRegistry('world')
    const waves = groupFieldsIntoDependencyWaves(world.fieldDefs)

    expect(waveIndexOf(waves, 'alternate_greetings'))
      .toBeGreaterThan(waveIndexOf(waves, 'first_mes'))
  })

  test('passes the main opening into world alternates as established context', () => {
    const world = getBuildRegistry('world')
    const field = getField(world.fieldDefs, 'alternate_greetings')!
    const user = buildFieldRenderUserMessage(world, {
      field,
      spine,
      established: new Map([['first_mes', 'The tide is already climbing the steps.']]),
    })

    expect(user).toContain('The tide is already climbing the steps.')
    expect(user).toContain('ALREADY WRITTEN')
  })

  test('orders waves by dependency depth, not declaration order', () => {
    const waves = groupFieldsIntoDependencyWaves([
      def('c', 1, ['b']),
      def('a', 2),
      def('b', 3, ['a']),
    ])

    expect(waves.map((wave) => wave.map((d) => d.id))).toEqual([['a'], ['b'], ['c']])
  })

  test('keeps independent fields in one shared wave', () => {
    const waves = groupFieldsIntoDependencyWaves([def('a', 1), def('b', 2)])

    expect(waves).toHaveLength(1)
  })

  test('treats a missing dependency as unblocked rather than stalling it', () => {
    const waves = groupFieldsIntoDependencyWaves([def('a', 1, ['ghost'])])

    expect(waves).toHaveLength(1)
    expect(waves[0][0].id).toBe('a')
  })

  test('terminates on a dependency cycle instead of recursing forever', () => {
    const waves = groupFieldsIntoDependencyWaves([def('a', 1, ['b']), def('b', 2, ['a'])])

    expect(waves.flat()).toHaveLength(2)
  })
})
