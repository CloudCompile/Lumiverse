# Runtime state

`spindle.host.capabilities['runtime-state-v1'] >= 1` advertises a combined read and mutation API for extensions that keep a local working state. Existing CRUD APIs are unchanged.

```ts
const state = await spindle.runtimeState.read(chatId, characterId, userId)
const result = await spindle.runtimeState.write(chatId, {
  kind: 'chat.variables', values: { score: '10' },
}, userId, crypto.randomUUID())
```

Reads require `characters`, `chats`, `chat_mutation`, `personas`, and `world_books`. The host checks the authenticated extension scope and chat owner before accessing data. Operator extensions must supply a user; user installations default to their owner.

## Read result

The result contains `revision`, `chat`, `character`, `persona`, `messages`, `lore`, and `globalVariables`. Reads are synchronous within one host operation, preventing other host requests from interleaving these reads.

- `revision` is `{ epoch: string, sequence: number }`. The epoch changes on host restart; the sequence advances for state events belonging to this user.
- `character` omits `extensions` and includes `world_book_ids` instead.
- `messages` include the active content, role, name, index, timestamps and greeting index. Alternate swipes and unrelated extra fields are omitted.
- `lore` contains entries from the selected character's attached world books.
- `persona` is the user's active persona or `null`; `globalVariables` comes from the user's global macro-variable setting.

The read cost grows with chat history and attached lore. Bootstrap or resynchronize when needed; do not read the complete state for each rendered message.

## Mutations

`write(chatId, command, userId?, mutationId?)` returns `{ revision, value, patch }`. `value` is the operation's result; `patch` contains only the changed record or deleted identifier.

| Command kind | Fields | Permission |
| --- | --- | --- |
| `chat.metadata` | `key`, `value` | `chats` |
| `chat.variables` | `values: Record<string, string \| null>` | `chats` |
| `message.create` | `id` (UUID v4), `content`, `role` (`system`, `assistant`, `user`) | `chat_mutation` |
| `message.edit` | `id`, `content` | `chat_mutation` |
| `message.delete` | `id` | `chat_mutation` |
| `character.update` | `id`, `patch` (`name`, `description`, `first_mes`) | `characters` |
| `persona.update` | `id`, `patch` (`name`, `description`) | `personas` |
| `lore.create` | `bookId`, `patch` (world-book entry fields) | `world_books` |
| `lore.update` | `id`, `patch` (world-book entry fields) | `world_books` |
| `lore.delete` | `id` | `world_books` |

Variable writes merge the supplied keys and preserve other chat metadata. Message edits and deletions must target this chat. Character, persona and lore operations retain the corresponding service's ownership checks. A supplied message ID cannot overwrite an existing message.

## Events and acknowledgement ordering

Relevant WebSocket events carry `stateRevision` outside the existing payload. Frontend `ctx.events.on` callbacks receive it in a second metadata argument. Supplying a mutation UUID also adds `runtimeMutationId` to events emitted by that mutation, allowing a client to match its own write acknowledgement without suppressing unrelated changes.

These identifiers are not a durable event log, a compare-and-swap token, or an idempotency guarantee. Apply revisions per changed field; a delta is not a complete snapshot. Reconnects require resynchronization, and a changed epoch invalidates comparisons with earlier revisions. Event payloads and ordinary event subscribers remain compatible.
