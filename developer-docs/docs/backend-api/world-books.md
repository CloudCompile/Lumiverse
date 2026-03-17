# World Books

!!! warning "Permission required: `world_books`"

Full CRUD access to the user's world books and their entries. Use this for extensions that manage, analyze, or batch-edit World Info / lorebook data.

## Usage

```ts
// List world books (paginated)
const { data, total } = await spindle.world_books.list({ limit: 20, offset: 0 })

// Get a single world book
const book = await spindle.world_books.get('world-book-id')
if (book) {
  spindle.log.info(`Found: ${book.name} (${book.description})`)
}

// Create a world book
const newBook = await spindle.world_books.create({
  name: 'My Lorebook',
  description: 'Character knowledge base',
})

// Update a world book
const updated = await spindle.world_books.update(newBook.id, {
  description: 'Updated description',
})

// Delete a world book (cascades all entries)
const deleted = await spindle.world_books.delete(newBook.id)
```

## Methods

| Method | Returns | Description |
|---|---|---|
| `list(options?)` | `Promise<{ data: WorldBookDTO[], total: number }>` | List world books. Options: `{ limit?, offset? }`. Defaults: limit 50, max 200. |
| `get(worldBookId)` | `Promise<WorldBookDTO \| null>` | Get a world book by ID. Returns `null` if not found. |
| `create(input)` | `Promise<WorldBookDTO>` | Create a new world book. `name` is required. |
| `update(worldBookId, input)` | `Promise<WorldBookDTO>` | Update a world book. All fields are optional. |
| `delete(worldBookId)` | `Promise<boolean>` | Delete a world book and all its entries. Returns `true` if deleted. |

## WorldBookDTO

```ts
{
  id: string
  name: string
  description: string
  metadata: Record<string, unknown>
  created_at: number   // unix epoch seconds
  updated_at: number
}
```

## WorldBookCreateDTO

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | World book name |
| `description` | `string` | No | Description |
| `metadata` | `Record<string, unknown>` | No | Arbitrary metadata |

## WorldBookUpdateDTO

Same fields as `WorldBookCreateDTO`, but all are optional (including `name`).

---

## Entries

World book entries are managed via `spindle.world_books.entries`. Each entry belongs to a world book and contains keywords, content, and activation settings used by the World Info system during prompt assembly.

### Entry Usage

```ts
// List entries in a world book (paginated)
const { data, total } = await spindle.world_books.entries.list('world-book-id', {
  limit: 50, offset: 0,
})

// Get a single entry
const entry = await spindle.world_books.entries.get('entry-id')
if (entry) {
  spindle.log.info(`Entry: ${entry.comment} — keys: ${entry.key.join(', ')}`)
}

// Create an entry
const newEntry = await spindle.world_books.entries.create('world-book-id', {
  key: ['dragon', 'dragons'],
  keysecondary: ['fire', 'scales'],
  content: 'Dragons are ancient creatures that breathe fire.',
  comment: 'Dragon lore',
  position: 0,
  selective: true,
})

// Update an entry
const updatedEntry = await spindle.world_books.entries.update(newEntry.id, {
  content: 'Dragons are ancient, intelligent creatures that breathe fire.',
  disabled: false,
})

// Delete an entry
const entryDeleted = await spindle.world_books.entries.delete(newEntry.id)
```

### Entry Methods

| Method | Returns | Description |
|---|---|---|
| `list(worldBookId, options?)` | `Promise<{ data: WorldBookEntryDTO[], total: number }>` | List entries in a world book. Options: `{ limit?, offset? }`. Defaults: limit 50, max 200. |
| `get(entryId)` | `Promise<WorldBookEntryDTO \| null>` | Get an entry by ID. Returns `null` if not found. |
| `create(worldBookId, input)` | `Promise<WorldBookEntryDTO>` | Create a new entry in a world book. All fields are optional. |
| `update(entryId, input)` | `Promise<WorldBookEntryDTO>` | Update an entry. All fields are optional. |
| `delete(entryId)` | `Promise<boolean>` | Delete an entry. Returns `true` if deleted. |

### WorldBookEntryDTO

```ts
{
  id: string
  world_book_id: string
  uid: string
  key: string[]                // primary activation keywords
  keysecondary: string[]       // secondary keywords (for selective mode)
  content: string              // the injected text
  comment: string              // human-readable label
  position: number             // injection position (0=before, 1=after, 4=depth, etc.)
  depth: number                // depth for position-based injection
  role: string | null          // "system", "user", or "assistant"
  order_value: number          // sort order within position bucket
  selective: boolean           // require secondary keys to match too
  constant: boolean            // always active (skip keyword check)
  disabled: boolean            // entry is disabled
  group_name: string           // mutual exclusion group
  group_override: boolean      // override group competition
  group_weight: number         // weight for group selection
  probability: number          // activation probability (0-100)
  scan_depth: number | null    // how many messages to scan for keywords
  case_sensitive: boolean      // case-sensitive keyword matching
  match_whole_words: boolean   // match whole words only
  automation_id: string | null // automation identifier
  use_regex: boolean           // treat keys as regex patterns
  prevent_recursion: boolean   // prevent recursive activation
  exclude_recursion: boolean   // exclude from recursion scanning
  delay_until_recursion: boolean
  priority: number             // activation priority
  sticky: number               // stay active for N turns after match
  cooldown: number             // cooldown turns after deactivation
  delay: number                // delay N turns before first activation
  selective_logic: number      // 0=AND, 1=NOT, 2=OR for secondary keys
  use_probability: boolean     // whether probability field is active
  vectorized: boolean          // entry has vector embeddings
  extensions: Record<string, unknown>
  created_at: number           // unix epoch seconds
  updated_at: number
}
```

### WorldBookEntryCreateDTO / WorldBookEntryUpdateDTO

All fields are optional. Common fields you'll typically set:

| Field | Type | Description |
|---|---|---|
| `key` | `string[]` | Primary activation keywords |
| `keysecondary` | `string[]` | Secondary keywords (used with `selective`) |
| `content` | `string` | The text to inject into the prompt |
| `comment` | `string` | Human-readable label/name |
| `position` | `number` | Injection position (0=WI Before, 1=WI After, 4=at depth) |
| `depth` | `number` | Depth for position-based injection (default 4) |
| `selective` | `boolean` | Require secondary keys to also match |
| `constant` | `boolean` | Always active regardless of keywords |
| `disabled` | `boolean` | Disable this entry |
| `order_value` | `number` | Sort order within position bucket (default 100) |
| `priority` | `number` | Activation priority (default 10) |

See `WorldBookEntryDTO` above for the full list of supported fields.

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, the user ID is resolved from the extension context. World books are always scoped to a single user.
