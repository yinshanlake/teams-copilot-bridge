import { randomUUID } from "node:crypto";
import { defineTool, type Tool } from "@github/copilot-sdk";
import type { ConversationReference } from "@microsoft/agents-activity";
import { Actions, isViewNavigation, StaleCardActionError, type ActionClaims } from "./actions.js";
import { Cards, inputSuffix, latestTranscriptPage, sessionListPage } from "./cards.js";
import type {
  Answer, AppAdmission, AppAdmissionSeed, BridgeOptions, Card, ConversationPreview, ConversationRecord, ModelChoice, Receipt, Runtime, RuntimeEvent,
  SessionListView, SessionRecord, Settings, BridgeState, Subscription, OutboxItem, IncomingAddress, Outbound, SendOptions,
} from "./domain.js";
import { appAdmissionNotice, appSessionCapability, isSessionListView, viewTarget } from "./domain.js";
import type { TimelineEntry } from "./domain.js";
import { Projector, chronologicalTimeline, mergeDialoguePreview, rememberConversation } from "./projection.js";
import { replyChunks } from "./replies.js";
import { Store } from "./store.js";
import { conversationDialogue, sourceTitle } from "./conversation-ui.js";
import { parseCommand, type Command } from "./commands.js";
import { newMessageFormat } from "./transport-format.js";
import { outboundActivity } from "./teams.js";
import { assertFields, canonicalId, DeliveryError, digest, logError, object, publicError, safeText, sessionName, string, UncertainOperationError, UserError } from "./safety.js";
import {
  followDescription, follows, focusHeader, inbox, interactionState, newSurface, observeInteraction, renderInteractionSurface,
  setTurnState, startTurn, surfaceConversation, touchSurface, turnForOrigin,
} from "./interaction.js";

export type Incoming = ({ kind: "text"; text: string } | { kind: "action"; data: Record<string, unknown> }) & { address?: IncomingAddress };
const workingCapability = "Bridge-owned native session: send/read/stop, mode/model/effort and scoped owner approvals.";
const controlCapability = "Persistent owner control session. Only bounded session-management tools are exposed.";
const livenessFailureNotice = "App live-status refresh failed or timed out; endpoint status is unknown and sending is disabled until a fresh check succeeds. Retained history and navigation remain available.";

function record(id: string, name: string, workspace: string, controller = false): SessionRecord {
  return {
    id, name, workspace, kind: controller ? "controller" : "owned", status: "offline",
    executionObserved: false,
    capability: controller ? controlCapability : workingCapability,
    timeline: [], pending: [], seenEvents: [], sequence: 0, updatedAt: Date.now(),
  };
}

function sameSettings(a: Settings, b: Settings): boolean {
  return a.mode === b.mode && a.modelId === b.modelId && a.providerId === b.providerId &&
    (b.effort === undefined || a.effort === b.effort);
}

interface SubscriptionRead {
  revision: number;
  cursorKey: string;
  promise: ReturnType<Runtime["subscriptionRead"]>;
}

export class Bridge {
  readonly actions: Actions;
  readonly cards: Cards;
  private readonly projector = new Projector();
  private readonly modelCatalogues = new Map<string, ModelChoice[]>();
  private readonly transcripts = new Map<string, TimelineEntry[]>();
  private readonly previews = new Map<string, ConversationPreview>();
  private readonly historyReads = new Set<symbol>();
  private readonly historyJobs = new Set<Promise<void>>();
  private readonly previewFailures = new Set<string>();
  private readonly previewReads = new Map<string, Promise<ConversationPreview>>();
  private readonly conversations = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private events: Promise<void> = Promise.resolve();
  private delivery: Promise<void> = Promise.resolve();
  private catalogueRefresh: Promise<void> | undefined;
  private appLivenessRefresh: Promise<boolean> | undefined;
  private appLivenessRead: ReturnType<Runtime["appLiveness"]> | undefined;
  private appLivenessRetryAt = 0;
  private appLivenessFailed = false;
  private timer: NodeJS.Timeout | undefined;
  private activeControlKey: string | undefined;
  private closing = false;
  private eventFailure = false;
  private deliveryEnabled: boolean;
  private subscriptionTimer: NodeJS.Timeout | undefined;
  private subscriptionCheck: Promise<void> | undefined;
  private readonly directAcks = new Map<string, Promise<void>>();
  private readonly subscriptionReads = new Map<string, SubscriptionRead>();
  private readonly baselineReads = new Map<string, ReturnType<Runtime["subscriptionBaseline"]>>();
  private interactionTimer: NodeJS.Timeout | undefined;
  private readonly dashboardUpdates = new Map<string, { at: number; transition: string }>();

  constructor(
    readonly store: Store,
    readonly runtime: Runtime,
    private readonly transport: import("./domain.js").Transport,
    readonly options: BridgeOptions,
  ) {
    if (store.snapshot().owner !== options.owner) throw new Error("Store owner mismatch");
    this.actions = new Actions(store.snapshot().actionKey, options.actionTtlMs);
    this.cards = new Cards(this.actions, options.workspaces, options.cardActions);
    this.deliveryEnabled = !options.deliveryInitiallyPaused;
  }

  get healthy(): boolean {
    return !this.eventFailure && !this.closing;
  }

  enableDelivery(): void {
    if (this.deliveryEnabled) return;
    this.deliveryEnabled = true;
    for (const conversation of Object.values(this.store.snapshot().conversations)) this.schedule(conversation.key);
  }

  async start(): Promise<void> {
    await this.runtime.start((event) => {
      this.events = this.events.then(() => this.applyEvent(event)).catch((error: unknown) => {
        this.eventFailure = true;
        logError("event-projection-or-persistence", error);
      });
    });
    if (!this.store.snapshot().controllerId) {
      const newControllerId = randomUUID();
      const workspace = this.options.workspaces[0];
      if (!workspace) throw new Error("At least one allowed workspace is required");
      await this.store.mutate((state) => {
        state.controllerId = newControllerId;
        state.sessions[newControllerId] = record(newControllerId, "Teams owner control", workspace.path, true);
      });
    }
    await this.store.mutate((state) => {
      if (this.options.interaction) {
        const ui = interactionState(state);
        ui.remoteApprovals = this.options.interaction.remoteApprovals !== false;
        ui.capabilityNotice = `Focus mode. Threads ${this.options.interaction.threads === "off" ? "disabled" : "unavailable on this validated transport"}; ` +
          `reactions ${this.options.interaction.reactions === "off" ? "disabled" : "unavailable"}. Native quoted replies are not enabled.`;
      }
      for (const conversation of Object.values(state.conversations)) {
        conversation.surfaceId = randomUUID();
        if (this.options.interaction && conversation.selectedId && state.sessions[conversation.selectedId]) {
          const header = focusHeader(state, conversation.key, conversation.selectedId);
          if (!header.activityId && conversation.view === "dashboard" && conversation.dashboardId && conversation.dashboardState === "ready") {
            header.activityId = conversation.dashboardId; header.delivery = "ready";
            delete conversation.dashboardId; delete conversation.dashboardState;
          }
        }
      }
      for (const session of Object.values(state.sessions)) {
        if (session.kind === "owned" || session.kind === "controller") {
          session.status = "offline";
          session.executionObserved = false;
          if (session.kind === "owned") session.capability = "Bridge-owned native session is not connected. Retained history is readable; sending a new instruction or opening Settings explicitly reconnects it without replaying prior work.";
        }
        for (const entry of session.timeline) {
          if (entry.kind === "user" || entry.kind === "assistant") rememberConversation(session, entry.timestamp);
        }
      }
    });
    for (const session of Object.values(this.store.snapshot().sessions)) {
      if (session.kind === "peer" && session.peerSource === "app") await this.runtime.watchPeer(session);
    }
    if (this.options.inventoryOnStart !== false) await this.refreshInventory();
    await this.reconcileAppAdmissions();
    await this.checkSubscriptions();
    this.armSubscriptions();
    for (const conversation of Object.values(this.store.snapshot().conversations)) {
      if (this.options.inventoryOnStart === false) {
        await this.notice(conversation.key, "Connection restored. The session list is saved; Refresh discovers current host sessions.");
      }
      if (conversation.view === "settings") {
        await this.setView(conversation.key, "dashboard");
        await this.notice(conversation.key, "Native sessions reconnect only on an explicit operation. Retained history/settings are preserved; reopen Settings to connect and load its live catalogue.");
      }
      if (conversation.historyRead?.status === "interrupted") await this.notice(conversation.key,
        "History read was interrupted by restart. It was not replayed; use !history to request a new snapshot.");
      this.schedule(conversation.key);
    }
  }

  private async ensureLive(id: string): Promise<void> {
    const item = this.store.snapshot().sessions[id];
    if (!item || (item.kind !== "owned" && item.kind !== "controller")) return;
    const actual = item.kind === "controller" && !item.settings
      ? await this.runtime.create({ id, name: item.name, workspace: item.workspace, controller: true, tools: this.controllerTools() })
      : await this.runtime.resume(item, item.kind === "controller" ? this.controllerTools() : undefined);
    await this.store.mutate((state) => {
      const session = state.sessions[id]!;
      session.settings = actual;
      if (session.status === "offline") session.status = "idle";
      session.capability = session.kind === "controller" ? controlCapability : workingCapability;
    });
  }

  async handle(
    key: string,
    reference: ConversationReference,
    activityId: string,
    incoming: Incoming,
  ): Promise<Card> {
    const legacyKey = key;
    const chatKey = this.options.interaction && incoming.address?.chatId
      ? digest(`chat:${this.options.owner}:${incoming.address.chatId}`) : undefined;
    if (this.options.interaction) {
      const state = this.store.snapshot();
      key = (chatKey ? state.interaction?.aliases?.[chatKey] : undefined) ??
        state.interaction?.aliases?.[legacyKey] ?? (state.conversations[legacyKey] ? legacyKey : chatKey ?? legacyKey);
    }
    const previous = this.conversations.get(key) ?? Promise.resolve();
    let result: Card | undefined;
    const operation = previous.then(async () => {
      if (!this.healthy) throw new UserError("Backend event persistence is unhealthy or shutting down. No new work was accepted.", 503);
      await this.store.mutate((state) => {
        if (this.options.interaction) {
          const ui = interactionState(state);
          const aliases = ui.aliases ??= {};
          if (legacyKey !== key && state.conversations[legacyKey] ||
            aliases[legacyKey] !== undefined && aliases[legacyKey] !== key ||
            chatKey && aliases[chatKey] !== undefined && aliases[chatKey] !== key) {
            throw new UserError("Conflicting chat identities cannot be merged automatically. Nothing was sent; inspect the original chat.");
          }
          aliases[legacyKey] = key;
          if (chatKey) aliases[chatKey] = key;
        }
        const existing = state.conversations[key];
        if (existing?.chatId && incoming.address?.chatId && existing.chatId !== incoming.address.chatId) {
          throw new UserError("The containing chat identity changed. Nothing was sent or merged.");
        }
        if (existing) existing.reference = reference;
        else state.conversations[key] = {
          key, reference, revision: 1, view: "home", page: 0, notice: "Choose a working session, or use Control.", surfaceId: randomUUID(),
          read: {},
        };
        if (incoming.address?.chatId) state.conversations[key]!.chatId = incoming.address.chatId;
        if (this.options.interaction) inbox(state, key);
      });
      const receiptId = digest(`${key}:${activityId}`);
      const existing = this.store.snapshot().receipts[receiptId];
      if (existing) {
        await this.notice(key, `Duplicate activity ignored. Previous operation: ${existing.status}. ${existing.detail}`);
        result = this.render(key);
        return;
      }
      await this.receipt(receiptId, key, incoming.kind, "started", "Operation received.");
      let actionReceipt: string | undefined;
      let operationName: string = incoming.kind;
      let livenessFailed = false;
      try {
        if (incoming.kind === "action") {
          const claims = this.actions.authenticate(incoming.data.token, this.store.snapshot().conversations[key]!);
          operationName = claims.op;
          if (!isViewNavigation(claims) || claims.op === "refresh" || claims.op === "select" ||
            claims.op === "view" && claims.argument === "transcript") {
            const nonceReceipt = `action:${claims.nonce}`;
            const previousAction = this.store.snapshot().receipts[nonceReceipt];
            if (previousAction) {
              if (previousAction.conversationKey !== key) throw new UserError("Card action receipt belongs to a different conversation.");
              const detail = `This card action was already used. Previous operation: ${previousAction.status}. ${previousAction.detail} No action was repeated.`;
              await this.receipt(receiptId, key, operationName,
                previousAction.status === "started" ? "uncertain" : previousAction.status, detail, previousAction);
              await this.notice(key, detail);
              await this.events;
              result = this.render(key);
              this.schedule(key);
              return;
            }
            actionReceipt = nonceReceipt;
          }
          this.actions.requireCurrent(claims, this.actionConversation(this.store.snapshot(), key, claims));
          if (actionReceipt) {
            await this.receipt(actionReceipt, key, claims.op, "started", "Card action validated.");
          }
          if (claims.op !== "unsubscribe") livenessFailed = await this.ensureAppLiveness();
          await this.action(key, claims, incoming.data, [receiptId, ...(actionReceipt ? [actionReceipt] : [])]);
        } else {
          if (!string(incoming.text, 64_000)) throw new UserError("Message is empty or too long; it was not forwarded.");
          const command = parseCommand(incoming.text);
          operationName = command?.name ?? "send";
          if (command?.name !== "unsubscribe") livenessFailed = await this.ensureAppLiveness();
          if (!command && this.options.interaction && incoming.address && incoming.address.place !== "top") {
            await this.captureRoute(key, incoming.text, receiptId, reference);
          } else await this.text(key, incoming.text, [receiptId], command);
        }
        if (!["history", "routing"].includes(this.store.snapshot().receipts[receiptId]?.operation ?? "")) {
          await this.receipt(receiptId, key, operationName, "accepted", "Operation accepted; task completion is reported separately.");
          if (actionReceipt) await this.receipt(actionReceipt, key, operationName, "accepted", "Card action consumed.");
        }
      } catch (error) {
        logError("inbound-operation", error);
        let cancelledHistory = false;
        if (incoming.kind === "text" && /^\s*!use(?:\s|$)/iu.test(incoming.text) ||
          ["select", "route-send", "route-create"].includes(operationName) && !(error instanceof StaleCardActionError)) {
          await this.store.mutate((state) => {
            state.conversations[key]!.selectionBlocked = true;
            state.conversations[key]!.revision++;
            cancelledHistory = this.supersedeHistory(state, key);
          });
        }
        const detail = publicError(error) + (cancelledHistory ? " The previous pending HISTORY snapshot was superseded." : "");
        const status = error instanceof UncertainOperationError ? "uncertain" : "failed";
        await this.receipt(receiptId, key, operationName, status, detail);
        if (actionReceipt && this.store.snapshot().receipts[actionReceipt]?.status === "started") {
          await this.receipt(actionReceipt, key, operationName, status, detail);
        }
        await this.reportOperationError(key, receiptId, detail, error instanceof StaleCardActionError);
      }
      await this.events;
      if (this.options.interaction) await this.store.mutate((state) => {
        touchSurface(inbox(state, key), true);
        const selected = state.conversations[key]!.selectedId;
        if (selected && state.sessions[selected]) touchSurface(focusHeader(state, key, selected), true);
      });
      if (operationName !== "unsubscribe") await this.loadPagePreviews(key);
      if (livenessFailed) await this.notice(key,
        `${livenessFailureNotice} ${this.store.snapshot().conversations[key]!.notice}`);
      result = this.render(key);
      this.schedule(key);
    });
    this.conversations.set(key, operation.catch(() => undefined));
    await operation;
    if (!result) throw new Error("Operation did not render a card");
    return result;
  }

  render(key: string): Card {
    const state = this.store.snapshot();
    const conversation = state.conversations[key];
    if (this.options.interaction && conversation && ["home", "working", "needs-reply"].includes(conversation.view)) {
      return renderInteractionSurface(state, inbox(state, key), this.cards);
    }
    if (this.options.interaction && conversation?.view === "dashboard" && conversation.selectedId && state.sessions[conversation.selectedId]) {
      return renderInteractionSurface(state, focusHeader(state, key, conversation.selectedId), this.cards);
    }
    const targetId = conversation ? viewTarget(state, conversation) : undefined;
    const rendered = this.cards.render(state, key, this.modelCatalogues.get(targetId ?? "") ?? [],
      this.transcriptEntries(state.sessions[targetId ?? ""]), {
        previews: this.previews, previewFailures: this.previewFailures,
        discoveryStatus: this.runtime.discoveryStatus(),
        connection: !this.healthy || this.transport.connected === false ? "unavailable"
          : this.transport.connected === true ? "connected" : "ready",
      });
    return rendered;
  }

  private actionConversation(state: BridgeState, key: string, claims: ActionClaims): ConversationRecord {
    if (claims.version === 1) return state.conversations[key]!;
    const surface = state.interaction?.surfaces[claims.surfaceId ?? ""];
    if (!surface || surface.conversationKey !== key || surface.frozen) {
      throw new StaleCardActionError("This interaction card was replaced or resolved. Use the latest Inbox.");
    }
    return surfaceConversation(state, surface);
  }

  private async loadPagePreviews(key: string): Promise<void> {
    const state = this.store.snapshot();
    const conversation = state.conversations[key];
    if (!conversation || !isSessionListView(conversation.view)) return;
    await Promise.all(sessionListPage(state, conversation).sessions.map(async (session) => {
      if (session.access?.read === false || session.kind === "unavailable") return;
      let read = this.previewReads.get(session.id);
      if (!read) {
        if (this.previewReads.size >= 3) {
          this.previewFailures.add(session.id);
          if (this.previewFailures.size > 24) this.previewFailures.delete(this.previewFailures.values().next().value!);
          return;
        }
        read = this.runtime.preview(session.id);
        this.previewReads.set(session.id, read);
        const clear = () => { if (this.previewReads.get(session.id) === read) this.previewReads.delete(session.id); };
        void read.then(clear, clear);
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        const preview = await Promise.race([read, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new UserError("Conversation preview timed out.")), 2000);
        })]);
        const cached = this.transcriptEntries(this.store.snapshot().sessions[session.id]);
        this.previews.delete(session.id);
        this.previews.set(session.id, { entries: mergeDialoguePreview(preview.entries, cached), complete: preview.complete });
        this.previewFailures.delete(session.id);
        if (this.previews.size > 24) {
          const oldest = this.previews.keys().next().value!;
          this.previews.delete(oldest);
          this.previewFailures.delete(oldest);
        }
      } catch (error) {
        logError("conversation-preview", error);
        this.previews.delete(session.id);
        this.previewFailures.add(session.id);
        if (this.previewFailures.size > 24) this.previewFailures.delete(this.previewFailures.values().next().value!);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));
  }

  private transcriptEntries(session: SessionRecord | undefined): TimelineEntry[] {
    const cached = this.transcripts.get(session?.id ?? "");
    const entries = new Map(cached?.map((entry) => [entry.id, entry]) ?? []);
    for (const entry of session?.timeline ?? []) entries.set(entry.id, entry);
    return chronologicalTimeline([...entries.values()]);
  }

  async rememberDashboard(key: string, id: string): Promise<void> {
    await this.store.mutate((state) => {
      const conversation = state.conversations[key];
      if (conversation) {
        conversation.dashboardId = id;
        conversation.dashboardState = "ready";
      }
    });
  }

  private async receipt(id: string, conversationKey: string, operation: string, status: Receipt["status"], detail: string, original?: Receipt): Promise<void> {
    await this.store.mutate((state) => {
      const previous = state.receipts[id];
      const admissionId = previous?.admissionId ?? original?.admissionId;
      const admission = admissionId ? state.admissions[admissionId] : undefined;
      const sessionId = previous?.sessionId ?? original?.sessionId;
      state.receipts[id] = {
        ...previous, id, conversationKey, operation, status,
        ...(admissionId ? { admissionId } : {}),
        ...(sessionId ? { sessionId } : {}),
        detail: safeText(admission && status === "accepted" ? appAdmissionNotice(admission) : detail, 500), at: Date.now(),
      };
    });
  }

  private async persistAppAdmission(key: string, sessionId: string, receiptIds: string[], seed: AppAdmissionSeed): Promise<void> {
    await this.store.mutate((state) => {
      if (seed.sessionId !== sessionId || seed.id !== digest(`${sessionId}:${seed.messageId}`) ||
        !state.conversations[key] || state.sessions[sessionId]?.peerSource !== "app" ||
        !Number.isSafeInteger(seed.baselineIndex) || seed.baselineIndex < -1 ||
        !receiptIds.length || state.admissions[seed.id]) {
        throw new UncertainOperationError("App admission identity could not be uniquely persisted. Execution/result are unconfirmed; no replay will be attempted.");
      }
      const admission: AppAdmission = {
        ...seed, conversationKey: key, receiptIds, phase: "accepted", observation: "watching",
        resultIds: [], checkedAt: seed.acceptedAt,
        ...(state.interaction?.turns[receiptIds[0] ?? ""]?.reference
          ? { reference: structuredClone(state.interaction.turns[receiptIds[0]!]!.reference) } : {}),
      };
      for (const id of receiptIds) {
        const receipt = state.receipts[id];
        if (!receipt || receipt.conversationKey !== key) throw new Error("App admission receipt scope is missing or mismatched.");
        receipt.admissionId = admission.id;
        receipt.sessionId = sessionId;
        receipt.status = "accepted";
        receipt.detail = appAdmissionNotice(admission);
      }
      state.admissions[admission.id] = admission;
      const turn = state.interaction?.turns[receiptIds[0] ?? ""];
      if (turn) { turn.messageId = seed.messageId; setTurnState(state, turn, "accepted"); }
      for (const item of state.outbox) if (item.sessionId === sessionId && item.conversationKey === key &&
        item.originatingMessageId === seed.messageId) {
        item.admissionId = admission.id;
        item.direct = true;
        if (item.status === "cancelled") item.status = "pending";
      }
      state.conversations[key]!.read[sessionId] ??= state.sessions[sessionId]!.sequence;
      state.conversations[key]!.notice = appAdmissionNotice(admission);
    });
  }

  private async reconcileAppAdmissions(sessionId?: string): Promise<void> {
    const admissions = Object.values(this.store.snapshot().admissions).filter((admission) =>
      admission.phase !== "confirmed" && (sessionId === undefined || admission.sessionId === sessionId));
    if (!admissions.length) return;
    await this.runtime.reconcileAdmissions(admissions);
    await this.events;
  }

  private async notice(key: string, text: string): Promise<void> {
    await this.store.mutate((state) => { state.conversations[key]!.notice = safeText(text, 800); });
  }

  private async ensureAppLiveness(): Promise<boolean> {
    if (this.appLivenessRefresh) return this.appLivenessRefresh;
    const now = Date.now();
    const sessions = Object.values(this.store.snapshot().sessions).filter((session) => session.peerSource === "app");
    const expired = sessions.some((session) => session.liveUntil !== undefined && session.liveUntil <= now);
    if (!expired && sessions.every((session) => session.liveUntil !== undefined && session.liveUntil > now)) return false;
    if (!expired && now < this.appLivenessRetryAt) return this.appLivenessFailed;
    const refresh = this.refreshAppLiveness(sessions.map((session) => session.id));
    this.appLivenessRefresh = refresh;
    try { return await refresh; } finally {
      if (this.appLivenessRefresh === refresh) this.appLivenessRefresh = undefined;
    }
  }

  private async refreshAppLiveness(ids: string[]): Promise<boolean> {
    let failed = false;
    let endpoints: Awaited<ReturnType<Runtime["appLiveness"]>> = [];
    let deadline: NodeJS.Timeout | undefined;
    try {
      // Keep at most one actual registry read even if a filesystem read stalls
      // past the UI deadline; late results cannot mutate the Store on their own.
      if (!this.appLivenessRead) {
        const read = Promise.resolve().then(() => this.runtime.appLiveness());
        this.appLivenessRead = read;
        const clear = () => { if (this.appLivenessRead === read) this.appLivenessRead = undefined; };
        void read.then(clear, clear);
      }
      endpoints = await Promise.race([
        this.appLivenessRead,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new UserError("APP_LIVENESS_TIMEOUT")), this.options.appLivenessTimeoutMs ?? 2000);
        }),
      ]);
    } catch (error) {
      logError("app-liveness-refresh", error);
      failed = true;
    } finally {
      if (deadline) clearTimeout(deadline);
    }
    if (this.closing) return failed;
    const fresh = new Map(endpoints.filter((endpoint) => endpoint.liveUntil > Date.now()).map((endpoint) => [endpoint.id, endpoint]));
    await this.store.mutate((state) => {
      for (const id of ids) {
        const session = state.sessions[id];
        if (session?.peerSource !== "app") continue;
        const endpoint = fresh.get(id);
        const readable = session.access?.read ?? false;
        session.status = endpoint?.status ?? "offline";
        session.access = { read: readable, send: readable && endpoint !== undefined };
        if (endpoint) session.liveUntil = endpoint.liveUntil;
        else delete session.liveUntil;
        session.capability = failed ? livenessFailureNotice : appSessionCapability(readable, endpoint !== undefined);
      }
    });
    this.appLivenessFailed = failed;
    this.appLivenessRetryAt = Date.now() + 1000;
    return failed;
  }

  private async reportOperationError(
    key: string, receiptId: string, detail: string, refreshCard = false, history?: { id: string; sessionId: string },
  ): Promise<void> {
    await this.store.mutate((state) => {
      const conversation = state.conversations[key]!;
      if (history && (!conversation.historyRead?.readOnlyTarget && (conversation.selectionBlocked || conversation.selectedId !== history.sessionId) ||
        conversation.historyRead?.id !== history.id || conversation.historyRead.sessionId !== history.sessionId ||
        conversation.historyRead.status !== "failed")) return;
      conversation.notice = safeText(refreshCard
        ? `${detail} No action was performed. These controls are refreshed; review the current session before acting.`
        : detail, 800);
      if (refreshCard) {
        delete conversation.dashboardId;
        delete conversation.dashboardState;
        conversation.surfaceId = randomUUID();
      }
      const sessionId = history?.sessionId ?? conversation.selectedId ?? state.controllerId;
      if (!sessionId) throw new Error("Cannot report an operation without a controller.");
      const eventId = `operation-error:${receiptId}`;
      const id = digest(`${key}:${eventId}`);
      if (!state.outbox.some((item) => item.id === id)) state.outbox.push({
        id, conversationKey: key, sessionId, eventId, status: "pending",
        text: safeText(`Request error: ${detail}\nNo automatic retry was made. ${refreshCard
          ? "Review the refreshed card below before acting."
          : 'Use !sessions to choose a source or !help for commands.'}`, 1500),
      });
    });
  }

  private async freshReply(key: string, notice: string): Promise<void> {
    await this.store.mutate((state) => {
      const conversation = state.conversations[key]!;
      delete conversation.dashboardId;
      delete conversation.dashboardState;
      conversation.surfaceId = randomUUID();
      conversation.notice = safeText(notice, 800);
    });
    this.schedule(key);
  }

  private async showSessions(key: string, fresh: boolean, preservePage = false, view: SessionListView = "sessions"): Promise<void> {
    if (this.options.interaction && (view === "working" || view === "needs-reply")) {
      await this.showHome(key, fresh);
      return;
    }
    if (!preservePage || this.store.snapshot().conversations[key]!.view !== view) {
      await this.setView(key, view);
    } else {
      await this.store.mutate((state) => { state.conversations[key]!.revision++; });
    }
    const notice = "Refreshing the session list. Cached entries are shown while the host responds.";
    if (fresh) await this.freshReply(key, notice);
    else {
      await this.notice(key, notice);
      this.schedule(key);
    }
    this.startCatalogueRefresh();
  }

  private startCatalogueRefresh(): void {
    if (!this.catalogueRefresh) {
      this.catalogueRefresh = this.refreshCatalogueInBackground().catch((error: unknown) => {
        this.eventFailure = true;
        logError("catalogue-result-persistence", error);
      }).finally(() => { this.catalogueRefresh = undefined; });
    }
  }

  private async showHome(key: string, fresh: boolean): Promise<void> {
    await this.setView(key, "home");
    if (this.options.interaction) await this.store.mutate((state) => { touchSurface(inbox(state, key, fresh), true); });
    if (fresh) await this.freshReply(key, "Choose a working session, or use Control.");
    this.startCatalogueRefresh();
  }

  private async refreshCatalogueInBackground(): Promise<void> {
    const controllerId = this.store.snapshot().controllerId;
    if (!controllerId) throw new Error("Missing controller for catalogue refresh.");
    let notice = "Session list refreshed. Open a session to send a task.";
    let inventory: Awaited<ReturnType<Runtime["inventory"]>> | undefined;
    try {
      inventory = await this.runtime.inventory(controllerId);
    } catch (error) {
      logError("catalogue-refresh", error);
      notice = "Host refresh is unavailable. Saved sessions are still shown; search and retained history remain available.";
    }
    if (this.closing) return;
    if (inventory) await this.applyInventory(inventory);
    await this.reconcileAppAdmissions();
    await this.store.mutate((state) => {
      for (const conversation of Object.values(state.conversations)) {
        if ((isSessionListView(conversation.view) || conversation.view === "home") &&
          conversation.notice === "Refreshing the session list. Cached entries are shown while the host responds.") {
          conversation.notice = notice;
        }
      }
    });
    for (const conversation of Object.values(this.store.snapshot().conversations)) await this.loadPagePreviews(conversation.key);
    for (const conversation of Object.values(this.store.snapshot().conversations)) this.schedule(conversation.key);
  }

  private async setView(key: string, view: ConversationRecord["view"], explicitTranscriptId?: string): Promise<void> {
    if (view === "settings") {
      const id = this.store.snapshot().conversations[key]?.selectedId;
      if (!id || this.store.snapshot().sessions[id]?.kind !== "owned") throw new UserError("Select a bridge-owned working session first.");
      await this.ensureLive(id);
      this.modelCatalogues.set(id, await this.runtime.models(id));
      await this.refreshSettings(id);
    }
    await this.store.mutate((state) => {
      const conversation = state.conversations[key]!;
      const transcriptId = explicitTranscriptId ?? viewTarget(state, conversation);
      if (view === "transcript" && transcriptId) {
        if (!state.sessions[transcriptId]) throw new UserError("Target is not in the current session catalogue.");
        conversation.transcriptId = transcriptId;
        if (transcriptId !== state.controllerId && !this.options.interaction) conversation.selectedId = transcriptId;
      }
      conversation.view = view;
      conversation.page = view === "transcript"
        ? latestTranscriptPage(this.transcriptEntries(state.sessions[transcriptId ?? ""]))
        : 0;
      conversation.revision++;
      delete conversation.modelKey;
      delete conversation.query;
      if (conversation.dashboardState === "uncertain" || conversation.dashboardState === "rejected") delete conversation.dashboardState;
      if (view === "control" || (view === "transcript" && transcriptId === state.controllerId)) conversation.notice = "Control view/history does not change the message destination. Ordinary text goes to the selected working session; optional management requires !control <instruction>.";
      else if (conversation.selectedId) conversation.notice = "Ordinary text goes unchanged to the selected working session.";
      if (conversation.selectedId && view !== "control") conversation.read[conversation.selectedId] = state.sessions[conversation.selectedId]?.sequence ?? 0;
      if (this.options.interaction && conversation.selectedId && state.sessions[conversation.selectedId]) {
        touchSurface(focusHeader(state, key, conversation.selectedId), true);
      }
    });
  }

  private async action(key: string, claims: ActionClaims, data: Record<string, unknown>, receiptIds: string[]): Promise<void> {
    const conversation = this.actionConversation(this.store.snapshot(), key, claims);
    const targetId = viewTarget(this.store.snapshot(), conversation);
    if (this.options.interaction && ["subscribe", "unsubscribe", "follow", "mute"].includes(claims.op)) {
      assertFields(data, ["token"]);
      if (!canonicalId(claims.targetId) || claims.targetId !== targetId && conversation.view !== "subscriptions") {
        throw new UserError("Following target does not match this signed source.");
      }
      await this.changeFollow(key, claims.targetId,
        claims.op === "unsubscribe" || claims.op === "mute" ? "muted" : "explicit", claims);
      return;
    }
    if (claims.view === "sides" && ["page", "filter", "refresh"].includes(claims.op)) {
      if (!canonicalId(claims.targetId) || !this.store.snapshot().sessions[claims.targetId]) throw new UserError("This side-chat list has no signed canonical parent.");
      await this.store.mutate((state) => { state.conversations[key]!.sideParentId = claims.targetId!; });
    }
    switch (claims.op) {
      case "confirm-stop":
      case "cancel-stop": {
        assertFields(data, ["token"]);
        const snapshot = this.store.snapshot();
        const surface = snapshot.interaction?.surfaces[claims.surfaceId ?? ""];
        if (surface?.kind !== "stop" || !surface.stop || surface.stop.state !== "pending" ||
          surface.stop.expiresAt <= Date.now() || !surface.sessionId || surface.sessionId !== claims.targetId) {
          throw new StaleCardActionError("This Stop confirmation expired or was already used.");
        }
        if (snapshot.sessions[surface.sessionId]?.kind !== "owned") throw new UserError("Only a bridge-owned working session can be stopped.");
        if (claims.op === "cancel-stop") {
          await this.store.mutate((state) => {
            const current = state.interaction!.surfaces[surface.id]!;
            current.stop!.state = "cancelled"; current.frozen = "Stop cancelled. No stop was sent.";
            current.revision++; touchSurface(current, true);
          });
          return;
        }
        await this.store.mutate((state) => {
          const current = state.interaction!.surfaces[surface.id]!;
          current.stop!.state = "uncertain"; current.revision++; touchSurface(current, true);
        });
        try {
          await this.runtime.stop(surface.sessionId, surface.stop.messageId);
          await this.store.mutate((state) => {
            const current = state.interaction!.surfaces[surface.id]!;
            current.stop!.state = "accepted";
            current.frozen = "Stop acknowledged. Await native events; queued or background work may remain.";
            touchSurface(current, true);
          });
        } catch (error) {
          const uncertain = error instanceof UncertainOperationError || !(error instanceof UserError);
          await this.store.mutate((state) => {
            const current = state.interaction!.surfaces[surface.id]!;
            current.stop!.state = uncertain ? "uncertain" : "cancelled";
            current.frozen = uncertain ? "Stop outcome is unconfirmed. Inspect the source; no stop is replayed."
              : "Stop was not accepted. Review the current source before a new confirmation.";
            touchSurface(current, true);
          });
          if (uncertain && !(error instanceof UncertainOperationError)) throw new UncertainOperationError("Stop outcome is unconfirmed. No stop will be replayed.");
          throw error;
        }
        return;
      }
      case "steer": {
        assertFields(data, ["token", "steering"]);
        const state = this.store.snapshot();
        const turn = state.interaction?.turns[claims.argument ?? ""];
        if (!turn || turn.sessionId !== claims.targetId || turn.conversationKey !== key ||
          state.interaction?.active[turn.sessionId] !== turn.id || turn.finishedAt ||
          state.sessions[turn.sessionId]?.kind !== "owned" || !turn.messageId) {
          throw new StaleCardActionError("Steer requires that same observed owned request. Nothing was sent.");
        }
        if (!string(data.steering, 64_000) || !data.steering.trim()) throw new UserError("Enter nonblank steering text.");
        await this.sendWorking(key, turn.sessionId, data.steering, receiptIds, turn.reference,
          { mode: "immediate", expectedMessageId: turn.messageId, parentTurnId: turn.id });
        return;
      }
      case "digest-page":
        assertFields(data, ["token"]);
        if (!claims.argument || !/^\d{1,4}$/u.test(claims.argument)) throw new UserError("Invalid digest page.");
        await this.store.mutate((state) => {
          this.actions.requireCurrent(claims, this.actionConversation(state, key, claims));
          const surface = state.interaction?.surfaces[claims.surfaceId ?? ""];
          const item = state.outbox.find((entry) => entry.id === surface?.outboxId);
          if (surface?.kind !== "digest" || !item?.digest || item.conversationKey !== key) throw new UserError("Digest scope changed.");
          const sources = new Set(item.digest.memberIds.flatMap((id) =>
            state.outbox.find((entry) => entry.id === id)?.sessionId ?? []));
          const page = Number(claims.argument);
          if (page >= Math.ceil(sources.size / 3)) throw new UserError("Digest page is unavailable.");
          surface.page = page; surface.revision++; touchSurface(surface, true);
        });
        return;
      case "route-send":
      case "route-create":
        await this.sendRoute(key, claims, data, receiptIds);
        return;
      case "route-refresh": {
        assertFields(data, ["token"]);
        await this.store.mutate((state) => {
          const route = state.interaction?.routes?.[claims.argument ?? ""];
          if (!route || route.conversationKey !== key || route.state !== "pending" || route.expiresAt <= Date.now()) {
            throw new UserError("This draft expired or was already attempted. It cannot be replayed.");
          }
          const surface = state.interaction!.surfaces[route.surfaceId]!;
          if (surface.delivery === "uncertain" || surface.delivery === "rejected") {
            surface.frozen = "Replaced by an explicitly requested routing card.";
            surface.revision++;
            route.surfaceId = newSurface(state, key, "routing", { routingId: route.id }).id;
          } else { surface.revision++; touchSurface(surface, true); }
        });
        return;
      }
      case "inbox":
        assertFields(data, ["token"]);
        await this.showHome(key, claims.argument !== "refresh");
        return;
      case "open-source":
        assertFields(data, ["token"]);
        if (!canonicalId(claims.targetId)) throw new UserError("Choose a canonical source.");
        await this.requestHistory(key, claims.targetId, 10, receiptIds, true);
        return;
      case "history-source":
        assertFields(data, ["token"]);
        if (!canonicalId(claims.targetId)) throw new UserError("Choose a canonical source.");
        await this.requestHistory(key, claims.targetId, 10, receiptIds, false, true);
        return;
      case "show-full":
        assertFields(data, ["token"]);
        await this.showFullResult(key, claims, receiptIds);
        return;
      case "follow":
      case "mute":
        throw new UserError("This interaction is not enabled.");
      case "subscribe":
      case "unsubscribe": {
        assertFields(data, ["token"]);
        if (!canonicalId(claims.targetId)) throw new UserError("Subscription target must be a canonical source ID.");
        const sourceId = claims.targetId;
        const id = digest(`${key}:${sourceId}`);
        if (claims.op === "unsubscribe") {
          await this.store.mutate((state) => {
            const current = state.conversations[key]!;
            this.actions.requireCurrent(claims, current);
            if (viewTarget(state, current) !== sourceId &&
              !(current.view === "subscriptions" && claims.view === "subscriptions")) throw new StaleCardActionError("Subscription view changed.");
            const subscription = state.subscriptions[id];
            if (!subscription || subscription.sessionId !== sourceId || subscription.conversationKey !== key) throw new UserError("This source is not subscribed in this conversation.");
            subscription.enabled = false; subscription.status = "disabled"; subscription.revision++;
            subscription.detail = "Unsubscribed. Already sent/sending/uncertain messages cannot be retracted.";
            for (const item of state.outbox) if (item.subscription?.id === id && !item.direct && !item.admissionId && item.status === "pending") {
              item.status = "cancelled"; item.detail = "Unsubscribed before notification delivery.";
            }
            state.conversations[key]!.notice = subscription.detail;
            state.conversations[key]!.revision++;
          });
        } else {
          if (sourceId !== targetId) throw new UserError("Subscription target does not match this view.");
          const target = this.store.snapshot().sessions[sourceId];
          if (!target || target.kind === "controller" || target.access?.read === false) throw new UserError("This source has no readable subscription history.");
          if (Object.values(this.store.snapshot().subscriptions).filter((item) => item.enabled).length >= 8) throw new UserError("At most eight subscriptions may be enabled. Unsubscribe one first.");
          const cursor = await this.captureSubscriptionBaseline(target.id);
          await this.store.mutate((state) => {
            this.actions.requireCurrent(claims, state.conversations[key]!);
            if (viewTarget(state, state.conversations[key]!) !== target.id) throw new StaleCardActionError("Subscription view changed.");
            if (state.subscriptions[id]?.enabled) throw new UserError("This source is already subscribed; its baseline was not reset.");
            if (Object.values(state.subscriptions).filter((item) => item.enabled).length >= 8) throw new UserError("The eight-subscription limit was reached.");
            if (!state.subscriptions[id] && Object.keys(state.subscriptions).length >= 64) throw new UserError("The 64-source subscription history limit was reached. No new subscription was saved.");
            const subscription: Subscription = { id, sessionId: target.id, conversationKey: key,
              enabled: true, status: "watching", revision: (state.subscriptions[id]?.revision ?? 0) + 1,
              cursor, detail: "Subscribed from now. Earlier results are not sent." };
            state.subscriptions[id] = subscription;
            state.conversations[key]!.notice = subscription.detail;
            state.conversations[key]!.revision++;
          });
        }
        this.armSubscriptions();
        return;
      }
      case "view": {
        assertFields(data, ["token"]);
        const view = claims.argument;
        if (view !== "home" && !isSessionListView(view) && view !== "dashboard" && view !== "new" && view !== "settings" && view !== "control" && view !== "transcript") {
          throw new UserError("Unknown view.");
        }
        if (isSessionListView(view)) {
          if (view === "sides") {
            if (!canonicalId(claims.targetId) || !this.store.snapshot().sessions[claims.targetId]) throw new UserError("A known parent ID is required.");
            await this.setView(key, view);
            await this.store.mutate((state) => { state.conversations[key]!.sideParentId = claims.targetId!; });
            this.startCatalogueRefresh();
            return;
          }
          await this.showSessions(key, false, false, view);
          return;
        }
        if (view === "home") {
          await this.showHome(key, false);
          return;
        }
        if (view === "transcript") {
          const id = claims.targetId ?? targetId;
          if (!id) throw new UserError("Choose a source with !sessions or !use before reading history.");
          if (id === this.store.snapshot().controllerId) await this.showTranscript(key, id);
          else await this.requestHistory(key, id, 10, receiptIds, !this.options.interaction, Boolean(this.options.interaction));
          return;
        }
        await this.setView(key, view);
        return;
      }
      case "page":
        assertFields(data, ["token"]);
        if (!claims.argument || !/^\d{1,5}$/.test(claims.argument) ||
          (!isSessionListView(claims.view) && !(claims.view === "transcript" && canonicalId(claims.targetId)) &&
            !isSessionListView(conversation.view) && conversation.view !== "settings" && conversation.view !== "transcript")) throw new UserError("Invalid page.");
        if (isSessionListView(claims.view) && conversation.view !== claims.view) await this.setView(key, claims.view);
        if (claims.view === "sides" && canonicalId(claims.targetId)) await this.store.mutate((state) => { state.conversations[key]!.sideParentId = claims.targetId!; });
        if (claims.view === "transcript" && claims.targetId) await this.showTranscript(key, claims.targetId);
        await this.store.mutate((state) => {
          state.conversations[key]!.page = Number(claims.argument);
          if (isSessionListView(claims.view)) state.conversations[key]!.query = claims.query ?? "";
          state.conversations[key]!.revision++;
        });
        return;
      case "filter": {
        assertFields(data, ["token", "query"]);
        const queryInput = data.query ?? "";
        if (typeof queryInput !== "string" || queryInput.length > 100) throw new UserError("Enter a session name of at most 100 characters.");
        const query = queryInput.trim();
        await this.setView(key, isSessionListView(claims.view) ? claims.view : "sessions");
        await this.store.mutate((state) => {
          state.conversations[key]!.query = query;
          state.conversations[key]!.notice = "Search uses the current session list. Refresh to discover new sessions.";
        });
        return;
      }
      case "refresh":
        assertFields(data, ["token"]);
        if (isSessionListView(claims.view)) {
          await this.showSessions(key, false, true, claims.view);
          return;
        }
        if (claims.view === "home") {
          await this.notice(key, "Refreshing the session list. Cached entries are shown while the host responds.");
          this.startCatalogueRefresh();
          return;
        }
        if (targetId) {
          const target = this.store.snapshot().sessions[targetId];
          if ((target?.kind === "owned" || target?.kind === "controller") && target.status !== "offline") {
            await this.refreshSettings(targetId);
          }
        }
        await this.store.mutate((state) => { state.conversations[key]!.revision++; });
        const current = this.store.snapshot().sessions[targetId ?? ""];
        await this.notice(key, (current?.kind === "owned" || current?.kind === "controller") && current.status === "offline"
          ? "Showing retained native history; no runtime was resumed. Open Settings or send a new instruction to the selected working session to reconnect."
          : "Refreshed native state. Idle is not a task-success signal.");
        return;
      case "select":
        assertFields(data, ["token"]);
        if (!canonicalId(claims.targetId)) throw new UserError("A full canonical session ID is required.");
        await this.requestHistory(key, claims.targetId, 10, receiptIds, true);
        return;
      case "create":
        assertFields(data, ["token", "sessionName", "workspace"]);
        if (!string(data.workspace)) throw new UserError("Select an allowed workspace.");
        await this.create(key, sessionName(data.sessionName), data.workspace);
        return;
      case "send": {
        assertFields(data, ["token", "message"]);
        this.actions.requireCurrent(claims, conversation);
        if (claims.view !== "dashboard" || conversation.view !== "dashboard" ||
          !canonicalId(claims.targetId) || claims.targetId !== conversation.selectedId || claims.targetId !== targetId) {
          throw new StaleCardActionError("This send form does not match the current working-session dashboard. Open Current session and use its fresh form.");
        }
        const target = this.store.snapshot().sessions[claims.targetId];
        if (!target || (target.kind !== "owned" && target.kind !== "peer")) {
          throw new UserError("Send requires an available working session, not Control or saved-only history.");
        }
        if (!string(data.message, 64_000) || !data.message.trim()) {
          throw new UserError("Enter a nonblank message of at most 64000 characters. Nothing was sent.");
        }
        if (target.kind === "peer" && Buffer.byteLength(data.message) > 16 * 1024) {
          throw new UserError("Peer messages must fit 16 KiB of UTF-8. The text was not changed or sent.");
        }
        await this.sendWorking(key, claims.targetId, data.message, receiptIds);
        return;
      }
      case "stop":
        assertFields(data, ["token"]);
        if (!targetId || claims.targetId !== targetId) throw new UserError("Stop action does not match the current session.");
        if (this.options.interaction) { await this.requestStop(key, targetId); return; }
        await this.runtime.stop(targetId);
        await this.notice(key, "Stop request acknowledged. History and other sessions are preserved.");
        return;
      case "pick-model": {
        // The current settings form submits its other displayed inputs as well.
        assertFields(data, ["token", "modelKey", "mode", "effort"]);
        if (!targetId || !string(data.modelKey)) throw new UserError("Choose a model from the live catalogue.");
        const models = await this.runtime.models(targetId);
        if (!models.some((item) => item.key === data.modelKey)) throw new UserError("This model is no longer available.");
        this.modelCatalogues.set(targetId, models);
        const modelKey = data.modelKey;
        await this.store.mutate((state) => {
          state.conversations[key]!.modelKey = modelKey;
          state.conversations[key]!.revision++;
        });
        await this.notice(key, "Model capabilities loaded. Nothing has been changed in the working session yet.");
        return;
      }
      case "settings": {
        assertFields(data, ["token", "modelKey", "mode", "effort"]);
        if (!targetId || targetId !== claims.targetId || data.modelKey !== claims.argument ||
          (data.mode !== "interactive" && data.mode !== "plan" && data.mode !== "autopilot") ||
          !string(data.modelKey) || (data.effort !== undefined && !string(data.effort, 100))) {
          throw new UserError("Malformed/stale settings form. Load the selected model's capabilities first.");
        }
        const target = this.store.snapshot().sessions[targetId];
        if (target?.kind !== "owned") throw new UserError("Foreign session settings belong to its owning host.");
        if (target.status === "busy" || target.status === "awaiting") throw new UserError("Session is busy. Settings were rejected; wait for an idle boundary.");
        const actual = await this.runtime.configure(targetId, {
          mode: data.mode, modelKey: data.modelKey,
          ...(data.effort && data.effort !== "__default__" ? { effort: data.effort } : {}),
        });
        await this.store.mutate((state) => {
          state.sessions[targetId]!.settings = actual.actual;
          state.sessions[targetId]!.settingsReceipt = actual;
          state.conversations[key]!.revision++;
        });
        await this.notice(key, `Settings ${actual.status}: ${actual.detail}`);
        return;
      }
      case "answer": {
        if (!targetId || targetId !== claims.targetId || !claims.requestId) throw new UserError("Approval scope does not match the selected session.");
        const target = this.store.snapshot().sessions[targetId]!;
        if (target.kind !== "owned" && target.kind !== "controller") throw new UserError("Peer messages cannot answer human approval requests.");
        const pending = target.pending.find((item) => item.id === claims.requestId);
        if (!pending) throw new UserError("This native request is no longer pending.");
        if (pending.kind === "form") throw new UserError("Structured forms are unavailable here. No response is inferred; use the original native UI.");
        if ((pending.kind === "permission" || pending.kind === "plan") && this.options.interaction?.remoteApprovals === false) {
          throw new UserError("Remote permission/plan approvals are disabled. No approval was sent.");
        }
        if (pending.responseState || pending.expiresAt !== undefined && pending.expiresAt <= Date.now()) {
          throw new StaleCardActionError("This response was already submitted or expired. No response was repeated.");
        }
        const suffix = inputSuffix(pending.id);
        const choiceField = `choice_${suffix}`;
        const textField = `text_${suffix}`;
        assertFields(data, ["token", choiceField, textField]);
        const value = data[choiceField];
        const text = data[textField];
        if (value !== undefined && value !== "" && (typeof value !== "string" || !/^\d{1,4}$/.test(value))) throw new UserError("Malformed choice.");
        if (text !== undefined && (typeof text !== "string" || text.length > 4000)) throw new UserError("Malformed answer.");
        const choice = typeof value === "string" && value !== "" ? Number(value) : undefined;
        if (choice !== undefined && pending.choices[choice] === undefined) throw new UserError("Choice is not part of this native request.");
        const accept = claims.argument === "accept" || pending.kind === "permission" && claims.argument === "session";
        if (!accept && claims.argument !== "decline") throw new UserError("Unknown approval decision.");
        if (accept && pending.kind !== "input" && pending.detailsComplete === false) throw new UserError("Complete approval details are unavailable. Remote Allow is forbidden.");
        if (claims.argument === "session" && !pending.canApproveSession) throw new UserError("This request offers no session-wide approval.");
        if (pending.kind === "input" && accept && choice === undefined && (!pending.allowFreeform || !string(text, 4000))) {
          throw new UserError("Answer using a native choice or permitted freeform text.");
        }
        const answer: Answer = {
          ...(choice === undefined ? {} : { choice }),
          ...(typeof text === "string" ? { text } : {}),
          ...(pending.kind === "input" ? (!accept ? { skip: true } : {}) : { approve: accept }),
          ...(pending.kind === "permission" && this.options.interaction ? {
            permission: claims.argument === "session" ? "session" as const : accept ? "once" as const : "deny" as const,
          } : {}),
        };
        await this.runtime.answer(targetId, pending.id, answer);
        await this.store.mutate((state) => {
          if (this.options.interaction) {
            const current = state.sessions[targetId]!.pending.find((item) => item.id === pending.id);
            if (current) current.responseState = "submitted";
            for (const surface of Object.values(state.interaction!.surfaces)) {
              if (surface.sessionId === targetId && (surface.kind === "header" || surface.requestId === pending.id) && !surface.frozen) {
                surface.revision++; touchSurface(surface, true);
              }
            }
          } else state.sessions[targetId]!.pending = state.sessions[targetId]!.pending.filter((item) => item.id !== pending.id);
          state.conversations[key]!.revision++;
        });
        await this.notice(key, "Response accepted for that exact native request. Waiting for the native completion event.");
        return;
      }
    }
  }

  private async text(key: string, text: string, receiptIds: string[], command?: Command): Promise<void> {
    const conversation = this.store.snapshot().conversations[key]!;
    if (command) {
      switch (command.name) {
        case "help":
          await this.setView(key, conversation.selectedId ? "dashboard" : "home");
          await this.notice(key, "Native chat sends ordinary text unchanged. !sessions · !use <name or ID> · !history [1..50] · !status · !subscribe · !unsubscribe. Advanced: !new, !settings, !working, !needs-reply, !subscriptions.");
          return;
        case "use": {
          await this.store.mutate((state) => {
            state.conversations[key]!.selectionBlocked = true;
            state.conversations[key]!.revision++;
          });
          let matches = this.resolveSource(command.target);
          if (!matches.length) {
            await this.refreshInventory();
            matches = this.resolveSource(command.target);
          }
          if (matches.length !== 1) {
            const detail = matches.length ? `Ambiguous source. Candidates:\n${matches.slice(0, 5).map((item) =>
              `${safeText(item.name, 55)} · ${item.id}`).join("\n")}${matches.length > 5 ? "\nMore matches: use !sessions." : ""}`
              : "No known source matches. Use !sessions, then !use <name or canonical ID>. Nothing was created or resumed.";
            throw new UserError(detail);
          }
          await this.requestHistory(key, matches[0]!.id, 10, receiptIds, true);
          return;
        }
        case "history":
          if (!conversation.selectedId) return this.promptSelection(key);
          if (conversation.selectionBlocked) throw new UserError("Destination unresolved. Choose a valid source with !use before reading history.");
          await this.requestHistory(key, conversation.selectedId, command.count, receiptIds, false);
          return;
        case "subscribe":
        case "unsubscribe": {
          if (!conversation.selectedId) return this.promptSelection(key);
          if (command.name === "subscribe" && conversation.selectionBlocked) throw new UserError("Destination unresolved. Choose a valid source with !use before subscribing.");
          await this.setView(key, "dashboard");
          const current = this.store.snapshot().conversations[key]!;
          if (this.options.interaction) {
            const claims = this.actions.verify(this.actions.issue(current, {
              op: command.name, targetId: current.selectedId!,
            }), current);
            await this.action(key, claims, { token: "internal-fixed-command" }, receiptIds);
            return;
          }
          const subscription = this.store.snapshot().subscriptions[digest(`${key}:${current.selectedId}`)];
          if (command.name === "subscribe" && subscription?.enabled) {
            await this.notice(key, subscription.status === "paused"
              ? `Notifications are paused: ${subscription.detail} The saved cursor was not reset.`
              : "Already subscribed. The saved baseline/cursor was not reset.");
            return;
          }
          if (command.name === "unsubscribe" && !subscription?.enabled) {
            await this.notice(key, "Not subscribed. No source was read or subscription changed.");
            return;
          }
          const claims = this.actions.verify(this.actions.issue(current, {
            op: command.name, targetId: current.selectedId!,
          }), current);
          await this.action(key, claims, { token: "internal-fixed-command" }, receiptIds);
          return;
        }
        case "status":
          if (!conversation.selectedId) return this.promptSelection(key);
          await this.setView(key, "dashboard");
          return;
        case "home":
          await this.showHome(key, true);
          return;
        case "sessions":
        case "working":
        case "needs-reply":
        case "subscriptions":
          await this.showSessions(key, true, false, command.name);
          return;
        case "sides": {
          if (!conversation.selectedId) return this.promptSelection(key);
          const parent = this.store.snapshot().sessions[conversation.selectedId]?.sideChat?.parentId ?? conversation.selectedId;
          await this.showSessions(key, true, false, "sides");
          await this.store.mutate((state) => { state.conversations[key]!.sideParentId = parent; });
          return;
        }
        case "read":
          if (!conversation.selectedId) return this.promptSelection(key);
          await this.showTranscript(key, conversation.selectedId);
          return;
        case "control":
          await this.setView(key, "control");
          if (command.instruction) await this.sendControl(key, command.instruction);
          return;
        case "new":
        case "settings":
          await this.setView(key, command.name);
          return;
        case "stop":
          if (!conversation.selectedId) return this.promptSelection(key);
          if (this.options.interaction) { await this.requestStop(key, conversation.selectedId); return; }
          await this.runtime.stop(conversation.selectedId);
          await this.notice(key, "Stop request acknowledged. Other sessions are unaffected.");
          return;
      }
    }
    if (!conversation.selectedId) {
      await this.promptSelection(key);
      return;
    }
    await this.sendWorking(key, conversation.selectedId, text, receiptIds);
  }

  private resolveSource(selector: string): SessionRecord[] {
    const normalize = (value: string) => value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
    const target = normalize(selector);
    const sessions = Object.values(this.store.snapshot().sessions).filter((item) => item.kind !== "controller");
    const exact = sessions.filter((item) => item.id === target);
    if (exact.length) return exact;
    return sessions.filter((item) => normalize(item.name) === target ||
      /^[0-9a-f]{8}[0-9a-f-]*$/u.test(target) && item.id.startsWith(target));
  }

  private async promptSelection(key: string): Promise<void> {
    await this.showSessions(key, true);
    await this.notice(key, "Choose a source with !sessions or !use <name or ID>. Nothing was forwarded, created or resumed.");
  }

  private async sendControl(key: string, text: string): Promise<void> {
    if (this.activeControlKey) throw new UserError("The owner control session is busy; working sessions remain independently available.");
    const id = this.store.snapshot().controllerId;
    if (!id) throw new Error("Missing controller");
    this.activeControlKey = key;
    try {
      await this.ensureLive(id);
      await this.runtime.send(id, text);
      await this.notice(key, "Control instruction admitted. The controller cannot run shell/file tools.");
    } catch (error) {
      this.activeControlKey = undefined;
      throw error;
    }
  }

  private async sendWorking(key: string, id: string, text: string, receiptIds: string[], origin?: ConversationReference, delivery?: SendOptions): Promise<void> {
    const steering = delivery?.mode === "immediate";
    if (!steering && this.store.snapshot().conversations[key]?.selectionBlocked) {
      throw new UserError("Destination unresolved after an unsuccessful !use. New work is blocked; choose a valid source with !use <canonical ID>. The previous selection was preserved, not used.");
    }
    const target = this.store.snapshot().sessions[id];
    if (!target) throw new UserError("Unknown session ID.");
    if (target.kind === "controller") throw new UserError("Select a working session first. Optional management requires explicit !control <instruction>.");
    if (target.kind === "peer" && Buffer.byteLength(text) > 16 * 1024) throw new UserError("Peer messages must fit 16 KiB of UTF-8. The text was not changed or sent.");
    if (target.access?.send === false) throw new UserError(target.peerSource === "app"
      ? "APP_SESSION_READ_ONLY: this session has no safe live send route. Refresh after opening its original App session with the endpoint extension. Nothing was sent; offline wake and coordinator fallback are unsupported."
      : target.capability);
    if (target.kind === "unavailable" || target.kind === "saved") throw new UserError(target.capability);
    if (target.pending.length) throw new UserError("This session is awaiting a scoped native response. Use its request card, not an ordinary message.");
    await this.ensureLive(id);
    let acknowledge: (() => void) | undefined;
    let gate: Promise<void> | undefined;
    const originId = receiptIds[0]!;
    if (target.peerSource !== "app") {
      await this.store.mutate((state) => {
        const records = Object.values(state.directOrigins);
        if (!steering && records.filter((item) => item.status !== "failed" && !item.answered && !item.parentTurnId).length >= 64) throw new UserError("Too many unconfirmed direct responses. No new task was sent.");
        if (records.length >= 1000) {
          const oldest = records.filter((item) => item.answered || item.status === "failed").sort((a, b) => a.at - b.at)[0];
          if (oldest) delete state.directOrigins[oldest.id];
        }
        state.directOrigins[originId] = { id: originId, sessionId: id, conversationKey: key, status: "admitting", at: Date.now(),
          ...(this.options.interaction ? { reference: structuredClone(origin ?? state.conversations[key]!.reference) } : {}),
          ...(steering && delivery.parentTurnId ? { parentTurnId: delivery.parentTurnId } : {}) };
        if (this.options.interaction) {
          if (steering) {
            const parent = state.interaction?.turns[delivery.parentTurnId ?? ""];
            if (!parent || parent.sessionId !== id || parent.conversationKey !== key || state.interaction?.active[id] !== parent.id) {
              throw new StaleCardActionError("The steering target changed. Nothing was sent.");
            }
            (state.interaction!.steers ??= {})[originId] = {
              id: originId, sessionId: id, conversationKey: key, parentTurnId: parent.id, at: Date.now(), state: "sending",
            };
            touchSurface(state.interaction!.surfaces[parent.surfaceId]!, true);
          } else startTurn(state, key, id, originId, origin);
        }
      });
      gate = new Promise<void>((resolve) => { acknowledge = resolve; });
      this.directAcks.set(id, gate);
    }
    if (this.options.interaction) this.schedule(key);
    if (!gate && this.options.interaction) {
      await this.store.mutate((state) => { startTurn(state, key, id, originId, origin); });
      gate = new Promise<void>((resolve) => { acknowledge = resolve; });
      this.directAcks.set(id, gate);
    }
    let result: Awaited<ReturnType<Runtime["send"]>>;
    let accepted = false;
    try {
      result = await this.runtime.send(id, text, target.peerSource === "app"
        ? (seed) => this.persistAppAdmission(key, id, receiptIds, seed) : undefined, delivery);
      accepted = true;
      if (gate) await this.store.mutate((state) => {
        const origin = state.directOrigins[originId];
        if (origin) { origin.messageId = result.id; origin.status = "accepted"; }
        const turn = state.interaction?.turns[originId];
        if (turn) { turn.messageId = result.id; setTurnState(state, turn, "accepted"); }
        const steer = state.interaction?.steers?.[originId];
        if (steer) {
          steer.messageId = result.id; steer.state = "accepted";
          touchSurface(state.interaction!.surfaces[state.interaction!.turns[steer.parentTurnId]!.surfaceId]!, true);
        }
      });
    } catch (error) {
      if (gate) await this.store.mutate((state) => {
        if (!accepted && state.directOrigins[originId]) state.directOrigins[originId]!.status = "failed";
        const turn = state.interaction?.turns[originId];
        if (turn) setTurnState(state, turn, accepted || error instanceof UncertainOperationError ? "uncertain" : "failed");
        const steer = state.interaction?.steers?.[originId];
        if (steer) {
          steer.state = accepted || error instanceof UncertainOperationError ? "uncertain" : "rejected";
          touchSurface(state.interaction!.surfaces[state.interaction!.turns[steer.parentTurnId]!.surfaceId]!, true);
        }
      });
      if (accepted) throw new UncertainOperationError("Task may be accepted but direct-response binding could not be persisted. No replay was attempted.");
      throw error;
    } finally {
      acknowledge?.();
      if (this.directAcks.get(id) === gate) this.directAcks.delete(id);
    }
    if (this.options.interaction) await this.changeFollow(key, id, "automatic");
    if (result.peer && target.peerSource === "app") {
      if (!this.store.snapshot().admissions[digest(`${id}:${result.id}`)]) {
        throw new UncertainOperationError("App host may have accepted, but no durable admission checkpoint exists. Execution/result are unconfirmed and no task will be replayed.");
      }
      return;
    }
    await this.store.mutate((state) => {
      const session = state.sessions[id]!;
      for (const receiptId of receiptIds) {
        const receipt = state.receipts[receiptId];
        if (receipt) receipt.sessionId = id;
      }
      if (!result.peer && !state.interaction?.turns[originId]?.finishedAt) session.status = "busy";
      const conversation = state.conversations[key]!;
      conversation.read[id] ??= session.sequence;
      conversation.notice = result.peer
        ? "Peer owner accepted the exact message. Acceptance is not Teams delivery or task completion; supported result observation continues in the background. Approvals remain in its owner."
        : steering ? `Steering message ${result.id} accepted. Consumption/completion is not implied; native-origin results keep the original recipient.`
          : `Native message ${result.id} admitted. Work continues independently of the selected view.`;
    });
  }

  private async create(key: string, name: string, workspaceId: string): Promise<string> {
    const workspace = this.options.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new UserError("Workspace is not in the configured allowlist.");
    const id = randomUUID();
    await this.store.mutate((state) => { state.sessions[id] = record(id, safeText(name, 100), workspace.path); });
    try {
      const actual = await this.runtime.create({ id, name, workspace: workspace.path, controller: false });
      await this.store.mutate((state) => {
        const session = state.sessions[id]!;
        session.settings = actual;
        session.status = "idle";
      });
    } catch (error) {
      await this.store.mutate((state) => {
        state.sessions[id]!.capability = "Creation failed or acknowledgement was lost. This canonical ID is retained for safe recovery; no task was sent.";
      });
      throw error;
    }
    await this.select(key, id);
    await this.notice(key, "Persistent native session created. Send a task to begin.");
    return id;
  }

  private async select(key: string, id: string): Promise<void> {
    const target = this.store.snapshot().sessions[id];
    if (!target || target.kind === "controller") throw new UserError("Target is not in the current working-session catalogue.");
    await this.store.mutate((state) => {
      this.supersedeHistory(state, key);
      const conversation = state.conversations[key]!;
      conversation.selectedId = id;
      conversation.selectionBlocked = false;
      conversation.view = "dashboard";
      conversation.page = 0;
      conversation.revision++;
      conversation.read[id] = state.sessions[id]!.sequence;
      delete conversation.modelKey;
      conversation.notice = "View switched. Other sessions were not stopped.";
      if (this.options.interaction) touchSurface(focusHeader(state, key, id), true);
    });
  }

  private async changeFollow(
    key: string, sessionId: string, mode: "automatic" | "explicit" | "muted", claims?: ActionClaims,
  ): Promise<void> {
    const options = this.options.interaction;
    if (!options) throw new UserError("Following is not enabled.");
    const id = digest(`${key}:${sessionId}`);
    const before = this.store.snapshot();
    const previous = before.interaction?.follows[id];
    if (mode === "automatic" && previous?.mode === "explicit") return;
    let cursor: Awaited<ReturnType<Runtime["subscriptionBaseline"]>> | undefined;
    let observation = previous?.observation ?? "unavailable";
    let detail = "Muted. Explicit task replies and pending request cards are not cancelled.";
    let failure: unknown;
    if (mode !== "muted") {
      const source = before.sessions[sessionId];
      if (!source || source.kind === "controller" || source.access?.read === false) {
        failure = new UserError("This source has no readable following route.");
      } else if (before.subscriptions[id]?.enabled) {
        observation = "journal";
        detail = before.subscriptions[id]!.detail;
      } else if (source.peerSource === "app") {
        try {
          if (Object.values(before.subscriptions).filter((entry) => entry.enabled).length >= 8 ||
            !before.subscriptions[id] && Object.keys(before.subscriptions).length >= 64) {
            throw new UserError("Journal following capacity reached; explicit task replies remain enabled.");
          }
          cursor = await this.captureSubscriptionBaseline(sessionId);
          observation = "journal";
          detail = "Following from now. Earlier results are not replayed.";
        } catch (error) {
          failure = error;
        }
      } else if (source.kind === "owned") {
        observation = "live";
        detail = "Live connection only. No durable catch-up or automatic SDK reconnect.";
      } else failure = new UserError("This host has no supported passive observer. Use History; no SDK was started.");
      if (failure) {
        logError("following-unavailable", failure);
        observation = "unavailable";
        detail = publicError(failure);
      }
    }
    await this.store.mutate((state) => {
      if (claims) this.actions.requireCurrent(claims, this.actionConversation(state, key, claims));
      const ui = interactionState(state);
      const existing = ui.follows[id];
      if (mode === "automatic" && existing?.mode === "explicit") return;
      const revision = existing && existing.mode !== "muted" && mode !== "muted" ? existing.revision : (existing?.revision ?? 0) + 1;
      ui.follows[id] = {
        id, conversationKey: key, sessionId, revision, mode, observation, detail,
        ...(mode === "automatic" ? { expiresAt: Date.now() + options.followMs } : {}),
      };
      if (cursor) {
        if (state.subscriptions[id]?.enabled) {
          ui.follows[id]!.detail = state.subscriptions[id]!.detail;
        } else {
          if (Object.values(state.subscriptions).filter((entry) => entry.enabled).length >= 8 ||
            !state.subscriptions[id] && Object.keys(state.subscriptions).length >= 64) {
            ui.follows[id]!.observation = "unavailable";
            ui.follows[id]!.detail = "Following capacity changed. Explicit task replies remain enabled.";
          } else state.subscriptions[id] = {
            id, sessionId, conversationKey: key, revision: (state.subscriptions[id]?.revision ?? 0) + 1,
            enabled: true, status: "watching", cursor, detail,
          };
        }
      }
      if (mode === "muted") {
        const subscription = state.subscriptions[id];
        if (subscription) {
          subscription.enabled = false; subscription.status = "disabled"; subscription.revision++;
          subscription.detail = detail;
        }
        for (const item of state.outbox) if (!item.direct && !item.admissionId && item.status === "pending" &&
          (item.follow?.id === id || item.subscription?.id === id)) {
          item.status = "cancelled"; item.detail = "Muted before passive delivery.";
        }
      }
      state.conversations[key]!.notice = followDescription(state, key, sessionId);
      touchSurface(inbox(state, key), true);
      for (const surface of Object.values(ui.surfaces)) if (surface.conversationKey === key && surface.sessionId === sessionId) {
        touchSurface(surface, true);
      }
    });
    this.armSubscriptions();
    this.armInteractionWake();
    this.schedule(key);
    if (failure && mode === "explicit") throw new UserError(detail);
  }

  private async requestStop(key: string, sessionId: string): Promise<void> {
    await this.store.mutate((state) => {
      const source = state.sessions[sessionId];
      if (source?.kind !== "owned" || source.status === "offline") {
        throw new UserError("Stop requires a live bridge-owned working session. App/foreign sessions remain under their original host.");
      }
      const ui = interactionState(state);
      const active = ui.turns[ui.active[sessionId] ?? ""];
      const surface = newSurface(state, key, "stop", { sessionId,
        ...(active?.conversationKey === key ? { turnId: active.id } : {}) });
      surface.stop = {
        state: "pending", expiresAt: Date.now() + (this.options.actionTtlMs ?? 15 * 60_000),
        ...(active?.messageId ? { messageId: active.messageId } : {}),
      };
      state.conversations[key]!.notice = "Confirm Stop on its separate card. No stop has been sent yet.";
    });
    this.schedule(key);
  }
  private async captureRoute(key: string, prompt: string, receiptId: string, reference: ConversationReference): Promise<void> {
    await this.store.mutate((state) => {
      const ui = interactionState(state);
      const routes = ui.routes ??= {};
      if (Object.values(routes).filter((route) => route.state === "pending" && route.expiresAt > Date.now()).length >= 16) {
        throw new UserError("Sixteen unrouted drafts are pending. Nothing was sent; resolve an existing draft first.");
      }
      const id = digest(`routing:${key}:${receiptId}`);
      if (routes[id]) throw new UserError("This draft was already captured. No action was repeated.");
      const surface = newSurface(state, key, "routing", { routingId: id });
      routes[id] = {
        id, conversationKey: key, surfaceId: surface.id, receiptId, reference: structuredClone(reference), prompt,
        expiresAt: Date.now() + (this.options.actionTtlMs ?? 15 * 60_000), state: "pending",
      };
      const receipt = state.receipts[receiptId]!;
      receipt.operation = "routing"; receipt.status = "applied";
      receipt.detail = "Draft retained without forwarding. Choose a target on its routing card.";
      state.conversations[key]!.notice = "This thread has no verified session binding. Your draft is retained; choose its target before it can be sent.";
      touchSurface(inbox(state, key), true);
    });
  }

  private async sendRoute(key: string, claims: ActionClaims, data: Record<string, unknown>, receiptIds: string[]): Promise<void> {
    assertFields(data, ["token", "source", "target", "workspace", "sessionName"]);
    const snapshot = this.store.snapshot();
    const route = snapshot.interaction?.routes?.[claims.argument ?? ""];
    if (!route || route.conversationKey !== key || snapshot.interaction?.surfaces[claims.surfaceId ?? ""]?.routingId !== route.id ||
      route.state !== "pending" || route.expiresAt <= Date.now()) {
      throw new StaleCardActionError("This routing request expired or was already attempted. It cannot be replayed.");
    }
    let target: string | undefined;
    let name: string | undefined;
    let workspace: string | undefined;
    if (claims.op === "route-send") {
      for (const field of ["source", "target"]) {
        const value = data[field];
        if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 220)) {
          throw new UserError("Choose one known source or enter its exact name/ID.");
        }
      }
      const choice = typeof data.source === "string" ? data.source.trim() : "";
      const typed = typeof data.target === "string" ? data.target.trim() : "";
      if (choice && typed) throw new UserError("Choose a recent source OR type a source, not both. Refresh this routing card to try again.");
      const matches = this.resolveSource(choice || typed);
      if (matches.length !== 1) throw new UserError("Routing target is missing or ambiguous. Nothing was sent; refresh the routing card and select its exact source.");
      const source = matches[0]!;
      if ((source.kind !== "owned" && source.kind !== "peer") || source.access?.send === false ||
        source.peerSource === "app" && (source.access?.read === false || (source.liveUntil ?? 0) <= Date.now())) {
        throw new UserError("This routing target is read-only. Nothing was sent; refresh the card and choose a writable source.");
      }
      if (source.pending.length) throw new UserError("This source needs its exact pending response before another task. Nothing was sent.");
      target = matches[0]!.id;
    } else {
      name = sessionName(data.sessionName);
      if (!string(data.workspace, 50) || !this.options.workspaces.some((item) => item.id === data.workspace)) {
        throw new UserError("Select an allowed workspace. Nothing was created or sent.");
      }
      workspace = data.workspace;
    }
    await this.store.mutate((state) => {
      this.actions.requireCurrent(claims, this.actionConversation(state, key, claims));
      const current = state.interaction!.routes![route.id]!;
      if (current.state !== "pending" || current.expiresAt <= Date.now()) throw new StaleCardActionError("This draft is no longer pending.");
      current.state = "sending";
      const surface = state.interaction!.surfaces[current.surfaceId]!;
      surface.revision++; touchSurface(surface, true);
    });
    try {
      target ??= await this.create(key, name!, workspace!);
      await this.select(key, target);
      await this.store.mutate((state) => { state.interaction!.routes![route.id]!.sessionId = target!; });
      await this.sendWorking(key, target, route.prompt, [route.receiptId, ...receiptIds], route.reference);
      await this.store.mutate((state) => {
        const current = state.interaction!.routes![route.id]!;
        current.state = "sent";
        const receipt = state.receipts[route.receiptId]!;
        receipt.operation = "send"; receipt.status = "accepted";
        receipt.detail = "The original draft was admitted once. Completion and Teams delivery remain separate.";
        const surface = state.interaction!.surfaces[current.surfaceId]!;
        surface.revision++; touchSurface(surface, true);
      });
    } catch (error) {
      const uncertain = error instanceof UncertainOperationError || !(error instanceof UserError);
      await this.store.mutate((state) => {
        const current = state.interaction!.routes![route.id]!;
        current.state = uncertain ? "uncertain" : "rejected";
        const receipt = state.receipts[route.receiptId]!;
        receipt.status = uncertain ? "uncertain" : "failed";
        receipt.detail = safeText(publicError(error), 500);
        const surface = state.interaction!.surfaces[current.surfaceId]!;
        surface.revision++; touchSurface(surface, true);
      });
      if (uncertain && !(error instanceof UncertainOperationError)) {
        logError("routing-admission", error);
        throw new UncertainOperationError("The routing operation may have been accepted. Inspect the original host; it will not be replayed.");
      }
      throw error;
    }
  }

  private async expireRoutes(): Promise<void> {
    const expired = Object.values(this.store.snapshot().interaction?.routes ?? {}).filter((route) =>
      route.state === "pending" && route.expiresAt <= Date.now());
    if (!expired.length) return;
    await this.store.mutate((state) => {
      for (const route of expired) {
        const current = state.interaction!.routes![route.id]!;
        if (current.state !== "pending") continue;
        current.state = "expired";
        state.receipts[current.receiptId]!.detail = "Routing expired. No prompt was sent.";
        const surface = state.interaction!.surfaces[current.surfaceId]!;
        surface.revision++; touchSurface(surface, true);
        touchSurface(inbox(state, current.conversationKey), true);
      }
    });
    for (const route of expired) this.schedule(route.conversationKey);
  }

  private async expireStops(): Promise<void> {
    const expired = Object.values(this.store.snapshot().interaction?.surfaces ?? {}).filter((surface) =>
      surface.kind === "stop" && surface.stop?.state === "pending" && surface.stop.expiresAt <= Date.now());
    if (!expired.length) return;
    await this.store.mutate((state) => {
      for (const previous of expired) {
        const surface = state.interaction!.surfaces[previous.id]!;
        if (surface.stop?.state !== "pending" || surface.stop.expiresAt > Date.now()) continue;
        surface.stop.state = "cancelled"; surface.frozen = "Stop confirmation expired. No stop was sent.";
        surface.revision++; touchSurface(surface, true);
      }
    });
    for (const surface of expired) this.schedule(surface.conversationKey);
  }

  private async expireFollows(): Promise<void> {
    if (!this.options.interaction) return;
    const expired = Object.values(this.store.snapshot().interaction?.follows ?? {}).filter((entry) =>
      entry.mode === "automatic" && entry.expiresAt !== undefined && entry.expiresAt <= Date.now());
    if (!expired.length) return;
    await this.store.mutate((state) => {
      for (const prior of expired) {
        const current = state.interaction?.follows[prior.id];
        if (!current || current.revision !== prior.revision || current.mode !== "automatic" ||
          current.expiresAt === undefined || current.expiresAt > Date.now()) continue;
        current.mode = "muted"; current.revision++;
        current.detail = "Automatic following expired. Explicit task replies remain enabled.";
        const subscription = state.subscriptions[prior.id];
        if (subscription) {
          subscription.enabled = false; subscription.status = "disabled"; subscription.revision++;
          subscription.detail = current.detail;
        }
        for (const item of state.outbox) if (!item.direct && !item.admissionId && item.status === "pending" &&
          (item.follow?.id === prior.id || item.subscription?.id === prior.id)) {
          item.status = "cancelled"; item.detail = current.detail;
        }
        touchSurface(inbox(state, prior.conversationKey), true);
      }
    });
    for (const entry of expired) this.schedule(entry.conversationKey);
  }

  private async showFullResult(key: string, claims: ActionClaims, receiptIds: string[]): Promise<void> {
    await this.store.mutate((state) => {
      this.actions.requireCurrent(claims, this.actionConversation(state, key, claims));
      const item = state.outbox.find((entry) => entry.id === claims.argument && entry.publication);
      if (!item || item.conversationKey !== key || item.sessionId !== claims.targetId) throw new UserError("This result does not belong to this card.");
      if (Buffer.byteLength(item.text) > 128_000) throw new UserError("This full result exceeds the bounded history group. Read it in the original host; no text was truncated.");
      this.supersedeHistory(state, key);
      const id = digest(`full:${key}:${item.id}:${receiptIds[0]}`);
      const chunks = replyChunks(item.text, {
        version: 4, title: item.publication!.title, sourceId: item.sessionId, kind: "history", groupId: id,
        format: newMessageFormat(item.publication!.title + "\n" + item.text) === "plain" ? "xml" : "markdown",
      });
      state.conversations[key]!.historyRead = {
        id, sessionId: item.sessionId, count: 1, receiptIds, status: "queued", readOnlyTarget: true,
      };
      for (const [index, chunk] of chunks.entries()) state.outbox.push({
        id: digest(`history:${key}:${item.sessionId}:${id}:${index}`), conversationKey: key, sessionId: item.sessionId,
        eventId: `history:${id}`, historyId: id, ...chunk, status: "pending",
      });
      for (const receiptId of receiptIds) {
        const receipt = state.receipts[receiptId]!;
        receipt.operation = "history"; receipt.status = "applied";
        receipt.detail = "Full result queued once as read-only history. The next-message target is unchanged.";
      }
    });
  }

  private armInteractionWake(): void {
    if (!this.options.interaction || this.closing) return;
    if (this.interactionTimer) clearTimeout(this.interactionTimer);
    this.interactionTimer = undefined;
    const state = this.store.snapshot();
    const now = Date.now();
    const times = [
      ...Object.values(state.interaction?.surfaces ?? {}).flatMap((surface) =>
        surface.stop?.state === "pending" ? [surface.stop.expiresAt] : []),
      ...Object.values(state.interaction?.routes ?? {}).flatMap((route) => route.state === "pending" ? [route.expiresAt] : []),
      ...Object.values(state.interaction?.follows ?? {}).flatMap((entry) =>
        entry.mode === "automatic" && entry.expiresAt !== undefined ? [entry.expiresAt] : []),
      ...Object.values(state.interaction?.surfaces ?? {}).flatMap((surface) =>
        surface.delivery === "ready" && surface.renderedVersion !== surface.version
          ? [Math.max(surface.retryAt ?? 0, (surface.lastUpdatedAt ?? 0) + this.options.interaction!.statusUpdateMs)] : []),
      ...state.outbox.flatMap((item) => item.status === "pending" && item.publication && !item.direct && !item.admissionId && !item.digestId
        ? [(item.createdAt ?? now) + (this.options.interaction!.digestMs ?? 60_000)] : []),
    ];
    if (!times.length) return;
    const next = times.reduce((earliest, time) => Math.min(earliest, time), Infinity);
    this.interactionTimer = setTimeout(() => {
      this.interactionTimer = undefined;
      for (const key of Object.keys(this.store.snapshot().conversations)) this.schedule(key);
    }, Math.max(10, Math.min(2_000_000_000, next - now)));
    this.interactionTimer.unref();
  }

  private supersedeHistory(state: BridgeState, key: string): boolean {
    const previous = state.conversations[key]!.historyRead;
    if (!previous) return false;
    let superseded = previous.status === "reading";
    for (const item of state.outbox) if (item.historyId === previous.id && item.conversationKey === key && item.status === "pending") {
      item.status = "cancelled";
      item.detail = "History snapshot superseded before delivery. No task or subscription was cancelled.";
      superseded = true;
    }
    if (superseded) for (const receiptId of previous.receiptIds) {
      const receipt = state.receipts[receiptId];
      if (receipt) {
        receipt.status = "failed";
        receipt.detail = `History for ${previous.sessionId} was superseded by a later selection/read. Already sending/sent/uncertain messages cannot be retracted.`;
      }
    }
    delete state.conversations[key]!.historyRead;
    return superseded;
  }

  private currentHistory(key: string, id: string, sessionId: string): boolean {
    const conversation = this.store.snapshot().conversations[key];
    return !this.closing && (conversation?.historyRead?.readOnlyTarget === true ||
      !conversation?.selectionBlocked && conversation?.selectedId === sessionId) &&
      conversation.historyRead?.id === id && conversation.historyRead.sessionId === sessionId &&
      conversation.historyRead.status === "reading";
  }

  private async requestHistory(key: string, sessionId: string, count: number, receiptIds: string[], select: boolean, readOnlyTarget = false): Promise<void> {
    if (select) await this.store.mutate((state) => { state.conversations[key]!.selectionBlocked = true; });
    const target = this.store.snapshot().sessions[sessionId];
    if (!canonicalId(sessionId) || !target || target.kind === "controller") throw new UserError("Choose a known working source with !sessions or !use.");
    if (target.kind === "unavailable" || target.access?.read === false) {
      throw new UserError(`History unavailable for ${sessionId}. Selection was not changed; no source was resumed. ${safeText(target.capability, 500)}`);
    }
    if (!Number.isSafeInteger(count) || count < 1 || count > 50 || !receiptIds[0]) throw new UserError("Use !history [1..50].");
    if (this.historyReads.size >= 2) throw new UserError("Two history reads are still active. Selection was not changed; wait for settlement, then explicitly retry.");
    const id = digest(`${key}:${sessionId}:history:${receiptIds[0]}`);
    const reservation = Symbol(id);
    this.historyReads.add(reservation);
    let started = false;
    try {
      await this.store.mutate((state) => {
        const conversation = state.conversations[key]!;
        if (!select && !readOnlyTarget && conversation.selectedId !== sessionId) throw new UserError("History source changed. Request !history again.");
        const superseded = this.supersedeHistory(state, key);
        if (!readOnlyTarget) conversation.selectedId = sessionId;
        if (select) conversation.selectionBlocked = false;
        conversation.historyRead = { id, sessionId, count, receiptIds, status: "reading", ...(superseded ? { superseded } : {}),
          ...(readOnlyTarget ? { readOnlyTarget: true } : {}) };
        conversation.view = "dashboard";
        conversation.page = 0;
        conversation.revision++;
        conversation.read[sessionId] = state.sessions[sessionId]!.sequence;
        if (this.options.interaction && conversation.selectedId && state.sessions[conversation.selectedId]) {
          touchSurface(focusHeader(state, key, conversation.selectedId), true);
        }
        conversation.notice = `${superseded ? "Previous history superseded. " : ""}${readOnlyTarget ? "Reading" : "Selected"} ${safeText(target.name, 100)}. Reading up to ${count} meaningful messages; no task was sent.${readOnlyTarget ? " Next-message target is unchanged." : ""}`;
        for (const receiptId of receiptIds) {
          const receipt = state.receipts[receiptId];
          if (!receipt || receipt.conversationKey !== key) throw new Error("Missing history intent receipt.");
          receipt.operation = "history";
          receipt.status = "accepted";
          receipt.sessionId = sessionId;
          receipt.detail = "Read-only history requested. Delivery is not yet confirmed.";
        }
      });
      const actual = this.hydrate(sessionId, () => this.currentHistory(key, id, sessionId));
      started = true;
      const release = () => { this.historyReads.delete(reservation); };
      void actual.then(release, release);
      const job = this.observeHistory(key, id, sessionId, count, actual).catch((error: unknown) => {
        this.eventFailure = true;
        logError("history-result-persistence", error);
      });
      this.historyJobs.add(job);
      void job.then(() => this.historyJobs.delete(job));
    } finally {
      if (!started) this.historyReads.delete(reservation);
    }
  }

  private async observeHistory(key: string, id: string, sessionId: string, count: number, actual: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([actual, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new UserError("History read timed out. Its actual read still owns its slot until settlement; no automatic retry.")), this.options.historyReadTimeoutMs ?? 10_000);
      })]);
      if (!this.currentHistory(key, id, sessionId)) return;
      const entries = conversationDialogue(this.transcriptEntries(this.store.snapshot().sessions[sessionId])).slice(-count);
      const bytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0);
      if (bytes > 128_000) throw new UserError("History snapshot exceeds the 128000-byte group budget. Use !history with a smaller count; no body was truncated.");
      const snapshot = this.store.snapshot();
      const title = safeText(sourceTitle(snapshot.sessions[sessionId]!, snapshot.sessions), 440);
      const format = newMessageFormat(title + "\n" + entries.map((entry) => entry.text).join("\n"));
      const text = entries.length
        ? `Latest ${entries.length} available meaningful message(s), requested ${count}. The existing source reader may expose only a bounded window.\n\n` +
          entries.map((entry) => {
            const role = entry.kind === "user" ? "You" : "Copilot";
            return `${format === "plain" ? role : `**${role}**`}\n\n${entry.text}`;
          }).join("\n\n")
        : "No visible dialogue is available in this source's retained/readable window. This does not prove that the original session has no older conversation.";
      await this.store.mutate((state) => {
        const conversation = state.conversations[key]!;
        const intent = conversation.historyRead;
        if ((!intent?.readOnlyTarget && (conversation.selectionBlocked || conversation.selectedId !== sessionId)) || intent?.id !== id ||
          intent.sessionId !== sessionId || intent.status !== "reading") return;
        const chunks = replyChunks(text, { version: 4, kind: "history", title,
          sourceId: sessionId, format: format === "plain" ? "xml" : "markdown", groupId: id });
        for (const [index, chunk] of chunks.entries()) {
          const itemId = digest(`history:${key}:${sessionId}:${id}:${index}`);
          if (!state.outbox.some((item) => item.id === itemId)) state.outbox.push({
            id: itemId, conversationKey: key, sessionId, eventId: `history:${id}`, historyId: id,
            ...chunk, status: "pending",
          });
        }
        intent.status = "queued";
        conversation.notice = `${intent.superseded ? "Previous history was superseded. " : ""}Read-only history snapshot queued. Teams delivery is reported separately.`;
        for (const receiptId of intent.receiptIds) {
          const receipt = state.receipts[receiptId]!;
          receipt.status = "applied";
          receipt.detail = "Read-only history snapshot queued once. No session task was sent; inspect history delivery status separately.";
        }
      });
    } catch (error) {
      if (!this.currentHistory(key, id, sessionId)) return;
      logError("history-read", error);
      const detail = `History for ${sessionId} could not be completed: ${publicError(error)} Use !history for an explicit new request.`;
      const receiptIds = await this.store.mutate((state) => {
        const conversation = state.conversations[key];
        const intent = conversation?.historyRead;
        if (!conversation || (!intent?.readOnlyTarget && (conversation.selectionBlocked || conversation.selectedId !== sessionId)) ||
          intent?.id !== id || intent.sessionId !== sessionId || intent.status !== "reading") return [];
        intent.status = "failed";
        for (const receiptId of intent.receiptIds) {
          state.receipts[receiptId]!.status = "failed";
          state.receipts[receiptId]!.detail = safeText(detail, 500);
        }
        return intent.receiptIds;
      });
      if (receiptIds[0]) await this.reportOperationError(key, receiptIds[0], detail, false, { id, sessionId });
    } finally {
      if (timer) clearTimeout(timer);
      this.schedule(key);
    }
  }

  private async showTranscript(key: string, id: string): Promise<void> {
    if (!canonicalId(id)) throw new UserError("A full canonical session ID is required.");
    if (!this.store.snapshot().sessions[id]) throw new UserError("Target is not in the current session catalogue.");
    await this.hydrate(id);
    await this.setView(key, "transcript", id);
  }

  private async hydrate(id: string, current?: () => boolean): Promise<void> {
    const target = this.store.snapshot().sessions[id];
    if (!target || target.kind === "unavailable") return;
    if (target.access?.read === false) throw new UserError("APP_HISTORY_UNAVAILABLE: this session has metadata but no readable local root journal. No session was resumed.");
    if ((target.kind === "owned" || target.kind === "controller") && target.status === "offline") return;
    if (target.kind === "controller" && !target.settings) return;
    if (target.kind === "peer") {
      await this.runtime.watchPeer(target);
    }
    const before = new Map(target.timeline.map((entry) => [entry.id, JSON.stringify(entry)]));
    const history = await this.runtime.history(id);
    if (current && !current()) return;
    const reconstructed: SessionRecord = { ...target, timeline: [], pending: [], seenEvents: [], sequence: 0 };
    const projector = new Projector(Number.MAX_SAFE_INTEGER);
    for (const event of history) projector.apply(reconstructed, event, true);
    const entries = await this.store.mutate((state) => {
      if (current && !current()) return undefined;
      const session = state.sessions[id]!;
      const merged = new Map(reconstructed.timeline.map((entry) => [entry.id, entry]));
      rememberConversation(session, reconstructed.lastConversationAt);
      for (const entry of session.timeline) {
        if (!merged.has(entry.id) || before.get(entry.id) !== JSON.stringify(entry)) merged.set(entry.id, entry);
      }
      const timeline = chronologicalTimeline([...merged.values()]);
      session.timeline = timeline.slice(-160);
      // History must not consume live callback IDs, establish busy/idle or grant approvals.
      return timeline;
    });
    if (!entries) return;
    this.transcripts.set(id, entries);
    await this.reconcileAppAdmissions(id);
  }

  private async refreshInventory(): Promise<void> {
    const controllerId = this.store.snapshot().controllerId;
    if (!controllerId) return;
    const inventory = await this.runtime.inventory(controllerId);
    await this.applyInventory(inventory);
  }

  private async applyInventory(inventory: Awaited<ReturnType<Runtime["inventory"]>>): Promise<void> {
    await this.store.mutate((state) => {
      for (const item of inventory) {
        const previous = state.sessions[item.id];
        if (previous?.kind === "owned" || previous?.kind === "controller") continue;
        state.sessions[item.id] = {
          ...(previous ?? record(item.id, item.name, item.workspace)), ...item,
          updatedAt: previous?.updatedAt ?? Date.now(),
          ...(item.modelId ? { peerModelId: item.modelId } : {}),
        };
        // Foreign mode is not reported by native management; never invent it.
        if (item.kind === "peer") delete state.sessions[item.id]!.settings;
        if (item.peerSource !== "app") delete state.sessions[item.id]!.peerSource;
        if (!item.access) delete state.sessions[item.id]!.access;
        if (item.liveUntil === undefined) delete state.sessions[item.id]!.liveUntil;
        rememberConversation(state.sessions[item.id]!, previous?.lastConversationAt);
      }
      for (const existing of Object.values(state.sessions)) {
        if (existing.kind === "peer" && !inventory.some((item) => item.id === existing.id && item.kind === "peer")) {
          existing.status = "offline";
          if (existing.peerSource === "app") {
            existing.access = { read: false, send: false };
            delete existing.liveUntil;
            existing.capability = "App session is no longer in the local directory. Refresh after restoring the original profile; no wake, takeover or coordinator fallback is attempted.";
          } else existing.capability = "Native peer is no longer discoverable; no attach/resume fallback is attempted.";
        }
      }
    });
  }

  private async refreshSettings(id: string): Promise<void> {
    const actual = await this.runtime.settings(id);
    await this.store.mutate((state) => {
      const target = state.sessions[id]!;
      target.settings = actual;
      const receipt = target.settingsReceipt;
      if (receipt) {
        receipt.actual = actual;
        if ((receipt.status === "queued" || receipt.status === "accepted") && receipt.expected && sameSettings(actual, receipt.expected)) {
          receipt.status = "applied";
          receipt.detail = "Native setting-change event received and effective values read back.";
        }
      }
    });
  }

  private async applyEvent(incoming: RuntimeEvent): Promise<void> {
    if (this.closing) return;
    await this.directAcks.get(incoming.sessionId);
    let settledAdmissionId: string | undefined;
    const changed = await this.store.mutate((state) => {
      const session = state.sessions[incoming.sessionId];
      if (!session) return false;
      const admission = incoming.admissionId ? state.admissions[incoming.admissionId] : undefined;
      if (incoming.admissionId && (!admission || admission.sessionId !== session.id || !object(incoming.event) ||
        !object(incoming.event.data) ||
        (incoming.event.type === "assistant.message"
          ? incoming.event.data.originatingMessageId !== admission.messageId
          : incoming.event.data.messageId !== admission.messageId))) return false;
      if (admission?.phase === "confirmed" && object(incoming.event) &&
        incoming.event.type === "bridge.app_output_unavailable") {
        settledAdmissionId = admission.id;
        return false;
      }
      const result = this.projector.apply(session, incoming.event, incoming.historical);
      if (this.options.interaction && !incoming.historical && object(incoming.event) && incoming.event.type === "session.error" &&
        !incoming.event.agentId) {
        result.final = { id: `error:${incoming.event.id}`, text: "The source reported an error. Inspect its original host for details. No task was retried." };
      }
      if (result.final && object(incoming.event) && object(incoming.event.data) && typeof incoming.event.data.sourceResultKey === "string") {
        const sourceResultKey = incoming.event.data.sourceResultKey;
        const existing = state.outbox.find((item) => item.sessionId === session.id && item.sourceResultKey === sourceResultKey);
        if (existing) result.final.id = existing.eventId;
      }
      let admissionChanged = false;
      if (admission && object(incoming.event) && object(incoming.event.data)) {
        const data = incoming.event.data;
        const index = typeof data.index === "number" && Number.isSafeInteger(data.index) && data.index > admission.baselineIndex
          ? data.index : undefined;
        if (incoming.event.type === "bridge.app_admission_consumed" && index !== undefined && admission.executionIndex === undefined) {
          admission.executionIndex = index;
          if (admission.phase !== "confirmed") admission.phase = "executing";
          admissionChanged = true;
        }
        if (result.final && incoming.event.type === "assistant.message" && !admission.resultIds.includes(result.final.id)) {
          admission.resultIds.push(result.final.id);
          admissionChanged = true;
        }
        if (incoming.event.type === "bridge.app_admission_confirmed" && index !== undefined &&
          admission.resultIds.length && admission.phase !== "confirmed") {
          admission.phase = "confirmed";
          admission.completionIndex = index;
          admission.observation = "settled";
          admissionChanged = true;
        }
        if (incoming.event.type === "bridge.app_output_unavailable" && admission.phase !== "confirmed") {
          const observation = data.code === "APP_OUTPUT_TIMEOUT" ? "timed_out" : "failed";
          if (admission.observation !== observation) { admission.observation = observation; admissionChanged = true; }
        }
        if (admissionChanged) {
          admission.checkedAt = Date.now();
          for (const id of admission.receiptIds) {
            const receipt = state.receipts[id];
            if (receipt) receipt.detail = appAdmissionNotice(admission);
          }
          const conversation = state.conversations[admission.conversationKey];
          const latest = Object.values(state.admissions).filter((item) =>
            item.conversationKey === admission.conversationKey && item.sessionId === session.id)
            .sort((a, b) => b.acceptedAt - a.acceptedAt || a.id.localeCompare(b.id))[0];
          if (conversation?.selectedId === session.id && latest?.id === admission.id) conversation.notice = appAdmissionNotice(admission);
        }
        if (admission.phase === "confirmed") settledAdmissionId = admission.id;
      }
      if (this.options.interaction && result.newEvent) observeInteraction(state, incoming);
      if (!result.changed && !admissionChanged) return false;
      for (const conversation of Object.values(state.conversations)) {
        const viewing = viewTarget(state, conversation) === session.id;
        if (viewing) {
          conversation.read[session.id] = session.sequence;
          if (result.requestChanged) conversation.revision++;
        }
        const nativeOrigin = object(incoming.event) && object(incoming.event.data) ? incoming.event.data.originatingMessageId : undefined;
        const direct = typeof nativeOrigin === "string" && Object.values(state.directOrigins).find((item) =>
          item.sessionId === session.id && item.conversationKey === conversation.key && item.status === "accepted" && item.messageId === nativeOrigin);
        const receives = admission ? admission.conversationKey === conversation.key :
          session.kind === "controller" ? this.activeControlKey === conversation.key : Boolean(direct);
        const passive = this.options.interaction && session.kind === "owned"
          ? follows(state, conversation.key, session.id) : undefined;
        if ((receives || passive?.observation === "live") && result.final && !incoming.historical) {
          if (direct) direct.answered = true;
          this.enqueueFinal(state, conversation.key, session.id, result.final, {
            direct: receives, ...(admission ? { admissionId: admission.id } : {}),
            ...(!receives && passive ? { follow: { id: passive.id, revision: passive.revision } } : {}),
            ...(typeof nativeOrigin === "string" ? { originatingMessageId: nativeOrigin } : {}),
            ...(object(incoming.event) && object(incoming.event.data) && typeof incoming.event.data.sourceResultKey === "string"
              ? { sourceResultKey: incoming.event.data.sourceResultKey } : {}),
          });
        }
      }
      return true;
    });
    if (settledAdmissionId) this.runtime.settleAdmission(settledAdmissionId);
    if (!changed) return;
    if (object(incoming.event) && (incoming.event.type === "session.model_change" || incoming.event.type === "session.mode_changed" || incoming.event.type === "exit_plan_mode.completed")) {
      const session = this.store.snapshot().sessions[incoming.sessionId];
      if (session?.kind === "owned" || session?.kind === "controller") await this.refreshSettings(session.id);
    }
    if (object(incoming.event) && incoming.event.type === "session.idle" && incoming.sessionId === this.store.snapshot().controllerId) {
      this.activeControlKey = undefined;
    }
    for (const conversation of Object.values(this.store.snapshot().conversations)) this.schedule(conversation.key);
  }

  private enqueueFinal(state: BridgeState, key: string, sessionId: string, final: { id: string; text: string },
    claim: { direct: boolean; admissionId?: string; originatingMessageId?: string; sourceResultKey?: string; subscription?: { id: string; revision: number }; follow?: { id: string; revision: number } }): void {
    const session = state.sessions[sessionId];
    const conversation = state.conversations[key];
    if (!session || !conversation) throw new Error("Missing canonical final destination.");
    const existing = state.outbox.filter((item) => !item.historyId && item.conversationKey === key && item.sessionId === sessionId &&
      (item.eventId === final.id || claim.sourceResultKey !== undefined && item.sourceResultKey === claim.sourceResultKey));
    if (existing.length) {
      for (const item of existing) {
        if (claim.direct) {
          if (item.digestId) this.releasePendingDigest(state, item.digestId);
          item.direct = true;
          if (claim.admissionId) item.admissionId = claim.admissionId;
          if (item.status === "cancelled") item.status = "pending";
        }
      }
      return;
    }
    if (this.options.interaction && session.kind !== "controller") {
      const id = digest(`${key}:${sessionId}:${final.id}:0`);
      const origin = claim.originatingMessageId ?? (claim.admissionId ? state.admissions[claim.admissionId]?.messageId : undefined);
      const turn = turnForOrigin(state, sessionId, origin);
      const directOrigin = Object.values(state.directOrigins).find((entry) =>
        entry.sessionId === sessionId && entry.conversationKey === key && entry.messageId === origin && entry.status === "accepted");
      const reference = turn?.reference ?? directOrigin?.reference ??
        (claim.admissionId ? state.admissions[claim.admissionId]?.reference : undefined);
      const surface = newSurface(state, key, "result", { sessionId, outboxId: id, ...(turn ? { turnId: turn.id } : {}) });
      state.outbox.push({
        id, conversationKey: key, sessionId, eventId: final.id, text: final.text,
        status: "pending", createdAt: Date.now(), ...claim,
        publication: { version: 1, title: safeText(sourceTitle(session, state.sessions), 440), surfaceId: surface.id,
          ...(turn || directOrigin?.parentTurnId ? { taskReceiptId: turn?.id ?? directOrigin!.parentTurnId! } : {}) },
        ...(claim.direct && reference ? { originReference: structuredClone(reference) } : {}),
      });
      return;
    }
    const chunks = replyChunks(final.text, { version: 4, title: safeText(sourceTitle(session, state.sessions), 440),
      kind: session.kind === "controller" ? "control" : conversation.selectedId === sessionId ? "session" : "background",
      sourceId: sessionId, format: newMessageFormat(sourceTitle(session, state.sessions) + "\n" + final.text) === "plain" ? "xml" : "markdown",
      groupId: digest(`${key}:${sessionId}:${final.id}`) });
    for (const [index, chunk] of chunks.entries()) state.outbox.push({
      id: digest(`${key}:${sessionId}:${final.id}:${index}`), conversationKey: key, sessionId, eventId: final.id,
      ...chunk, status: "pending", ...claim,
    });
  }

  private armSubscriptions(): void {
    const active = Object.values(this.store.snapshot().subscriptions).some((item) => item.enabled && item.status === "watching");
    if (!active && this.subscriptionTimer) { clearInterval(this.subscriptionTimer); this.subscriptionTimer = undefined; }
    if (!active || this.subscriptionTimer || this.closing) return;
    this.subscriptionTimer = setInterval(() => {
      void this.checkSubscriptions().catch((error: unknown) => {
        this.eventFailure = true;
        logError("subscription-persistence", error);
      });
    }, this.options.subscriptionPollMs ?? 5000);
    this.subscriptionTimer.unref();
  }

  private async captureSubscriptionBaseline(id: string): Promise<Awaited<ReturnType<Runtime["subscriptionBaseline"]>>> {
    if (this.baselineReads.has(id)) throw new UserError("SUBSCRIPTION_BASELINE_IN_PROGRESS: an earlier capture is still pending. Nothing was subscribed; retry after it settles for a fresh from-now baseline.");
    if (this.baselineReads.size >= 2) throw new UserError("SUBSCRIPTION_BASELINE_LIMIT: two baseline reads are still in flight.");
    const read = this.runtime.subscriptionBaseline(id);
    this.baselineReads.set(id, read);
    const clear = () => { if (this.baselineReads.get(id) === read) this.baselineReads.delete(id); };
    void read.then(clear, clear);
    let deadline: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([read, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new UserError("SUBSCRIPTION_BASELINE_TIMEOUT: nothing was subscribed.")), this.options.subscriptionBaselineTimeoutMs ?? 30_000);
      })]);
    } finally { if (deadline) clearTimeout(deadline); }
  }

  async checkSubscriptions(): Promise<void> {
    if (this.subscriptionCheck) return this.subscriptionCheck;
    const run = async () => {
      await this.expireFollows();
      const subscriptions = Object.values(this.store.snapshot().subscriptions).filter((item) => item.enabled && item.status === "watching");
      for (let offset = 0; offset < subscriptions.length && !this.closing; offset += 2) {
        await Promise.all(subscriptions.slice(offset, offset + 2).map(async (subscription) => {
          const cursorKey = digest(JSON.stringify(subscription.cursor));
          const readKey = `${subscription.id}:${subscription.revision}:${cursorKey}`;
          const matches = (current: Subscription | undefined) => current?.enabled && current.status === "watching" &&
            current.revision === subscription.revision && current.sessionId === subscription.sessionId &&
            current.conversationKey === subscription.conversationKey && digest(JSON.stringify(current.cursor)) === cursorKey;
          let page: Awaited<ReturnType<Runtime["subscriptionRead"]>>;
          let deadline: NodeJS.Timeout | undefined;
          try {
            let read = this.subscriptionReads.get(readKey);
            if (!read) {
              if (this.subscriptionReads.size >= 2) throw new UserError("SUBSCRIPTION_READ_LIMIT: two actual reads are still in flight.");
              read = {
                revision: subscription.revision, cursorKey,
                promise: this.runtime.subscriptionRead(subscription.sessionId, structuredClone(subscription.cursor)),
              };
              this.subscriptionReads.set(readKey, read);
              const clear = () => { if (this.subscriptionReads.get(readKey) === read) this.subscriptionReads.delete(readKey); };
              void read.promise.then(clear, clear);
            }
            page = await Promise.race([read.promise, new Promise<never>((_resolve, reject) => {
              deadline = setTimeout(() => reject(new UserError("SUBSCRIPTION_READ_TIMEOUT: source status is unconfirmed.")), this.options.subscriptionReadTimeoutMs ?? 2000);
            })]);
          } catch (error) {
            logError("subscription-source", error);
            await this.store.mutate((state) => {
              const current = state.subscriptions[subscription.id];
              if (!current || !matches(current)) return;
              current.status = "paused";
              current.detail = `Subscription paused: ${publicError(error)} No history was replayed; unsubscribe and explicitly subscribe again after inspection.`;
              const conversation = state.conversations[current.conversationKey];
              if (conversation) conversation.notice = current.detail;
            });
            this.schedule(subscription.conversationKey);
            return;
          } finally { if (deadline) clearTimeout(deadline); }
          if (this.closing) return;
          await this.directAcks.get(subscription.sessionId);
          await this.store.mutate((state) => {
            const current = state.subscriptions[subscription.id];
            const session = state.sessions[subscription.sessionId];
            if (!current || !matches(current) || !session) return;
            const projector = new Projector();
            for (const event of page.events) {
              if (!object(event) || event.type !== "assistant.message" || !object(event.data) ||
                !string(event.data.messageId, 512) || event.agentId || event.data.parentToolCallId) continue;
              const data = event.data;
              projector.apply(session, { ...event, id: `subscription-history:${event.id}` }, true);
              const entry = session.timeline.find((item) => item.id === `message:${data.messageId}`);
              if (!entry || entry.kind !== "assistant" || entry.phase !== "final") continue;
              const origin = typeof event.data.originatingMessageId === "string" ? event.data.originatingMessageId : undefined;
              const admission = Object.values(state.admissions).find((item) => item.sessionId === session.id &&
                item.conversationKey === current.conversationKey && item.messageId === origin);
              const direct = admission !== undefined || Object.values(state.directOrigins).some((item) =>
                item.sessionId === session.id && item.conversationKey === current.conversationKey && item.status === "accepted" && item.messageId === origin);
              this.enqueueFinal(state, current.conversationKey, session.id, { id: event.data.messageId, text: entry.text }, {
                direct, subscription: { id: current.id, revision: current.revision },
                ...(origin ? { originatingMessageId: origin } : {}), ...(admission ? { admissionId: admission.id } : {}),
                ...(typeof data.sourceResultKey === "string" ? { sourceResultKey: data.sourceResultKey } : {}),
              });
            }
            current.cursor = page.cursor;
          });
          this.schedule(subscription.conversationKey);
        }));
      }
      this.armSubscriptions();
    };
    const operation = run();
    this.subscriptionCheck = operation;
    try { await operation; } finally { if (this.subscriptionCheck === operation) this.subscriptionCheck = undefined; }
  }

  private schedule(key: string): void {
    if (this.closing) return;
    this.dirty.add(key);
    if (!this.deliveryEnabled) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.delivery = this.delivery.then(() => this.deliver()).catch((error: unknown) => {
        logError("proactive-flush", error);
        this.eventFailure = true;
      });
    }, this.options.coalesceMs);
    this.timer.unref();
  }

  private passiveEligible(state: BridgeState, item: OutboxItem): boolean {
    if (item.direct || item.admissionId) return true;
    if (item.follow) {
      const current = follows(state, item.conversationKey, item.sessionId);
      if (!current || current.id !== item.follow.id || current.revision !== item.follow.revision) return false;
    }
    if (item.subscription) {
      const current = state.subscriptions[item.subscription.id];
      if (!current?.enabled || current.revision !== item.subscription.revision) return false;
    }
    return true;
  }

  private releasePendingDigest(state: BridgeState, id: string): void {
    const digestItem = state.outbox.find((entry) => entry.id === id);
    if (!digestItem?.digest || digestItem.status !== "pending") return;
    digestItem.status = "cancelled";
    digestItem.detail = "Unclaimed digest membership changed; no send was attempted.";
    for (const memberId of digestItem.digest.memberIds) {
      const member = state.outbox.find((entry) => entry.id === memberId);
      if (member?.status === "pending") delete member.digestId;
    }
  }

  private async prepareDigests(key: string): Promise<void> {
    await this.store.mutate((state) => {
      let candidates = state.outbox.filter((item) => item.conversationKey === key && item.status === "pending" &&
        item.publication && !item.direct && !item.admissionId && !item.digestId && this.passiveEligible(state, item))
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      while (candidates.length) {
        const first = candidates[0]!;
        const boundary = (first.createdAt ?? 0) + (this.options.interaction?.digestMs ?? 60_000);
        const window = candidates.filter((item) => (item.createdAt ?? 0) <= boundary);
        const groups = new Map<string, OutboxItem[]>();
        for (const item of window) {
          const group = groups.get(item.sessionId) ?? [];
          group.push(item); groups.set(item.sessionId, group);
        }
        if (groups.size < 3) { candidates = candidates.filter((item) => (item.createdAt ?? 0) > boundary); continue; }
        const members: OutboxItem[] = [];
        const selected = [...groups.values()].slice(0, 64);
        for (let round = 0; members.length < 64; round++) {
          let found = false;
          for (const group of selected) {
            const item = group[round];
            if (item) { members.push(item); found = true; }
            if (members.length === 64) break;
          }
          if (!found) break;
        }
        const ids = new Set(members.map((item) => item.id));
        candidates = candidates.filter((item) => !ids.has(item.id));
        const id = digest(`digest:${key}:${members.map((item) => item.id).join(":")}`);
        if (state.outbox.some((item) => item.id === id)) continue;
        const surface = newSurface(state, key, "digest", { outboxId: id });
        state.outbox.push({
          id, conversationKey: key, sessionId: first.sessionId, eventId: `digest:${id}`,
          text: "Followed sessions have new replies.", status: "pending", createdAt: Date.now(),
          digest: { version: 1, memberIds: members.map((item) => item.id), surfaceId: surface.id },
        });
        for (const member of members) member.digestId = id;
      }
    });
  }

  private async deliverInteractionSurfaces(key: string): Promise<void> {
    const options = this.options.interaction;
    if (!options) return;
    const state = this.store.snapshot();
    const surfaces = Object.values(state.interaction?.surfaces ?? {}).filter((surface) =>
      surface.conversationKey === key && surface.renderedVersion !== surface.version &&
      (surface.delivery === "ready" || surface.delivery === "pending" && surface.kind !== "result" && surface.kind !== "digest") &&
      (!surface.frozen || surface.activityId));
    for (const surface of surfaces) {
      if ((surface.retryAt ?? 0) > Date.now() ||
        surface.activityId && !surface.urgent && Date.now() < (surface.lastUpdatedAt ?? 0) + options.statusUpdateMs) continue;
      const snapshot = this.store.snapshot();
      const current = snapshot.interaction?.surfaces[surface.id];
      if (!current || current.delivery !== surface.delivery || current.renderedVersion === current.version) continue;
      const reference = snapshot.interaction?.turns[current.turnId ?? ""]?.reference ??
        snapshot.interaction?.routes?.[current.routingId ?? ""]?.reference ?? snapshot.conversations[key]!.reference;
      const body = renderInteractionSurface(snapshot, current, this.cards);
      if (Buffer.byteLength(JSON.stringify(body)) > 27_000) {
        await this.notice(key, "A detailed interaction card exceeds Teams' size limit. Use !status or !history; no action was approved.");
        await this.store.mutate((draft) => { draft.interaction!.surfaces[current.id]!.delivery = "rejected"; });
        continue;
      }
      if (!current.activityId) await this.store.mutate((draft) => { draft.interaction!.surfaces[current.id]!.delivery = "sending"; });
      try {
        const activityId = current.activityId;
        const sentId = activityId ? (await this.transport.update(reference, activityId, body), activityId)
          : await this.transport.send(reference, { type: "card", card: body,
            summary: current.kind === "request" ? `${snapshot.sessions[current.sessionId ?? ""]?.name ?? "Copilot"} needs your response.`
              : current.kind === "turn" ? "Copilot task receipt - acceptance and progress are separate." : "Copilot Sessions Inbox" });
        await this.store.mutate((draft) => {
          const saved = draft.interaction!.surfaces[current.id]!;
          saved.activityId = sentId; saved.delivery = "ready";
          saved.renderedVersion = current.version; saved.lastUpdatedAt = Date.now();
          saved.urgent = saved.version !== current.version && saved.urgent;
          delete saved.retryAt;
        });
      } catch (error) {
        logError("interaction-card-delivery", error);
        const status = object(error) ? error.statusCode ?? error.status ?? (object(error.response) ? error.response.status : undefined) : undefined;
        let retry = options.statusUpdateMs;
        if (status === 429 && object(error) && object(error.response)) {
          const headers = error.response.headers;
          const value = headers instanceof Headers ? headers.get("retry-after")
            : object(headers) ? headers["retry-after"] : undefined;
          if (typeof value === "string") {
            const seconds = Number(value);
            const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
            if (Number.isFinite(delay) && delay > 0) retry = Math.max(retry, Math.min(2_000_000_000, delay));
          }
        }
        await this.store.mutate((draft) => {
          const saved = draft.interaction!.surfaces[current.id]!;
          if (current.activityId && status === 429) {
            saved.delivery = "ready"; saved.retryAt = Date.now() + retry; saved.urgent = false;
          } else if (current.activityId && status === 404 && !current.frozen &&
            current.kind !== "result" && current.kind !== "digest") {
            delete saved.activityId; saved.delivery = "pending"; saved.revision++; saved.version++; saved.urgent = true;
            this.schedule(key);
          } else {
            saved.delivery = error instanceof DeliveryError && error.outcome !== "uncertain" ? "rejected" : "uncertain";
            draft.conversations[key]!.notice = "Interaction card delivery is unconfirmed. Use !status/!home; no prompt or response was replayed.";
          }
        });
      }
    }
  }

  private async deliver(): Promise<void> {
    if (!this.deliveryEnabled) return;
    await this.expireFollows();
    await this.expireRoutes();
    await this.expireStops();
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const key of keys) {
      const conversation = this.store.snapshot().conversations[key];
      if (!conversation) continue;
      if (this.options.interaction) await this.prepareDigests(key);
      for (const item of this.store.snapshot().outbox.filter((entry) => entry.conversationKey === key && entry.status === "pending" && !entry.digestId)) {
        const surfaceId = item.publication?.surfaceId ?? item.digest?.surfaceId;
        const snapshot = this.store.snapshot();
        const surface = surfaceId ? snapshot.interaction?.surfaces[surfaceId] : undefined;
        if (surfaceId && !surface) throw new Error("Missing persisted result surface.");
        const message: Outbound = surface ? {
          type: "card", card: renderInteractionSurface(snapshot, surface, this.cards),
          summary: item.digest ? "Followed Copilot sessions have new replies." : `Copilot reply - ${item.publication!.title}`,
        } : { type: "text", text: item.text, ...(item.presentation ? { presentation: item.presentation } : {}) };
        if (message.type === "card" && Buffer.byteLength(JSON.stringify(outboundActivity(message))) > 27_000) {
          logError("outbox-card-budget", new UserError("Signed card exceeds the outbound payload budget."));
          await this.store.mutate((state) => {
            const current = state.outbox.find((entry) => entry.id === item.id)!;
            if (current.status !== "pending") return;
            if (current.digest) this.releasePendingDigest(state, current.id);
            current.status = "rejected"; current.detail = "Local payload budget rejection; no transport call was made.";
            if (surfaceId) state.interaction!.surfaces[surfaceId]!.delivery = "rejected";
            state.conversations[key]!.notice = current.digest
              ? "Digest exceeded the payload budget. Its unclaimed notifications remain queued for individual delivery."
              : "Result card exceeds the payload budget. The source result remains available through History; no work was replayed.";
          });
          this.schedule(key);
          continue;
        }
        const claimed = await this.store.mutate((state) => {
          const current = state.outbox.find((entry) => entry.id === item.id)!;
          if (current.status !== "pending") return false;
          if (current.digest) {
            const members = current.digest.memberIds.map((id) => state.outbox.find((entry) => entry.id === id));
            if (members.some((member) => !member || member.status !== "pending" || member.direct || member.admissionId || !this.passiveEligible(state, member))) {
              this.releasePendingDigest(state, current.id);
              this.schedule(key);
              return false;
            }
            for (const member of members) member!.status = "sending";
          } else if (current.publication && !current.direct && !current.admissionId &&
            Date.now() < (current.createdAt ?? 0) + (this.options.interaction?.digestMs ?? 60_000)) return false;
          if (current.historyId) {
            const conversation = state.conversations[key]!;
            if (conversation.historyRead?.id !== current.historyId ||
              !conversation.historyRead.readOnlyTarget && (conversation.selectionBlocked || conversation.selectedId !== current.sessionId)) {
              current.status = "cancelled";
              current.detail = "History source/read was superseded before delivery. No task or subscription was cancelled.";
              return false;
            }
          }
          if (current.subscription && !current.direct && !current.admissionId) {
            const subscription = state.subscriptions[current.subscription.id];
            if (!subscription?.enabled || subscription.revision !== current.subscription.revision) {
              current.status = "cancelled"; current.detail = "Subscription ended before notification claim.";
              return false;
            }
          }
          if (current.follow && !current.direct && !current.admissionId && !this.passiveEligible(state, current)) {
            current.status = "cancelled"; current.detail = "Following ended before notification claim.";
            return false;
          }
          current.status = "sending";
          return true;
        });
        if (!claimed) continue;
        try {
          const claimedItem = this.store.snapshot().outbox.find((entry) => entry.id === item.id)!;
          const activityId = await this.transport.send(claimedItem.originReference ?? conversation.reference, message);
          await this.store.mutate((state) => {
            const current = state.outbox.find((entry) => entry.id === item.id)!;
            current.status = "sent";
            current.activityId = activityId;
            if (current.digest) for (const id of current.digest.memberIds) {
              const member = state.outbox.find((entry) => entry.id === id)!;
              member.status = "sent"; member.activityId = activityId;
            }
            if (surface) {
              const saved = state.interaction!.surfaces[surface.id]!;
              saved.activityId = activityId; saved.delivery = "ready"; saved.renderedVersion = surface.version;
              saved.lastUpdatedAt = Date.now(); saved.urgent = saved.version !== surface.version && saved.urgent;
            }
          });
          console.log(JSON.stringify({
            area: item.historyId ? "teams-history-delivery" : "teams-final-delivery", outcome: "sent", outboxId: item.id, messageId: safeText(activityId, 2048),
          }));
        } catch (error) {
          logError("proactive-final", error);
          const rejected = error instanceof DeliveryError && error.outcome !== "uncertain";
          console.error(JSON.stringify({
            area: item.historyId ? "teams-history-delivery" : "teams-final-delivery", outcome: rejected ? "rejected" : "uncertain", outboxId: item.id,
            code: error instanceof DeliveryError ? error.code : "TRANSPORT_ERROR",
          }));
          await this.store.mutate((state) => {
            for (const entry of state.outbox) {
              if (entry.conversationKey === key && entry.sessionId === item.sessionId && entry.eventId === item.eventId &&
                entry.historyId === item.historyId && (entry.status === "pending" || entry.status === "sending")) {
                entry.status = rejected ? "rejected" : "uncertain";
                entry.detail = rejected ? `Definite delivery rejection: ${error.code}.` : "Delivery outcome is uncertain.";
              }
            }
            if (item.digest) for (const id of item.digest.memberIds) {
              const member = state.outbox.find((entry) => entry.id === id)!;
              if (member.status === "sending") {
                member.status = rejected ? "rejected" : "uncertain";
                member.detail = "Digest delivery was not confirmed. No individual repost will be attempted.";
              }
            }
            const surfaceId = item.publication?.surfaceId ?? item.digest?.surfaceId;
            if (surfaceId) state.interaction!.surfaces[surfaceId]!.delivery = rejected ? "rejected" : "uncertain";
            const label = item.historyId ? "HISTORY snapshot" : "Final-message";
            state.conversations[key]!.notice = rejected
              ? `${label} delivery was definitely rejected/not sent. It is not retried automatically; read the transcript.`
              : `${label} delivery failed or is uncertain. It is not retried automatically; read the transcript. No task was re-executed.`;
          });
          if (!item.historyId) break;
        }
      }
      if (this.options.interaction) {
        await this.deliverInteractionSurfaces(key);
        if (["home", "working", "needs-reply", "dashboard"].includes(this.store.snapshot().conversations[key]!.view)) continue;
      }
      try {
        const current = this.store.snapshot().conversations[key]!;
        const selected = this.store.snapshot().sessions[current.selectedId ?? ""];
        const transition = digest(JSON.stringify([current.view, current.selectedId, current.revision, current.notice,
          selected?.status, selected?.pending.map((request) => request.id)]));
        const lastUpdate = this.dashboardUpdates.get(key);
        if (this.options.interaction && current.dashboardId && lastUpdate?.transition === transition &&
          Date.now() < lastUpdate.at + this.options.interaction.statusUpdateMs) continue;
        if (current.dashboardId) {
          try {
            await this.transport.update(current.reference, current.dashboardId, this.render(key));
            this.dashboardUpdates.set(key, { at: Date.now(), transition });
          } catch (error) {
            const missing = object(error) && (error.statusCode === 404 || error.status === 404 ||
              (object(error.response) && error.response.status === 404));
            if (!missing) throw error;
            await this.store.mutate((state) => {
              const conversation = state.conversations[key]!;
              if (conversation.dashboardId === current.dashboardId) delete conversation.dashboardId;
              delete conversation.dashboardState;
              conversation.notice = "The previous dashboard was deleted. A replacement is being created; session work and approvals are unchanged.";
            });
            await this.createDashboard(key);
          }
        } else if (current.dashboardState !== "uncertain" && current.dashboardState !== "rejected") {
          await this.createDashboard(key);
        }
      } catch (error) {
        logError("proactive-card", error);
        await this.store.mutate((state) => {
          state.conversations[key]!.notice = 'Proactive dashboard update failed. Use !status or !sessions for a fresh card; progress is still retained locally.';
        });
      }
    }
    this.armInteractionWake();
  }

  private async createDashboard(key: string): Promise<void> {
    await this.store.mutate((state) => { state.conversations[key]!.dashboardState = "sending"; });
    try {
      const conversation = this.store.snapshot().conversations[key]!;
      const id = await this.transport.send(conversation.reference, { type: "card", card: this.render(key) });
      await this.rememberDashboard(key, id);
      console.log(JSON.stringify({ area: "teams-dashboard-delivery", outcome: "sent", messageId: safeText(id, 2048) }));
    } catch (error) {
      await this.store.mutate((state) => {
        state.conversations[key]!.dashboardState = error instanceof DeliveryError && error.outcome !== "uncertain" ? "rejected" : "uncertain";
      });
      throw error;
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.historyJobs);
    await this.events;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.delivery = this.delivery.then(() => this.deliver());
    await this.delivery;
  }

  private controllerTools(): Tool<unknown>[] {
    const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[],
      run: (key: string, parameters: Record<string, unknown>, receiptId: string) => Promise<unknown>) => defineTool<unknown>(name, {
      description, parameters: { type: "object", properties, required, additionalProperties: false },
      // Only these bounded management tools bypass SDK custom-tool prompts.
      // Their handlers still enforce the authenticated control turn, canonical IDs and durable receipts.
      skipPermission: true, defer: "never",
      handler: async (parameters, invocation) => {
        const key = this.activeControlKey;
        const controllerId = this.store.snapshot().controllerId;
        if (!key || !object(parameters) || invocation.sessionId !== controllerId) throw new UserError("No matching owner-authenticated management turn is active.");
        assertFields(parameters, Object.keys(properties));
        const receiptId = `control-tool:${controllerId}:${invocation.toolCallId}`;
        if (this.store.snapshot().receipts[receiptId]) throw new UserError("Management operation already received; it will not be replayed.");
        await this.receipt(receiptId, key, name, "started", "Bounded management operation received.");
        try {
          const result = await run(key, parameters, receiptId);
          await this.receipt(receiptId, key, name, "accepted", "Management operation accepted; this is not task completion.");
          return result;
        } catch (error) {
          await this.receipt(receiptId, key, name, "failed", publicError(error));
          throw error;
        }
      },
    });
    return [
      tool("bridge_list", "List canonical session IDs, names, state and safe capabilities.", {}, [], async () =>
        Object.values(this.store.snapshot().sessions).filter((item) => item.kind !== "controller").map((item) => ({
          sessionId: item.id, name: item.name, status: item.status, capability: item.capability,
        }))),
      tool("bridge_create", "Create a persistent working session in a configured workspace. Does not send a task.",
        { name: { type: "string" }, workspace: { type: "string", enum: this.options.workspaces.map((item) => item.id) } },
        ["name", "workspace"], async (key, parameters) => {
          if (!string(parameters.workspace)) throw new UserError("A workspace ID is required.");
          return { sessionId: await this.create(key, sessionName(parameters.name), parameters.workspace) };
        }),
      tool("bridge_select", "Select an existing canonical session ID. Does not stop any other session.",
        { sessionId: { type: "string" } }, ["sessionId"], async (key, parameters, receiptId) => {
          if (!canonicalId(parameters.sessionId)) throw new UserError("A canonical session ID is required.");
          await this.requestHistory(key, parameters.sessionId, 10, [receiptId], true);
          return { selectedSessionId: parameters.sessionId };
        }),
      tool("bridge_read", "Read only the safe visible projection, never raw internal prompts, reasoning or tool output.",
        { sessionId: { type: "string" } }, ["sessionId"], async (_key, parameters) => {
          if (!canonicalId(parameters.sessionId)) throw new UserError("A canonical session ID is required.");
          const session = this.store.snapshot().sessions[parameters.sessionId];
          if (!session) throw new UserError("Unknown session ID.");
          return { sessionId: session.id, entries: session.timeline.slice(-20) };
        }),
      tool("bridge_send", "Send the owner's requested exact task text to one working session; peer acceptance is not completion.",
        { sessionId: { type: "string" }, text: { type: "string" } }, ["sessionId", "text"], async (key, parameters, receiptId) => {
          if (!canonicalId(parameters.sessionId) || !string(parameters.text, 64_000)) throw new UserError("Canonical session ID and nonempty task text are required.");
          if (parameters.sessionId === this.store.snapshot().controllerId) throw new UserError("Controller recursion is forbidden.");
          await this.sendWorking(key, parameters.sessionId, parameters.text, [receiptId]);
          return { accepted: true, sessionId: parameters.sessionId, completed: false };
        }),
      tool("bridge_stop", "Request an owner-confirmed stop of a bridge-owned working session, preserving history.",
        { sessionId: { type: "string" } }, ["sessionId"], async (key, parameters) => {
          if (!canonicalId(parameters.sessionId) || this.store.snapshot().sessions[parameters.sessionId]?.kind !== "owned") {
            throw new UserError("Stop requires a bridge-owned canonical working-session ID.");
          }
          if (this.options.interaction) {
            await this.requestStop(key, parameters.sessionId);
            return { confirmationRequired: true, stopAcknowledged: false };
          }
          await this.runtime.stop(parameters.sessionId);
          return { stopAcknowledged: true };
        }),
    ];
  }

  async close(): Promise<void> {
    if (this.interactionTimer) { clearTimeout(this.interactionTimer); this.interactionTimer = undefined; }
    if (this.subscriptionTimer) { clearInterval(this.subscriptionTimer); this.subscriptionTimer = undefined; }
    await this.subscriptionCheck;
    await this.events;
    await Promise.all(this.conversations.values());
    await this.flush();
    this.closing = true;
    if (this.interactionTimer) { clearTimeout(this.interactionTimer); this.interactionTimer = undefined; }
    await this.runtime.close();
    await this.store.mutate((state) => {
      for (const admission of Object.values(state.admissions)) {
        if (admission.phase !== "confirmed" && admission.observation === "watching") admission.observation = "interrupted";
      }
    });
    await this.catalogueRefresh;
    await this.store.close();
  }
}
