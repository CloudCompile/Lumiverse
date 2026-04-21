# Tokens

Request token counts from the Lumiverse server using the same tokenizer-resolution logic the backend uses for prompt assembly and generation breakdowns.

No permission is required. This is a free-tier API.

## Usage

```ts
// Count plain text against the user's default main connection model
const textCount = await spindle.tokens.countText('Hello from my extension')

// Count a message array against the selected sidecar model
const messages = await spindle.chat.getMessages(chatId)
const messageCount = await spindle.tokens.countMessages(messages, {
  modelSource: 'sidecar',
})

// Count the live stored chat directly on the server
const chatCount = await spindle.tokens.countChat(chatId)

spindle.log.info(
  `Chat uses ${chatCount.total_tokens} tokens on ${chatCount.model} (${chatCount.tokenizer_name})`
)
```

## Model Source

All three methods accept an optional `options.modelSource`:

- `'main'` — use the user's default main connection profile model
- `'sidecar'` — use the user's selected sidecar model, or fall back to that sidecar connection's configured model when the sidecar model override is empty

If omitted, `modelSource` defaults to `'main'`.

## Methods

### `spindle.tokens.countText(text, options?)`

Count tokens for a raw string.

```ts
const result = await spindle.tokens.countText('Summarize this paragraph', {
  modelSource: 'main',
})
```

**Returns:** `Promise<TokenCountResultDTO>`

### `spindle.tokens.countMessages(messages, options?)`

Count tokens for an array of `{ role, content }` messages.

This accepts the normalized output of `spindle.chat.getMessages(chatId)` directly because those message objects already expose compatible `role` and `content` fields.

```ts
const messages = await spindle.chat.getMessages(chatId)

const result = await spindle.tokens.countMessages(messages, {
  modelSource: 'sidecar',
})
```

**Returns:** `Promise<TokenCountResultDTO>`

### `spindle.tokens.countChat(chatId, options?)`

Count tokens for the current stored contents of a Lumiverse chat.

The host reads the chat messages from the database, normalizes their roles the same way `spindle.chat.getMessages()` does, flattens them into the token-count wire format, and then runs the resolved tokenizer.

```ts
const result = await spindle.tokens.countChat(chatId, {
  modelSource: 'main',
})
```

**Returns:** `Promise<TokenCountResultDTO>`

## Result Shape

```ts
type TokenCountResultDTO = {
  total_tokens: number
  model: string
  modelSource: 'main' | 'sidecar'
  tokenizer_id: string | null
  tokenizer_name: string
  approximate: boolean
}
```

| Field | Type | Description |
|---|---|---|
| `total_tokens` | `number` | Computed token count for the supplied text or messages |
| `model` | `string` | Model ID that was actually used to resolve the tokenizer |
| `modelSource` | `'main' \| 'sidecar'` | Which configuration source supplied the model |
| `tokenizer_id` | `string \| null` | Matched tokenizer ID, or `null` when no exact tokenizer mapping was found |
| `tokenizer_name` | `string` | Human-readable tokenizer label |
| `approximate` | `boolean` | `true` when Lumiverse fell back to the approximate char/4 heuristic |

## Error Cases

These helpers reject when the server cannot resolve the requested model context. Common examples:

- no default connection is configured and `modelSource` is `'main'`
- the default connection exists but does not have a model configured
- no sidecar connection is configured and `modelSource` is `'sidecar'`
- the selected sidecar connection no longer exists
- `countChat(chatId)` is called for a chat the extension cannot access

## Notes

- The count reflects Lumiverse's tokenizer mapping for the resolved model, not the upstream provider's eventual billing counters.
- When no tokenizer pattern matches the resolved model, Lumiverse falls back to an approximate `chars / 4` heuristic and sets `approximate: true`.
- `countMessages()` flattens messages as `role + newline + content`, matching the backend's shared token-count helper for chat-style message arrays.

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, pass `options.userId` when counting text or message arrays. `countChat(chatId)` derives ownership from the chat itself and rejects if you provide a mismatched `userId`.
