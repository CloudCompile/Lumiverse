import { invoke } from '@tauri-apps/api/core'

const SUPPORTED_CHARACTER_FILE = /\.(json|png|charx|jpe?g)$/i

type ReadDroppedFile = (path: string) => Promise<ArrayBuffer | Uint8Array | number[]>

function defaultReadDroppedFile(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('read_frontend_drop_file', { path })
}

export function isSupportedCharacterDropPath(path: string): boolean {
  return SUPPORTED_CHARACTER_FILE.test(path)
}

export function desktopPathBasename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || 'character'
}

function droppedFileType(name: string): string {
  if (/\.png$/i.test(name)) return 'image/png'
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg'
  if (/\.json$/i.test(name)) return 'application/json'
  if (/\.charx$/i.test(name)) return 'application/zip'
  return 'application/octet-stream'
}

function binaryBlobPart(value: ArrayBuffer | Uint8Array | number[]): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value
  const source = value instanceof Uint8Array ? value : new Uint8Array(value)
  const copy = new Uint8Array(source.byteLength)
  copy.set(source)
  return copy.buffer
}

/**
 * Turn Tauri's native filesystem paths into browser `File` objects. The Rust
 * command accepts only paths from the immediately preceding OS drop and
 * consumes each authorization, so the remote frontend never gains general
 * filesystem access.
 */
export async function filesFromDesktopDrop(
  paths: string[],
  readDroppedFile: ReadDroppedFile = defaultReadDroppedFile,
): Promise<File[]> {
  const supported = paths.filter(isSupportedCharacterDropPath)
  return Promise.all(supported.map(async (path) => {
    const name = desktopPathBasename(path)
    const bytes = await readDroppedFile(path)
    return new File([binaryBlobPart(bytes)], name, { type: droppedFileType(name) })
  }))
}
