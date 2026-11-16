import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isSessionListView, type ConversationRecord, type View } from "./domain.js";
import { canonicalId, object, string, UserError } from "./safety.js";

export const operations = ["view", "page", "filter", "select", "create", "send", "refresh", "stop", "pick-model", "settings", "answer", "subscribe", "unsubscribe"] as const;
export type Operation = typeof operations[number];

export interface ActionScope {
  op: Operation;
  view?: View;
  query?: string;
  targetId?: string;
  requestId?: string;
  argument?: string;
}

export interface ActionClaims extends ActionScope {
  version: 1;
  nonce: string;
  conversation: string;
  selected: string;
  revision: number;
  expires: number;
  surfaceId?: string;
}

export class StaleCardActionError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = "StaleCardActionError";
  }
}

function isOperation(value: unknown): value is Operation {
  return operations.some((operation) => operation === value);
}

function isView(value: unknown): value is View {
  return ["home", "dashboard", "sessions", "working", "needs-reply", "sides", "subscriptions", "new", "settings", "control", "transcript"].some((view) => view === value);
}

export function isViewNavigation(scope: ActionScope): boolean {
  return (scope.op === "select" && canonicalId(scope.targetId)) ||
    (scope.op === "view" && ["home", "sessions", "working", "needs-reply", "subscriptions", "new", "control", "dashboard"].includes(scope.argument ?? "")) ||
    (scope.op === "view" && scope.argument === "sides" && canonicalId(scope.targetId)) ||
    (scope.op === "view" && scope.argument === "transcript" && canonicalId(scope.targetId)) ||
    (scope.view === "transcript" && scope.op === "page" && canonicalId(scope.targetId)) ||
    (isSessionListView(scope.view) && (scope.op === "page" || scope.op === "refresh" || scope.op === "filter"));
}

export class Actions {
  constructor(private readonly key: string, private readonly ttlMs = 15 * 60_000) {}

  issue(conversation: ConversationRecord, scope: ActionScope, now = Date.now()): string {
    const claims: ActionClaims = {
      ...scope, version: 1, nonce: randomUUID(), conversation: conversation.key,
      selected: conversation.selectedId ?? "", revision: conversation.revision, expires: now + this.ttlMs,
      view: conversation.view,
      ...(conversation.view === "sides" && conversation.sideParentId && !scope.targetId ? { targetId: conversation.sideParentId } : {}),
      ...(conversation.surfaceId ? { surfaceId: conversation.surfaceId } : {}),
      ...(conversation.query ? { query: conversation.query } : {}),
    };
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  verify(token: unknown, conversation: ConversationRecord, now = Date.now()): ActionClaims {
    const claims = this.authenticate(token, conversation);
    this.requireCurrent(claims, conversation, now);
    return claims;
  }

  authenticate(token: unknown, conversation: ConversationRecord): ActionClaims {
    if (!string(token, 4096)) throw new UserError("Missing or malformed card action.");
    const pieces = token.split(".");
    const body = pieces[0];
    const signature = pieces[1];
    if (pieces.length !== 2 || !body || !signature || !/^[A-Za-z0-9_-]+$/.test(signature)) {
      throw new UserError("Invalid card action signature.");
    }
    const expected = Buffer.from(this.sign(body), "base64url");
    const supplied = Buffer.from(signature, "base64url");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new UserError("Invalid card action signature.");
    }
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new UserError("Invalid card action payload.");
    }
    if (!object(claims) || claims.version !== 1 || !string(claims.nonce) ||
      !string(claims.conversation) || typeof claims.selected !== "string" ||
      !Number.isSafeInteger(claims.revision) || typeof claims.expires !== "number" ||
      !isOperation(claims.op) ||
      (claims.surfaceId !== undefined && !canonicalId(claims.surfaceId)) ||
      (claims.view !== undefined && !isView(claims.view)) ||
      (claims.query !== undefined && !string(claims.query, 100)) ||
      (claims.targetId !== undefined && !string(claims.targetId)) ||
      (claims.requestId !== undefined && !string(claims.requestId)) ||
      (claims.argument !== undefined && !string(claims.argument))) {
      throw new UserError("Invalid card action payload.");
    }
    const verified: ActionClaims = {
      version: 1, nonce: claims.nonce, conversation: claims.conversation, selected: claims.selected,
      revision: Number(claims.revision), expires: claims.expires, op: claims.op,
      ...(claims.view === undefined ? {} : { view: claims.view }),
      ...(claims.query === undefined ? {} : { query: claims.query }),
      ...(claims.targetId === undefined ? {} : { targetId: claims.targetId }),
      ...(claims.requestId === undefined ? {} : { requestId: claims.requestId }),
      ...(claims.argument === undefined ? {} : { argument: claims.argument }),
      ...(claims.surfaceId === undefined ? {} : { surfaceId: claims.surfaceId }),
    };
    if (claims.conversation !== conversation.key) throw new UserError("This card belongs to a different conversation.");
    return verified;
  }

  requireCurrent(claims: ActionClaims, conversation: ConversationRecord, now = Date.now()): void {
    if (claims.conversation !== conversation.key) throw new UserError("This card belongs to a different conversation.");
    if (claims.surfaceId !== undefined && claims.surfaceId !== conversation.surfaceId) {
      throw new StaleCardActionError("This operation card was replaced. Use the latest card, !status or !sessions.");
    }
    // View-only links can recover legacy cards or navigate the current surface.
    // Runtime operations never bypass expiry or request/selection checks.
    if (!isViewNavigation(claims)) {
      if (claims.expires <= now) throw new StaleCardActionError("This card expired.");
      if (claims.revision !== conversation.revision || claims.selected !== (conversation.selectedId ?? "")) {
        throw new StaleCardActionError("This card is stale or belongs to a different conversation/session.");
      }
    }
  }

  private sign(body: string): string {
    return createHmac("sha256", Buffer.from(this.key, "base64url")).update(body).digest("base64url");
  }
}
