# User Presence

Check whether a user currently has the Lumiverse app visible and focused. This is useful for extensions that want to avoid interrupting the user while they're actively using the app, or to defer background tasks until the user is away.

No permission is required. This is a free-tier utility.

## Usage

```ts
const visible = await spindle.users.isVisible()

if (visible) {
  spindle.log.info('User is actively viewing the app')
} else {
  spindle.log.info('User is away — safe to send a push notification')
}
```

## Methods

### `spindle.users.isVisible(userId?)`

Returns `true` if the user has the app visible in at least one browser tab or PWA window. Returns `false` if all sessions are hidden/backgrounded, or the user has no active WebSocket connections.

| Parameter | Type | Description |
|---|---|---|
| `userId` | `string?` | Target user (operator-scoped extensions only; user-scoped infers from owner) |

**Returns:** `Promise<boolean>`

## How It Works

The Lumiverse frontend automatically reports page visibility to the backend over the WebSocket connection using the [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API). The backend tracks visibility per-user, per-session:

- When a tab/window gains focus or becomes visible, the session is marked **visible**
- When a tab/window is hidden or backgrounded, the session is marked **hidden**
- When a WebSocket disconnects (tab closed, app quit), the session is removed

`isVisible()` returns `true` if **any** of the user's sessions are currently visible. This correctly handles multiple tabs, multiple devices, and PWA windows.

## Example: Deferred Push Notification

```ts
async function sendNudgeIfAway(userId: string, message: string) {
  const visible = await spindle.users.isVisible(userId)

  if (visible) {
    // User is here — use an in-app toast instead
    spindle.toast.info(message)
  } else {
    // User is away — send a push notification
    await spindle.push.send({
      title: 'Hey!',
      body: message,
    }, userId)
  }
}
```

## Example: Skip Background Work While Active

```ts
async function runMaintenanceTask() {
  const visible = await spindle.users.isVisible()

  if (visible) {
    spindle.log.info('User is active, deferring maintenance')
    setTimeout(runMaintenanceTask, 5 * 60 * 1000)
    return
  }

  // Safe to do expensive background work
  await performMaintenance()
}
```

!!! tip "Combining with Push Notifications"
    Push notifications are automatically suppressed by the service worker when the app is focused. However, `isVisible()` lets you make smarter decisions *before* generating the notification content — avoiding unnecessary LLM calls, database queries, or other expensive work when the user is right there in the app.

!!! note
    For user-scoped extensions, the user context is inferred automatically. For operator-scoped extensions, pass `userId` explicitly.
