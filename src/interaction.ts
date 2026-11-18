import { randomUUID } from "node:crypto";
import type { ConversationReference } from "@microsoft/agents-activity";
import type {
  BridgeState, Card, ConversationRecord, InteractionOptions, InteractionState,
  InteractionSurface, InteractionSurfaceKind, InteractionTurn, ModelChoice, RuntimeEvent, SessionListView, TimelineEntry,
} from "./domain.js";
import { Cards, block, card, hasPendingReply, isWorking, sessionStatus, statusBlock } from "./cards.js";
import { canFollow, conversationDialogue, followDescription, follows, notificationLabel, sourceTitle } from "./conversation-ui.js";
import { mergeDialoguePreview } from "./projection.js";
import { digest, object, safeText, string, UserError } from "./safety.js";

export { followDescription, follows } from "./conversation-ui.js";
export const acknowledgementDelayMs = 1500;

export const interactionDefaults: InteractionOptions = {
  statusUpdateMs: 5000, followMs: 24 * 60 * 60_000, digestMs: 60_000,
  remoteApprovals: true, approvalTimeoutMs: 15 * 60_000,
};

export function interactionState(state: BridgeState): InteractionState {
  if (!state.interaction) {
    state.interaction = { surfaces: {}, turns: {}, follows: {}, active: {} };
    for (const subscription of Object.values(state.subscriptions)) {
      state.interaction.follows[subscription.id] = {
        id: subscription.id, sessionId: subscription.sessionId, conversationKey: subscription.conversationKey,
        revision: subscription.revision, mode: subscription.enabled ? "explicit" : "muted",
        observation: "journal", detail: subscription.detail,
      };
    }
  }
  return state.interaction;
}

export function newSurface(
  state: BridgeState, conversationKey: string, kind: InteractionSurfaceKind,
  scope: Pick<InteractionSurface, "sessionId" | "turnId" | "requestId" | "outboxId" | "routingId"> = {},
): InteractionSurface {
  const surface: InteractionSurface = {
    id: randomUUID(), conversationKey, kind, ...scope,
    revision: 1, version: 1, delivery: "pending", urgent: true,
  };
  interactionState(state).surfaces[surface.id] = surface;
  return surface;
}

export function touchSurface(surface: InteractionSurface, urgent = false): void {
  surface.version++;
  surface.urgent ||= urgent;
}

export function inbox(state: BridgeState, key: string, replace = false): InteractionSurface {
  const ui = interactionState(state);
  const current = Object.values(ui.surfaces).find((surface) =>
    surface.conversationKey === key && surface.kind === "inbox" && !surface.frozen);
  if (current && !replace) return current;
  if (current) {
    current.frozen = "Updated below. Use the latest Inbox.";
    current.revision++;
    touchSurface(current, true);
  }
  return newSurface(state, key, "inbox");
}

export function focusHeader(state: BridgeState, key: string, sessionId: string, reopen = false): InteractionSurface {
  const ui = interactionState(state);
  const current = Object.values(ui.surfaces).find((surface) =>
    surface.conversationKey === key && surface.kind === "header" && !surface.frozen);
  if (current?.sessionId === sessionId && !reopen) return current;
  if (current) {
    current.frozen = current.sessionId === sessionId ? "Reopened below. Use the latest session card."
      : "Focus changed. Use the current session header or Inbox. Existing task replies still keep their original destination.";
    current.revision++;
    touchSurface(current, true);
  }
  return newSurface(state, key, "header", { sessionId });
}

export function pickerSurface(state: BridgeState, key: string, view: SessionListView, replace = false): InteractionSurface {
  const ui = interactionState(state);
  let current = Object.values(ui.surfaces).find((surface) =>
    surface.kind === "picker" && surface.conversationKey === key && !surface.frozen);
  if (current && replace) {
    current.frozen = "Replaced by the newer session picker.";
    current.revision++; touchSurface(current, true);
    current = undefined;
  }
  const picker = current ?? newSurface(state, key, "picker");
  const conversation = state.conversations[key]!;
  picker.listView = view; picker.page = conversation.page; picker.query = conversation.query ?? "";
  if (view === "sides" && conversation.sideParentId) picker.sideParentId = conversation.sideParentId;
  else delete picker.sideParentId;
  picker.revision++; touchSurface(picker, true);
  usePicker(state, picker);
  return picker;
}

export function usePicker(state: BridgeState, picker: InteractionSurface): void {
  const conversation = state.conversations[picker.conversationKey]!;
  conversation.view = picker.listView ?? "sessions";
  conversation.page = picker.page ?? 0;
  if (picker.query) conversation.query = picker.query;
  else delete conversation.query;
  if (picker.sideParentId) conversation.sideParentId = picker.sideParentId;
  conversation.surfaceId = picker.id;
  if (picker.activityId) {
    conversation.dashboardId = picker.activityId; conversation.dashboardState = "ready";
  } else {
    delete conversation.dashboardId;
    if (picker.delivery === "uncertain" || picker.delivery === "rejected") conversation.dashboardState = picker.delivery;
    else delete conversation.dashboardState;
  }
}

export function refreshSessionSurfaces(state: BridgeState, sessionId: string, urgent = true): void {
  const session = state.sessions[sessionId];
  if (!session) return;
  const requestHash = digest(JSON.stringify(session.pending));
  for (const surface of Object.values(state.interaction?.surfaces ?? {})) {
    if (surface.frozen) continue;
    if (surface.kind === "inbox" || surface.kind === "picker") touchSurface(surface, urgent);
    if (surface.sessionId === sessionId && (surface.kind === "header" || surface.kind === "actions")) {
      if (surface.requestHash !== requestHash) { surface.requestHash = requestHash; surface.revision++; }
      touchSurface(surface, urgent);
    }
  }
}

export function surfaceConversation(state: BridgeState, surface: InteractionSurface): ConversationRecord {
  const conversation = state.conversations[surface.conversationKey];
  if (!conversation) throw new UserError("This card's conversation is no longer available.");
  const context: ConversationRecord = {
    ...conversation, actionVersion: 2, surfaceId: surface.id, revision: surface.revision,
    view: surface.kind === "picker" ? surface.listView ?? "sessions" : surface.section === "settings" ? "settings" : "dashboard",
    page: surface.page ?? 0, query: surface.query ?? "",
  };
  if (surface.modelKey) context.modelKey = surface.modelKey;
  else delete context.modelKey;
  if (surface.sessionId) context.selectedId = surface.sessionId;
  else if (surface.kind !== "picker") delete context.selectedId;
  if (surface.sideParentId) context.sideParentId = surface.sideParentId;
  return context;
}

export function setTurnState(state: BridgeState, turn: InteractionTurn, next: InteractionTurn["state"]): void {
  if (turn.state === next || ["done", "failed", "stopped"].includes(turn.state)) return;
  turn.state = next;
  if (["done", "failed", "stopped"].includes(next)) turn.finishedAt = Date.now();
  const surface = state.interaction?.surfaces[turn.surfaceId];
  if (surface) {
    surface.revision++;
    touchSurface(surface, true);
  }
  for (const result of Object.values(state.interaction?.surfaces ?? {})) {
    if (result.kind === "result" && result.turnId === turn.id) touchSurface(result, true);
  }
}

export function startTurn(state: BridgeState, key: string, sessionId: string, receiptId: string, origin?: ConversationReference): InteractionTurn {
  const existing = state.interaction?.turns[receiptId];
  if (existing) {
    if (existing.conversationKey !== key || existing.sessionId !== sessionId) throw new UserError("The received task's destination changed. Nothing was sent.");
    return existing;
  }
  const conversation = state.conversations[key];
  const reference = origin ?? conversation?.reference;
  if (!reference?.activityId) throw new UserError("The authenticated prompt activity ID is missing; nothing was sent.");
  const surface = newSurface(state, key, "turn", { sessionId, turnId: receiptId });
  surface.notBefore = Date.now() + acknowledgementDelayMs;
  const turn: InteractionTurn = {
    id: receiptId, conversationKey: key, sessionId, surfaceId: surface.id,
    teamsActivityId: reference.activityId, reference: structuredClone(reference),
    state: "admitting", at: Date.now(), steps: [],
  };
  interactionState(state).turns[receiptId] = turn;
  return turn;
}

export function turnForOrigin(state: BridgeState, sessionId: string, origin: unknown): InteractionTurn | undefined {
  return typeof origin === "string" ? Object.values(state.interaction?.turns ?? {}).find((turn) =>
    turn.sessionId === sessionId && turn.messageId === origin) : undefined;
}

export function observeInteraction(state: BridgeState, incoming: RuntimeEvent): void {
  if (incoming.historical || !state.interaction || !object(incoming.event) ||
    !string(incoming.event.type) || !string(incoming.event.id)) return;
  const event = incoming.event;
  const data = event.data;
  if (!object(data)) return;
  if (event.agentId || data.parentToolCallId || event.checkpoint === true) return;
  const session = state.sessions[incoming.sessionId];
  if (!session) return;
  const ui = state.interaction;
  if (event.type === "user.message") {
    const consumed = turnForOrigin(state, session.id, data.messageId);
    if (consumed) {
      ui.active[session.id] = consumed.id;
      setTurnState(state, consumed, "executing");
    } else delete ui.active[session.id];
  }
  const active = ui.turns[ui.active[session.id] ?? ""];
  const explicit = turnForOrigin(state, session.id,
    data.originatingMessageId ?? (typeof event.type === "string" && event.type.startsWith("bridge.app_") ? data.messageId : undefined));
  const turn = explicit ?? (session.kind === "owned" ? active : undefined);
  if (explicit && session.kind === "owned" && event.type === "assistant.message" && !explicit.finishedAt) ui.active[session.id] = explicit.id;
  if (turn) {
    if (event.type === "assistant.turn_start" && string(data.turnId)) {
      turn.nativeTurnId = data.turnId;
    } else if (event.type === "assistant.intent" && typeof data.intent === "string") {
      turn.intent = safeText(data.intent, 120);
      touchSurface(ui.surfaces[turn.surfaceId]!);
    } else if (event.type === "tool.execution_start" && string(data.toolCallId) &&
      (data.turnId === undefined || data.turnId === turn.nativeTurnId)) {
      const name = typeof data.toolName === "string" && /^[\w.-]{1,100}$/u.test(data.toolName) ? data.toolName : "Tool";
      turn.steps = [...turn.steps.filter((step) => step.id !== data.toolCallId),
        { id: data.toolCallId, name, state: "running" as const }].slice(-5);
      touchSurface(ui.surfaces[turn.surfaceId]!);
    } else if (event.type === "bridge.app_admission_consumed") {
      setTurnState(state, turn, "executing");
    } else if (event.type === "bridge.app_admission_confirmed") {
      setTurnState(state, turn, "done");
    } else if (event.type === "bridge.app_output_unavailable") {
      setTurnState(state, turn, "uncertain");
    } else if (event.type === "assistant.message" && explicit && typeof data.content === "string" &&
      data.content.trim() && data.phase !== "commentary" && (!Array.isArray(data.toolRequests) || !data.toolRequests.length) &&
      (data.phase === undefined || ["final", "final_answer", "response"].includes(String(data.phase)))) {
      setTurnState(state, turn, "result");
    } else if (event.type === "session.task_complete" && data.success === true) {
      if (!turn.finishedAt && typeof data.summary === "string" && data.summary.trim()) turn.summary = safeText(data.summary, 8000);
      setTurnState(state, turn, "done");
    } else if (event.type === "session.error" && explicit) {
      setTurnState(state, turn, "failed");
    } else if (event.type === "abort" && active) {
      setTurnState(state, active, "stopped");
    }
    if (["user_input.requested", "permission.requested", "exit_plan_mode.requested"].includes(String(event.type)) &&
      data.resolvedByHook !== true && session.kind === "owned") setTurnState(state, turn, "waiting");
    if (["user_input.completed", "permission.completed", "exit_plan_mode.completed"].includes(String(event.type)) &&
      turn.state === "waiting" && !session.pending.length) setTurnState(state, turn, "executing");
  }
  if (event.type === "tool.execution_complete" && string(data.toolCallId)) {
    for (const candidate of Object.values(ui.turns)) {
      if (candidate.sessionId !== session.id) continue;
      const step = candidate.steps.find((entry) => entry.id === data.toolCallId);
      if (step) {
        step.state = data.success === true ? "done" : "failed";
        touchSurface(ui.surfaces[candidate.surfaceId]!);
      }
    }
  }
  if (event.type === "session.idle" || event.type === "abort" || event.type === "session.shutdown") delete ui.active[session.id];
  const urgent = [
    "user.message", "user_input.requested", "user_input.completed", "permission.requested", "permission.completed",
    "exit_plan_mode.requested", "exit_plan_mode.completed", "session.idle", "session.error", "session.task_complete",
    "session.shutdown", "abort", "bridge.app_admission_consumed", "bridge.app_admission_confirmed", "bridge.app_output_unavailable",
    "bridge.permission_resolved", "bridge.approval_unconfirmed", "bridge.approval_timeout_submitted", "elicitation.requested", "elicitation.completed",
  ].includes(String(event.type));
  for (const conversation of Object.values(state.conversations)) {
    inbox(state, conversation.key);
    if (session.kind !== "owned") continue;
    for (const pending of session.pending) {
      const existing = Object.values(ui.surfaces).find((surface) => surface.kind === "request" &&
        !surface.frozen && surface.conversationKey === conversation.key && surface.sessionId === session.id && surface.requestId === pending.id);
      const requestHash = digest(JSON.stringify(pending));
      if (!existing && (turn?.conversationKey === conversation.key || follows(state, conversation.key, session.id))) {
        const requestSurface = newSurface(state, conversation.key, "request", {
          sessionId: session.id, requestId: pending.id, ...(turn ? { turnId: turn.id } : {}),
        });
        requestSurface.requestHash = requestHash;
      } else if (existing && existing.requestHash !== requestHash) {
        existing.requestHash = requestHash; existing.revision++; touchSurface(existing, true);
      }
    }
  }
  refreshSessionSurfaces(state, session.id, urgent);
  for (const surface of Object.values(ui.surfaces)) {
    if (surface.kind === "request" && surface.sessionId === session.id && !surface.frozen &&
      !session.pending.some((pending) => pending.id === surface.requestId)) {
      const outcomes: Record<string, string> = {
        once: "Allowed once by you.", session: "Allowed for this session by you.", deny: "Denied by you.",
        timeout: "Timed out - user not available. The native response was acknowledged.", elsewhere: "Already resolved in the native host.",
      };
      surface.frozen = event.type === "bridge.permission_resolved" && data.requestId === surface.requestId
        ? outcomes[String(data.outcome)] ?? "Request resolved."
        : event.type === "abort" || event.type === "session.shutdown" ? "Request cancelled." : "Request resolved.";
      surface.revision++;
      touchSurface(surface, true);
    }
  }
}

// Excerpts are presentation only: never rewrite the source or a full-history group.
function dialogueBlocks(
  timeline: readonly TimelineEntry[], preview: readonly TimelineEntry[], compact: boolean,
): Record<string, unknown>[] {
  const rows = mergeDialoguePreview(conversationDialogue(preview), conversationDialogue(timeline));
  return rows.flatMap((entry, index) => {
    if (compact && rows.slice(index + 1).some((other) => other.kind === entry.kind)) return [];
    const user = entry.kind === "user";
    const limit = compact ? user ? 120 : 180 : user ? 180 : 260;
    const lines = entry.text.split(/\r\n|[\n\r\u2028\u2029]/u).map((line) => line.trim())
      .filter((line) => line && !/^(?:`{3,}|~{3,})(?:[\w.+#-]+)?$|^[-|:\s]{3,}$/u.test(line));
    const visible = compact ? 1 : 2;
    const plain = lines.slice(0, visible).map((line) => /^\|.*\|$/u.test(line)
      ? line.slice(1, -1).trim().replace(/\s*\|\s*/gu, " · ") : line).join(" ").replace(/!?\[([^\]]+)\]\([^\n)]*\)/gu, "$1")
      .replace(/^(?:#{1,6}\s+|[-*+]\s+|>\s?)/u, "").replace(/`+|\*\*/gu, "").replace(/\s+/gu, " ").trim();
    if (!plain) return [];
    const chars = [...plain.replace(/([\\[\]<>_*])/gu, "\\$1")];
    const clipped = chars.length > limit || lines.length > visible;
    const excerpt = clipped ? chars.slice(0, limit - 1).join("").replace(/\\+$/u, "").trimEnd() + "…" : chars.join("");
    return [
      block(user ? "You" : "Copilot", { size: "Small", weight: "Bolder", isSubtle: true, maxLines: 1, spacing: "Small" }),
      block(excerpt, { spacing: "None", maxLines: compact ? 2 : 3 }),
    ];
  });
}

export function renderInteractionSurface(
  state: BridgeState, surface: InteractionSurface, cards: Cards, now = Date.now(), models: ModelChoice[] = [],
  cached: { entries: readonly TimelineEntry[]; unavailable?: boolean } = { entries: [] },
): Card {
  const context = surfaceConversation(state, surface);
  const action = (title: string, scope: Parameters<Cards["scopedAction"]>[2]) => cards.scopedAction(context, title, scope);
  const session = state.sessions[surface.sessionId ?? ""];
  const title = session ? safeText(sourceTitle(session, state.sessions), 180) : "Copilot Sessions";
  if (surface.frozen) return card([block(title, { weight: "Bolder" }), block(surface.frozen)]);
  if (surface.kind === "actions") return renderAllActions(state, surface, cards, models, now, cached);
  if (surface.kind === "picker") return cards.render({
    ...state, conversations: { ...state.conversations, [context.key]: context },
  }, context.key);
  if (surface.kind === "inbox") {
    const conversation = state.conversations[surface.conversationKey]!;
    const sources = Object.values(state.sessions).filter((source) => source.kind !== "controller");
    const waiting = sources.filter((source) => hasPendingReply(source, now));
    const running = sources.filter((source) => isWorking(source, now));
    const completed = Object.values(state.interaction?.turns ?? {}).filter((turn) =>
      turn.conversationKey === conversation.key && turn.state === "done").sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    const selected = state.sessions[conversation.selectedId ?? ""];
    const recent = [...(selected ? [selected] : []), ...waiting, ...running,
      ...completed.flatMap((turn) => state.sessions[turn.sessionId] ? [state.sessions[turn.sessionId]!] : [])];
    const visible = [...new Map(recent.map((source) => [source.id, source])).values()].slice(0, 3);
    const body = [
      block("Copilot Sessions - Inbox", { size: "Medium", weight: "Bolder" }),
      block(conversation.selectionBlocked ? "Destination unresolved. Nothing new will be sent until you select a valid source."
        : selected ? `Next message -> ${safeText(sourceTitle(selected, state.sessions), 180)}`
          : "Choose a session before sending work. Nothing has been sent."),
      ...(!selected ? [block("Use Choose a session or !sessions. All actions and !help explain the available controls.", { size: "Small" })] : []),
      block(`Needs you: ${waiting.length} | Working: ${running.length}`, { size: "Small" }),
    ];
    const routes = Object.values(state.interaction?.routes ?? {}).filter((route) =>
      route.conversationKey === conversation.key && route.state === "pending" && route.expiresAt > now);
    if (routes.length) body.push({
      type: "Container", items: [
        block(`${routes.length} unsent draft(s) need a target`, { weight: "Bolder" }),
        { type: "ActionSet", actions: [action("Review draft", { op: "route-refresh", argument: routes[0]!.id })] },
      ],
    });
    for (const source of visible) body.push({
      type: "Container", separator: true, items: [
        block(sourceTitle(source, state.sessions), { weight: "Bolder" }),
        statusBlock(sessionStatus(source, now)),
        block(notificationLabel(state, context.key, source.id, now), { size: "Small" }),
        { type: "ActionSet", actions: [action("Open", { op: "open-source", targetId: source.id }),
          action("All actions", { op: "all-actions", targetId: source.id })] },
      ],
    });
    return card(body, [
      action(selected ? "All sessions" : "Choose a session", { op: "view", argument: "sessions" }),
      action("All actions", { op: "all-actions", ...(selected ? { targetId: selected.id } : {}) }),
      action("Refresh", { op: "inbox", argument: "refresh" }),
    ]);
  }
  if (surface.kind === "routing") {
    const route = state.interaction?.routes?.[surface.routingId ?? ""];
    if (!route) throw new UserError("This routing request is no longer available.");
    if (route.state !== "pending" || route.expiresAt <= now) return card([
      block(route.state === "sent" ? `Sent once to ${state.sessions[route.sessionId ?? ""]?.name ?? route.sessionId}`
        : route.state === "uncertain" || route.state === "sending" ? "May have been accepted - check the original host. Do not resend."
          : route.state === "rejected" ? "This draft was not sent. Select a valid source before sending new work."
            : "Routing request expired. Nothing was sent.", { weight: "Bolder" }),
    ], [action("Inbox", { op: "inbox" })]);
    const writable = Object.values(state.sessions).filter((source) =>
      (source.kind === "owned" || source.kind === "peer") && source.access?.send !== false && !source.pending.length &&
      (source.peerSource !== "app" || (source.liveUntil ?? 0) > now))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, 20);
    return card([
      block("Choose where to send this unchanged draft", { weight: "Bolder" }),
      block("This reply is not bound to a supported session thread. Focus fallback has not forwarded it.", { size: "Small" }),
      block(safeText(route.prompt, 120), {}, 160),
      { type: "Input.ChoiceSet", id: "source", label: "Recent writable sources", choices: writable.map((source) => ({
        title: safeText(source.name, 100), value: source.id,
      })) },
      { type: "Input.Text", id: "target", label: "Or an exact source name / canonical ID", maxLength: 220 },
      block("Read-only sources are not send choices. All sessions shows their reasons. Model uses the configured default for new sessions.", { size: "Small" }),
    ], [
      cards.scopedAction(context, "Send once", { op: "route-send", argument: route.id }, true),
      { type: "Action.ShowCard", title: "Create and send", card: card(cards.newSessionInputs(), [
        cards.scopedAction(context, "Create and send once", { op: "route-create", argument: route.id }, true),
      ]) },
      action("Refresh choices", { op: "route-refresh", argument: route.id }),
      action("All sessions", { op: "view", argument: "sessions" }),
    ]);
  }
  if (surface.kind === "request") {
    const pending = session?.pending.find((request) => request.id === surface.requestId);
    if (state.interaction?.remoteApprovals === false && (pending?.kind === "permission" || pending?.kind === "plan")) {
      return card([block(title), block("Remote approvals are disabled. No approval action is available.")]);
    }
    return session && pending ? cards.requestSurface(context, session, pending)
      : card([block(title, { weight: "Bolder" }), block("Already resolved. No response was sent.")]);
  }
  if (surface.kind === "stop") {
    if (!surface.stop || surface.stop.state !== "pending" || surface.stop.expiresAt <= now || session?.kind !== "owned") {
      return card([block(title), block("Stop confirmation is expired, unavailable, or already attempted. No stop is replayed.")]);
    }
    return card([
      block(`Confirm Stop - ${title}`, { weight: "Bolder" }),
      block("Stop only the message currently processing in this owned session. Queued or background work may remain; history is not deleted."),
      block(`Target: ${surface.sessionId}`, { size: "Small" }),
    ], [
      action("Confirm Stop", { op: "confirm-stop", targetId: surface.sessionId! }),
      action("Cancel", { op: "cancel-stop", targetId: surface.sessionId! }),
    ]);
  }
  if (surface.kind === "header") {
    if (!session) return card([block("Choose a session. The previous source is unavailable.")], [
      action("Choose a session", { op: "view", argument: "sessions" }), action("All actions", { op: "all-actions" }),
    ]);
    const conversation = state.conversations[context.key]!;
    const readable = session.kind !== "unavailable" && session.access?.read !== false;
    const danger = /\b(?:failed|uncertain|unconfirmed|unavailable|rejected|expired|unresolved|error)\b/iu.test(conversation.notice);
    return card([
      block(`Next message -> ${title}`, { size: "Medium", weight: "Bolder", maxLines: 2 }),
      statusBlock(sessionStatus(session, now)),
      block(notificationLabel(state, context.key, session.id, now), { size: "Small", isSubtle: true }),
      ...(conversation.selectionBlocked ? [block("Destination unresolved. Choose a session before sending work.", { color: "Attention" })] : []),
      ...(danger ? [block(conversation.notice, { size: "Small", color: "Warning" }, 350)] : []),
      ...(readable ? dialogueBlocks(session.timeline, cached.entries, true) : []),
    ], [
      ...(readable ? [action("Recent conversation", { op: "history-source", targetId: session.id })] : []),
      ...(follows(state, context.key, session.id, now) || canFollow(session) ? [action(follows(state, context.key, session.id, now) ? "Unsubscribe" : "Subscribe", {
        op: follows(state, context.key, session.id, now) ? "unsubscribe" : "subscribe", targetId: session.id,
      })] : []),
      action("Change next target", { op: "view", argument: "sessions" }),
      action("All actions", { op: "all-actions", targetId: session.id }),
    ]);
  }
  if (surface.kind === "turn") {
    const turn = state.interaction?.turns[surface.turnId ?? ""];
    if (!turn) throw new UserError("This turn is no longer available.");
    const labels: Record<InteractionTurn["state"], string> = {
      admitting: "Received by bridge - not yet accepted by the source",
      accepted: "Accepted by source - queued; execution not yet observed",
      executing: "Running - execution observed",
      waiting: "Needs your response",
      result: "Result available - task completion not yet confirmed",
      done: "Task completion observed",
      failed: "Failed - inspect the source",
      stopped: "Stopped",
      uncertain: turn.messageId ? "Accepted - observation interrupted or unconfirmed; do not resend"
        : "May have been accepted - check the original host; do not resend",
    };
    const results = state.outbox.filter((item) => item.publication?.taskReceiptId === turn.id);
    const deliveryUnknown = results.some((item) => item.status === "uncertain" || item.status === "rejected");
    const label = deliveryUnknown ? "Reply delivery unconfirmed - no automatic resend"
      : results.some((item) => item.status === "sent") ? "Reply delivered"
        : turn.state === "done" ? "Task completion observed - waiting for the answer" : labels[turn.state];
    return card([block(`${label} - ${title}`, {
      size: "Small", color: deliveryUnknown || turn.state === "uncertain" || turn.state === "failed" ? "Warning" : "Default",
    })], [action("All actions", { op: "all-actions", targetId: turn.sessionId }),
      { type: "Action.ShowCard", title: "Details", card: card(turnDetails(state, turn), [
        action("History", { op: "history-source", targetId: turn.sessionId }),
        action("Change next target", { op: "view", argument: "sessions" }),
      ]) }]);
  }
  const item = state.outbox.find((entry) => entry.id === surface.outboxId);
  if (!item) throw new UserError("This result is no longer available.");
  if (surface.kind === "digest") {
    const members = item.digest?.memberIds.flatMap((id) => state.outbox.find((entry) => entry.id === id) ?? []) ?? [];
    const groups = new Map<string, typeof members>();
    for (const member of members) {
      const group = groups.get(member.sessionId) ?? [];
      group.push(member);
      groups.set(member.sessionId, group);
    }
    const pages = Math.max(1, Math.ceil(groups.size / 3));
    const page = Math.min(surface.page ?? 0, pages - 1);
    const body = [block(`${groups.size} followed sessions have ${members.length} new replies`, { weight: "Bolder" }),
      block(`Background notifications only. Page ${page + 1} of ${pages}. Explicit task replies keep their original destination.`, { size: "Small" })];
    const choices: Record<string, unknown>[] = [];
    for (const [, group] of [...groups].slice(page * 3, page * 3 + 3)) {
      const member = group.at(-1)!;
      const source = state.sessions[member.sessionId];
      body.push(block(`${source?.name ?? member.sessionId} (${member.sessionId.slice(0, 8)}): ${group.length} new replies. ${safeText(member.text, 120)}`, { size: "Small" }));
      choices.push(action(`Open ${safeText(source?.name ?? member.sessionId, 35)} ${member.sessionId.slice(0, 8)}`, {
        op: "open-source", targetId: member.sessionId,
      }));
    }
    if (page > 0) choices.push(action("Previous sources", { op: "digest-page", argument: String(page - 1) }));
    if (page + 1 < pages) choices.push(action("More sources", { op: "digest-page", argument: String(page + 1) }));
    if (choices.length < 5) choices.push(action("Inbox", { op: "inbox" }));
    return card(body, choices);
  }
  const turn = state.interaction?.turns[surface.turnId ?? ""];
  const preview = resultPreview(item.text);
  return card([
    block(preview.text, {}, Number.MAX_SAFE_INTEGER),
    block(`From ${item.publication?.title ?? title}`, { size: "Small", isSubtle: true }),
  ], [
    ...(preview.truncated ? [action("Show full", { op: "show-full", targetId: item.sessionId, argument: item.id })] : []),
    action("All actions", { op: "all-actions", targetId: item.sessionId }),
    { type: "Action.ShowCard", title: "Details", card: card([
      block(`Source: ${item.sessionId}`, { size: "Small" }),
      ...(turn ? turnDetails(state, turn) : []),
      block(`Teams delivery: ${item.status}`, { size: "Small" }),
    ], [action("Open", { op: "open-source", targetId: item.sessionId })]) },
  ]);
}

function resultPreview(text: string): { text: string; truncated: boolean } {
  const full = safeText(text, Number.MAX_SAFE_INTEGER);
  const characters = [...full];
  let end = Math.min(characters.length, 4000);
  while (Buffer.byteLength(JSON.stringify(characters.slice(0, end).join(""))) > 10_000) end = Math.floor(end * 0.8);
  const truncated = end < characters.length;
  return { text: characters.slice(0, end).join("") + (truncated ? "\n[Continued in Show full]" : ""), truncated };
}

function turnDetails(state: BridgeState, turn: InteractionTurn): Record<string, unknown>[] {
  const steering = Object.values(state.interaction?.steers ?? {}).filter((entry) => entry.parentTurnId === turn.id).at(-1);
  return [
    block(`Task: ${turn.state}. Task state is separate from the source's availability.`, { size: "Small" }),
    block(`Receipt: ${turn.id}\nNative message: ${turn.messageId ?? "(not acknowledged)"}`, { size: "Small", fontType: "Monospace" }),
    ...(turn.intent ? [block(turn.intent, { size: "Small" })] : []),
    ...turn.steps.map((step) => block(`${step.state}: ${step.name}`, { size: "Small" })),
    block(`Tracked queued tasks: ${Object.values(state.interaction?.turns ?? {}).filter((entry) =>
      entry.sessionId === turn.sessionId && entry.state === "accepted").length} (not a host-wide queue count)`, { size: "Small" }),
    ...(turn.summary ? [block(`Native completion summary: ${turn.summary}`, { size: "Small" }, 800)] : []),
    ...(steering ? [block(`Steering ${steering.state}. Acceptance is not consumption; the original task keeps its recipient.`, { size: "Small" })] : []),
  ];
}

function renderAllActions(state: BridgeState, surface: InteractionSurface, cards: Cards, models: ModelChoice[], now: number,
  cached: { entries: readonly TimelineEntry[]; unavailable?: boolean }): Card {
  const context = surfaceConversation(state, surface);
  const session = state.sessions[surface.sessionId ?? ""];
  const title = session ? safeText(sourceTitle(session, state.sessions), 180) : "Copilot Sessions";
  const action = (label: string, scope: Parameters<Cards["scopedAction"]>[2], inputs = false) =>
    cards.scopedAction(context, label, scope, inputs);
  const back = action("All actions", { op: "actions-section", argument: "menu" });
  const active = session ? state.interaction?.turns[state.interaction.active[session.id] ?? ""] : undefined;
  const canControl = session?.kind === "owned" && session.status !== "offline" && active?.conversationKey === context.key &&
    active.state === "executing" && !active.finishedAt && active.messageId;
  const canStop = session?.kind === "owned" && session.status !== "offline" && active?.conversationKey === context.key &&
    ["executing", "waiting"].includes(active.state) && !active.finishedAt && active.messageId;
  if (surface.section === "settings" && session) return cards.settingsSurface(context, session, models);
  if (surface.section === "history") {
    const readable = session && session.kind !== "unavailable" && session.access?.read !== false;
    const rows = readable ? dialogueBlocks(session.timeline, cached.entries, false) : [];
    return card([
      block("Recent conversation", { size: "Medium", weight: "Bolder" }),
      block(title, { size: "Small", maxLines: 2 }),
      ...(cached.unavailable ? [block("Preview refresh unavailable. Only retained excerpts can be shown.", { size: "Small", color: "Warning" })] : []),
      ...(rows.length ? rows : [block("No public conversation excerpt is available here.", { isSubtle: true })]),
    ], [...(readable ? [{ type: "Action.ShowCard", title: "Full history", card: card([
      block("Post full-length messages to this chat. Long replies may need several messages.", { size: "Small" }),
      { type: "Input.ChoiceSet", id: "count", label: "Messages to post", value: "1",
        choices: [1, 3, 10, 25, 50].map((count) => ({ title: String(count), value: String(count) })) },
    ], [action("Post full history", { op: "history-source", argument: "publish", targetId: session.id }, true)]) }] : []), back]);
  }
  if (surface.section === "steer") {
    const turn = state.interaction?.turns[surface.turnId ?? ""];
    if (!canControl || active.id !== turn?.id || session.pending.length) return card([
      block("Steering is no longer available for that processing request. Nothing was sent."),
    ], [back]);
    return card([block(`Steer - ${title}`, { weight: "Bolder" }),
      block("Send immediately to this same processing request. This does not change the next-message target.", { size: "Small" }),
      { type: "Input.Text", id: "steering", label: "Steering instruction", isMultiline: true, isRequired: true, maxLength: 64_000 },
    ], [action("Send steering", { op: "steer", targetId: session.id, argument: turn.id }, true), back]);
  }
  if (surface.section === "request") {
    const pending = session?.pending.find((item) => item.id === surface.requestId);
    if (!pending || !session) return card([block("Request resolved. No response was sent.")], [back]);
    if (state.interaction?.remoteApprovals === false && ["permission", "plan"].includes(pending.kind)) {
      return card([block("Remote approvals are disabled. No approval action is available.")], [back]);
    }
    return cards.requestSurface(context, session, pending);
  }
  if (surface.section === "control") return card([
    block("Optional Control", { weight: "Bolder" }),
    block("Explicit management instruction only. Ordinary Teams text still goes to your selected working session. Control has bounded management tools, not shell/file access."),
    { type: "Input.Text", id: "instruction", label: "Management instruction", isMultiline: true, isRequired: true, maxLength: 64_000 },
  ], [action("Send Control instruction", { op: "control-send" }, true),
    ...(state.controllerId ? [action("Control history", { op: "read-source", targetId: state.controllerId })] : []), back]);
  if (surface.section === "help") return card([
    block("Choose a session, then send work", { weight: "Bolder" }),
    block("Ordinary Teams composer text is forwarded unchanged to the selected source. Opening All actions never sends it as a management command."),
    block("Choose a session / !sessions opens the picker. Open selects a source without sending work. !help opens this guide."),
    block("Shortcuts: !home, !sessions, !use <name or ID>, !history [1..50], !read, !status, !subscribe, !unsubscribe, !subscriptions, !sides, !new, !settings, !stop, !control <instruction>."),
    block("App approvals, Stop and model/mode belong to the original host. Structured forms, preview threads, reactions and native typing are not supported here."),
  ], [action("Choose a session", { op: "view", argument: "sessions" }), back]);
  if (surface.section === "details") return card([
    block(`Details - ${title}`, { weight: "Bolder" }),
    ...(session ? [block(session.id, { fontType: "Monospace", size: "Small" }), block(session.capability, { size: "Small" }),
      statusBlock(sessionStatus(session, now)), block(followDescription(state, context.key, session.id, now), { size: "Small" }),
      block(`Model: ${session.settings?.modelId ?? session.peerModelId ?? "(not exposed)"}\nMode: ${session.settings?.mode ?? "(original host)"}\nEffort: ${session.settings?.effort ?? "(native default or not exposed)"}`, { size: "Small" }),
      ...(active ? turnDetails(state, active) : []),
    ] : [block("No source selected.")]),
    block(state.interaction?.capabilityNotice ?? "Focus mode.", { size: "Small" }),
    block("App pending questions and approvals are unknown here; inspect the original host.", { size: "Small" }),
    block(state.conversations[context.key]!.notice, { size: "Small" }, 1200),
  ], [action("Check status", { op: "refresh" }), back]);

  const entries: Array<{ group: string; title: string; description: string; button?: Record<string, unknown> }> = [];
  const add = (group: string, label: string, description: string, scope?: Parameters<Cards["scopedAction"]>[2]) =>
    entries.push({ group, title: label, description, ...(scope ? { button: action(label, scope) } : {}) });
  if (canControl && session && !session.pending.length) {
    add("Current task", "Steer", "Send an immediate instruction to the observed processing request.", {
      op: "actions-section", argument: "steer", turnId: active.id,
    });
  }
  if (canStop && session && active) {
    add("Current task", "Stop", "Requires a separate confirmation; queued/background work may remain.", { op: "stop", targetId: session.id, argument: active.id });
  }
  if (session?.kind === "owned" && session.status !== "offline") for (const pending of session.pending) {
    add("Needs you", pending.kind === "input" ? "Answer question" : pending.kind === "permission" ? "Review approval"
      : pending.kind === "plan" ? "Review plan" : "Structured form",
    safeText(pending.title, 150), { op: "actions-section", argument: "request", requestId: pending.id });
  }
  add("Sessions", "Choose a session", "Search and switch the next-message target without sending work.", { op: "view", argument: "sessions" });
  if (session) add("Sessions", "Open session", "Select this source and show its session card. No task or history is sent.", { op: "open-source", targetId: session.id });
  add("Sessions", "New session", "Create in an allowed workspace; no prompt is automatically sent.", { op: "view", argument: "new" });
  add("Sessions", "Inbox", "See observed session activity and requests.", { op: "inbox" });
  if (session && session.kind !== "controller") {
    if (follows(state, context.key, session.id, now) || canFollow(session)) add("Notifications", follows(state, context.key, session.id, now) ? "Unsubscribe" : "Subscribe",
      followDescription(state, context.key, session.id, now), {
        op: follows(state, context.key, session.id, now) ? "unsubscribe" : "subscribe", targetId: session.id,
      });
    else add("Notifications", "Subscription unavailable", "This source has no supported passive observer. Direct task replies and readable history remain separate.");
    if (session.access?.read !== false && session.kind !== "unavailable") {
      add("History", "Recent conversation", "View short public excerpts. Full history is optional; the task destination stays unchanged.", { op: "actions-section", argument: "history" });
      add("History", "Browse full transcript", "Browse full-length retained dialogue without running source work.", { op: "read-source", targetId: session.id });
    }
    if (session.kind === "owned") add("Settings", "Model and mode", "Open the live model/effort catalogue. Applying changes requires an idle owned session.",
      { op: "actions-section", argument: "settings" });
    else add("Native host", "Model, mode, Stop and approvals", "Native-only for this source. Use its original host; this bridge cannot assume ownership.");
    add("Sessions", "Side chats", "Read verified children; subscriptions are never inherited.", { op: "view", argument: "sides", targetId: session.id });
    if (session.sideChat?.parentId) add("Sessions", "Parent session", "Open the verified parent.", { op: "open-source", targetId: session.sideChat.parentId });
  }
  add("Notifications", "Subscriptions", "Manage saved following, including paused and unavailable sources.", { op: "view", argument: "subscriptions" });
  add("Diagnostics", "Check status", "Refresh observed state without sending a task.", { op: "refresh" });
  add("Diagnostics", "Details", "Source IDs, task receipts, queue/tool evidence and capability limits.", { op: "actions-section", argument: "details" });
  add("Management", "Control", "Explicit optional management form; ordinary messages remain literal work.", { op: "actions-section", argument: "control" });
  add("Help", "Commands and help", "First-contact guide and !sessions / !help discovery.", { op: "actions-section", argument: "help" });
  const query = surface.query?.trim().toLocaleLowerCase() ?? "";
  const filtered = entries.filter((entry) => !query || query.split(/\s+/u).every((word) =>
    `${entry.group} ${entry.title} ${entry.description}`.toLocaleLowerCase().includes(word)));
  const pages = Math.max(1, Math.ceil(filtered.length / 4));
  const page = Math.min(surface.page ?? 0, pages - 1);
  const body: Record<string, unknown>[] = [
    block(`All actions - ${title}`, { weight: "Bolder" }),
    ...(session ? [statusBlock(sessionStatus(session, now))] : [block("No source selected. Choose a session before sending work.")]),
    { type: "Input.Text", id: "actionQuery", label: "Search actions", value: surface.query ?? "", maxLength: 100,
      placeholder: "e.g. stop, model, history, notifications", inlineAction: action("Search actions", { op: "search-actions" }, true) },
  ];
  for (const entry of filtered.slice(page * 4, page * 4 + 4)) body.push({
    type: "Container", separator: true, items: [
      block(`${entry.group} - ${entry.title}`, { weight: "Bolder", size: "Small" }),
      block(entry.description, { size: "Small" }, 500),
      ...(entry.button ? [{ type: "ActionSet", actions: [entry.button] }] : []),
    ],
  });
  if (!filtered.length) body.push(block("No matching actions. Clear the search to see all available operations."));
  body.push(block(`Page ${page + 1} of ${pages}`, { size: "Small", isSubtle: true }));
  return card(body, [
    ...(page > 0 ? [action("Previous actions", { op: "actions-page", argument: String(page - 1) })] : []),
    ...(page + 1 < pages ? [action("More actions", { op: "actions-page", argument: String(page + 1) })] : []),
    action("Clear search", { op: "actions-section", argument: "menu" }),
  ]);
}
