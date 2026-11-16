import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BridgeState } from "./domain.js";
import { canonicalId, digest, object, string, UserError } from "./safety.js";

function settings(value: unknown): boolean {
  return value === undefined || (object(value) && ["interactive", "plan", "autopilot"].includes(String(value.mode)) &&
    [value.modelId, value.providerId, value.effort].every((field) => field === undefined || string(field, 512)));
}

function timeline(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => object(entry) && string(entry.id) && typeof entry.text === "string" &&
    (entry.timestamp === undefined || (typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)))) &&
    ["user", "assistant", "tool", "agent", "input", "permission", "plan", "task", "error", "status"].includes(String(entry.kind)) &&
    (entry.phase === undefined || entry.phase === "commentary" || entry.phase === "final") &&
    (entry.state === undefined || ["running", "done", "failed", "answered", "skipped", "waiting", "cancelled"].includes(String(entry.state))));
}

function pending(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => object(entry) && string(entry.id) && typeof entry.title === "string" &&
    ["input", "permission", "plan"].includes(String(entry.kind)) && typeof entry.allowFreeform === "boolean" &&
    Array.isArray(entry.choices) && entry.choices.every((choice) => typeof choice === "string"));
}

function admissions(value: unknown): boolean {
  return value === undefined || (object(value) && Object.entries(value).every(([id, item]) =>
    /^[a-f0-9]{64}$/.test(id) && object(item) && item.id === id && canonicalId(item.sessionId) &&
    string(item.messageId, 512) && string(item.conversationKey) &&
    Number.isSafeInteger(item.baselineIndex) && Number(item.baselineIndex) >= -1 &&
    typeof item.acceptedAt === "number" && Number.isFinite(item.acceptedAt) &&
    typeof item.deadlineAt === "number" && Number.isFinite(item.deadlineAt) && item.deadlineAt >= item.acceptedAt &&
    typeof item.checkedAt === "number" && Number.isFinite(item.checkedAt) &&
    ["accepted", "executing", "confirmed"].includes(String(item.phase)) &&
    ["watching", "timed_out", "interrupted", "failed", "settled"].includes(String(item.observation)) &&
    Array.isArray(item.receiptIds) && item.receiptIds.every((entry) => string(entry, 512)) &&
    Array.isArray(item.resultIds) && item.resultIds.every((entry) => string(entry, 512)) &&
    [item.executionIndex, item.completionIndex].every((entry) => entry === undefined || (Number.isSafeInteger(entry) && Number(entry) >= 0))));
}

function presentation(value: unknown): boolean {
  return value === undefined || (object(value) && string(value.title, 512) &&
    (value.version === 2 && ["session", "background", "control"].includes(String(value.kind)) ||
      ((value.version === 3 && ["markdown", "plain"].includes(String(value.format))) ||
        (value.version === 4 && ["markdown", "xml"].includes(String(value.format)))) &&
      ["session", "background", "control", "history"].includes(String(value.kind)) &&
      canonicalId(value.sourceId)) && string(value.groupId, 64) &&
    Number.isSafeInteger(value.part) && Number.isSafeInteger(value.parts) &&
    Number(value.part) >= 1 && Number(value.part) <= Number(value.parts));
}

function cursor(value: unknown): boolean {
  return object(value) && string(value.generation, 512) && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 &&
    Number.isSafeInteger(value.index) && Number(value.index) >= 0 && typeof value.anchor === "string" && /^[a-f0-9]{64}$/.test(value.anchor) &&
    (value.header === undefined || typeof value.header === "string" && /^[a-f0-9]{64}$/.test(value.header)) &&
    (value.headerBytes === undefined || Number.isSafeInteger(value.headerBytes) && Number(value.headerBytes) >= 0 && Number(value.headerBytes) <= 256) &&
    (value.discard === undefined || object(value.discard) && value.eofRecord === false &&
      Number.isSafeInteger(value.discard.offset) && Number(value.discard.offset) > Number(value.offset) &&
      typeof value.discard.anchor === "string" && /^[a-f0-9]{64}$/.test(value.discard.anchor)) &&
    typeof value.eofRecord === "boolean" && Array.isArray(value.requests) && value.requests.length <= 32 &&
    value.requests.every((item) => object(item) && ["toolCallId", "summaryHash", "messageEventId", "turnId", "interactionId"].every((key) => string(item[key], 512)) &&
      (item.toolName === undefined || item.toolName === "task_complete" || item.toolName === "publish_chat_update") &&
      (item.origin === undefined || string(item.origin, 512))) &&
    Array.isArray(value.starts) && value.starts.length <= 32 && value.starts.every((id) => string(id, 512)) &&
    Array.isArray(value.outputs) && value.outputs.length <= 256 && value.outputs.every((item) => object(item) && string(item.key, 64) &&
      Number.isSafeInteger(item.index) && string(item.timestamp, 64));
}

function isState(value: unknown, owner: string): value is BridgeState {
  if (!object(value) || value.schema !== 1 || value.owner !== owner || typeof value.actionKey !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.actionKey) || (value.controllerId !== undefined && !canonicalId(value.controllerId))) return false;
  if (!object(value.sessions) || !object(value.conversations) || !object(value.receipts) ||
    !Array.isArray(value.outbox) || !admissions(value.admissions)) return false;
  if (value.subscriptions !== undefined && (!object(value.subscriptions) || Object.keys(value.subscriptions).length > 64 || !Object.entries(value.subscriptions).every(([id, item]) =>
    object(item) && string(item.id, 64) && canonicalId(item.sessionId) && string(item.conversationKey) &&
    item.id === id && id === digest(`${item.conversationKey}:${item.sessionId}`) &&
    Number.isSafeInteger(item.revision) && typeof item.enabled === "boolean" && ["watching", "paused", "disabled"].includes(String(item.status)) &&
    cursor(item.cursor) && typeof item.detail === "string"))) return false;
  if (value.directOrigins !== undefined && (!object(value.directOrigins) || !Object.values(value.directOrigins).every((item) =>
    object(item) && string(item.id) && canonicalId(item.sessionId) && string(item.conversationKey) &&
    ["admitting", "accepted", "failed"].includes(String(item.status)) && typeof item.at === "number" &&
    (item.answered === undefined || typeof item.answered === "boolean") &&
    (item.messageId === undefined || string(item.messageId, 512))))) return false;
  return Object.entries(value.sessions).every(([id, item]) =>
    object(item) && canonicalId(id) && item.id === id && string(item.name) &&
    ["owned", "controller", "saved", "peer", "unavailable"].includes(String(item.kind)) &&
    ["idle", "busy", "awaiting", "error", "offline"].includes(String(item.status)) &&
    (item.executionObserved === undefined || typeof item.executionObserved === "boolean") &&
    (item.peerSource === undefined || item.peerSource === "app") &&
    (item.lastConversationAt === undefined || (typeof item.lastConversationAt === "string" && Number.isFinite(Date.parse(item.lastConversationAt)))) &&
    (item.liveUntil === undefined || (typeof item.liveUntil === "number" && Number.isFinite(item.liveUntil))) &&
    (item.access === undefined || (object(item.access) && typeof item.access.read === "boolean" && typeof item.access.send === "boolean")) &&
    (item.sideChat === undefined || object(item.sideChat) && (item.sideChat.parentId === undefined || canonicalId(item.sideChat.parentId))) &&
    (item.subscriptionSupported === undefined || typeof item.subscriptionSupported === "boolean") &&
    typeof item.workspace === "string" && typeof item.capability === "string" && timeline(item.timeline) && pending(item.pending) && settings(item.settings) &&
    Array.isArray(item.seenEvents) && item.seenEvents.every((id) => typeof id === "string") && Number.isSafeInteger(item.sequence)) &&
    Object.values(value.conversations).every((item) =>
      object(item) && string(item.key) && object(item.reference) && object(item.read) &&
      Number.isSafeInteger(item.revision) && ["home", "dashboard", "sessions", "working", "needs-reply", "sides", "subscriptions", "new", "settings", "control", "transcript"].includes(String(item.view)) &&
      (item.surfaceId === undefined || canonicalId(item.surfaceId)) &&
      (item.query === undefined || (typeof item.query === "string" && item.query.length <= 100)) &&
      (item.historyRead === undefined || object(item.historyRead) && string(item.historyRead.id, 64) &&
        canonicalId(item.historyRead.sessionId) && Number.isSafeInteger(item.historyRead.count) &&
        Number(item.historyRead.count) >= 1 && Number(item.historyRead.count) <= 50 &&
        ["reading", "queued", "failed", "interrupted"].includes(String(item.historyRead.status)) &&
        Array.isArray(item.historyRead.receiptIds) && item.historyRead.receiptIds.length <= 2 &&
        item.historyRead.receiptIds.every((id) => string(id, 512)) &&
        (item.historyRead.superseded === undefined || typeof item.historyRead.superseded === "boolean")) &&
      (item.selectionBlocked === undefined || typeof item.selectionBlocked === "boolean") &&
      (item.selectedId === undefined || canonicalId(item.selectedId))) &&
    Object.values(value.receipts).every((item) => object(item) && string(item.id) &&
      ["started", "accepted", "applied", "failed", "uncertain"].includes(String(item.status))) &&
    value.outbox.every((item) => object(item) && string(item.id) && typeof item.text === "string" && presentation(item.presentation) &&
      (item.historyId === undefined || typeof item.historyId === "string" && /^[a-f0-9]{64}$/u.test(item.historyId)) &&
      (item.direct === undefined || typeof item.direct === "boolean") &&
      (item.originatingMessageId === undefined || string(item.originatingMessageId, 512)) &&
      (item.sourceResultKey === undefined || typeof item.sourceResultKey === "string" && /^[a-f0-9]{64}$/.test(item.sourceResultKey)) &&
      (item.subscription === undefined || object(item.subscription) && string(item.subscription.id, 64) && Number.isSafeInteger(item.subscription.revision)) &&
      ["pending", "sending", "sent", "uncertain", "rejected", "cancelled"].includes(String(item.status)));
}

export class Store {
  private queue: Promise<void> = Promise.resolve();
  private lockId = "";
  private closed = false;

  private constructor(
    readonly directory: string,
    private state: BridgeState,
  ) {}

  static async open(directory: string, owner: string): Promise<Store> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = join(directory, "bridge.lock");
    const lockId = randomUUID();
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, id: lockId }));
      await handle.close();
    } catch (error) {
      if (!object(error) || error.code !== "EEXIST") throw error;
      const lock: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      if (!object(lock) || typeof lock.pid !== "number" || !Number.isSafeInteger(lock.pid) || lock.pid < 1) throw new Error("Invalid bridge lock; inspect it manually.");
      let alive = true;
      try {
        process.kill(lock.pid, 0);
      } catch (probeError) {
        if (object(probeError) && probeError.code === "ESRCH") alive = false;
        else throw probeError;
      }
      if (alive) throw new UserError("Another bridge process owns this state directory.");
      throw new UserError(`A stopped bridge left its application lock at ${lockPath}. Verify the recorded PID, then remove only that bridge.lock manually. Never remove Copilot session locks.`);
    }
    try {
      let state: BridgeState;
      try {
        const statePath = join(directory, "state.json");
        if ((await stat(statePath)).size > 64 * 1024 * 1024) throw new Error("Bridge state exceeds the 64 MiB startup budget; inspect/archive it manually.");
        const parsed: unknown = JSON.parse(await readFile(statePath, "utf8"));
        if (!isState(parsed, owner)) throw new Error("State schema/owner mismatch; refusing to replace state.");
        state = { ...parsed, admissions: parsed.admissions ?? {}, subscriptions: parsed.subscriptions ?? {}, directOrigins: parsed.directOrigins ?? {} };
      } catch (error) {
        if (!object(error) || error.code !== "ENOENT") throw error;
        state = {
          schema: 1, owner, actionKey: randomBytes(32).toString("base64url"),
          sessions: {}, conversations: {}, receipts: {}, outbox: [], admissions: {}, subscriptions: {}, directOrigins: {},
        };
      }
      const store = new Store(directory, state);
      store.lockId = lockId;
      await store.mutate((draft) => {
        for (const origin of Object.values(draft.directOrigins)) if (origin.status === "admitting") origin.status = "failed";
        for (const receipt of Object.values(draft.receipts)) {
          if (receipt.status === "started") {
            receipt.status = "uncertain";
            receipt.detail = "Backend restarted during this operation. It will not be replayed automatically.";
          } else if (receipt.operation === "send" && receipt.status === "accepted" && !receipt.admissionId) {
            const target = receipt.sessionId ? draft.sessions[receipt.sessionId] : undefined;
            if (!target || target.peerSource === "app") {
              receipt.status = "uncertain";
              receipt.detail = "Legacy send receipt has no native admission ID. Execution/result are unknown; this request cannot be reconciled or replayed.";
            }
          }
        }
        for (const admission of Object.values(draft.admissions)) {
          if (admission.phase !== "confirmed" && admission.observation === "watching") admission.observation = "interrupted";
        }
        for (const item of draft.outbox) if (item.status === "sending") item.status = "uncertain";
        for (const session of Object.values(draft.sessions)) {
          session.pending = [];
          for (const entry of session.timeline) {
            if (entry.state === "waiting") {
              entry.state = "cancelled";
              entry.text = "Request interrupted by backend restart; old approval actions are invalid.";
            }
          }
          if (session.kind === "owned" || session.kind === "controller") {
            session.status = "offline";
            session.executionObserved = false;
          }
        }
        for (const conversation of Object.values(draft.conversations)) {
          if (conversation.historyRead?.status === "reading") {
            conversation.historyRead.status = "interrupted";
          }
          conversation.revision++;
          if (conversation.dashboardState === "sending") conversation.dashboardState = "uncertain";
          conversation.notice = "Backend restarted. Old card actions expired; interrupted operations are not replayed.";
        }
      });
      return store;
    } catch (error) {
      await rm(lockPath);
      throw error;
    }
  }

  snapshot(): BridgeState {
    return structuredClone(this.state);
  }

  async mutate<T>(change: (state: BridgeState) => T): Promise<T> {
    if (this.closed) throw new Error("Store is closed");
    let result: T;
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      result = change(draft);
      const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(draft));
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, join(this.directory, "state.json"));
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      this.state = draft;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result!;
  }

  async close(): Promise<void> {
    await this.queue;
    this.closed = true;
    const path = join(this.directory, "bridge.lock");
    const lock: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!object(lock) || lock.id !== this.lockId) throw new Error("Bridge lock ownership changed.");
    await rm(path);
  }
}
