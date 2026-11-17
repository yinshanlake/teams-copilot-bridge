import { randomUUID } from "node:crypto";
import type { ConversationReference } from "@microsoft/agents-activity";
import type {
  BridgeState, Card, ConversationRecord, FollowPreference, InteractionOptions, InteractionState,
  InteractionSurface, InteractionSurfaceKind, InteractionTurn, RuntimeEvent,
} from "./domain.js";
import { Cards, block, card } from "./cards.js";
import { sourceTitle } from "./conversation-ui.js";
import { digest, object, safeText, string, UserError } from "./safety.js";

export const interactionDefaults: InteractionOptions = {
  statusUpdateMs: 5000, followMs: 24 * 60 * 60_000, digestMs: 60_000,
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

export function follows(state: BridgeState, key: string, sessionId: string, now = Date.now()): FollowPreference | undefined {
  const preference = state.interaction?.follows[digest(`${key}:${sessionId}`)];
  return preference && preference.mode !== "muted" &&
    (preference.expiresAt === undefined || preference.expiresAt > now) ? preference : undefined;
}

export function followDescription(state: BridgeState, key: string, sessionId: string, now = Date.now()): string {
  const preference = state.interaction?.follows[digest(`${key}:${sessionId}`)];
  if (!preference || preference.mode === "muted") return preference?.detail ?? "Muted - explicit task replies still arrive.";
  if (preference.expiresAt !== undefined && preference.expiresAt <= now) return "Automatic following expired - explicit task replies still arrive.";
  const subscription = state.subscriptions[preference.id];
  if (subscription?.enabled && subscription.status === "paused") return `Following paused: ${subscription.detail}`;
  if (preference.observation === "unavailable") return `Following unavailable: ${preference.detail}`;
  const duration = preference.mode === "explicit" ? "no expiry"
    : `${Math.max(1, Math.ceil(((preference.expiresAt ?? now) - now) / 3_600_000))} hr left`;
  return preference.observation === "live"
    ? `Following (${duration}) - live connection only; no offline catch-up or automatic reconnect.`
    : `Following (${duration}) - from the saved journal cursor.`;
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

export function focusHeader(state: BridgeState, key: string, sessionId: string): InteractionSurface {
  const ui = interactionState(state);
  const current = Object.values(ui.surfaces).find((surface) =>
    surface.conversationKey === key && surface.kind === "header" && !surface.frozen);
  if (current?.sessionId === sessionId) return current;
  if (current) {
    current.frozen = "Focus changed. Use the current session header or Inbox. Existing task replies still keep their original destination.";
    current.revision++;
    touchSurface(current, true);
  }
  return newSurface(state, key, "header", { sessionId });
}

export function surfaceConversation(state: BridgeState, surface: InteractionSurface): ConversationRecord {
  const conversation = state.conversations[surface.conversationKey];
  if (!conversation) throw new UserError("This card's conversation is no longer available.");
  const context: ConversationRecord = {
    ...conversation, actionVersion: 2, surfaceId: surface.id, revision: surface.revision,
    view: "dashboard",
  };
  if (surface.sessionId) context.selectedId = surface.sessionId;
  else delete context.selectedId;
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
  const conversation = state.conversations[key];
  const reference = origin ?? conversation?.reference;
  if (!reference?.activityId) throw new UserError("The authenticated prompt activity ID is missing; nothing was sent.");
  const surface = newSurface(state, key, "turn", { sessionId, turnId: receiptId });
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
  for (const conversation of Object.values(state.conversations)) {
    touchSurface(inbox(state, conversation.key), [
      "user.message", "user_input.requested", "user_input.completed", "permission.requested", "permission.completed",
      "exit_plan_mode.requested", "exit_plan_mode.completed", "session.idle", "session.error", "session.task_complete",
      "session.shutdown", "abort", "bridge.app_admission_consumed", "bridge.app_admission_confirmed", "bridge.app_output_unavailable",
    ].includes(String(event.type)));
    if (session.kind !== "owned") continue;
    for (const pending of session.pending) {
      const existing = Object.values(ui.surfaces).find((surface) => surface.kind === "request" &&
        surface.conversationKey === conversation.key && surface.sessionId === session.id && surface.requestId === pending.id);
      if (!existing && (turn?.conversationKey === conversation.key || follows(state, conversation.key, session.id))) {
        newSurface(state, conversation.key, "request", {
          sessionId: session.id, requestId: pending.id, ...(turn ? { turnId: turn.id } : {}),
        });
      }
      for (const header of Object.values(ui.surfaces)) {
        if (header.kind === "header" && header.sessionId === session.id && !header.frozen) {
          touchSurface(header, ["user.message", "user_input.requested", "user_input.completed", "permission.requested", "permission.completed",
            "exit_plan_mode.requested", "exit_plan_mode.completed", "session.idle", "session.error", "session.task_complete",
            "session.shutdown", "abort", "bridge.app_admission_consumed", "bridge.app_admission_confirmed", "bridge.app_output_unavailable"].includes(String(event.type)));
        }
      }
    }
  }
  for (const surface of Object.values(ui.surfaces)) {
    if (surface.kind === "request" && surface.sessionId === session.id && !surface.frozen &&
      !session.pending.some((pending) => pending.id === surface.requestId)) {
      surface.frozen = event.type === "abort" || event.type === "session.shutdown" ? "Request cancelled." : "Request resolved.";
      surface.revision++;
      touchSurface(surface, true);
    }
  }
}

export function renderInteractionSurface(
  state: BridgeState, surface: InteractionSurface, cards: Cards, now = Date.now(),
): Card {
  const context = surfaceConversation(state, surface);
  const action = (title: string, scope: Parameters<Cards["scopedAction"]>[2]) => cards.scopedAction(context, title, scope);
  const session = state.sessions[surface.sessionId ?? ""];
  const title = session ? safeText(sourceTitle(session, state.sessions), 180) : "Copilot Sessions";
  if (surface.frozen) return card([block(title, { weight: "Bolder" }), block(surface.frozen)]);
  if (surface.kind === "inbox") {
    const conversation = state.conversations[surface.conversationKey]!;
    const sources = Object.values(state.sessions).filter((source) => source.kind !== "controller");
    const waiting = sources.filter((source) => source.pending.length && source.kind === "owned" && source.status !== "offline");
    const running = sources.filter((source) => source.status === "busy" && source.executionObserved !== false &&
      (source.peerSource !== "app" || (source.liveUntil ?? 0) > now));
    const completed = Object.values(state.interaction?.turns ?? {}).filter((turn) =>
      turn.conversationKey === conversation.key && turn.state === "done").sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    const recent = [...waiting, ...running, ...completed.flatMap((turn) => state.sessions[turn.sessionId] ? [state.sessions[turn.sessionId]!] : [])];
    const visible = [...new Map(recent.map((source) => [source.id, source])).values()].slice(0, 3);
    const selected = state.sessions[conversation.selectedId ?? ""];
    const body = [
      block("Copilot Sessions - Inbox", { size: "Medium", weight: "Bolder" }),
      block("Send work in the Teams composer. Use buttons or !commands for control.", { size: "Small" }),
      block(state.interaction?.capabilityNotice ?? "Focus mode. Preview operations are unavailable.", { size: "Small" }),
      block(conversation.selectionBlocked ? "Destination unresolved. Nothing new will be sent until you select a valid source."
        : selected ? `Next message -> ${selected.name} (${selected.id.slice(0, 8)})` : "No target selected. Choose a session before sending."),
      block(`Needs you: ${waiting.length} | Running: ${running.length} | Recently done: ${completed.length}`),
      block("App pending questions/approvals are unknown. Check the original host.", { size: "Small", isSubtle: true }),
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
        block(source.pending.length ? "Needs your response" : source.status === "busy" ? "Running" : "Result available", { size: "Small" }),
        { type: "ActionSet", actions: [action("Open", { op: "open-source", targetId: source.id })] },
      ],
    });
    const readOnly = sources.filter((source) => source.access?.send === false || source.kind === "saved" || source.kind === "unavailable" ||
      source.peerSource === "app" && (source.liveUntil ?? 0) <= now).length;
    body.push(block(`${sources.length} sessions | ${readOnly} read-only`, { size: "Small" }));
    return card(body, [
      action("New task", { op: "view", argument: "new" }),
      action("All sessions", { op: "view", argument: "sessions" }),
      action("Notifications", { op: "view", argument: "subscriptions" }),
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
    return session && pending ? cards.requestSurface(context, session, pending)
      : card([block(title, { weight: "Bolder" }), block("Already resolved. No response was sent.")]);
  }
  if (surface.kind === "header") {
    const header = cards.render({ ...state, conversations: { ...state.conversations, [context.key]: context } }, context.key);
    header.body.splice(1, 0, block(`Next message -> ${title}`, { weight: "Bolder" }),
      block(followDescription(state, context.key, surface.sessionId!), { size: "Small" }));
    header.actions = [...(header.actions ?? []), action("Change next target", { op: "view", argument: "sessions" })];
    if (Buffer.byteLength(JSON.stringify(header)) > 27_000) return card([
      block(`Next message -> ${title}`, { weight: "Bolder" }),
      block("Details exceed Teams' card budget. Pending requests have separately scoped cards; use History for source content."),
    ], [action("History", { op: "history-source", targetId: surface.sessionId! }),
      action("Change next target", { op: "view", argument: "sessions" }), action("Inbox", { op: "inbox" })]);
    return header;
  }
  if (surface.kind === "turn") {
    const turn = state.interaction?.turns[surface.turnId ?? ""];
    if (!turn) throw new UserError("This turn is no longer available.");
    const labels: Record<InteractionTurn["state"], string> = {
      admitting: "Sending - acceptance not yet known",
      accepted: "Accepted - queued; execution not yet observed",
      executing: "Running",
      waiting: "Needs your response",
      result: "Result available - task completion not yet confirmed",
      done: "Done - Teams result delivery is tracked separately",
      failed: "Failed - inspect the source",
      stopped: "Stopped",
      uncertain: turn.messageId ? "Accepted - observation interrupted or unconfirmed; do not resend"
        : "May have been accepted - check the original host; do not resend",
    };
    const minutes = Math.max(0, Math.floor(((turn.finishedAt ?? now) - turn.at) / 60_000));
    const queued = Object.values(state.interaction?.turns ?? {}).filter((candidate) =>
      candidate.sessionId === turn.sessionId && candidate.state === "accepted").length;
    const body = [
      block(`${labels[turn.state]} - ${title}`, { weight: "Bolder" }),
      block(`Target: ${turn.sessionId}`, { size: "Small" }),
      block(`Task receipt: ${turn.id.slice(0, 8)}`, { size: "Small" }),
      block(`${minutes} min | ${turn.intent ?? "Progress is shown only when correlated to this request."}`, { size: "Small" }),
      ...turn.steps.map((step) => block(`${step.state}: ${step.name}`, { size: "Small" })),
      block(`Tracked queue: ${queued} waiting (not a host-wide count)`, { size: "Small" }),
      block(followDescription(state, turn.conversationKey, turn.sessionId, now), { size: "Small" }),
    ];
    return card(body, [
      action("History", { op: "history-source", targetId: turn.sessionId }),
      action("Change next target", { op: "view", argument: "sessions" }),
      action(follows(state, turn.conversationKey, turn.sessionId, now) ? "Mute" : "Follow", {
        op: follows(state, turn.conversationKey, turn.sessionId, now) ? "mute" : "follow", targetId: turn.sessionId,
      }),
      action("Inbox", { op: "inbox" }),
    ]);
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
  return card([
    block(`${item.eventId.startsWith("error:") ? "Source reported an error" : turn?.state === "done" ? "Done" : "New reply"} - ${item.publication?.title ?? title}`, { weight: "Bolder" }),
    block(safeText(turn?.summary ?? item.text, 600), {}, 800),
    ...(turn ? [block(`Task receipt: ${turn.id.slice(0, 8)} - original Teams prompt`, { size: "Small" })] : []),
    block(`Source: ${item.sessionId}`, { size: "Small" }),
  ], [
    action("Show full", { op: "show-full", targetId: item.sessionId, argument: item.id }),
    action("Open", { op: "open-source", targetId: item.sessionId }),
  ]);
}
