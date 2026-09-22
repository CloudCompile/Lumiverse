import { describe, expect, test } from 'bun:test'
import {
  desktopPathBasename,
  filesFromDesktopDrop,
  isSupportedCharacterDropPath,
} from './desktop-file-drop'

describe('desktop file drops', () => {
  test('recognizes the same character formats as the browser drop target', () => {
    expect(isSupportedCharacterDropPath('/cards/A.JSON')).toBe(true)
    expect(isSupportedCharacterDropPath('C:\\cards\\B.charx')).toBe(true)
    expect(isSupportedCharacterDropPath('/cards/avatar.jpeg')).toBe(true)
    expect(isSupportedCharacterDropPath('/cards/notes.txt')).toBe(false)
  })

  test('extracts a file name from Unix and Windows paths', () => {
    expect(desktopPathBasename('/cards/Alice.png')).toBe('Alice.png')
    expect(desktopPathBasename('C:\\cards\\Bob.jpg')).toBe('Bob.jpg')
  })

  test('reads supported paths into browser File objects in drop order', async () => {
    const reads: string[] = []
    const files = await filesFromDesktopDrop(
      ['/cards/Alice.png', '/cards/ignore.txt', 'C:\\cards\\Bob.json'],
      async (path) => {
        reads.push(path)
        return new Uint8Array([1, 2, 3])
      },
    )

    expect(reads).toEqual(['/cards/Alice.png', 'C:\\cards\\Bob.json'])
    expect(files.map((file) => [file.name, file.size])).toEqual([
      ['Alice.png', 3],
      ['Bob.json', 3],
    ])
    expect(files[0].type).toBe('image/png')
    expect(files[1].type.startsWith('application/json')).toBe(true)
  })
})
