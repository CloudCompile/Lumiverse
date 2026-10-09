import { timingSafeEqual } from "node:crypto";
import sharp from "sharp";
import type {
  CapturedMediaRef,
  DesktopCaptureCommand,
  DesktopCaptureDestination,
  DesktopCaptureDevice,
  DesktopCaptureReply,
  DesktopCaptureRequest,
} from "./desktop-capture-contract";
import type { LlmMessage, LlmMessagePart } from "../llm/types";

export const DESKTOP_CAPTURE_LIMITS = Object.freeze({
  imageBytes: 8 * 1024 * 1024,
  videoBytes: 32 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  maxPixels: 16_777_216,
  maxDurationSeconds: 30,
  requestTimeoutMs: 120_000,
  assetTtlMs: 120_000,
  deviceLeaseMs: 45_000,
  cooldownMs: 5_000,
});

export class DesktopCaptureError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
  }
}

export interface DesktopCaptureOwner {
  runtimeId: string;
  extensionId: string;
  identifier: string;
  name: string;
  userId: string;
}

type Device = {
  userId: string;
  token: string;
  info: DesktopCaptureDevice;
  queue: DesktopCaptureCommand[];
  timer: ReturnType<typeof setTimeout>;
};

type PendingCapture = {
  owner: DesktopCaptureOwner;
  deviceId: string;
  input: DesktopCaptureRequest;
  destination: DesktopCaptureDestination;
  authorized: () => boolean;
  resolve: (asset: CapturedMediaRef) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  completing: boolean;
};

type Asset = {
  owner: DesktopCaptureOwner;
  deviceId: string;
  destination: DesktopCaptureDestination;
  ref: CapturedMediaRef;
  data: Buffer;
  timer: ReturnType<typeof setTimeout>;
};

export class DesktopCaptureBroker {
  private readonly devices = new Map<string, Device>();
  private readonly pending = new Map<string, PendingCapture>();
  private readonly assets = new Map<string, Asset>();
  private readonly lastRequest = new Map<string, number>();
  private retainedBytes = 0;
  private incomingBytes = 0;
  private incomingTransportBytes = 0;
  private readonly receivingDevices = new Map<string, AbortController>();

  constructor(private readonly options: { now?: () => number; requestTimeoutMs?: number } = {}) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  register(userId: string, input: unknown): { device: DesktopCaptureDevice; transportToken: string } {
    if (!input || typeof input !== "object") throw new DesktopCaptureError("INVALID_DEVICE");
    const value = input as Record<string, any>;
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80
      || /[\x00-\x1f\x7f]/.test(value.name)
      || !["linux", "macos", "windows"].includes(value.platform)
      || !value.capabilities || typeof value.capabilities !== "object"
      || ["image", "video", "replay"].some((key) => typeof value.capabilities[key] !== "boolean")
      || (value.capabilities.replay && !value.capabilities.video)) {
      throw new DesktopCaptureError("INVALID_DEVICE");
    }
    if (this.devices.size >= 32 || [...this.devices.values()].filter((device) => device.userId === userId).length >= 4) {
      throw new DesktopCaptureError("DEVICE_LIMIT", 429);
    }
    const id = crypto.randomUUID();
    const token = crypto.randomUUID() + crypto.randomUUID();
    const info: DesktopCaptureDevice = {
      id, name: value.name.trim(), platform: value.platform,
      capabilities: { image: value.capabilities.image, video: value.capabilities.video, replay: value.capabilities.replay },
      expiresAt: this.now() + DESKTOP_CAPTURE_LIMITS.deviceLeaseMs,
    };
    const timer = setTimeout(() => this.disconnect(id), DESKTOP_CAPTURE_LIMITS.deviceLeaseMs);
    timer.unref();
    this.devices.set(id, { userId, token, info, queue: [], timer });
    return { device: structuredClone(info), transportToken: token };
  }

  private authenticate(userId: string, deviceId: string, token: string): Device {
    const device = this.devices.get(deviceId);
    if (device && device.info.expiresAt <= this.now()) this.disconnect(deviceId);
    const supplied = Buffer.from(typeof token === "string" ? token : "");
    const expected = Buffer.from(device?.token ?? "");
    if (!device || !this.devices.has(deviceId) || device.userId !== userId
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new DesktopCaptureError("INVALID_DEVICE_LEASE", 401);
    }
    return device;
  }

  poll(userId: string, deviceId: string, token: string): DesktopCaptureCommand[] {
    const device = this.authenticate(userId, deviceId, token);
    clearTimeout(device.timer);
    device.info.expiresAt = this.now() + DESKTOP_CAPTURE_LIMITS.deviceLeaseMs;
    device.timer = setTimeout(() => this.disconnect(deviceId), DESKTOP_CAPTURE_LIMITS.deviceLeaseMs);
    device.timer.unref();
    return device.queue.splice(0);
  }

  unregister(userId: string, deviceId: string, token: string): void {
    this.authenticate(userId, deviceId, token);
    this.disconnect(deviceId);
  }

  listDevices(userId: string): DesktopCaptureDevice[] {
    for (const [id, device] of this.devices) if (device.info.expiresAt <= this.now()) this.disconnect(id);
    return [...this.devices.values()].filter((device) => device.userId === userId)
      .map((device) => structuredClone(device.info));
  }

  request(owner: DesktopCaptureOwner, input: DesktopCaptureRequest, destination: DesktopCaptureDestination,
    authorized: () => boolean): Promise<CapturedMediaRef> {
    if (!input || typeof input !== "object" || typeof input.purpose !== "string"
      || !input.purpose.trim() || input.purpose.length > 240 || /[\x00-\x1f\x7f]/.test(input.purpose)
      || !["image", "video"].includes(input.kind)
      || input.connectionId !== destination.connectionId
      || (input.kind === "image" && ("mode" in input || "durationSeconds" in input))
      || (input.kind === "video" && (!["record", "replay"].includes(input.mode)
        || !Number.isInteger(input.durationSeconds) || input.durationSeconds < 1
        || input.durationSeconds > DESKTOP_CAPTURE_LIMITS.maxDurationSeconds))) {
      throw new DesktopCaptureError("INVALID_CAPTURE_REQUEST");
    }
    if (!authorized()) throw new DesktopCaptureError("CAPTURE_PERMISSION_REVOKED", 403);
    const device = this.devices.get(input.deviceId);
    if (device && device.info.expiresAt <= this.now()) this.disconnect(input.deviceId);
    if (!device || !this.devices.has(input.deviceId) || device.userId !== owner.userId) {
      throw new DesktopCaptureError("DESKTOP_UNAVAILABLE", 404);
    }
    if (!device.info.capabilities[input.kind] || (input.kind === "video" && input.mode === "replay" && !device.info.capabilities.replay)) {
      throw new DesktopCaptureError("CAPTURE_UNSUPPORTED", 409);
    }
    const captures = [...this.pending.values()];
    if (captures.length >= 16 || captures.some((capture) => capture.deviceId === input.deviceId)
      || captures.some((capture) => capture.owner.runtimeId === owner.runtimeId && capture.owner.userId === owner.userId)
      || [...this.assets.values()].filter((asset) => asset.owner.runtimeId === owner.runtimeId).length >= 4) {
      throw new DesktopCaptureError("CAPTURE_BUSY", 429);
    }
    const cooldownKey = `${owner.userId}:${owner.extensionId}`;
    if (this.now() - (this.lastRequest.get(cooldownKey) ?? -Infinity) < DESKTOP_CAPTURE_LIMITS.cooldownMs) {
      throw new DesktopCaptureError("CAPTURE_RATE_LIMITED", 429);
    }
    if (this.lastRequest.size > 1024) {
      for (const [key, time] of this.lastRequest) if (this.now() - time >= DESKTOP_CAPTURE_LIMITS.cooldownMs) this.lastRequest.delete(key);
    }
    this.lastRequest.set(cooldownKey, this.now());
    const requestId = crypto.randomUUID();
    const timeoutMs = this.options.requestTimeoutMs ?? DESKTOP_CAPTURE_LIMITS.requestTimeoutMs;
    const { revision: _revision, ...publicDestination } = destination;
    const command: DesktopCaptureCommand = {
      type: "capture", requestId, extension: { id: owner.extensionId, identifier: owner.identifier, name: owner.name },
      purpose: input.purpose.trim(), kind: input.kind, destination: publicDestination,
      ...(input.kind === "video" ? { mode: input.mode, durationSeconds: input.durationSeconds } : {}),
      maxBytes: input.kind === "image" ? DESKTOP_CAPTURE_LIMITS.imageBytes : DESKTOP_CAPTURE_LIMITS.videoBytes,
      maxPixels: DESKTOP_CAPTURE_LIMITS.maxPixels, expiresAt: this.now() + timeoutMs,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel(requestId, "CAPTURE_TIMEOUT"), timeoutMs);
      timer.unref();
      this.pending.set(requestId, { owner: { ...owner }, deviceId: input.deviceId, input: { ...input },
        destination: { ...destination }, authorized, resolve, reject, timer, completing: false });
      device.queue.push(command);
    });
  }

  async receive(userId: string, deviceId: string, token: string, read: (maxBytes: number, signal: AbortSignal) => Promise<unknown>): Promise<void> {
    this.authenticate(userId, deviceId, token);
    const pending = [...this.pending.values()].find((capture) => capture.deviceId === deviceId && capture.owner.userId === userId);
    if (!pending) throw new DesktopCaptureError("UNKNOWN_CAPTURE_REQUEST", 404);
    if (this.receivingDevices.has(deviceId) || pending.completing) throw new DesktopCaptureError("CAPTURE_BUSY", 429);
    const maxBytes = Math.ceil((pending.input.kind === "image" ? DESKTOP_CAPTURE_LIMITS.imageBytes : DESKTOP_CAPTURE_LIMITS.videoBytes) / 3) * 4 + 4096;
    const transportLimit = Math.ceil(DESKTOP_CAPTURE_LIMITS.totalBytes / 3) * 4 + 8192;
    if (this.incomingTransportBytes + maxBytes > transportLimit) throw new DesktopCaptureError("CAPTURE_MEMORY_LIMIT", 429);
    const controller = new AbortController();
    this.receivingDevices.set(deviceId, controller);
    this.incomingTransportBytes += maxBytes;
    try { await this.complete(userId, deviceId, token, await read(maxBytes, controller.signal)); }
    finally {
      this.receivingDevices.delete(deviceId);
      this.incomingTransportBytes -= maxBytes;
    }
  }

  async complete(userId: string, deviceId: string, token: string, value: unknown): Promise<void> {
    this.authenticate(userId, deviceId, token);
    const reply = value as DesktopCaptureReply;
    const pending = value && typeof value === "object" && typeof reply.requestId === "string"
      ? this.pending.get(reply.requestId) : undefined;
    if (!pending || pending.deviceId !== deviceId || pending.owner.userId !== userId || pending.completing) {
      throw new DesktopCaptureError("UNKNOWN_CAPTURE_REQUEST", 404);
    }
    if (!["approved", "denied", "cancelled", "unsupported", "failed"].includes(reply.outcome)) {
      throw new DesktopCaptureError("INVALID_CAPTURE_REPLY");
    }
    if (reply.outcome !== "approved") {
      this.cancel(reply.requestId, `CAPTURE_${reply.outcome.toUpperCase()}`);
      return;
    }
    pending.completing = true;
    let reservedBytes = 0;
    try {
      if (!pending.authorized()) throw new DesktopCaptureError("CAPTURE_PERMISSION_REVOKED", 403);
      const media = reply.media;
      const maxBytes = pending.input.kind === "image" ? DESKTOP_CAPTURE_LIMITS.imageBytes : DESKTOP_CAPTURE_LIMITS.videoBytes;
      if (!media || typeof media.data !== "string" || media.data.length > Math.ceil(maxBytes / 3) * 4
        || media.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(media.data)) {
        throw new DesktopCaptureError("INVALID_CAPTURE_MEDIA");
      }
      reservedBytes = media.data.length / 4 * 3 - (media.data.endsWith("==") ? 2 : media.data.endsWith("=") ? 1 : 0);
      if (this.retainedBytes + this.incomingBytes + reservedBytes > DESKTOP_CAPTURE_LIMITS.totalBytes) {
        reservedBytes = 0;
        throw new DesktopCaptureError("CAPTURE_MEMORY_LIMIT", 429);
      }
      this.incomingBytes += reservedBytes;
      const data = Buffer.from(media.data, "base64");
      if (data.toString("base64") !== media.data || !data.length || data.byteLength > maxBytes || !Number.isInteger(media.width) || !Number.isInteger(media.height)
        || media.width < 1 || media.height < 1 || media.width * media.height > DESKTOP_CAPTURE_LIMITS.maxPixels) {
        throw new DesktopCaptureError("INVALID_CAPTURE_MEDIA");
      }
      if (pending.input.kind === "image") {
        const formats: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };
        if (!Object.hasOwn(formats, media.mimeType)) throw new DesktopCaptureError("INVALID_CAPTURE_MEDIA");
        const metadata = await sharp(data, { limitInputPixels: DESKTOP_CAPTURE_LIMITS.maxPixels }).metadata();
        if (metadata.format !== formats[media.mimeType] || metadata.width !== media.width || metadata.height !== media.height
          || (metadata.pages ?? 1) !== 1) throw new DesktopCaptureError("INVALID_CAPTURE_MEDIA");
      } else {
        const validContainer = (media.mimeType === "video/mp4" && data.length >= 12 && data.toString("ascii", 4, 8) === "ftyp")
          || (media.mimeType === "video/webm" && data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
        if (!validContainer || !Number.isFinite(media.durationSeconds) || media.durationSeconds! <= 0
          || media.durationSeconds! > pending.input.durationSeconds) throw new DesktopCaptureError("INVALID_CAPTURE_MEDIA");
      }
      if (this.pending.get(reply.requestId) !== pending || !pending.authorized()) {
        throw new DesktopCaptureError("CAPTURE_PERMISSION_REVOKED", 403);
      }
      this.authenticate(userId, deviceId, token);
      if (this.retainedBytes + data.byteLength > DESKTOP_CAPTURE_LIMITS.totalBytes) throw new DesktopCaptureError("CAPTURE_MEMORY_LIMIT", 429);
      const assetId = crypto.randomUUID();
      const ref: CapturedMediaRef = {
        assetId, kind: pending.input.kind, mimeType: media.mimeType, width: media.width, height: media.height,
        ...(pending.input.kind === "video" ? { durationSeconds: media.durationSeconds } : {}),
        connectionId: pending.destination.connectionId, expiresAt: this.now() + DESKTOP_CAPTURE_LIMITS.assetTtlMs,
      };
      const timer = setTimeout(() => this.deleteAsset(assetId), DESKTOP_CAPTURE_LIMITS.assetTtlMs);
      timer.unref();
      this.assets.set(assetId, { owner: pending.owner, deviceId, destination: pending.destination, ref, data, timer });
      this.retainedBytes += data.byteLength;
      clearTimeout(pending.timer);
      this.pending.delete(reply.requestId);
      pending.resolve({ ...ref });
    } catch (error) {
      this.cancel(reply.requestId, error instanceof DesktopCaptureError ? error.code : "INVALID_CAPTURE_MEDIA");
      throw error instanceof DesktopCaptureError ? error : new DesktopCaptureError("INVALID_CAPTURE_MEDIA");
    } finally {
      this.incomingBytes -= reservedBytes;
    }
  }

  release(owner: DesktopCaptureOwner, assetId: string): void {
    const asset = this.requireAsset(owner, assetId);
    this.deleteAsset(asset.ref.assetId);
  }

  private requireAsset(owner: DesktopCaptureOwner, assetId: string): Asset {
    const asset = this.assets.get(assetId);
    if (asset && asset.ref.expiresAt <= this.now()) this.deleteAsset(assetId);
    if (!asset || !this.assets.has(assetId) || asset.owner.runtimeId !== owner.runtimeId
      || asset.owner.extensionId !== owner.extensionId || asset.owner.userId !== owner.userId) {
      throw new DesktopCaptureError("CAPTURE_ASSET_UNAVAILABLE", 404);
    }
    return asset;
  }

  resolveMessages(owner: DesktopCaptureOwner, messages: LlmMessage[], destination: DesktopCaptureDestination,
    authorized: (kind: "image" | "video") => boolean): LlmMessage[] {
    const selected = new Map<string, Asset>();
    const resolved = messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      return { ...message, content: message.content.map((part) => {
        if ((part as { type: string }).type !== "desktop_capture") return part;
        const assetId = (part as unknown as { asset_id: string }).asset_id;
        const asset = this.requireAsset(owner, assetId);
        if (!authorized(asset.ref.kind)) throw new DesktopCaptureError("CAPTURE_PERMISSION_REVOKED", 403);
        if (asset.destination.connectionId !== destination.connectionId || asset.destination.revision !== destination.revision) {
          throw new DesktopCaptureError("CAPTURE_DESTINATION_CHANGED", 403);
        }
        selected.set(assetId, asset);
        return { type: asset.ref.kind, mime_type: asset.ref.mimeType, data: asset.data.toString("base64") } as LlmMessagePart;
      }) };
    });
    for (const id of selected.keys()) this.deleteAsset(id);
    return resolved;
  }

  revokeRuntime(runtimeId: string): void {
    for (const [id, pending] of this.pending) if (pending.owner.runtimeId === runtimeId) this.cancel(id, "CAPTURE_REVOKED");
    for (const [id, asset] of this.assets) if (asset.owner.runtimeId === runtimeId) this.deleteAsset(id);
  }

  private cancel(requestId: string, code: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    const device = this.devices.get(pending.deviceId);
    this.receivingDevices.get(pending.deviceId)?.abort();
    if (device) {
      device.queue = device.queue.filter((command) => command.requestId !== requestId);
      if (device.queue.length >= 16) this.disconnect(pending.deviceId);
      else device.queue.push({ type: "cancel", requestId });
    }
    pending.reject(new DesktopCaptureError(code));
  }

  private deleteAsset(assetId: string): void {
    const asset = this.assets.get(assetId);
    if (!asset) return;
    clearTimeout(asset.timer);
    this.retainedBytes -= asset.data.byteLength;
    asset.data.fill(0);
    this.assets.delete(assetId);
  }

  private disconnect(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    clearTimeout(device.timer);
    this.devices.delete(deviceId);
    this.receivingDevices.get(deviceId)?.abort();
    for (const [id, pending] of this.pending) if (pending.deviceId === deviceId) this.cancel(id, "DESKTOP_DISCONNECTED");
    for (const [id, asset] of this.assets) if (asset.deviceId === deviceId) this.deleteAsset(id);
  }

  dispose(): void {
    for (const id of this.devices.keys()) this.disconnect(id);
    this.lastRequest.clear();
  }
}

export const desktopCaptureBroker = new DesktopCaptureBroker();
