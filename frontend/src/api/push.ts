import { get, post, del } from './client'

export interface PushSubscriptionRecord {
  type: 'web_push' | 'tauri_desktop'
  id: string
  user_id: string
  endpoint?: string
  device_id?: string
  user_agent: string
  label: string
  platform?: string
  created_at: number
  updated_at: number
  last_seen_at?: number | null
}

export interface DesktopNotificationEnrollment {
  destination: PushSubscriptionRecord & { type: 'tauri_desktop'; device_id: string }
  credential: string
  serverInstanceId: string
}

export interface PushTestResult {
  success: boolean
  sent: number
  reason?: 'no_subscriptions' | 'disabled' | 'event_disabled' | 'user_active'
}

export const pushApi = {
  getVapidPublicKey() {
    return get<{ publicKey: string }>('/push/vapid-public-key')
  },

  getDesktopInfo() {
    return get<{ serverInstanceId: string }>('/push/desktop/info')
  },

  listSubscriptions() {
    return get<PushSubscriptionRecord[]>('/push/subscriptions')
  },

  subscribe(subscription: PushSubscriptionJSON) {
    return post<PushSubscriptionRecord>('/push/subscriptions', {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      userAgent: navigator.userAgent,
    })
  },

  subscribeDesktop(input: { deviceId: string; label: string; platform: string }) {
    return post<DesktopNotificationEnrollment>('/push/desktop', {
      ...input,
      userAgent: navigator.userAgent,
    })
  },

  unsubscribe(id: string) {
    return del<{ success: boolean }>(`/push/subscriptions/${id}`)
  },

  test(destinationId?: string) {
    return post<PushTestResult>('/push/subscriptions/test', { destinationId })
  },
}
