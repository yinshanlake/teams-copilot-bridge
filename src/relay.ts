import { randomUUID } from "node:crypto";
import { io, type ManagerOptions, type Socket, type SocketOptions } from "socket.io-client";
import type { ConversationReference } from "@microsoft/agents-activity";
import type { Card, Outbound, Transport } from "./domain.js";
import type { RelayBinding } from "./relay-config.js";
import { MicrosoftSignInRequired, type RelayTokenSource } from "./relay-auth.js";
import { allowedServiceUrl, outboundActivity, validateProactiveReference, validateTeamsOwnerActivity, type AuthorizedActivity, type TeamsIdentity } from "./teams.js";
import { DeliveryError, logError, object, string, UserError } from "./safety.js";

interface RelayServerEvents {
  activity: (payload: unknown) => void;
  sendResult: (payload: unknown) => void;
  kick: (payload: unknown) => void;
  pong: (payload: unknown) => void;
  command: (payload: unknown) => void;
}

interface RelayClientEvents {
  sendActivity: (payload: Record<string, unknown>) => void;
  updateActivity: (payload: Record<string, unknown>) => void;
  ping: (payload: { type: "ping"; ts: number }) => void;
  commandResult: (payload: { type: "commandResult"; requestId: string; ok: false; error: { code: string; message: string } }) => void;
}

export type RelaySocket = Socket<RelayServerEvents, RelayClientEvents>;
export type RelaySocketFactory = (url: string, options: Partial<ManagerOptions & SocketOptions>) => RelaySocket;
export type RelayStatus = "stopped" | "connecting" | "connected" | "disconnected" | "signin-required" | "rejected" | "kicked";
type ActivityHandler = (turn: AuthorizedActivity, relayReceiptId: string) => Promise<void>;

interface PendingSend {
  resolve(messageId: string): void;
  reject(error: DeliveryError): void;
  timer: NodeJS.Timeout;
}

export interface RelayOptions {
  acknowledgementMs?: number;
  connectTimeoutMs?: number;
  reconnectMs?: number;
  onStatus?: (status: RelayStatus) => void;
}

export function relayHandshake(token: string, botAppId: string): Record<string, unknown> {
  return { token, botAppId, version: "0.1.0", caps: [] };
}

export function relayActivityRejectionReasons(
  payload: unknown,
  binding: Pick<RelayBinding, "botAppId">,
  identity: TeamsIdentity,
): string[] {
  if (!object(payload)) return ["ENVELOPE_NOT_OBJECT"];
  const reasons: string[] = [];
  if (payload.type !== undefined && payload.type !== "activity") reasons.push("ENVELOPE_TYPE");
  if (!string(payload.id, 2048)) reasons.push("ENVELOPE_ID");
  if (payload.botAppId !== undefined && payload.botAppId !== binding.botAppId) reasons.push("ENVELOPE_BOT");
  if (payload.receivedAt !== undefined && !((typeof payload.receivedAt === "number" && Number.isFinite(payload.receivedAt)) ||
    (typeof payload.receivedAt === "string" && Number.isFinite(Date.parse(payload.receivedAt))))) reasons.push("ENVELOPE_RECEIVED_AT");
  if (!object(payload.activity)) {
    reasons.push("ACTIVITY_NOT_OBJECT");
    return reasons;
  }
  if (Buffer.byteLength(JSON.stringify(payload.activity)) > 128 * 1024) reasons.push("ACTIVITY_SIZE");
  const activity = payload.activity;
  if (!object(activity.from)) reasons.push("FROM");
  if (!object(activity.recipient)) reasons.push("RECIPIENT");
  if (!object(activity.conversation)) reasons.push("CONVERSATION");
  if (!object(activity.channelData) || !object(activity.channelData.tenant)) reasons.push("TENANT");
  if (activity.channelId === undefined) reasons.push("CHANNEL_MISSING");
  else if (typeof activity.channelId !== "string") reasons.push("CHANNEL_TYPE");
  else if (activity.channelId !== "msteams") {
    reasons.push(activity.channelId.toLowerCase() === "msteams" ? "CHANNEL_CASE" : "CHANNEL_VALUE");
  }
  if (object(activity.conversation)) {
    if (activity.conversation.conversationType !== "personal") reasons.push("SCOPE");
    if (activity.conversation.isGroup === true) reasons.push("GROUP");
    if (!string(activity.conversation.id, 2048)) reasons.push("CONVERSATION_ID");
    if (activity.conversation.tenantId !== undefined &&
      (typeof activity.conversation.tenantId !== "string" || activity.conversation.tenantId.toLowerCase() !== identity.tenantId)) {
      reasons.push("CONVERSATION_TENANT");
    }
  }
  if (object(activity.from)) {
    if (typeof activity.from.aadObjectId !== "string") reasons.push("OWNER_AAD_MISSING");
    else if (activity.from.aadObjectId.toLowerCase() !== identity.ownerId) reasons.push("OWNER_AAD");
    if (activity.from.role === "bot") reasons.push("FROM_ROLE");
    if (!string(activity.from.id)) reasons.push("FROM_ID");
  }
  if (object(activity.recipient) &&
    activity.recipient.id !== `28:${identity.appId}` && activity.recipient.id !== identity.appId) reasons.push("RECIPIENT_BOT");
  if (object(activity.from) && object(activity.recipient) && activity.from.id === activity.recipient.id) reasons.push("ECHO");
  if (object(activity.channelData) && object(activity.channelData.tenant) &&
    (typeof activity.channelData.tenant.id !== "string" || activity.channelData.tenant.id.toLowerCase() !== identity.tenantId)) {
    reasons.push("CHANNEL_TENANT");
  }
  if (!string(activity.id, 2048)) reasons.push("ACTIVITY_ID");
  if (!allowedServiceUrl(activity.serviceUrl, identity.serviceHosts)) reasons.push("SERVICE_URL");
  if (activity.type !== "message") reasons.push("ACTIVITY_TYPE");
  else {
    if (Array.isArray(activity.attachments) && activity.attachments.length > 0) reasons.push("ATTACHMENTS");
    if (activity.value !== undefined && activity.value !== null) {
      if (!object(activity.value)) reasons.push("VALUE_TYPE");
      else if (!string(activity.value.token, 4096)) reasons.push("VALUE_TOKEN");
    } else if (typeof activity.text !== "string") reasons.push("TEXT_MISSING");
  }
  return reasons.length ? reasons : ["ACTIVITY_VALIDATION"];
}

export function relayValidationErrorCode(error: unknown): string {
  if (!(error instanceof UserError)) return "UNEXPECTED";
  switch (error.message) {
    case "Malformed relay activity envelope.": return "MALFORMED_ENVELOPE";
    case "Incomplete Teams activity.": return "INCOMPLETE_ACTIVITY";
    case "Only the configured tenant/owner in a private one-to-one Teams conversation is allowed.": return "OWNER_OR_SCOPE";
    case "Untrusted Teams service URL.": return "SERVICE_URL";
    case "Relay supports message/Action.Submit activities only; synchronous invoke response is unavailable.": return "ACTIVITY_TYPE";
    case "Only text messages and scoped card actions are supported.": return "INPUT_TYPE";
    case "v1 accepts text and its own card forms, not uploaded attachments.": return "ATTACHMENTS";
    case "Malformed Action.Submit payload.": return "VALUE";
    case "A text message is required.": return "TEXT_MISSING";
    default: return "USER_VALIDATION";
  }
}

function normalizedRelayActivity(activity: Record<string, unknown>): Record<string, unknown> {
  // The pinned, owner-authenticated relay is the channel provenance. Some relay
  // revisions omit channelId, while Teams casing is not an identity boundary.
  // Explicit non-Teams values still reach the strict validator and are rejected.
  let normalized = activity;
  if (activity.channelId === undefined ||
    (typeof activity.channelId === "string" && activity.channelId.toLowerCase() === "msteams")) {
    normalized = { ...normalized, channelId: "msteams" };
  }
  // Teams clients can add transport-only attachments to an ordinary text
  // activity. Relay mode never imports attachment content, so preserve the text
  // and drop only those attachments. Image/file-only messages still fail closed.
  if (normalized.type === "message" && typeof normalized.text === "string" &&
    (normalized.value === undefined || normalized.value === null) &&
    Array.isArray(normalized.attachments) && normalized.attachments.length > 0) {
    normalized = { ...normalized, attachments: [] };
  }
  return normalized;
}

export class RelayConnection implements Transport {
  private readonly socket: RelaySocket;
  private readonly pending = new Map<string, PendingSend>();
  private handler: ActivityHandler | undefined;
  private statusValue: RelayStatus = "stopped";
  private wanted = false;
  private everConnected = false;
  private generation = 0;
  private attempts = 0;
  private authRejections = 0;
  private opening: Promise<void> | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private firstResolve: (() => void) | undefined;
  private firstReject: ((error: Error) => void) | undefined;
  private tokenExpires = 0;
  private inbound = 0;

  constructor(
    readonly binding: RelayBinding,
    private readonly identity: TeamsIdentity,
    private readonly tokens: RelayTokenSource,
    private readonly options: RelayOptions = {},
    factory: RelaySocketFactory = (url, configuration) => io(url, configuration),
  ) {
    if (identity.appId !== binding.botAppId || identity.ownerId !== binding.ownerOid || identity.tenantId !== binding.aadTenantId) {
      throw new UserError("Relay and Teams identity bindings disagree.");
    }
    this.socket = factory(`${binding.relayUrl}/twin`, {
      autoConnect: false, forceNew: true, transports: ["websocket"], reconnection: false,
      retries: 0, timeout: options.connectTimeoutMs ?? 10_000, rejectUnauthorized: true,
      transportOptions: { websocket: { followRedirects: false, rejectUnauthorized: true } },
    });
    this.socket.on("connect", () => {
      if (!this.wanted) { this.socket.disconnect(); return; }
      this.everConnected = true;
      this.attempts = 0;
      this.authRejections = 0;
      this.setStatus("connected");
      this.firstResolve?.();
      this.firstResolve = undefined;
      this.firstReject = undefined;
      this.clearHeartbeat();
      this.pingTimer = setInterval(() => {
        if (this.connected) this.socket.volatile.emit("ping", { type: "ping", ts: Date.now() });
      }, 30_000);
      this.refreshTimer = setTimeout(() => {
        this.socket.disconnect();
        this.setStatus("disconnected");
        this.failPending("DISCONNECTED");
        this.scheduleReconnect();
      }, Math.max(1000, Math.min(2_000_000_000, this.tokenExpires - Date.now() - 120_000)));
    });
    this.socket.on("disconnect", () => {
      this.clearHeartbeat();
      this.failPending("DISCONNECTED");
      if (!this.wanted) return;
      this.setStatus("disconnected");
      if (this.everConnected) this.scheduleReconnect();
      else this.firstReject?.(new UserError("Relay disconnected before the new bot binding became ready."));
    });
    this.socket.on("connect_error", (error) => {
      this.failPending("DISCONNECTED");
      if (!this.wanted) return;
      const code = error.message;
      if (code.includes("NOT_OWNER") || code.includes("BOT_NOT_FOUND")) {
        this.halt("rejected", new UserError("Relay rejected the confirmed new bot/owner binding. No takeover or identity fallback was attempted."));
      } else if (code.includes("INVALID_TOKEN") && ++this.authRejections > 1) {
        this.halt("signin-required", new MicrosoftSignInRequired(binding));
      } else if (!this.everConnected && !code.includes("INVALID_TOKEN")) {
        this.halt("disconnected", new UserError("Relay connection did not become ready. Check the trusted relay origin and Microsoft login; no webhook fallback was used."));
      } else {
        this.setStatus("disconnected");
        this.scheduleReconnect();
      }
    });
    this.socket.on("kick", () => {
      this.halt("kicked", new UserError("Relay kicked this client. Reconnect is stopped to avoid replacing another bot owner."));
    });
    this.socket.on("sendResult", (payload) => this.receiveResult(payload));
    this.socket.on("activity", (payload) => {
      if (!this.connected || !this.handler || this.inbound >= 16) {
        logError("relay-activity-unavailable", new UserError("Relay is not ready or the inbound admission budget is full."));
        return;
      }
      let turn: AuthorizedActivity;
      let id: string;
      try {
        if (!object(payload) || (payload.type !== undefined && payload.type !== "activity") || !string(payload.id, 2048) || !object(payload.activity) ||
          (payload.botAppId !== undefined && payload.botAppId !== binding.botAppId) ||
          (payload.receivedAt !== undefined && !((typeof payload.receivedAt === "number" && Number.isFinite(payload.receivedAt)) ||
            (typeof payload.receivedAt === "string" && Number.isFinite(Date.parse(payload.receivedAt))))) ||
          Buffer.byteLength(JSON.stringify(payload.activity)) > 128 * 1024) {
          throw new UserError("Malformed relay activity envelope.");
        }
        turn = validateTeamsOwnerActivity(normalizedRelayActivity(payload.activity), identity, true);
        id = payload.id;
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          area: "relay-activity-rejected",
          kind: error instanceof Error ? error.name : "UnknownError",
          validation: relayValidationErrorCode(error),
          reasons: relayActivityRejectionReasons(payload, binding, identity),
        }));
        return;
      }
      this.inbound++;
      void this.handler(turn, id).catch((error: unknown) => logError("relay-activity-handler", error))
        .finally(() => { this.inbound--; });
    });
    this.socket.on("command", (payload) => {
      if (this.connected && object(payload) && string(payload.requestId, 512)) {
        this.socket.volatile.emit("commandResult", {
          type: "commandResult", requestId: payload.requestId, ok: false,
          error: { code: "UNKNOWN_COMMAND", message: "This standalone client does not execute relay administration commands." },
        });
      }
    });
  }

  get status(): RelayStatus { return this.statusValue; }
  get connected(): boolean { return this.statusValue === "connected" && this.socket.connected; }

  async start(handler: ActivityHandler): Promise<void> {
    if (this.wanted || this.everConnected) throw new UserError("Relay lifecycle already started.");
    this.handler = handler;
    this.wanted = true;
    let deadline: NodeJS.Timeout | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      this.firstResolve = resolve;
      this.firstReject = reject;
      deadline = setTimeout(() => this.halt("disconnected", new UserError("Relay startup timed out; it is not online.")),
        (this.options.connectTimeoutMs ?? 10_000) + 25_000);
    });
    void this.attempt();
    try { await ready; } finally { if (deadline) clearTimeout(deadline); }
  }

  private setStatus(status: RelayStatus): void {
    this.statusValue = status;
    this.options.onStatus?.(status);
  }

  private async attempt(): Promise<void> {
    if (!this.wanted || this.opening) return;
    const generation = this.generation;
    this.opening = (async () => {
      try {
        this.setStatus("connecting");
        const token = await this.tokens.getToken();
        if (!this.wanted || this.generation !== generation) return;
        this.tokenExpires = token.expiresOnTimestamp;
        this.socket.auth = relayHandshake(token.token, this.binding.botAppId);
        this.socket.connect();
      } catch (error) {
        logError("relay-credential", error);
        this.halt(error instanceof MicrosoftSignInRequired ? "signin-required" : "rejected",
          error instanceof UserError ? error : new UserError("Relay credential acquisition failed."));
      }
    })().finally(() => { this.opening = undefined; });
    await this.opening;
  }

  private scheduleReconnect(): void {
    if (!this.wanted || this.reconnectTimer) return;
    const delay = Math.min(30_000, (this.options.reconnectMs ?? 2000) * 2 ** Math.min(this.attempts++, 4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.attempt();
    }, delay);
  }

  private clearHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.pingTimer = undefined;
    this.refreshTimer = undefined;
  }

  private failPending(code: string): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      this.pending.delete(id);
      request.reject(new DeliveryError("uncertain", code));
    }
  }

  private halt(status: RelayStatus, error: Error): void {
    this.wanted = false;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearHeartbeat();
    this.failPending("DISCONNECTED");
    this.setStatus(status);
    this.socket.disconnect();
    this.firstReject?.(error);
    this.firstReject = undefined;
    this.firstResolve = undefined;
  }

  private receiveResult(payload: unknown): void {
    if (!object(payload) || (payload.type !== undefined && payload.type !== "sendResult") || !string(payload.requestId, 512)) return;
    const pending = this.pending.get(payload.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(payload.requestId);
    if (object(payload.error)) {
      const codeValue = typeof payload.error.code === "number" ? String(payload.error.code)
        : typeof payload.error.code === "string" ? payload.error.code.toUpperCase() : "";
      const code = /^[A-Z0-9_]{1,60}$/.test(codeValue) ? codeValue : "RELAY_ERROR";
      const status = payload.error.statusCode ?? payload.error.status;
      const explicitRejection = typeof status === "number" && [400, 401, 403, 404, 409, 413, 422].includes(status);
      const rejected = new Set(["INVALID_REQUEST", "BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_OWNER", "BOT_NOT_FOUND",
        "NOT_CONNECTED", "CONVERSATION_NOT_FOUND", "MESSAGE_NOT_FOUND", "400", "401", "403", "404", "409", "413", "422"]);
      pending.reject(new DeliveryError(rejected.has(code) || explicitRejection ? "rejected" : "uncertain", code,
        status === 404 || code === "404" || code === "MESSAGE_NOT_FOUND" ? 404 : 400));
    } else if (string(payload.messageId, 2048)) pending.resolve(payload.messageId);
    else pending.reject(new DeliveryError("uncertain", "MISSING_MESSAGE_ID"));
  }

  private request(event: "sendActivity" | "updateActivity", reference: ConversationReference, outbound: Outbound, messageId?: string): Promise<string> {
    validateProactiveReference(reference, this.identity);
    if (!this.connected) return Promise.reject(new DeliveryError("not-sent", "NOT_CONNECTED"));
    if (this.pending.size >= 32) return Promise.reject(new DeliveryError("not-sent", "LOCAL_BACKPRESSURE"));
    const requestId = randomUUID();
    const payload: Record<string, unknown> = {
      type: event, requestId, conversationId: reference.conversation.id,
      serviceUrl: reference.serviceUrl, tenantId: this.binding.aadTenantId,
      ...(event === "sendActivity" ? { recipient: reference.user } : { messageId }),
      ...(reference.conversation.name ? { conversationName: reference.conversation.name } : {}),
      activity: outboundActivity(outbound),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new DeliveryError("uncertain", "TIMEOUT"));
      }, this.options.acknowledgementMs ?? 30_000);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        // Socket.IO's offline/retry queues must never replay a Teams POST after
        // reconnect. A dropped volatile packet instead becomes explicitly uncertain.
        this.socket.volatile.emit(event, payload);
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new DeliveryError("uncertain", "EMIT_FAILED"));
      }
    });
  }

  send(reference: ConversationReference, outbound: Outbound): Promise<string> {
    return this.request("sendActivity", reference, outbound);
  }

  async update(reference: ConversationReference, id: string, card: Card): Promise<void> {
    await this.request("updateActivity", reference, { type: "card", card }, id);
  }

  async close(): Promise<void> {
    this.halt("stopped", new UserError("Relay stopped."));
    this.socket.removeAllListeners();
    await this.opening;
  }
}
