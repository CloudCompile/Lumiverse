/**
 * Outbound WebSocket client that maintains a persistent connection to LumiHub.
 * Handles reconnection with exponential backoff, heartbeats, and dispatches
 * install commands to the installer module.
 */
import type { LumiHubWSMessage, InstallCharacterPayload } from "./types";
import { installCharacter } from "./installer";
import { updateLastConnected } from "../services/lumihub-link.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const HEARTBEAT_INTERVAL_MS = 30_000;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;

class LumiHubWSClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private connected = false;
  private intentionalClose = false;
  private wsUrl: string = "";
  private linkToken: string = "";

  /** Open a WebSocket connection to LumiHub. */
  connect(wsUrl: string, linkToken: string): void {
    this.wsUrl = wsUrl;
    this.linkToken = linkToken;
    this.intentionalClose = false;
    this.doConnect();
  }

  /** Gracefully disconnect and stop reconnection. */
  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private doConnect(): void {
    this.cleanup();

    try {
      const url = `${this.wsUrl}?token=${encodeURIComponent(this.linkToken)}`;
      this.ws = new WebSocket(url);

      this.ws.addEventListener("open", () => {
        console.log("[LumiHub WS] Connected");
        this.connected = true;
        this.reconnectDelay = INITIAL_RECONNECT_MS;
        this.startHeartbeat();
        updateLastConnected();
        eventBus.emit(EventType.LUMIHUB_CONNECTION_CHANGED, { connected: true });
      });

      this.ws.addEventListener("message", (event) => {
        this.handleMessage(event.data as string);
      });

      this.ws.addEventListener("close", (event) => {
        console.log(`[LumiHub WS] Closed: ${event.code} ${event.reason}`);
        this.connected = false;
        this.stopHeartbeat();
        eventBus.emit(EventType.LUMIHUB_CONNECTION_CHANGED, { connected: false });

        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      });

      this.ws.addEventListener("error", (event) => {
        console.error("[LumiHub WS] Error:", event);
      });
    } catch (err) {
      console.error("[LumiHub WS] Connection failed:", err);
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    }
  }

  private handleMessage(data: string): void {
    let msg: LumiHubWSMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "ping":
        this.send({ type: "pong", id: msg.id, timestamp: Date.now() });
        break;

      case "auth_ok":
        console.log("[LumiHub WS] Authenticated successfully");
        // Send instance info
        this.send({
          type: "instance_info",
          id: crypto.randomUUID(),
          payload: {
            capabilities: ["character_import", "chub_import"],
            version: "1.0.0",
          },
          timestamp: Date.now(),
        });
        break;

      case "install_character":
        this.handleInstallCharacter(msg);
        break;

      default:
        // Unknown message type, ignore
        break;
    }
  }

  private async handleInstallCharacter(msg: LumiHubWSMessage): Promise<void> {
    const payload = msg.payload as InstallCharacterPayload;
    console.log(`[LumiHub WS] Install request: ${payload.characterName} (source: ${payload.source})`);

    // Notify local frontend
    eventBus.emit(EventType.LUMIHUB_INSTALL_STARTED, {
      characterName: payload.characterName,
      source: payload.source,
    });

    const result = await installCharacter(msg.id, payload);

    // Send result back to LumiHub
    this.send({
      type: "install_result",
      id: crypto.randomUUID(),
      replyTo: msg.id,
      payload: result,
      timestamp: Date.now(),
    });

    if (!result.success) {
      eventBus.emit(EventType.LUMIHUB_INSTALL_FAILED, {
        characterName: payload.characterName,
        error: result.error,
      });
    }
  }

  private send(msg: Partial<LumiHubWSMessage>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Send failed, will reconnect
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "ping", id: crypto.randomUUID(), timestamp: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    console.log(`[LumiHub WS] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
  }

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000); } catch {}
      this.ws = null;
    }
    this.connected = false;
  }
}

// Singleton instance
let _client: LumiHubWSClient | null = null;

export function getLumiHubClient(): LumiHubWSClient {
  if (!_client) {
    _client = new LumiHubWSClient();
  }
  return _client;
}

/**
 * Auto-connect to LumiHub if a link config exists.
 * Called at startup from index.ts.
 */
export async function autoConnect(): Promise<void> {
  const { getLinkConfig } = await import("../services/lumihub-link.service");
  const config = await getLinkConfig();
  if (!config) {
    console.log("[LumiHub] No link configured — skipping auto-connect");
    return;
  }

  console.log(`[LumiHub] Auto-connecting to ${config.lumihubUrl}...`);
  const client = getLumiHubClient();
  client.connect(config.wsUrl, config.linkToken);
}
