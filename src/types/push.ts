export interface PushSubscriptionRecord {
  type: "web_push";
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string;
  label: string;
  created_at: number;
  updated_at: number;
}

export interface DesktopNotificationDestinationRecord {
  type: "tauri_desktop";
  id: string;
  user_id: string;
  device_id: string;
  user_agent: string;
  label: string;
  platform: string;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
}

export type NotificationDestinationRecord =
  | PushSubscriptionRecord
  | DesktopNotificationDestinationRecord;

export interface CreatePushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
  label?: string;
}

export interface CreateDesktopNotificationDestinationInput {
  deviceId: string;
  label?: string;
  platform?: string;
  userAgent?: string;
}

export interface DesktopNotificationEnrollment {
  destination: DesktopNotificationDestinationRecord;
  credential: string;
  serverInstanceId: string;
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  data?: {
    url?: string;
    chatId?: string;
    characterName?: string;
    connectionName?: string;
    errorCode?: string;
    errorMessage?: string;
  };
  icon?: string;
  image?: string;
}

export interface PushNotificationPreferences {
  enabled: boolean;
  events: {
    generation_ended: boolean;
    generation_error: boolean;
  };
}
