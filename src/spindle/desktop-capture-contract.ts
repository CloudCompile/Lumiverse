export type DesktopCaptureKind = "image" | "video";

export interface DesktopCaptureDevice {
  id: string;
  name: string;
  platform: "linux" | "macos" | "windows";
  capabilities: { image: boolean; video: boolean; replay: boolean };
  expiresAt: number;
}

export type DesktopCaptureRequest = {
  deviceId: string;
  connectionId: string;
  purpose: string;
  userId?: string;
} & (
  | { kind: "image" }
  | { kind: "video"; mode: "record" | "replay"; durationSeconds: number }
);

export interface CapturedMediaRef {
  assetId: string;
  kind: DesktopCaptureKind;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds?: number;
  connectionId: string;
  expiresAt: number;
}

export interface SpindleDesktopAPI {
  capture: {
    listDevices(options?: { userId?: string }): Promise<DesktopCaptureDevice[]>;
    request(input: DesktopCaptureRequest): Promise<CapturedMediaRef>;
    release(assetId: string, options?: { userId?: string }): Promise<void>;
  };
}

export type DesktopCaptureWorkerMessage =
  | { type: "desktop_capture_devices"; requestId: string; userId?: string }
  | { type: "desktop_capture_request"; requestId: string; input: DesktopCaptureRequest }
  | { type: "desktop_capture_release"; requestId: string; assetId: string; userId?: string };

export interface DesktopCaptureDestination {
  connectionId: string;
  revision: string;
  provider: string;
  model: string;
  endpointOrigin: string;
}

export type DesktopCaptureCommand =
  | {
      type: "capture";
      requestId: string;
      extension: { id: string; identifier: string; name: string };
      purpose: string;
      kind: DesktopCaptureKind;
      mode?: "record" | "replay";
      durationSeconds?: number;
      destination: Omit<DesktopCaptureDestination, "revision">;
      maxBytes: number;
      maxPixels: number;
      expiresAt: number;
    }
  | { type: "cancel"; requestId: string };

export type DesktopCaptureReply =
  | {
      requestId: string;
      outcome: "approved";
      media: {
        mimeType: string;
        data: string;
        width: number;
        height: number;
        durationSeconds?: number;
      };
    }
  | { requestId: string; outcome: "denied" | "cancelled" | "unsupported" | "failed" };
