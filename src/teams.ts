import express, { type ErrorRequestHandler } from "express";
import { Activity, ActivityTypes, type ConversationReference } from "@microsoft/agents-activity";
import { CloudAdapter, authorizeJWT, getAuthConfigWithDefaults, type AuthConfiguration, type Request as AgentRequest, type TurnContext } from "@microsoft/agents-hosting";
import type { Bridge, Incoming } from "./bridge.js";
import type { Card, IncomingAddress, Outbound, Transport } from "./domain.js";
import { digest, logError, object, publicError, safeText, string, UserError } from "./safety.js";
import { replyActivityFields } from "./replies.js";

export interface TeamsIdentity {
  tenantId: string;
  ownerId: string;
  appId: string;
  serviceHosts: string[];
}

export interface AuthorizedActivity {
  activity: Activity;
  reference: ConversationReference;
  key: string;
  incoming: Incoming;
}

export function allowedServiceUrl(value: unknown, hosts: readonly string[]): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
      (!url.port || url.port === "443") && hosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function incomingActivity(activity: Activity): Incoming {
  const address = activityAddress(activity);
  if (activity.type === ActivityTypes.Invoke) {
    const value: unknown = activity.value;
    if (activity.name !== "adaptiveCard/action" || !object(value) || !object(value.action) ||
      value.action.type !== "Action.Execute" || value.action.verb !== "bridge" || !object(value.action.data) ||
      (value.trigger !== undefined && value.trigger !== "manual")) {
      throw new UserError("Unsupported or malformed Adaptive Card invoke.");
    }
    return { kind: "action", data: value.action.data, ...(address ? { address } : {}) };
  }
  if (activity.type !== ActivityTypes.Message) throw new UserError("Only text messages and scoped card actions are supported.", 400);
  if (activity.attachments?.length) throw new UserError("v1 accepts text and its own card forms, not uploaded attachments.");
  const value: unknown = activity.value;
  if (value !== undefined && value !== null) {
    if (!object(value) || !string(value.token, 4096)) throw new UserError("Malformed Action.Submit payload.");
    return { kind: "action", data: value, ...(address ? { address } : {}) };
  }
  if (typeof activity.text !== "string") throw new UserError("A text message is required.");
  return { kind: "text", text: activity.text, ...(address ? { address } : {}) };
}

function activityAddress(activity: Activity): IncomingAddress | undefined {
  if (!object(activity.channelData)) return undefined;
  const data = activity.channelData;
  const validId = (value: unknown) => string(value, 2048) && !/[\u0000-\u001f\u007f]/u.test(value);
  if (data.chat !== undefined && (!object(data.chat) || !validId(data.chat.id)) ||
    data.replyChain !== undefined && (!object(data.replyChain) || !validId(data.replyChain.id))) {
    throw new UserError("Malformed containing-chat or reply-chain identity. Nothing was routed.");
  }
  const chatId = object(data.chat) && typeof data.chat.id === "string" ? data.chat.id : undefined;
  const rootId = object(data.replyChain) && typeof data.replyChain.id === "string" ? data.replyChain.id : undefined;
  if (!chatId && !rootId) return undefined;
  let messageId = activity.id;
  if (activity.type === ActivityTypes.Invoke || data.source !== undefined) {
    const value: unknown = activity.value;
    messageId = object(value) && object(value.messagePayload) && typeof value.messagePayload.id === "string"
      ? value.messagePayload.id : activity.replyToId;
  }
  return {
    ...(chatId ? { chatId } : {}), ...(rootId ? { rootId } : {}),
    place: !rootId ? "top" : !chatId || !messageId ? "unknown" : messageId === rootId ? "top" : "thread",
  };
}

export function authorizeActivity(body: unknown, verifiedClaims: unknown, identity: TeamsIdentity): AuthorizedActivity {
  if (!object(verifiedClaims) || verifiedClaims.aud !== identity.appId) throw new UserError("Authenticated bot audience required.", 401);
  if (verifiedClaims.serviceurl !== undefined && object(body)) {
    if (!allowedServiceUrl(verifiedClaims.serviceurl, identity.serviceHosts) || !allowedServiceUrl(body.serviceUrl, identity.serviceHosts) ||
      new URL(String(verifiedClaims.serviceurl)).hostname !== new URL(String(body.serviceUrl)).hostname) {
      throw new UserError("Activity service URL does not match the authenticated channel claim.", 403);
    }
  }
  return validateTeamsOwnerActivity(body, identity);
}

// Authorization provenance is supplied by the official webhook adapter OR the
// authenticated, explicitly pinned relay connection. Body validation is not JWT
// authentication, and relay callers never manufacture verified-claims objects.
export function validateTeamsOwnerActivity(body: unknown, identity: TeamsIdentity, submitOnly = false): AuthorizedActivity {
  if (!object(body) || !object(body.from) || !object(body.recipient) || !object(body.conversation) || !object(body.channelData) ||
    !object(body.channelData.tenant)) throw new UserError("Incomplete Teams activity.", 403);
  if (body.channelId !== "msteams" || body.conversation.conversationType !== "personal" || body.conversation.isGroup === true ||
    typeof body.from.aadObjectId !== "string" || body.from.aadObjectId.toLowerCase() !== identity.ownerId ||
    typeof body.channelData.tenant.id !== "string" || body.channelData.tenant.id.toLowerCase() !== identity.tenantId ||
    (body.conversation.tenantId !== undefined && (typeof body.conversation.tenantId !== "string" || body.conversation.tenantId.toLowerCase() !== identity.tenantId)) ||
    body.from.role === "bot" || body.from.id === body.recipient.id ||
    (body.recipient.id !== `28:${identity.appId}` && body.recipient.id !== identity.appId) ||
    !string(body.from.id) || !string(body.conversation.id, 2048) || !string(body.id, 2048)) {
    throw new UserError("Only the configured tenant/owner in a private one-to-one Teams conversation is allowed.", 403);
  }
  if (!allowedServiceUrl(body.serviceUrl, identity.serviceHosts)) throw new UserError("Untrusted Teams service URL.", 403);
  const activity = Activity.fromObject(body);
  if (submitOnly && activity.type !== ActivityTypes.Message) throw new UserError("Relay supports message/Action.Submit activities only; synchronous invoke response is unavailable.");
  const reference = activity.getConversationReference();
  reference.conversation.tenantId = identity.tenantId;
  const key = digest(`${identity.tenantId}:${identity.ownerId}:msteams:${reference.conversation.id}`);
  return { activity, reference, key, incoming: incomingActivity(activity) };
}

export function outboundActivity(message: Outbound, id?: string): Activity {
  return Activity.fromObject({
    type: ActivityTypes.Message, ...(id ? { id } : {}),
    ...(message.type === "text"
      ? replyActivityFields(message)
      : { ...(message.summary ? { text: safeText(message.summary, 1000), textFormat: "plain" } : {}),
        attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: message.card }] }),
  });
}

export function validateProactiveReference(reference: ConversationReference, identity: TeamsIdentity): void {
  if (reference.channelId !== "msteams" || reference.conversation.conversationType !== "personal" ||
    reference.conversation.isGroup === true || reference.conversation.tenantId !== identity.tenantId ||
    reference.user?.aadObjectId?.toLowerCase() !== identity.ownerId ||
    (reference.agent?.id !== `28:${identity.appId}` && reference.agent?.id !== identity.appId) ||
    !string(reference.conversation.id, 2048) || !allowedServiceUrl(reference.serviceUrl, identity.serviceHosts)) {
    throw new UserError("Stored proactive reference no longer matches the configured owner/tenant/bot.", 403);
  }
}

type SendContext = Pick<TurnContext, "sendActivity" | "updateActivity">;
export type ContinueConversation = (reference: ConversationReference, logic: (context: SendContext) => Promise<void>) => Promise<void>;

export class TeamsTransport implements Transport {
  readonly capabilities = { threadReplies: false, quotedReplies: false, reactions: false } as const;
  constructor(private readonly identity: TeamsIdentity, private readonly continueConversation: ContinueConversation) {}

  private validate(reference: ConversationReference): void {
    validateProactiveReference(reference, this.identity);
  }

  async send(reference: ConversationReference, message: Outbound): Promise<string> {
    this.validate(reference);
    let id: string | undefined;
    let failure: unknown;
    await this.continueConversation(reference, async (context) => {
      try {
        id = (await context.sendActivity(outboundActivity(message)))?.id;
      } catch (error) {
        failure = error;
      }
    });
    if (failure) throw failure;
    if (!id) throw new Error("Teams send did not return an activity ID");
    return id;
  }

  async update(reference: ConversationReference, id: string, card: Card): Promise<void> {
    this.validate(reference);
    let failure: unknown;
    await this.continueConversation(reference, async (context) => {
      try {
        await context.updateActivity(outboundActivity({ type: "card", card }, id));
      } catch (error) {
        failure = error;
      }
    });
    if (failure) throw failure;
  }
}

export function teamsAuthentication(identity: TeamsIdentity, clientSecret: string): AuthConfiguration {
  return getAuthConfigWithDefaults({
    clientId: identity.appId, tenantId: identity.tenantId, clientSecret, authType: "ClientSecret", validateIssuer: true,
  });
}

export function createTeamsAdapter(identity: TeamsIdentity, clientSecret: string): CloudAdapter {
  const auth = teamsAuthentication(identity, clientSecret);
  const adapter = new CloudAdapter(auth, undefined, undefined, { validateServiceUrl: true, emitStackTrace: false }, {
    enabled: true,
    isAllowed: (url) => allowedServiceUrl(url instanceof URL ? url.href : url, identity.serviceHosts),
  });
  adapter.onTurnError = async (_context, error) => { throw error; };
  return adapter;
}

export function createProductionApp(
  identity: TeamsIdentity,
  clientSecret: string,
  adapter: CloudAdapter,
  bridge: Bridge,
): express.Express {
  const app = express();
  app.disable("x-powered-by");
  const auth = teamsAuthentication(identity, clientSecret);
  const jwt = authorizeJWT(auth);
  app.get("/health", (_request, response) => response.status(bridge.healthy ? 200 : 503).json({
    status: bridge.healthy ? "ready" : "unhealthy", mock: false,
  }));
  app.post("/api/messages", express.json({ limit: "128kb" }), async (request, response) => {
    let authorized = false;
    const authenticatedRequest: AgentRequest = request;
    // The official JWT validator must finish before owner checks, reference persistence or connector creation.
    await jwt(authenticatedRequest, response, () => { authorized = true; });
    if (!authorized || response.headersSent) return;
    const turn = authorizeActivity(authenticatedRequest.body, authenticatedRequest.user, identity);
    await adapter.process(authenticatedRequest, response, async (context) => {
      const card = await bridge.handle(turn.key, turn.reference, turn.activity.id!, turn.incoming);
      if (turn.activity.type === ActivityTypes.Invoke) {
        await context.sendActivity(Activity.fromObject({
          type: ActivityTypes.InvokeResponse,
          value: { status: 200, body: { statusCode: 200, type: "application/vnd.microsoft.card.adaptive", value: card } },
        }));
      }
    });
  });
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    logError("teams-http", error);
    if (!response.headersSent) response.status(error instanceof UserError ? error.status : 500).json({ error: publicError(error) });
  };
  app.use(errors);
  return app;
}
