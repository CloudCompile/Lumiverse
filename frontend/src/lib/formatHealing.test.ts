import { describe, expect, test } from 'bun:test'
import { healFormattingArtifacts } from './formatHealing'

describe('healFormattingArtifacts', () => {
  test('closes unclosed font tags around dialogue and actions', () => {
    expect(healFormattingArtifacts('<font color="aaabbb>"Hey there." They said.'))
      .toBe('<font color="aaabbb">"Hey there."</font> They said.')
    expect(healFormattingArtifacts('<font color=xxxxxx>"Hey hey!" <font color=baabaa>*They look great today.*'))
      .toBe('<font color=xxxxxx>"Hey hey!"</font> <font color=baabaa>*They look great today.*</font>')
  })

  test('does not change balanced font tags', () => {
    const input = '<font color=#abc>"Hello."</font> <font color=#def>*She smiled.*</font>'
    expect(healFormattingArtifacts(input)).toBe(input)
  })

  test('preserves fenced code while healing surrounding prose', () => {
    const input = 'Use this exactly:\n```json\n{ "example": "* softly*" }\n```\n\nThen * softly*.'
    expect(healFormattingArtifacts(input)).toBe(
      'Use this exactly:\n```json\n{ "example": "* softly*" }\n```\n\nThen *softly*.',
    )
  })
})

test('preserves adjacent HTML buttons with an empty conditional class', () => {
  const html = '<div class="grid"><div class="btn " data-action="one">One</div><div class="btn active" data-action="two">Two</div></div>';
  expect(healFormattingArtifacts(html)).toBe(html);
});
test('heals prose without changing HTML attribute values or comments', () => {
  const html = '<div title="a > b" data-label="* padded *"><!-- " padded " -->* padded * and " padded "</div>';
  expect(healFormattingArtifacts(html)).toBe('<div title="a > b" data-label="* padded *"><!-- " padded " -->*padded* and "padded"</div>');
});
