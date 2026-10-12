import { get, post } from './client'

export interface PollinationsDeviceCode {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export interface PollinationsBalance {
  /** Pollen remaining for this key (key budget when budgeted, else account total). */
  balance: number
  /** Full account balances; only present when the key carries the `usage` scope. */
  account_balance: { total: number; tier: number; paid: number } | null
}

export interface PollinationsDailyUsage {
  daily: { date: string; requests: number; cost_usd: number }[]
  today_requests: number
  today_cost_usd: number
  month_cost_usd: number
  window_days: number
}

export interface PollinationsAccountUsage {
  balance: PollinationsBalance | null
  usage: PollinationsDailyUsage | null
  errors: Partial<Record<'balance' | 'usage', string>>
}

export type PollinationsDevicePollResult =
  | { status: 'pending' }
  | {
      status: 'complete'
      created: boolean
      connection_id: string
      profile: import('@/types/api').ConnectionProfile
    }

export interface PollinationsDeviceStartInput {
  models?: string
  budget?: number
  expiry?: number
  permissions?: string
}

export const pollinationsApi = {
  /** Start the BYOP device-authorization flow (App Key stays server-side). */
  startDeviceAuth(input: PollinationsDeviceStartInput = {}) {
    return post<PollinationsDeviceCode>('/pollinations/device/start', input)
  },

  /** Poll once for the user-authorized key; resolves `pending` until approved. */
  pollDeviceAuth(deviceCode: string, opts: { connectionId?: string; connectionName?: string }) {
    const body: Record<string, string> = { device_code: deviceCode }
    if (opts.connectionId) body.connection_id = opts.connectionId
    else if (opts.connectionName) body.connection_name = opts.connectionName
    return post<PollinationsDevicePollResult>('/pollinations/device/poll', body)
  },

  /** Account balance and usage for a connection's user-authorized key. */
  account(connectionId: string) {
    return get<PollinationsAccountUsage>('/pollinations/account', { connection_id: connectionId })
  },
}
