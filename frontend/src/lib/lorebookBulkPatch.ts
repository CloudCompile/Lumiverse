/**
 * Sparse patch builder for the lorebook editor's bulk "set fields" bar.
 *
 * The bar used to hold hard-coded initial values (`'10'` / `'4'` / `'0'` /
 * `'keyword'`) and send all five fields on every Apply. A hard-coded default is
 * indistinguishable from a deliberate choice, so "select two entries, set State
 * to Disable, Apply" also wrote `priority = 10`, `depth = 4`, `position = 0` and
 * `trigger = 'keyword'` over whatever those entries actually had. The trigger
 * write was the worst of it: `src/services/world-books.service.ts` clears
 * `vectorized` and deletes the stored embeddings whenever a trigger arrives, so
 * a "disable" click permanently demoted every semantic entry in the selection to
 * a keyword entry — unrecoverable, and `revision` was bumped so the
 * optimistic-concurrency path could not recover it either.
 *
 * The server is innocent: it only builds `SET` clauses from keys it actually
 * receives, and every field on `WorldBookEntryBulkSetFieldsInput` is optional.
 * The fix is therefore entirely on this side — never send a key the user did not
 * set. `''` (the two number inputs) and `'unchanged'` (the three selects) both
 * mean "leave this column alone".
 *
 * Deliberately dependency-free: this module is unit-tested directly and must not
 * drag a React component tree (`EntryTable`, CSS modules) into the test process.
 */

export const BULK_UNCHANGED = 'unchanged'

export type BulkTriggerType = 'constant' | 'keyword' | 'vector'
export type BulkTriggerSelection = typeof BULK_UNCHANGED | BulkTriggerType
export type BulkEnabledSelection = typeof BULK_UNCHANGED | 'enabled' | 'disabled'
/** The position select's value: a stringified position, or the sentinel. */
export type BulkPositionSelection = typeof BULK_UNCHANGED | string

export interface BulkFieldForm {
  /** Free-text number input. `''` means untouched. */
  priority: string
  /** Free-text number input. `''` means untouched. */
  depth: string
  position: BulkPositionSelection
  trigger: BulkTriggerSelection
  enabled: BulkEnabledSelection
}

export interface BulkFieldPatch {
  priority?: number
  depth?: number
  position?: number
  trigger?: BulkTriggerType
  enabled?: boolean
}

/**
 * The state every control starts in, and the only state in which Apply is a
 * no-op. Exported so the workspace cannot re-introduce a literal default.
 */
export const EMPTY_BULK_FIELD_FORM: BulkFieldForm = {
  priority: '',
  depth: '',
  position: BULK_UNCHANGED,
  trigger: BULK_UNCHANGED,
  enabled: BULK_UNCHANGED,
}

/**
 * `null` when the field carries no instruction. Note `Number('')` is `0`, which
 * is exactly how an empty box used to become a real "set priority to 0" write —
 * so the emptiness test has to happen before the coercion, not after. Garbage is
 * dropped rather than coerced, for the same reason.
 */
function readNumericField(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === BULK_UNCHANGED) return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? Math.trunc(value) : null
}

/** Only the fields the user actually set. Never a full patch. */
export function buildBulkFieldPatch(form: BulkFieldForm): BulkFieldPatch {
  const patch: BulkFieldPatch = {}

  const priority = readNumericField(form.priority)
  if (priority !== null) patch.priority = priority

  const depth = readNumericField(form.depth)
  // Mirrors the server's own `Math.max(0, ...)` so the UI cannot claim to have
  // written a negative depth that the column will never hold.
  if (depth !== null) patch.depth = Math.max(0, depth)

  const position = readNumericField(form.position)
  if (position !== null) patch.position = position

  if (form.trigger !== BULK_UNCHANGED) patch.trigger = form.trigger
  if (form.enabled !== BULK_UNCHANGED) patch.enabled = form.enabled === 'enabled'

  return patch
}

/**
 * False when Apply would send nothing. The server rejects an empty `set_fields`
 * with "At least one field is required", so this gates the button rather than
 * letting the user discover it as an error toast.
 */
export function hasBulkFieldMutation(form: BulkFieldForm): boolean {
  return Object.keys(buildBulkFieldPatch(form)).length > 0
}
