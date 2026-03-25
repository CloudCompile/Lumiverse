import { useState, useEffect, useCallback } from 'react'
import { pushApi, type PushSubscriptionRecord } from '@/api/push'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

export function usePushSubscription() {
  const [isSupported] = useState(
    () => 'PushManager' in window && 'serviceWorker' in navigator && 'Notification' in window
  )
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [subscriptions, setSubscriptions] = useState<PushSubscriptionRecord[]>([])
  const [permissionState, setPermissionState] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  )

  // Check current subscription status on mount
  useEffect(() => {
    if (!isSupported) return

    navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription()
      setIsSubscribed(!!sub)
    })

    pushApi.listSubscriptions().then(setSubscriptions).catch(() => {})
  }, [isSupported])

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!isSupported) return false

    const permission = await Notification.requestPermission()
    setPermissionState(permission)
    if (permission !== 'granted') return false

    const { publicKey } = await pushApi.getVapidPublicKey()
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
    })

    const record = await pushApi.subscribe(sub.toJSON())
    setIsSubscribed(true)
    setSubscriptions((prev) => {
      const filtered = prev.filter((s) => s.id !== record.id)
      return [record, ...filtered]
    })
    return true
  }, [isSupported])

  const unsubscribe = useCallback(async (id: string): Promise<void> => {
    await pushApi.unsubscribe(id)
    setSubscriptions((prev) => prev.filter((s) => s.id !== id))

    // If we just removed the current browser's subscription, update browser state
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      const remaining = subscriptions.find(
        (s) => s.id !== id && s.endpoint === sub.endpoint
      )
      if (!remaining) {
        await sub.unsubscribe()
        setIsSubscribed(false)
      }
    }
  }, [subscriptions])

  const unsubscribeAll = useCallback(async (): Promise<void> => {
    // Unsubscribe browser-level
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) await sub.unsubscribe()

    // Unsubscribe all server-side
    await Promise.allSettled(subscriptions.map((s) => pushApi.unsubscribe(s.id)))
    setSubscriptions([])
    setIsSubscribed(false)
  }, [subscriptions])

  const testPush = useCallback(async (): Promise<boolean> => {
    const result = await pushApi.test()
    return result.success
  }, [])

  const refresh = useCallback(async () => {
    const subs = await pushApi.listSubscriptions()
    setSubscriptions(subs)
  }, [])

  return {
    isSupported,
    isSubscribed,
    permissionState,
    subscriptions,
    subscribe,
    unsubscribe,
    unsubscribeAll,
    testPush,
    refresh,
  }
}
