# Generation

!!! warning "Permission required: `generation`"

Fire LLM generations programmatically.

## `spindle.generate.raw(input)`

Direct generation — you specify the provider, model, and messages.

```ts
const result = await spindle.generate.raw({
  messages: [
    { role: 'user', content: 'Summarize this text: ...' },
  ],
  parameters: { temperature: 0.3, max_tokens: 200 },
  connection_id: 'optional-connection-id',
})
// result: { content: string, finish_reason: string, usage: { ... } }
```

## `spindle.generate.quiet(input)`

Uses the user's active connection profile and preset parameters.

```ts
const result = await spindle.generate.quiet({
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' },
  ],
})
```

## `spindle.generate.batch(input)`

Run multiple generation requests.

```ts
const results = await spindle.generate.batch({
  requests: [
    { messages: [...], provider: 'openai', model: 'gpt-4o' },
    { messages: [...], provider: 'openai', model: 'gpt-4o' },
  ],
  concurrent: true,
})
// results: Array<{ index, success, content?, error? }>
```

## GenerationRequestDTO

| Field | Type | Description |
|---|---|---|
| `messages` | `LlmMessageDTO[]` | The message array to send |
| `parameters` | `Record<string, unknown>` | Optional LLM parameters (temperature, max_tokens, etc.) |
| `connection_id` | `string` | Optional. Use a specific connection profile (see Connection Profiles below) |

---

## Structured Output

Some providers support native structured output, ensuring the LLM response conforms to a JSON schema. Pass provider-specific parameters via the `parameters` field.

### Google Gemini

Use `responseMimeType` and `responseSchema` to request structured JSON output:

```ts
const result = await spindle.generate.raw({
  messages: [
    { role: 'user', content: 'Extract the character name and age from: "Alice is 25 years old."' },
  ],
  parameters: {
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name', 'age'],
    },
  },
  connection_id: 'my-gemini-connection',
})
// result.content: '{"name": "Alice", "age": 25}'
```

`responseJsonSchema` is accepted as an alias for `responseSchema`.

### OpenAI-compatible

Use the standard `response_format` parameter:

```ts
const result = await spindle.generate.raw({
  messages: [
    { role: 'user', content: 'Extract the character name and age.' },
  ],
  parameters: {
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'character_info',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'integer' },
          },
          required: ['name', 'age'],
        },
      },
    },
  },
  connection_id: 'my-openai-connection',
})
```

### Anthropic

Anthropic uses tool definitions for structured output. Define a tool with the desired output schema and set `tool_choice` to force it:

```ts
const result = await spindle.generate.raw({
  messages: [
    { role: 'user', content: 'Extract the character name and age.' },
  ],
  parameters: {
    tools: [{
      name: 'extract_info',
      description: 'Extract structured character information',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['name', 'age'],
      },
    }],
    tool_choice: { type: 'tool', name: 'extract_info' },
  },
  connection_id: 'my-anthropic-connection',
})
```

!!! tip
    Provider-specific parameters are passed through to the underlying API. Any parameter not explicitly handled by Lumiverse is forwarded directly, so you can use provider-specific features even if they aren't documented here.

---

## Connection Profiles

Extensions with the `generation` permission can discover and inspect the user's connection profiles. This lets you present a UI for selecting which LLM provider/model to use, or programmatically pick the right connection for your use case.

Connection profiles are returned as safe `ConnectionProfileDTO` objects — **API keys are never exposed** (only a `has_api_key` boolean).

### `spindle.connections.list(userId?)`

List all connection profiles available to the user.

```ts
const connections = await spindle.connections.list()
// connections: Array<{ id, name, provider, model, is_default, has_api_key, ... }>

const defaultConn = connections.find(c => c.is_default)
if (defaultConn) {
  const result = await spindle.generate.quiet({
    messages: [{ role: 'user', content: 'Hello' }],
    connection_id: defaultConn.id,
  })
}
```

### `spindle.connections.get(connectionId, userId?)`

Get a single connection profile by ID. Returns `null` if not found.

```ts
const conn = await spindle.connections.get('some-connection-id')
if (conn) {
  spindle.log.info(`Using ${conn.provider} / ${conn.model}`)
}
```

### ConnectionProfileDTO

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique connection profile ID |
| `name` | `string` | Human-readable display name |
| `provider` | `string` | LLM provider identifier (e.g. `"openai"`, `"anthropic"`) |
| `api_url` | `string` | Custom API URL (empty string for default) |
| `model` | `string` | Selected model identifier |
| `preset_id` | `string \| null` | Associated generation preset |
| `is_default` | `boolean` | Whether this is the user's default connection |
| `has_api_key` | `boolean` | Whether an API key is configured (key itself is never exposed) |
| `metadata` | `Record<string, unknown>` | Provider-specific metadata |
| `created_at` | `number` | Unix timestamp |
| `updated_at` | `number` | Unix timestamp |

!!! note
    For user-scoped extensions, the `userId` parameter is automatically inferred from the extension owner. For operator-scoped extensions, pass `userId` to scope the query to a specific user.
