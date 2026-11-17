import type {
  AppAdmission, BridgeState, Card, ConversationPreview, ConversationRecord, ModelChoice, PendingRequest, SessionRecord, TimelineEntry, Workspace,
} from "./domain.js";
import { Actions, type ActionScope } from "./actions.js";
import { appAdmissionNotice, isSessionListView, viewTarget } from "./domain.js";
import { mergeDialoguePreview } from "./projection.js";
import { chunkText, digest, safeText } from "./safety.js";
import { conversationDialogue, sourceTitle } from "./conversation-ui.js";

const pageSize = 3;
const modelPageSize = 20;
const statusNames = { idle: "Ready", busy: "Working", awaiting: "Needs reply", offline: "Offline", error: "Failed" } as const;

function freshEndpoint(session: SessionRecord, now: number): boolean {
  return session.peerSource !== "app" || (session.liveUntil !== undefined && session.liveUntil > now);
}

function activityRank(session: SessionRecord, now: number): number {
  if (session.kind === "saved" || session.kind === "unavailable" ||
    !freshEndpoint(session, now)) return 2;
  return session.status === "busy" || session.status === "awaiting" ? 0 : session.status === "idle" ? 1 : 2;
}

function compareSessions(a: SessionRecord, b: SessionRecord, now: number): number {
  const rank = activityRank(a, now) - activityRank(b, now);
  if (rank) return rank;
  const time = (session: SessionRecord) => {
    const parsed = Date.parse(session.lastConversationAt ?? "");
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };
  const recentA = time(a);
  const recentB = time(b);
  return recentA === recentB ? a.id.localeCompare(b.id) : recentA > recentB ? -1 : 1;
}

export function block(text: string, extra: Record<string, unknown> = {}, limit = 4000): Record<string, unknown> {
  return { type: "TextBlock", text: safeText(text, limit), wrap: true, ...extra };
}

export function card(body: Record<string, unknown>[], actions?: Record<string, unknown>[]): Card {
  return {
    type: "AdaptiveCard", version: "1.5", $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body, ...(actions ? { actions } : {}),
  };
}

export function inputSuffix(requestId: string): string {
  return digest(requestId).slice(0, 12);
}

export function transcriptPages(entries: TimelineEntry[]): string[] {
  const pages: string[] = [];
  let page = "";
  let messages = 0;
  const flush = () => { if (page) pages.push(page); page = ""; messages = 0; };
  for (const entry of conversationDialogue(entries)) {
    const label = entry.kind === "user" ? "You" : "Copilot";
    const message = `**${label}**\n\n${entry.text}`;
    if (Buffer.byteLength(message) > 7000) {
      flush();
      pages.push(...chunkText(message, 7000));
      continue;
    }
    if (messages >= 4 || Buffer.byteLength(page + "\n\n" + message) > 7000) flush();
    page += (page ? "\n\n" : "") + message;
    messages++;
  }
  flush();
  return pages;
}

export function latestTranscriptPage(entries: TimelineEntry[]): number {
  return Math.max(0, transcriptPages(entries).length - 1);
}

function notificationState(state: BridgeState, key: string, id: string): Record<string, unknown> {
  const preference = state.interaction?.follows[digest(`${key}:${id}`)];
  if (state.interaction) {
    const subscription = state.subscriptions[digest(`${key}:${id}`)];
    const active = preference && preference.mode !== "muted" && (preference.expiresAt === undefined || preference.expiresAt > Date.now());
    const label = !active ? "Muted" : subscription?.enabled && subscription.status === "paused" ? "Following paused"
      : preference.observation === "live" ? "Following - live only" : preference.observation === "unavailable" ? "Following unavailable" : "Following";
    return block(`Notifications: ${label}`, { id: `notification-state-${id}`, size: "Default", weight: "Bolder", spacing: "Small" });
  }
  const subscription = state.subscriptions[digest(`${key}:${id}`)];
  const active = subscription?.enabled && subscription.status === "watching";
  const paused = subscription?.enabled && subscription.status === "paused";
  return block(`Notifications: ${active ? "Subscribed" : paused ? "Paused" : "Not subscribed"}`, {
    id: `notification-state-${id}`, size: "Default", weight: "Bolder",
    color: active ? "Good" : paused ? "Warning" : "Default", spacing: "Small",
  });
}

function timeline(entries: TimelineEntry[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  let tools: TimelineEntry[] = [];
  const flush = () => {
    if (!tools.length) return;
    result.push(block(`Tools: ${tools.filter((entry) => entry.state === "done").length}/${tools.length} completed`, { weight: "Bolder" }));
    result.push(...tools.map((entry) => block(`${entry.state ?? "running"} | ${safeText(entry.text, 350)}`, { size: "Small", isSubtle: true })));
    tools = [];
  };
  for (const entry of entries.slice(-8)) {
    if (entry.kind === "tool") { tools.push(entry); continue; }
    flush();
    result.push(block(`${entry.kind}${entry.phase ? `/${entry.phase}` : ""}${entry.state ? ` - ${entry.state}` : ""}`, {
      weight: "Bolder", size: "Small", color: entry.state === "failed" ? "Attention" : "Default",
    }));
    result.push(block(safeText(entry.text, 350), { size: "Small" }));
  }
  flush();
  return result.length ? result : [block("No visible native events yet.", { isSubtle: true })];
}

interface SessionAppearance {
  text: string;
  color: "Good" | "Accent" | "Warning" | "Attention" | "Default";
  symbol: string;
  check: boolean;
}

function sessionStatus(session: SessionRecord, now: number): SessionAppearance {
  const status = (text: string, color: SessionAppearance["color"], symbol: string, check = false) => ({ text, color, symbol, check });
  if (session.kind === "controller" && session.status === "offline") return status("Control starts on demand", "Default", "○");
  if (session.peerSource === "app" && session.liveUntil !== undefined && session.liveUntil <= now) {
    return status("Status needs refresh", "Warning", "?", true);
  }
  if (session.peerSource === "app" && session.capability.includes("endpoint status is unknown")) {
    return status("Status unavailable", "Warning", "?", true);
  }
  if (session.status === "offline" && session.peerSource !== "app" && session.kind !== "saved" && session.kind !== "unavailable") return status("Not connected", "Default", "○");
  if (hasPendingReply(session, now)) return status("Needs reply", "Warning", "▲");
  if (session.status === "awaiting") return status("Waiting status unverified", "Warning", "?", true);
  if (session.status === "error") return status("Session error", "Attention", "!", true);
  if (session.kind === "owned" && session.status === "busy" && session.executionObserved === false) {
    return status("Queued · Execution not observed", "Warning", "○");
  }
  if (session.kind === "saved" || session.kind === "unavailable") return status(session.access?.read === false ? "Metadata only" : "History only", "Default", "○");
  if (session.peerSource === "app" && session.access?.read === false) return status("History unavailable · Sending disabled", "Default", "○", true);
  if (session.peerSource === "app" && (!freshEndpoint(session, now) || session.access?.send === false)) {
    return status(!freshEndpoint(session, now) ? "Offline · History only" : "Read-only · History only", "Default", "○", true);
  }
  if (session.status === "offline") return status("Offline · History only", "Default", "○", true);
  if (session.access?.send === false) return status("Read-only · History only", "Default", "○", true);
  return status(statusNames[session.status], session.status === "busy" ? "Accent" : "Good", "●");
}

function statusBlock(status: SessionAppearance, prefix = ""): Record<string, unknown> {
  return block(`${prefix}${status.symbol} ${status.text}`, { weight: "Bolder", color: status.color, spacing: "Small" });
}

function hasPendingReply(session: SessionRecord, now: number): boolean {
  return session.pending.length > 0 && session.status !== "offline" && freshEndpoint(session, now) &&
    (session.kind === "owned" || session.kind === "peer" || session.kind === "controller");
}

function isWorking(session: SessionRecord, now: number): boolean {
  return (session.kind === "owned" || session.kind === "peer") && freshEndpoint(session, now) &&
    session.status === "busy" && !session.pending.length &&
    (session.kind !== "owned" || session.executionObserved !== false);
}

export function sessionListPage(state: BridgeState, conversation: ConversationRecord, now = Date.now()): {
  sessions: SessionRecord[]; page: number; pages: number; total: number;
} {
  const query = conversation.query?.trim().toLocaleLowerCase() ?? "";
  const notificationSources = [...Object.values(state.subscriptions),
    ...Object.values(state.interaction?.follows ?? {}).map((entry) => ({
      ...entry, enabled: entry.mode !== "muted" && (entry.expiresAt === undefined || entry.expiresAt > now),
    }))];
  const uniqueNotifications = [...new Map(notificationSources.map((entry) => [entry.id, entry])).values()];
  const missing: SessionRecord[] = conversation.view === "subscriptions" ? uniqueNotifications
    .filter((item) => item.enabled && item.conversationKey === conversation.key && !state.sessions[item.sessionId])
    .map((item) => ({
      id: item.sessionId, name: `Unavailable source ${item.sessionId.slice(0, 8)}`, kind: "unavailable", status: "offline",
      workspace: "", capability: "The original source is unavailable. You can unsubscribe without opening its history.",
      access: { read: false, send: false }, timeline: [], pending: [], seenEvents: [], sequence: 0, updatedAt: 0,
    })) : [];
  const sorted = [...Object.values(state.sessions), ...missing].filter((session) => session.kind !== "controller" &&
    (!query || session.name.toLocaleLowerCase().includes(query)) &&
    (conversation.view !== "sides" || session.sideChat?.parentId === conversation.sideParentId) &&
    (conversation.view !== "subscriptions" || uniqueNotifications.some((item) =>
      item.conversationKey === conversation.key && item.sessionId === session.id && item.enabled)) &&
    (conversation.view !== "working" || isWorking(session, now)) &&
    (conversation.view !== "needs-reply" || hasPendingReply(session, now)))
    .sort((a, b) => compareSessions(a, b, now));
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(conversation.page, pages - 1);
  return { sessions: sorted.slice(page * pageSize, (page + 1) * pageSize), pages, page, total: sorted.length };
}

function recency(timestamp: string | undefined, now: number): string {
  const time = Date.parse(timestamp ?? "");
  if (!Number.isFinite(time)) return "Conversation time unknown";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes >= 0 && minutes < 1) return "just now";
  if (minutes > 0 && minutes < 60) return `${minutes} min ago`;
  if (minutes >= 60 && minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  return new Date(time).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function admissionStatus(state: BridgeState, admission: AppAdmission): { text: string; attention: boolean; check: boolean } {
  const results = state.outbox.filter((item) => item.admissionId === admission.id && admission.resultIds.includes(item.eventId));
  if (admission.phase === "confirmed") {
    if (admission.resultIds.length && admission.resultIds.every((id) => results.some((item) => item.eventId === id)) &&
      results.every((item) => item.status === "sent" && item.activityId)) return { text: "Reply delivered", attention: false, check: false };
    if (results.some((item) => item.status === "uncertain")) return { text: "Result confirmed · Delivery uncertain", attention: true, check: true };
    if (results.some((item) => item.status === "rejected")) return { text: "Result confirmed · Delivery rejected", attention: true, check: true };
    return { text: "Result confirmed · Delivery pending", attention: false, check: false };
  }
  if (admission.observation !== "watching") return {
    text: admission.observation === "timed_out" ? "Reply unconfirmed · Observation timed out"
      : admission.observation === "interrupted" ? "Reply unconfirmed · Observation interrupted" : "Reply unconfirmed · Check failed",
    attention: true, check: true,
  };
  return {
    text: admission.phase === "executing" ? "Execution observed · Waiting for reply" : "Queued · Execution not yet observed",
    attention: false, check: false,
  };
}

export class Cards {
  constructor(
    private readonly actions: Actions,
    private readonly workspaces: Workspace[],
    private readonly cardActions: "submit" | "execute" = "submit",
  ) {}

  scopedAction(conversation: ConversationRecord, title: string, scope: ActionScope, inputs = false): Record<string, unknown> {
    return this.execute(conversation, title, scope, inputs);
  }

  newSessionInputs(): Record<string, unknown>[] {
    return [
      { type: "Input.Text", id: "sessionName", label: "Session name", isRequired: true, maxLength: 100, errorMessage: "Enter a name." },
      { type: "Input.ChoiceSet", id: "workspace", label: "Allowed workspace", isRequired: true,
        value: this.workspaces[0]?.id, choices: this.workspaces.map((workspace) => ({ title: workspace.name, value: workspace.id })) },
    ];
  }

  requestSurface(conversation: ConversationRecord, target: SessionRecord, pending: PendingRequest): Card {
    const body = [block(`${target.name} needs you`, { weight: "Bolder" }), block(target.id, { size: "Small" })];
    this.request(body, conversation, target, pending);
    return card(body, [this.execute(conversation, "Inbox", { op: "inbox" })]);
  }

  render(state: BridgeState, key: string, models: ModelChoice[] = [], transcript?: TimelineEntry[], context: {
    previews?: ReadonlyMap<string, ConversationPreview>;
    connection?: "connected" | "ready" | "unavailable";
    previewFailures?: ReadonlySet<string>;
    discoveryStatus?: string;
  } = {}): Card {
    const conversation = state.conversations[key];
    if (!conversation) throw new Error("Cannot render an unknown conversation");
    const execute = (title: string, scope: ActionScope, inputs = false) => this.execute(conversation, title, scope, inputs);
    const owned = Object.values(state.sessions).filter((session) => session.kind !== "controller");
    const target = state.sessions[viewTarget(state, conversation) ?? ""];
    const selected = state.sessions[conversation.selectedId ?? ""];
    const control = target?.kind === "controller";
    const now = Date.now();
    const readOnly = selected && (selected.access?.send === false || selected.kind === "saved" || selected.kind === "unavailable" ||
      selected.kind === "peer" && selected.status === "offline" ||
      !freshEndpoint(selected, now));
    const status = target ? sessionStatus(target, now) : undefined;
    const admissions = Object.values(state.admissions).filter((admission) =>
      admission.conversationKey === key && admission.sessionId === selected?.id)
      .sort((a, b) => b.acceptedAt - a.acceptedAt || a.id.localeCompare(b.id));
    const latestAdmission = admissions[0];
    const sendStatus = latestAdmission ? admissionStatus(state, latestAdmission) : undefined;
    const olderUnconfirmed = admissions.slice(1).filter((admission) => admission.phase !== "confirmed").length;
    const unknown = Object.values(state.receipts).findLast((receipt) =>
      receipt.conversationKey === key && receipt.operation === "send" && !receipt.admissionId && receipt.status === "uncertain");
    const list = isSessionListView(conversation.view);
    const home = conversation.view === "home";
    const title = home ? "Copilot Sessions" : conversation.view === "sessions" ? "Sessions"
      : conversation.view === "working" ? "Working" : conversation.view === "needs-reply" ? "Needs reply"
        : conversation.view === "sides" ? "Side chats" : conversation.view === "subscriptions" ? "Subscriptions" : conversation.view === "new" ? "New session"
      : control ? "Control" : target ? sourceTitle(target, state.sessions) : conversation.selectedId ? "Source unavailable" : "Choose a session";
    const body: Record<string, unknown>[] = [block(title, { size: "Medium", weight: "Bolder", spacing: "None" })];
    if (conversation.selectionBlocked) body.push(block("Destination unresolved. New work is blocked until !use selects a valid source. The previous source is retained, not used.",
      { color: "Attention", weight: "Bolder" }));
    if (status && !list && !home && conversation.view !== "new") {
      body.push(statusBlock(status, control ? "Management history · " : conversation.view === "transcript" ? "History · " : conversation.view === "settings" ? "Settings · " : ""));
    }
    if (selected && (control || list)) {
      body.push(block(`${control ? "Tasks go to" : "Current"}: ${safeText(selected.name, 100)}${control && selected.status === "offline" && !readOnly ? " (not connected)" : ""}`,
        { size: "Small", color: control && readOnly ? "Attention" : "Default", isSubtle: true, spacing: "Small" }));
    }
    const subscription = target ? state.subscriptions[digest(`${key}:${target.id}`)] : undefined;
    const follow = target ? state.interaction?.follows[digest(`${key}:${target.id}`)] : undefined;
    const following = state.interaction ? Boolean(follow && follow.mode !== "muted" &&
      (follow.expiresAt === undefined || follow.expiresAt > now)) : Boolean(subscription?.enabled);
    if (target && !control && !home && !list && conversation.view !== "new") {
      body.push(notificationState(state, key, target.id));
      body.push(block(target.id, { size: "Small", fontType: "Monospace" }));
      if (subscription?.enabled && subscription.status === "paused") body.push(block(subscription.detail, { size: "Small", color: "Attention" }, 500));
    }
    if (target?.status === "error") {
      const error = target.timeline.findLast((entry) => entry.kind === "error");
      if (error) body.push(block(error.text, { color: "Attention", size: "Small" }, 500));
    }
    if ((home || conversation.view === "sides") && context.discoveryStatus &&
      /unavailable|not configured|disabled|unknown|needs/iu.test(context.discoveryStatus)) {
      body.push(block(context.discoveryStatus, { size: "Small", color: /unavailable|not configured|disabled/iu.test(context.discoveryStatus) ? "Warning" : "Default" }, 350));
    }
    const routineNotices = new Set([
      "Session list refreshed. Open a session to send a task.",
      "View switched. Other sessions were not stopped.",
      "Ordinary text goes unchanged to the selected working session.",
      "Choose a working session, or use Control.",
      "Persistent native session created. Send a task to begin.",
      "Search uses the current session list. Refresh to discover new sessions.",
      "Control view/history does not change the message destination. Ordinary text goes to the selected working session; only control: <instruction> (or /control <instruction>) invokes optional management.",
      "Control view/history does not change the message destination. Ordinary text goes to the selected working session; only /control <instruction> invokes optional management.",
      "CONTROL view: text is a management instruction. Switch to Current session to send ordinary work.",
      "Stop request acknowledged. History and other sessions are preserved.",
      "Stop request acknowledged. Other sessions are unaffected.",
      "Model capabilities loaded. Nothing has been changed in the working session yet.",
      "Subscribed from now. Earlier results are not sent.",
      "Unsubscribed. Already sent/sending/uncertain messages cannot be retracted.",
      ...admissions.map(appAdmissionNotice),
    ]);
    if (subscription?.enabled && subscription.status === "paused" && !control && !list) routineNotices.add(subscription.detail);
    let notice = "";
    let noticeAttention = false;
    const routine = /^(?:Native message |Peer owner accepted |Refreshed native state\.|Persistent native session created\.|Status checked|Response accepted for that exact native request\.)/u.test(conversation.notice) ||
      target?.settingsReceipt?.status === "applied" && conversation.notice.startsWith("Settings applied:") ||
      conversation.historyRead?.status === "queued" && conversation.notice.endsWith("Read-only history snapshot queued. Teams delivery is reported separately.");
    if (conversation.notice && !routineNotices.has(conversation.notice) && !routine) {
      const source = conversation.notice;
      notice = source.startsWith("Refreshing the session list.") ? "Refreshing sessions..."
        : source.startsWith("Host refresh is unavailable.") ? "Couldn't refresh sessions. Retained history is available."
          : source.startsWith("App live-status refresh failed") ? "Couldn't refresh status. Try Check status."
            : source.startsWith("Native message ") || source.startsWith("Peer owner accepted ") ? "Message accepted"
              : source.startsWith("Duplicate activity ignored.") ? "Duplicate ignored · No action repeated"
                : source.startsWith("This card action was already used.") ? "Already submitted · Previous outcome in More"
                  : source.startsWith("Refreshed native state.") ? "Status checked"
                    : source;
      noticeAttention = /\b(?:failed?|uncertain|unavailable|rejected?|expired|stale|invalid|error)\b|couldn't/iu.test(notice);
      body.push(block(notice.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "(details in More)"),
        { size: "Small", color: noticeAttention ? "Attention" : "Default" },
        conversation.notice.startsWith("Native chat sends ordinary text unchanged.") ? 800 : 180));
    }
    if (sendStatus && !list && !home && conversation.view !== "new" && !control && sendStatus.text !== "Reply delivered") {
      body.push(block(`${sendStatus.attention ? "! " : ""}${sendStatus.text}${sendStatus.attention || latestAdmission?.phase !== "confirmed" ? " · Do not resend" : ""}`,
        { color: sendStatus.attention ? "Attention" : "Warning", weight: "Bolder", spacing: "Small" }));
    }
    if (target?.settingsReceipt && (conversation.view === "settings" ||
      conversation.view === "dashboard" && target.settingsReceipt.status !== "applied")) {
      body.push(block(`Settings ${target.settingsReceipt.status}`, { size: "Small",
        color: target.settingsReceipt.status === "rejected" ? "Attention" : "Default" }));
    }
    const navigation: Record<string, unknown>[] = [];
    const excerpts: Record<string, unknown>[] = [];
    const check = () => execute(list || home ? "Refresh" : "Check status", { op: "refresh" });
    const history = () => execute("History", { op: "view", argument: "transcript", ...(target ? { targetId: target.id } : {}) });
    let checkOnMain = false;

    switch (conversation.view) {
      case "home": {
        body.push(block(context.connection === "unavailable" ? "? Bridge connection unavailable"
          : context.connection === "connected" ? "● Bridge connected" : "● Bridge ready",
        { weight: "Bolder", color: context.connection === "unavailable" ? "Warning" : "Good" }));
        if (selected) {
          body.push(block("Current session", { size: "Small", weight: "Bolder" }),
            block(sourceTitle(selected, state.sessions), { weight: "Bolder" }),
            block(selected.id, { size: "Small", fontType: "Monospace" }), statusBlock(sessionStatus(selected, now)),
            notificationState(state, key, selected.id));
          const currentSubscription = state.subscriptions[digest(`${key}:${selected.id}`)];
          if (currentSubscription?.enabled && currentSubscription.status === "paused") body.push(block(currentSubscription.detail, { size: "Small", color: "Attention" }, 500));
        }
        else body.push(block("Choose a session to read or send work. No task has been sent."));
        const working = owned.filter((session) => isWorking(session, now)).length;
        const awaiting = owned.filter((session) => hasPendingReply(session, now)).length;
        const unknownPending = owned.some((session) => session.kind !== "owned" || session.status === "offline" || session.status === "awaiting" && !session.pending.length);
        body.push(block(`${owned.length} sessions · ${working} working · ${awaiting} needs a reply`, { size: "Small" }));
        if (unknownPending) body.push(block("Other hosts' pending requests are unknown.", { size: "Small", color: "Warning" }));
        navigation.push(execute("Sessions", { op: "view", argument: "sessions" }),
          execute("Working", { op: "view", argument: "working" }),
          execute("Needs reply", { op: "view", argument: "needs-reply" }));
        break;
      }
      case "sessions":
      case "working":
      case "needs-reply":
      case "sides":
      case "subscriptions": {
        const query = conversation.query?.trim().toLocaleLowerCase() ?? "";
        const { sessions, pages, page } = sessionListPage(state, conversation, now);
        body.push(block(`Page ${page + 1} of ${pages}`, { size: "Small", isSubtle: true }));
        body.push({
          type: "Input.Text", id: "query", label: "Find a session", placeholder: "Search by name",
          value: conversation.query ?? "", maxLength: 100,
          inlineAction: execute("Search", { op: "filter" }, true),
        });
        for (const session of sessions) {
          const available = state.sessions[session.id] !== undefined;
          const unread = Math.max(0, session.sequence - (conversation.read[session.id] ?? 0));
          const rowStatus = sessionStatus(session, now);
          body.push({
            type: "ColumnSet", separator: true, spacing: "Medium",
            ...(available ? { selectAction: { ...execute("Open", { op: "select", targetId: session.id }), tooltip: `Open ${safeText(session.name, 100)}` } } : {}),
            columns: [
              { type: "Column", width: "stretch", items: [
                block(sourceTitle(session, state.sessions), { weight: "Bolder", spacing: "None", maxLines: 2 }),
                statusBlock(rowStatus),
                ...(state.subscriptions[digest(`${key}:${session.id}`)]?.enabled ? [notificationState(state, key, session.id)] : []),
                block(`${recency(session.lastConversationAt, now)}${unread ? " · New activity" : ""} · ${session.id.slice(0, 8)}`,
                  { size: "Small", isSubtle: true, spacing: "None" }),
                ...(() => {
                  if (context.previewFailures?.has(session.id)) return [
                    block("Conversation preview unavailable. Open History.", { size: "Small", color: "Warning" }),
                  ];
                  const preview = context.previews?.get(session.id);
                  const entries = mergeDialoguePreview(preview?.entries ?? [], session.timeline);
                  if (!entries.length) return [block(preview?.complete ? "No conversation yet." : "Conversation preview not loaded. Open History.",
                    { size: "Small", isSubtle: true })];
                  return entries.flatMap((entry, index) => {
                    const excerpt = block(entry.text, { id: `excerpt-${session.id}-${index}`, size: "Default", maxLines: 2, spacing: "Small" }, 600);
                    excerpts.push(excerpt);
                    return [block(entry.kind === "user" ? "Input · You" : "Output · Copilot", { size: "Small", weight: "Bolder" }), excerpt];
                  });
                })(),
              ] },
              { type: "Column", width: "auto", verticalContentAlignment: "Center", items: [
                ...(session.id === selected?.id ? [block("Current", { size: "Small", color: "Accent" })] : []),
                { type: "ActionSet", spacing: "None", actions: [
                  ...(available ? [{ ...execute("Open", { op: "select", targetId: session.id }), style: "default" }] : []),
                  ...(conversation.view === "subscriptions" ? [execute("Unsubscribe", { op: "unsubscribe", targetId: session.id })] : []),
                ] },
              ] },
            ],
          });
        }
        if (!sessions.length) body.push(block(query ? "No matching sessions. Clear the search to see all sessions."
          : conversation.view === "working" ? "No sessions are working."
            : conversation.view === "needs-reply" ? "No observed pending requests. Other hosts may not expose them."
              : conversation.view === "sides" ? "No verified side chats for this parent."
                : conversation.view === "subscriptions" ? "No enabled subscriptions. Subscribe to an exact source from its More menu."
              : "No sessions yet. Use More to create one."));
        navigation.push(
          ...(page > 0 ? [execute("Previous", { op: "page", argument: String(page - 1) })] : []),
          ...(page + 1 < pages ? [execute("Next", { op: "page", argument: String(page + 1) })] : []),
          execute("Home", { op: "view", argument: "home" }),
          ...(conversation.view === "sides" && conversation.sideParentId && state.sessions[conversation.sideParentId]
            ? [execute("Parent", { op: "select", targetId: conversation.sideParentId })]
            : [
              ...(!conversation.page && conversation.view !== "sessions" ? [execute("Sessions", { op: "view", argument: "sessions" })] : []),
              check(),
            ]),
        );
        break;
      }
      case "new":
        body.push(
          ...this.newSessionInputs(),
          block("Manual approvals stay on. No task runs until you send one.", { size: "Small", isSubtle: true }),
        );
        navigation.push(execute("Create", { op: "create" }, true), execute("Back", { op: "view", argument: selected ? "dashboard" : "sessions" }));
        break;
      case "settings":
        if (!target || target.kind !== "owned" || target.status === "offline") {
          body.push(block("Settings require a live bridge-owned working session. Foreign peers keep their own settings/approvals."));
        } else this.settings(body, conversation, target, models);
        navigation.push(execute("Back", { op: "view", argument: "dashboard" }));
        break;
      default:
        if (!target) {
          if (conversation.selectedId) body.push(block(conversation.selectedId, { size: "Small", fontType: "Monospace" }),
            notificationState(state, key, conversation.selectedId),
            block("Source metadata is unavailable. Use !sessions or !use to select a known source; !unsubscribe can still cancel its saved notifications."));
          else body.push(block("Choose a session with !sessions or !use before sending work."));
          navigation.push(execute("Sessions", { op: "view", argument: "sessions" }));
          break;
        }
        if (control) {
          if (selected && readOnly) {
            const availability = sessionStatus(selected, now).text;
            body.push(block(availability === "Status needs refresh" || availability === "Status unavailable"
              ? `Selected target: ${availability}. Sending is disabled until checked.`
              : "Selected working session is read-only. Its history remains available.", { size: "Small", color: "Attention" }),
            block("Optional explicit management: !control <instruction>.", { size: "Small", isSubtle: true }));
          } else {
            body.push(block("Use the native Teams chat box for tasks. Optional management requires !control <instruction>.", { size: "Small", isSubtle: true }));
            if (selected?.status === "offline") body.push(block("The selected working session is not connected. A new task explicitly reconnects it.", { size: "Small", isSubtle: true }));
          }
        } else if (target.kind === "owned" && target.status === "offline") {
          body.push(block("History is saved. Sending a new task or opening Settings reconnects this session.", { size: "Small", isSubtle: true }));
        } else if (readOnly && !status?.check) {
          body.push(block("This target cannot receive new tasks. History is still available.", { size: "Small", isSubtle: true }));
        }
        if (target.pending.length) {
          for (const pending of target.pending.slice(0, 3)) {
            this.request(body, conversation, target, pending);
          }
          if (target.pending.length > 3) body.push(block("Additional pending requests appear after these are resolved."));
        }
        if (conversation.view === "transcript") {
          const pages = transcriptPages(transcript ?? target.timeline);
          const page = Math.min(conversation.page, Math.max(0, pages.length - 1));
          body.push(block(`${page + 1} / ${Math.max(1, pages.length)}`, { size: "Small", isSubtle: true }));
          body.push(block(pages[page] ?? "No conversation yet.", { id: "transcript-page-text", size: "Default" }, Number.MAX_SAFE_INTEGER));
          navigation.push(
            ...(page > 0 ? [execute("Older", { op: "page", argument: String(page - 1), targetId: target.id })] : []),
            ...(page + 1 < pages.length ? [execute("Newer", { op: "page", argument: String(page + 1), targetId: target.id })] : []),
            execute("Back", { op: "view", argument: "dashboard" }),
          );
        } else {
          if (!control && conversation.view === "dashboard") {
            body.push(block("Use the Teams chat box to talk to this source. !sessions · !use <name or ID> · !history [1..50] · !status · !subscribe / !unsubscribe · !help",
              { size: "Small" }));
            const intent = conversation.historyRead;
            if (intent?.sessionId === target.id) {
              if (intent.superseded) body.push(block("The previous pending HISTORY snapshot was superseded by this read.", { size: "Small" }));
              const items = state.outbox.filter((item) => item.historyId === intent.id && item.conversationKey === key);
              const delivered = items.length > 0 && items.every((item) => item.status === "sent");
              if (!delivered) body.push(block(intent.status === "reading" ? "Reading HISTORY snapshot..."
                : intent.status === "failed" || intent.status === "interrupted" ? "HISTORY read incomplete. Use !history to explicitly request a new snapshot."
                  : items.some((item) => item.status === "uncertain" || item.status === "rejected") ? "HISTORY delivery unconfirmed. Already attempted parts are not resent."
                    : "HISTORY snapshot queued for chat delivery.",
              { size: "Small", color: intent.status === "failed" || intent.status === "interrupted" ||
                items.some((item) => item.status === "uncertain" || item.status === "rejected") ? "Warning" : "Default" }));
            }
          }
          checkOnMain = Boolean(status?.check || sendStatus?.check || noticeAttention);
          if (checkOnMain) body.push({ type: "ActionSet", id: "working-action", actions: [check()] });
          navigation.push(execute("Sessions", { op: "view", argument: "sessions" }));
          if (target.access?.read !== false) navigation.push(history());
        }
        const unread = owned.filter((session) => session.id !== target.id && session.sequence > (conversation.read[session.id] ?? 0));
        if (unread.length) body.push(block(`${unread.length} other session(s) have updates.`, { size: "Small", isSubtle: true }));
    }

    const details: Record<string, unknown>[] = [];
    const progress: Record<string, unknown> = { type: "Container", items: target ? timeline(target.timeline) : [] };
    const moreActions: Record<string, unknown>[] = [
      ...(!checkOnMain ? [check()] : []),
      ...(!home ? [execute("Home", { op: "view", argument: "home" })] : []),
      ...(selected && (home || list) ? [execute(list ? "Back" : "Current session", { op: "view", argument: "dashboard" })] : []),
      ...(!navigation.some((action) => action.title === "Sessions") && conversation.view !== "sessions"
        ? [execute("Sessions", { op: "view", argument: "sessions" })] : []),
      execute("New session", { op: "view", argument: "new" }),
      execute("Subscriptions", { op: "view", argument: "subscriptions" }),
      ...(target && target.kind !== "controller" ? [
        execute(state.interaction ? following ? "Mute" : "Follow" : subscription?.enabled ? "Unsubscribe" : "Subscribe",
          { op: following ? "unsubscribe" : "subscribe", targetId: target.id }),
        ...(target.sideChat?.parentId && state.sessions[target.sideChat.parentId]
          ? [execute("Parent", { op: "select", targetId: target.sideChat.parentId })] : []),
        ...(!target.sideChat ? [execute("Side chats", { op: "view", argument: "sides", targetId: target.id })] : []),
      ] : []),
      ...(target?.kind === "owned" ? [
        execute("Settings", { op: "view", argument: "settings" }),
        ...(target.status !== "offline" ? [execute("Stop turn", { op: "stop", targetId: target.id })] : []),
      ] : []),
      ...(!control ? [execute("Control", { op: "view", argument: "control" })] : []),
    ];
    for (let offset = 0; offset < moreActions.length; offset += 3) details.push({ type: "ActionSet", actions: moreActions.slice(offset, offset + 3) });
    if (target) {
      details.push(block("Session details", { weight: "Bolder" }),
        block(target.id, { size: "Small", fontType: "Monospace" }),
        block(target.capability, { size: "Small" }, 1200),
        block(`Last conversation: ${target.lastConversationAt ?? "(unknown)"}`, { size: "Small" }));
      if (target.settings) details.push({
        type: "FactSet", facts: [
          { title: target.status === "offline" ? "Saved mode" : "Native mode", value: target.settings.mode },
          { title: target.status === "offline" ? "Last known model" : "Actual model", value: target.settings.modelId ?? "(not selected)" },
          { title: "Reasoning effort", value: target.settings.effort ?? "(native default)" },
        ],
      });
      else if (target.kind === "peer") details.push({
        type: "FactSet", facts: [
          { title: "Peer model", value: target.peerModelId ?? "(not reported)" },
          { title: "Mode / effort", value: "Not exposed by peer management API" },
        ],
      });
      if (target.settingsReceipt) details.push(block(`Settings ${target.settingsReceipt.status}: ${target.settingsReceipt.detail}`, { size: "Small" }));
      details.push(block("Progress", { weight: "Bolder" }), progress);
    }
    if (conversation.notice && !admissions.some((admission) => appAdmissionNotice(admission) === conversation.notice)) {
      details.push(block("Last operation", { weight: "Bolder" }), block(conversation.notice, { size: "Small" }, 1400));
    }
    for (const admission of admissions.slice(0, 3)) {
      details.push(block(`App instruction ${admission.id.slice(0, 8)}`, { weight: "Bolder" }),
        block(admissionStatus(state, admission).text, { size: "Small" }),
        block(appAdmissionNotice(admission), { size: "Small" }),
        block(`Native message: ${admission.messageId}`, { size: "Small", fontType: "Monospace" }));
      const results = state.outbox.filter((item) => item.admissionId === admission.id && admission.resultIds.includes(item.eventId));
      if (results.length) details.push(block("Teams result delivery: " +
        results.map((item) => `${item.status}${item.activityId ? ` (${item.activityId})` : ""}`).join(", "), { size: "Small" }, 1600));
    }
    if (unknown) details.push(block("Older send unconfirmed", { weight: "Bolder" }),
      block("No confirmed native message ID. Execution/result remain unknown; this older request cannot be reconciled or replayed.", { size: "Small" }),
      block(unknown.detail, { size: "Small" }, 800));
    if (olderUnconfirmed) details.push(block(`${olderUnconfirmed} earlier instruction(s) unconfirmed`, { size: "Small" }));
    if (!list) navigation.push({ type: "Action.ShowCard", title: "More", card: card(details) });
    const result = card(body, navigation);
    if (Buffer.byteLength(JSON.stringify(result)) > 27_000) {
      progress.items = [block("Recent progress omitted to fit Teams' card limit." +
        (target?.access?.read !== false ? " Read History for visible events." : ""), { size: "Small", isSubtle: true })];
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 27_000) {
      for (const excerpt of excerpts) if (typeof excerpt.text === "string") excerpt.text = safeText(excerpt.text, 200);
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 27_000) {
      return card([
        block(title, { weight: "Bolder" }),
        ...(status ? [block(status.text, { size: "Small" })] : []),
        ...(sendStatus ? [block(sendStatus.text, { size: "Small" })] : []),
        ...(target && target.kind !== "controller" ? [notificationState(state, key, target.id)] : []),
        ...(target || conversation.selectedId ? [block(target?.id ?? conversation.selectedId!, { size: "Small", fontType: "Monospace" })] : []),
        block("Details exceed Teams' card budget. Open History for the full conversation."),
      ], [
        execute("Sessions", { op: "view", argument: "sessions" }),
        history(),
      ]);
    }
    return result;
  }

  private execute(conversation: ConversationRecord, title: string, scope: ActionScope, inputs = false): Record<string, unknown> {
    const data = { token: this.actions.issue(conversation, scope) };
    if (this.cardActions === "submit") {
      return { type: "Action.Submit", title, data, associatedInputs: inputs ? "auto" : "none" };
    }
    return {
      type: "Action.Execute", title, verb: "bridge", data, associatedInputs: inputs ? "auto" : "none",
      fallback: { type: "Action.Submit", title, data, associatedInputs: inputs ? "auto" : "none" },
    };
  }

  private settings(body: Record<string, unknown>[], conversation: ConversationRecord, target: SessionRecord, models: ModelChoice[]): void {
    const currentChoices = models.filter((model) => model.id === target.settings?.modelId);
    const currentModel = currentChoices.find((model) => model.providerId === target.settings?.providerId) ??
      (!target.settings?.providerId && currentChoices.length === 1 && currentChoices[0]?.providerKind === "copilot"
        ? currentChoices[0] : undefined);
    const selected = models.find((model) => model.key === conversation.modelKey) ??
      currentModel;
    body.push(block("Selected working session settings", { weight: "Bolder" }));
    if (!models.length) {
      body.push(block("The native catalogue is unavailable. No hardcoded model or compatibility fallback is offered."));
      return;
    }
    const page = Math.min(conversation.page, Math.max(0, Math.ceil(models.length / modelPageSize) - 1));
    const pageModels = models.slice(page * modelPageSize, (page + 1) * modelPageSize);
    if (selected && !pageModels.some((item) => item.key === selected.key)) pageModels.unshift(selected);
    body.push({
      type: "Input.ChoiceSet", id: "modelKey", label: `Live model catalogue (${models.length} models)`,
      ...(selected ? { value: selected.key } : {}), isRequired: true,
      choices: pageModels.map((model) => ({ title: `${model.name}${model.providerId ? ` [${model.providerId}]` : ""}`, value: model.key })),
    });
    body.push({ type: "ActionSet", actions: [
      this.execute(conversation, "Load options", { op: "pick-model" }, true),
      ...(page > 0 ? [this.execute(conversation, "Previous models", { op: "page", argument: String(page - 1) })] : []),
      ...((page + 1) * modelPageSize < models.length ? [this.execute(conversation, "More models", { op: "page", argument: String(page + 1) })] : []),
    ] });
    if (!selected) return;
    body.push({
      type: "Input.ChoiceSet", id: "mode", label: "Native session mode", value: target.settings?.mode ?? "interactive",
      choices: ["interactive", "plan", "autopilot"].map((mode) => ({ title: mode, value: mode })),
    });
    body.push({
      type: "Input.ChoiceSet", id: "effort", label: "Advertised reasoning effort",
      value: selected.efforts.includes(target.settings?.effort ?? "") ? target.settings?.effort : "__default__",
      choices: [
        { title: "Native default (clear override)", value: "__default__" },
        ...selected.efforts.map((effort) => ({ title: effort, value: effort })),
      ],
    });
    body.push(block("Load capabilities after choosing another model. Busy sessions reject changes. The card reports actual native readback, not a local preference.", { size: "Small" }));
    body.push({ type: "ActionSet", actions: [this.execute(conversation, "Apply", {
      op: "settings", targetId: target.id, argument: selected.key,
    }, true)] });
  }

  private request(body: Record<string, unknown>[], conversation: ConversationRecord, target: SessionRecord, pending: PendingRequest): void {
    const label = pending.kind === "input" ? "Question" : pending.kind === "permission" ? "Approval" : "Plan";
    body.push(block(`${label}: ${safeText(pending.title, 800)}`, { size: "Small", color: "Attention" }));
    if (target.kind === "peer" || target.kind === "unavailable") {
      body.push(block("Answer in the owning host. Peer messages are not human approvals.", { size: "Small" }));
      return;
    }
    const suffix = inputSuffix(pending.id);
    const scope = { op: "answer", targetId: target.id, requestId: pending.id } as const;
    const form: Record<string, unknown>[] = [block(safeText(pending.title, 2400))];
    if (pending.choices.length) form.push({
      type: "Input.ChoiceSet", id: `choice_${suffix}`, label: pending.kind === "plan" ? "Native continuation action" : "Choice",
      choices: pending.choices.map((choice, index) => ({ title: safeText(choice, 100), value: String(index) })),
    });
    if (pending.allowFreeform) form.push({
      type: "Input.Text", id: `text_${suffix}`, label: pending.kind === "plan" ? "Feedback (optional)" : "Freeform answer", isMultiline: true, maxLength: 4000,
    });
    const submit = this.execute(conversation, pending.kind === "permission" ? "Approve once" : pending.kind === "plan" ? "Approve plan" : "Answer", {
      ...scope, argument: "accept",
    }, true);
    const decline = this.execute(conversation, pending.kind === "input" ? "Skip question" : pending.kind === "permission" ? "Deny" : "Request changes", {
      ...scope, argument: "decline",
    }, true);
    body.push({
      type: "ActionSet", actions: [{
        type: "Action.ShowCard", title: pending.kind === "input" ? "Answer question" : `Review ${label.toLowerCase()}`,
        card: card(form, [submit, decline]),
      }],
    });
  }
}
