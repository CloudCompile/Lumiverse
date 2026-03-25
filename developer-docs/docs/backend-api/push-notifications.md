# Push Notifications

!!! warning "Permission required: `push_notification`"
    This is a privileged permission. The user must explicitly grant it from the Extensions panel.

Send OS-level push notifications to users' devices. Notifications are delivered even when the Lumiverse app is closed or backgrounded — ideal for alerting users to completed tasks, character activity, or time-sensitive events.

Notifications are automatically **suppressed** when the user is actively viewing the app (the service worker checks for focused clients), so you won't double-notify alongside in-app toasts.

## Usage

```ts
// Send a push notification
const { sent } = await spindle.push.send({
  title: 'Task Complete',
  body: 'Your character analysis is ready!',
})

spindle.log.info(`Push sent to ${sent} device(s)`)
```

### With Options

```ts
// Tag collapses rapid notifications (same tag = single notification)
await spindle.push.send({
  title: 'New Message',
  body: 'Alice sent you a reply',
  tag: 'chat-update',
  url: '/#/chat/abc123',    // Where the notification click navigates
})
```

## Methods

### `spindle.push.send(input, userId?)`

Send a push notification to a user's registered devices.

| Parameter | Type | Description |
|---|---|---|
| `input.title` | `string` | Notification title (max 100 chars, auto-prefixed with extension name) |
| `input.body` | `string` | Notification body text (max 500 chars) |
| `input.tag` | `string?` | Dedup key — notifications with the same tag replace each other |
| `input.url` | `string?` | URL to navigate to when the notification is clicked (default: `/`) |
| `userId` | `string?` | Target user (operator-scoped extensions only; user-scoped infers from owner) |

**Returns:** `Promise<{ sent: number }>` — number of devices the notification was delivered to.

### `spindle.push.getStatus(userId?)`

Check if push notifications are available for a user.

| Parameter | Type | Description |
|---|---|---|
| `userId` | `string?` | Target user (operator-scoped extensions only) |

**Returns:** `Promise<{ available: boolean; subscriptionCount: number }>`

- `available`: `true` if the user has at least one registered push subscription
- `subscriptionCount`: number of registered devices

## Attribution

Every push notification title is automatically prefixed with your extension name: **"Your Extension: Your Title"**. This ensures users always know which extension triggered the notification and cannot be spoofed.

## Checking Before Sending

Always check if push is available before relying on it for critical workflows:

```ts
const status = await spindle.push.getStatus()
if (!status.available) {
  // Fall back to in-app toast
  spindle.toast.info('Task complete! (Enable push notifications for background alerts)')
  return
}

await spindle.push.send({
  title: 'Task Complete',
  body: 'Your analysis is ready',
})
```

## Example: Character "Bugging" the User

```ts
// An extension that makes a character ping the user after inactivity
spindle.on('GENERATION_ENDED', async (payload) => {
  const chatId = payload.chatId

  // Wait 5 minutes, then send a "nudge" push
  setTimeout(async () => {
    const status = await spindle.push.getStatus()
    if (!status.available) return

    await spindle.push.send({
      title: 'Missing You',
      body: 'Hey, are you still there? I was thinking about what you said...',
      tag: `nudge-${chatId}`,
      url: `/#/chat/${chatId}`,
    })
  }, 5 * 60 * 1000)
})
```

## Example: Background Task Completion

```ts
async function runLongAnalysis(chatId: string) {
  spindle.toast.info('Analysis started — you can close the app, we\'ll notify you when done.')

  // Do expensive work...
  const result = await analyzeChat(chatId)

  // Notify via push (works even if user closed the tab)
  await spindle.push.send({
    title: 'Analysis Complete',
    body: `Found ${result.insights.length} insights across ${result.messagesScanned} messages`,
    tag: `analysis-${chatId}`,
    url: `/#/chat/${chatId}`,
  })
}
```

!!! tip "Best Practices"
    - Check `getStatus()` before sending — don't assume push is available
    - Use `tag` to avoid notification spam (rapid updates collapse into one)
    - Fall back to `spindle.toast` when push isn't available
    - Keep titles short and bodies actionable
    - Use `url` so clicking the notification takes the user somewhere useful
