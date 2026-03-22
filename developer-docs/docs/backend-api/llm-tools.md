# LLM Tools

!!! warning "Permission required: `tools`"

Register tools (function calling) that LLM providers can invoke during generation. Tools can also be made available as **Council tools**, allowing users to assign them to Council members for pre-generation analysis.

## Registering a Tool

```ts
spindle.registerTool({
  name: 'search_knowledge_base',
  display_name: 'Search Knowledge Base',
  description: 'Searches the extension knowledge base for relevant information',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results', default: 5 },
    },
    required: ['query'],
  },
  council_eligible: true,
})

// Unregister
spindle.unregisterTool('search_knowledge_base')
```

## ToolRegistrationDTO

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Unique tool identifier (bare name — no colons) |
| `display_name` | `string` | Human-readable name shown in the Council tools list |
| `description` | `string` | Description for the LLM. Used in function calling and as the tool prompt for Council sidecar mode |
| `parameters` | `JSONSchema` | JSON Schema defining the tool's input arguments |
| `council_eligible` | `boolean` | Optional. When `true`, the tool appears in the Council tools list and can be assigned to Council members. Default: `false` |

The `extension_id` field is set automatically by the host — you don't need to provide it.

## Council Tool Integration

When `council_eligible: true`, your tool appears in the user's Council panel alongside built-in tools. Users can assign it to any Council member. During generation, if the member is active (passes their dice roll), your tool is invoked.

### How tools are invoked

Tools execute differently depending on the Council **mode** (configured by the user):

| Mode | How your tool runs |
|---|---|
| **Sidecar** (default) | A separate sidecar LLM reads your tool's `description` as a prompt and generates a text response. Your extension is **not** called — sidecar tools use the LLM, not your code. |
| **Inline** | Your tool definition is sent as a function-call schema to the primary LLM. The LLM decides when to invoke it. |

!!! note "Extension tools always route to your worker"
    Unlike built-in/DLC tools (which are pure LLM prompts), **extension-registered tools** are always invoked via your worker — even in sidecar mode. The host sends a `tool_invocation` message to your worker with the chat context, and your code returns the result.

### Handling tool invocations

When your tool is invoked during Council execution, the host sends a `tool_invocation` event to your worker:

```ts
spindle.on('tool_invocation', async (event) => {
  const { toolName, args } = event

  if (toolName === 'search_knowledge_base') {
    const results = await searchMyKnowledgeBase(args.query, args.limit)
    return results.map(r => r.summary).join('\n')
  }

  return 'Unknown tool'
})
```

The return value is a string that becomes the tool's result in the Council deliberation block (visible to the main LLM during generation).

### Tool naming

Extension tools are stored internally with a qualified name: `extensionId:toolName`. When a user assigns your tool to a Council member, the qualified name is used. You don't need to worry about collisions with other extensions' tools.

### Execution context

Your tool receives the following in `args`:

| Field | Type | Description |
|---|---|---|
| `context` | `string` | Formatted chat context (character info, world info, recent messages) — the same context sidecar tools see |
| `__userId` | `string` | The user ID (for scoped operations) |
| `__deadlineMs` | `number` | Timestamp by which the tool must respond (derived from `timeoutMs` setting) |

### Tool lifecycle

- Tools are registered when your extension loads (`spindle.registerTool()`)
- Tools are automatically unregistered when your extension stops or unloads
- If the `tools` permission is revoked, registration silently fails and a `permission_denied` event fires

## Sidecar LLM

Council tools, expression detection, and other background LLM features share a **sidecar LLM connection** configured by the user in the Council panel under "Sidecar LLM". This is independent of the user's main generation connection.

The sidecar connection is stored as the `sidecarSettings` user setting:

```ts
interface SidecarConfig {
  connectionProfileId: string  // FK to a connection profile
  model: string                // Model override
  temperature: number          // Default: 0.7
  topP: number                 // Default: 0.9
  maxTokens: number            // Default: 1024
}
```

Your extension doesn't need to interact with sidecar settings directly — tool invocations are routed through the host, which handles connection resolution. If you need to fire your own LLM calls, use `spindle.generate.quiet()` or `spindle.generate.raw()` with the `generation` permission instead.
