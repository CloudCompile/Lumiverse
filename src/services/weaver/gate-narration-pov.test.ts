import { describe, expect, test } from 'bun:test'
import { getBuildRegistry } from './build-registry'
import { getField } from './fields'
import { buildFieldGatePrompt, buildFieldRenderPrompt } from './prompts'
import { getNarrationMode, NARRATION_MODES } from './narration'

const reg = getBuildRegistry('character')

describe('gate judges narration against the configured POV', () => {
  test('carries the narration POV into the gate prompt for narrated fields', () => {
    const field = getField(reg.fieldDefs, 'first_mes')!
    const second = NARRATION_MODES.find((m) => m.id === 'second')!

    const prompt = buildFieldGatePrompt(reg, field, second)

    expect(prompt).toContain('NARRATION POV')
    expect(prompt).toContain(second.guidance)
    expect(prompt).toContain('do not fail it for choosing a different grammatical person')
  })

  test('does not claim first person is required when the field was written in second', () => {
    const field = getField(reg.fieldDefs, 'first_mes')!
    const prompt = buildFieldGatePrompt(reg, field, getNarrationMode('second'))

    expect(prompt).not.toContain('not a neutral third-person camera')
  })

  test('omits the POV block for fields that are not narrated', () => {
    const field = getField(reg.fieldDefs, 'description')!
    const prompt = buildFieldGatePrompt(reg, field, getNarrationMode('second'))

    expect(prompt).not.toContain('NARRATION POV')
  })

  test('render and gate agree on the POV they were given', () => {
    const field = getField(reg.fieldDefs, 'first_mes')!
    const mode = getNarrationMode('third')

    expect(buildFieldRenderPrompt(reg, field, mode)).toContain(mode.guidance)
    expect(buildFieldGatePrompt(reg, field, mode)).toContain(mode.guidance)
  })
})
