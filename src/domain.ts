import type { ConversationReference } from "@microsoft/agents-activity";
import type { SessionMode, Tool } from "@github/copilot-sdk";

export type Mode = SessionMode;
export type SessionKind = "owned" | "controller" | "saved" | "peer" | "unavailable";
export type SessionStatus = "idle" | "busy" | "awaiting" | "error" | "offline";
export type View = "home" | "dashboard" | "sessions" | "working" | "needs-reply" | "sides" | "subscriptions" | "new" | "settings" | "control" | "transcript";
export type SessionListView = "sessions" | "working" | "needs-reply" | "sides" | "subscriptions";

export function isSessionListView(view: string | undefined): view is SessionListView {
  return view === "sessions" || view === "working" || view === "needs-reply" || view === "sides" || view === "subscriptions";
}

export interface ModelChoice {
  key: string;
  id: string;
  name: string;
  providerId?: string;
  providerKind?: string;
  efforts: string[];
}

export interface Settings {
  mode: Mode;
  modelId?: string;
  providerId?: string;
  effort?: string;
}

export interface SettingsChange {
  mode: Mode;
  modelKey: string;
  effort?: string;
}

export interface SettingsResult {
  status: "applied" | "queued" | "accepted" | "rejected";
  actual: Settings;
  detail: string;
  expected?: Settings;
}

export interface PendingRequest {
  id: string;
  kind: "input" | "permission" | "plan";
  title: string;
  choices: string[];
  allowFreeform: boolean;
}

export interface Answer {
  choice?: number;
  text?: string;
  approve?: boolean;
  skip?: boolean;
}

export interface TimelineEntry {
  id: string;
  kind: "user" | "assistant" | "tool" | "agent" | "input" | "permission" | "plan" | "task" | "error" | "status";
  text: string;
  timestamp?: string;
  phase?: "commentary" | "final";
  state?: "running" | "done" | "failed" | "answered" | "skipped" | "waiting" | "cancelled";
}

export interface SessionAccess {
  read: boolean;
  send: boolean;
}

export interface AppSessionLiveness {
  id: string;
  status: "idle" | "busy";
  liveUntil: number;
}

export function appSessionCapability(readable: boolean, direct: boolean): string {
  return "Copilot App session: fixed local discovery; " +
    (readable ? "root history is readable; " : "local history is unavailable; ") +
    (direct && readable ? "new instructions use its live local endpoint with output observation. "
      : direct ? "live endpoint found, but safe sends are blocked without a readable history baseline. "
        : "no live endpoint: new instructions/offline wake are unavailable. ") +
    "Mode/model/stop/approvals remain in the owning App session.";
}

export interface SessionRecord {
  id: string;
  name: string;
  kind: SessionKind;
  status: SessionStatus;
  executionObserved?: boolean;
  workspace: string;
  settings?: Settings;
  settingsReceipt?: SettingsResult;
  capability: string;
  timeline: TimelineEntry[];
  pending: PendingRequest[];
  seenEvents: string[];
  sequence: number;
  updatedAt: number;
  lastConversationAt?: string;
  liveUntil?: number;
  peerStatePath?: string;
  peerModelId?: string;
  peerSource?: "app";
  access?: SessionAccess;
  sideChat?: { parentId?: string };
  subscriptionSupported?: boolean;
}

export interface ConversationRecord {
  key: string;
  reference: ConversationReference;
  selectedId?: string;
  selectionBlocked?: boolean;
  revision: number;
  view: View;
  page: number;
  query?: string;
  modelKey?: string;
  dashboardId?: string;
  dashboardState?: "sending" | "ready" | "uncertain" | "rejected";
  transcriptId?: string;
  notice: string;
  read: Record<string, number>;
  surfaceId?: string;
  sideParentId?: string;
  historyRead?: {
    id: string;
    sessionId: string;
    count: number;
    receiptIds: string[];
    status: "reading" | "queued" | "failed" | "interrupted";
    superseded?: boolean;
  };
}

export interface ConversationPreview {
  entries: TimelineEntry[];
  complete: boolean;
}

interface ReplyGroup {
  title: string;
  groupId: string;
  part: number;
  parts: number;
}

export type ReplyPresentation = ReplyGroup & (
  { version: 2; kind: "session" | "background" | "control" } |
  { version: 3; kind: "session" | "background" | "control" | "history"; sourceId: string; format: "markdown" | "plain" } |
  { version: 4; kind: "session" | "background" | "control" | "history"; sourceId: string; format: "markdown" | "xml" }
);
export type ReplyGroupPresentation = Omit<Extract<ReplyPresentation, { version: 2 }>, "part" | "parts"> |
  Omit<Extract<ReplyPresentation, { version: 3 }>, "part" | "parts"> |
  Omit<Extract<ReplyPresentation, { version: 4 }>, "part" | "parts">;
export interface Receipt {
  id: string;
  conversationKey: string;
  operation: string;
  status: "started" | "accepted" | "applied" | "failed" | "uncertain";
  detail: string;
  at: number;
  sessionId?: string;
  admissionId?: string;
}

export interface AppAdmissionSeed {
  id: string;
  sessionId: string;
  messageId: string;
  baselineIndex: number;
  acceptedAt: number;
  deadlineAt: number;
}

export interface AppAdmission extends AppAdmissionSeed {
  conversationKey: string;
  receiptIds: string[];
  phase: "accepted" | "executing" | "confirmed";
  observation: "watching" | "timed_out" | "interrupted" | "failed" | "settled";
  resultIds: string[];
  checkedAt: number;
  executionIndex?: number;
  completionIndex?: number;
}

export function appAdmissionNotice(admission: AppAdmission): string {
  if (admission.phase === "confirmed") return "Result confirmed for this App instruction. Teams delivery is reported separately.";
  if (admission.observation !== "watching") {
    const reason = admission.observation === "timed_out" ? "timed out"
      : admission.observation === "interrupted" ? "was interrupted by a backend restart" : "failed";
    return `App observation ${reason}; result remains unconfirmed (${admission.phase === "executing" ? "execution observed" : "execution not yet observed"}). Refresh or Read transcript to check this saved message ID without replaying the task.`;
  }
  return admission.phase === "executing"
    ? "Execution observed for this App instruction; awaiting its confirmed result. This is not a Teams delivery receipt."
    : "App host accepted this instruction (queued); execution not yet observed. Acceptance is not execution or Teams delivery.";
}

export interface OutboxItem {
  id: string;
  conversationKey: string;
  sessionId: string;
  eventId: string;
  text: string;
  status: "pending" | "sending" | "sent" | "uncertain" | "rejected" | "cancelled";
  detail?: string;
  activityId?: string;
  admissionId?: string;
  presentation?: ReplyPresentation;
  originatingMessageId?: string;
  sourceResultKey?: string;
  direct?: boolean;
  subscription?: { id: string; revision: number };
  historyId?: string;
}

export interface JournalCursor {
  generation: string;
  offset: number;
  index: number;
  anchor: string;
  header?: string;
  headerBytes?: number;
  discard?: { offset: number; anchor: string };
  eofRecord: boolean;
  requests: Array<{ toolCallId: string; toolName?: "task_complete" | "publish_chat_update"; summaryHash: string; messageEventId: string; turnId: string; interactionId: string; origin?: string }>;
  starts: string[];
  outputs: Array<{ key: string; index: number; timestamp: string }>;
}

export interface FinalPage { cursor: JournalCursor; events: unknown[]; hasMore: boolean }
export interface Subscription {
  id: string; sessionId: string; conversationKey: string; revision: number; enabled: boolean;
  status: "watching" | "paused" | "disabled"; cursor: JournalCursor; detail: string;
}
export interface DirectOrigin {
  id: string; sessionId: string; conversationKey: string; messageId?: string;
  status: "admitting" | "accepted" | "failed"; at: number;
  answered?: boolean;
}

export interface BridgeState {
  schema: 1;
  owner: string;
  actionKey: string;
  controllerId?: string;
  sessions: Record<string, SessionRecord>;
  conversations: Record<string, ConversationRecord>;
  receipts: Record<string, Receipt>;
  outbox: OutboxItem[];
  admissions: Record<string, AppAdmission>;
  subscriptions: Record<string, Subscription>;
  directOrigins: Record<string, DirectOrigin>;
}

export interface RuntimeEvent {
  sessionId: string;
  event: unknown;
  historical?: boolean;
  admissionId?: string;
}

export interface CreateOptions {
  id: string;
  name: string;
  workspace: string;
  controller: boolean;
  tools?: Tool<unknown>[];
}

export interface Runtime {
  readonly description: string;
  start(listener: (event: RuntimeEvent) => void): Promise<void>;
  inventory(controllerId: string): Promise<Array<Pick<SessionRecord, "id" | "name" | "kind" | "status" | "workspace" | "capability"> & { peerStatePath?: string; modelId?: string; peerSource?: "app"; access?: SessionAccess; lastConversationAt?: string; liveUntil?: number; sideChat?: { parentId?: string }; subscriptionSupported?: boolean }>>;
  discoveryStatus(): string;
  subscriptionBaseline(id: string): Promise<JournalCursor>;
  subscriptionRead(id: string, cursor: JournalCursor): Promise<FinalPage>;
  appLiveness(): Promise<AppSessionLiveness[]>;
  create(options: CreateOptions): Promise<Settings>;
  resume(record: SessionRecord, tools?: Tool<unknown>[]): Promise<Settings>;
  send(id: string, text: string, persistAdmission?: (admission: AppAdmissionSeed) => Promise<void>): Promise<{ id: string; peer: boolean }>;
  reconcileAdmissions(admissions: AppAdmission[]): Promise<void>;
  settleAdmission(admissionId: string): void;
  stop(id: string): Promise<void>;
  settings(id: string): Promise<Settings>;
  models(id: string): Promise<ModelChoice[]>;
  configure(id: string, change: SettingsChange): Promise<SettingsResult>;
  answer(id: string, requestId: string, answer: Answer): Promise<void>;
  history(id: string): Promise<unknown[]>;
  preview(id: string): Promise<ConversationPreview>;
  watchPeer(record: SessionRecord): Promise<void>;
  close(): Promise<void>;
}

export interface Card {
  type: "AdaptiveCard";
  version: "1.5";
  $schema: string;
  body: Record<string, unknown>[];
  actions?: Record<string, unknown>[];
}

export type Outbound = { type: "card"; card: Card } | { type: "text"; text: string; presentation?: ReplyPresentation };

export interface Transport {
  readonly connected?: boolean;
  send(reference: ConversationReference, message: Outbound): Promise<string>;
  update(reference: ConversationReference, id: string, card: Card): Promise<void>;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
}

export interface BridgeOptions {
  owner: string;
  workspaces: Workspace[];
  coalesceMs: number;
  actionTtlMs?: number;
  cardActions?: "submit" | "execute";
  deliveryInitiallyPaused?: boolean;
  inventoryOnStart?: boolean;
  appLivenessTimeoutMs?: number;
  historyReadTimeoutMs?: number;
  subscriptionPollMs?: number;
  subscriptionReadTimeoutMs?: number;
  subscriptionBaselineTimeoutMs?: number;
}

export function viewTarget(state: BridgeState, conversation: ConversationRecord): string | undefined {
  if (conversation.view === "control") return state.controllerId;
  if (conversation.view === "transcript") return conversation.transcriptId;
  return conversation.selectedId;
}
