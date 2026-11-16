import { randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { canonicalId, logError, object, safeText, string, UncertainOperationError, UserError } from "./safety.js";
import { visibleUserContent } from "./projection.js";
import type { AppSessionLiveness, JournalCursor, FinalPage } from "./domain.js";
import { readSideMetadata } from "./side-metadata.js";
import { journalBaseline, journalPage } from "./journal-observer.js";
import { originAgrees, publishedMessage, visibleArgument, visibleTool, type VisibleTool } from "./visible-publication.js";

export interface AppSessionsOptions {
  timeoutMs: number;
  sessionStateDirectory?: string;
  brokerDirectory?: string;
  outputPollIntervalMs?: number;
  outputWatchTimeoutMs?: number;
  metadataDatabasePath?: string;
}

export interface AppSessionInfo {
  id: string;
  name: string;
  status: "idle" | "busy" | "offline";
  workspace: string;
  readable: boolean;
  direct: boolean;
  lastConversationAt?: string;
  liveUntil?: number;
  sideChat?: { parentId?: string };
}

export interface AppSessionTurn {
  index: number;
  assistantResponse: string;
  timestamp: string;
  role?: "user";
  phase?: "commentary";
  originatingMessageId?: string;
}

export interface AppSessionCompletion {
  index: number;
  originatingMessageId: string;
}

export interface AppSessionSnapshot {
  turns: AppSessionTurn[];
  completedThrough: number;
  completions: AppSessionCompletion[];
  throughIndex: number;
  consumed: Array<{ index: number; messageId: string }>;
}

export interface AppSessionClient {
  start(): Promise<void>;
  listSessions(): Promise<AppSessionInfo[]>;
  liveness(): Promise<AppSessionLiveness[]>;
  sendMessage(sessionId: string, message: string): Promise<string>;
  readSession(sessionId: string): Promise<AppSessionTurn[]>;
  readPreview(sessionId: string): Promise<AppSessionTurn[]>;
  readSessionState(sessionId: string, messageIds?: readonly string[]): Promise<AppSessionSnapshot>;
  discoveryStatus(): string;
  subscriptionBaseline(sessionId: string): Promise<JournalCursor>;
  subscriptionRead(sessionId: string, cursor: JournalCursor): Promise<FinalPage>;
  close(): Promise<void>;
}

const maximumBytes = 128 * 1024;
const maximumHistoryBytes = 120_000;
const maximumEventLineBytes = 4 * 1024 * 1024;
const maximumRegistrationBytes = 16 * 1024;
const initialActivityBytes = 1024 * 1024;
const maximumTargetedMessages = 32;

async function* boundedJournalLines(input: ReadStream): AsyncGenerator<{ text: string | undefined; terminated: boolean }> {
  let parts: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  const append = (part: Buffer) => {
    if (oversized || !part.length) return;
    if (bytes + part.length > maximumEventLineBytes) {
      parts = [];
      bytes = 0;
      oversized = true;
    } else {
      parts.push(part);
      bytes += part.length;
    }
  };
  const finish = (terminated: boolean) => {
    const line = oversized ? undefined : Buffer.concat(parts, bytes).toString("utf8");
    parts = [];
    bytes = 0;
    oversized = false;
    return { text: line, terminated };
  };
  // Bound a single untrusted JSONL record as well as the stream buffers. Even
  // skipped oversized terminated records occupy one physical history index.
  for await (const chunk of input) {
    if (!Buffer.isBuffer(chunk)) throw new UserError("App journal reader expected byte chunks.");
    let start = 0;
    let newline: number;
    while ((newline = chunk.indexOf(10, start)) >= 0) {
      append(chunk.subarray(start, newline));
      yield finish(true);
      start = newline + 1;
    }
    append(chunk.subarray(start));
  }
  if (bytes || oversized) yield finish(false);
}

interface EndpointRegistration {
  sessionId: string;
  instanceId: string;
  pid: number;
  name: string;
  workspace: string;
  heartbeatAt: string;
  liveUntil: number;
  status: "idle" | "busy";
}

interface EndpointBroker {
  root: string;
  registrationTtlMs: number;
}

interface TaskCompleteRequest {
  toolName: VisibleTool;
  summary: string;
  messageEventId: string;
  turnId: string;
  interactionId: string;
  originatingMessageId?: string;
}

function property(value: unknown, name: string): unknown {
  return object(value) ? value[name] : undefined;
}

function timestamp(value: unknown): string | undefined {
  return string(value, 64) && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function correlation(event: Record<string, unknown>, key: "turnId" | "interactionId" | "originatingMessageId"): string | undefined {
  const nested = property(event.data, key);
  const root = event[key];
  if (nested !== undefined && root !== undefined && nested !== root) return undefined;
  const value = nested ?? root;
  return string(value, key === "originatingMessageId" ? 512 : 200) ? value : undefined;
}

function consistentOrigin(event: Record<string, unknown>, origin: string | undefined): string | undefined {
  if (event.originatingMessageId !== undefined || property(event.data, "originatingMessageId") !== undefined) {
    return correlation(event, "originatingMessageId") === origin ? origin : undefined;
  }
  return origin;
}

function missing(error: unknown): boolean {
  return object(error) && error.code === "ENOENT";
}

function metadataScalar(source: string, key: "name" | "cwd"): string | undefined {
  const raw = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(source)?.[1]?.trim();
  if (!raw || /^[!&*|>{[\]#]/u.test(raw)) return undefined;
  if (raw.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(raw);
      return typeof value === "string" ? value : undefined;
    } catch { return undefined; }
  }
  if (raw.startsWith("'")) return raw.endsWith("'") ? raw.slice(1, -1).replaceAll("''", "'") : undefined;
  return raw;
}

export class LocalAppSessions implements AppSessionClient {
  private readonly sessionStateDirectory: string;
  private readonly brokerDirectory: string;
  private started = false;
  private closed = false;
  private readonly activityCache = new Map<string, { fingerprint: string; lastConversationAt?: string }>();
  private readonly previewCache = new Map<string, { fingerprint: string; turns: AppSessionTurn[] }>();
  private readonly previewReads = new Map<string, Promise<AppSessionTurn[]>>();
  private metadataStatus = "Side-chat metadata has not been checked.";

  constructor(private readonly options: AppSessionsOptions) {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30_000) {
      throw new UserError("App endpoint timeout must be 100-30000 milliseconds.");
    }
    const sessionStateDirectory = options.sessionStateDirectory ??
      join(homedir(), ".copilot", "session-state");
    if (!isAbsolute(sessionStateDirectory)) {
      throw new UserError("App session-state directory must be an explicit absolute path.");
    }
    this.sessionStateDirectory = resolve(sessionStateDirectory);
    const brokerDirectory = options.brokerDirectory ?? join(homedir(), ".copilot", "teams-session-broker");
    if (!isAbsolute(brokerDirectory)) {
      throw new UserError("App session endpoint broker directory must be an explicit absolute path.");
    }
    this.brokerDirectory = resolve(brokerDirectory);
  }

  async start(): Promise<void> {
    await Promise.all([this.optionalDirectory(this.sessionStateDirectory), this.broker()]);
    this.started = true;
  }

  async listSessions(): Promise<AppSessionInfo[]> {
    this.requireStarted();
    const [root, endpoints] = await Promise.all([
      this.optionalDirectory(this.sessionStateDirectory), this.endpointRegistrations(),
    ]);
    const sessions = new Map<string, AppSessionInfo>();
    if (root) {
      const directories = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && canonicalId(entry.name));
      for (const entry of directories) {
        const id = entry.name.toLowerCase();
        let metadata: string | undefined;
        let readable = false;
        let lastConversationAt: string | undefined;
        try {
          const path = await this.profileFile(root, id, "workspace.yaml");
          metadata = await this.readBoundedText(path, maximumRegistrationBytes);
        } catch (error) {
          if (!missing(error)) logError("app-session-metadata", error);
        }
        try {
          const path = await this.profileFile(root, id, "events.jsonl");
          const handle = await open(path, "r");
          await handle.close();
          readable = true;
          lastConversationAt = await this.conversationActivity(id, path);
        } catch (error) {
          if (!missing(error)) logError("app-session-history-discovery", error);
        }
        if (metadata === undefined && !readable) continue;
        const name = metadata === undefined ? undefined : metadataScalar(metadata, "name");
        const workspace = metadata === undefined ? undefined : metadataScalar(metadata, "cwd");
        sessions.set(id, {
          id, name: safeText(name?.trim() || `Saved session ${id.slice(0, 8)}`, 100),
          workspace: safeText(workspace ?? "", 1000), status: "offline", readable, direct: false,
          ...(lastConversationAt ? { lastConversationAt } : {}),
        });
      }
    }
    for (const endpoint of endpoints.values()) {
      const saved = sessions.get(endpoint.sessionId);
      sessions.set(endpoint.sessionId, {
        id: endpoint.sessionId, name: endpoint.name, workspace: endpoint.workspace,
        status: endpoint.status, readable: saved?.readable ?? false, direct: true,
        liveUntil: endpoint.liveUntil,
        ...(saved?.lastConversationAt ? { lastConversationAt: saved.lastConversationAt } : {}),
      });
    }
    const metadata = await readSideMetadata(this.options.metadataDatabasePath);
    this.metadataStatus = metadata.detail;
    if (!metadata.available) for (const session of sessions.values()) {
      if (/^new session$/iu.test(session.name.trim())) session.name = `Session ${session.id.slice(0, 8)} · Context unknown`;
    }
    for (const side of metadata.sides) {
      const session = sessions.get(side.id);
      if (!session) continue;
      session.sideChat = { ...(side.parentId ? { parentId: side.parentId } : {}) };
      const compact = (value: string, limit: number) => {
        const label = value.replace(/[\r\n]/gu, " ");
        const characters = [...label];
        return characters.length > limit ? characters.slice(0, limit - 3).join("") + "..." : label;
      };
      const parent = compact(side.parentId ? sessions.get(side.parentId)?.name ?? side.parentName ?? `Parent ${side.parentId.slice(0, 8)}` : "Unknown parent", 48);
      const title = side.title && !/^new session$/iu.test(side.title) ? `${compact(side.title, 32)} · Side chat ${side.id.slice(0, 8)}` : `Side chat ${side.id.slice(0, 8)}`;
      session.name = safeText(`${parent} > ${title}`, 220);
    }
    return [...sessions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  discoveryStatus(): string { return this.metadataStatus; }
  async subscriptionBaseline(sessionId: string): Promise<JournalCursor> {
    this.requireStarted();
    if (!canonicalId(sessionId)) throw new UserError("Invalid subscription source.");
    return journalBaseline(sessionId, await this.journalPath(sessionId));
  }
  async subscriptionRead(sessionId: string, cursor: JournalCursor): Promise<FinalPage> {
    this.requireStarted();
    if (!canonicalId(sessionId)) throw new UserError("Invalid subscription source.");
    return journalPage(sessionId, await this.journalPath(sessionId), cursor);
  }

  async sendMessage(sessionId: string, message: string): Promise<string> {
    this.requireStarted();
    if (!canonicalId(sessionId) || !string(message, 16_384) || !message.trim() ||
      Buffer.byteLength(message) > 16 * 1024) throw new UserError("Invalid App session message request; the unchanged text must fit 16 KiB.");
    return this.sendDirect(sessionId.toLowerCase(), message);
  }

  async liveness(): Promise<AppSessionLiveness[]> {
    this.requireStarted();
    return [...(await this.endpointRegistrations()).values()].map((endpoint) => ({
      id: endpoint.sessionId, status: endpoint.status, liveUntil: endpoint.liveUntil,
    }));
  }

  async readSession(sessionId: string): Promise<AppSessionTurn[]> {
    return (await this.readSessionState(sessionId)).turns;
  }

  async readSessionState(sessionId: string, messageIds?: readonly string[]): Promise<AppSessionSnapshot> {
    this.requireStarted();
    if (!canonicalId(sessionId)) {
      throw new UserError("Invalid App session read request.");
    }
    if (messageIds && (messageIds.length > maximumTargetedMessages || messageIds.some((id) => !string(id, 512)))) {
      throw new UserError("Targeted App history supports at most 32 valid message IDs per read.");
    }
    const eventsPath = await this.journalPath(sessionId);
    return (await this.projectJournal(sessionId, eventsPath, 0, undefined, messageIds)).snapshot;
  }

  private async journalPath(sessionId: string): Promise<string> {
    try {
      const root = await this.optionalDirectory(this.sessionStateDirectory);
      if (!root) throw new UserError("APP_HISTORY_UNAVAILABLE: no local session-state directory. No session was resumed.");
      return await this.profileFile(root, sessionId.toLowerCase(), "events.jsonl");
    } catch (error) {
      if (object(error) && error.code === "ENOENT") {
        throw new UserError("APP_HISTORY_UNAVAILABLE: local App session history was not found. No session was resumed.");
      }
      throw error;
    }
  }

  async readPreview(sessionId: string): Promise<AppSessionTurn[]> {
    this.requireStarted();
    if (!canonicalId(sessionId)) throw new UserError("Invalid App session preview request.");
    const pending = this.previewReads.get(sessionId);
    if (pending) return pending;
    const read = this.readPreviewJournal(sessionId);
    this.previewReads.set(sessionId, read);
    try { return await read; } finally { this.previewReads.delete(sessionId); }
  }

  private async readPreviewJournal(sessionId: string): Promise<AppSessionTurn[]> {
    const path = await this.journalPath(sessionId);
    const before = await stat(path);
    const fingerprint = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
    const cached = this.previewCache.get(path);
    if (cached?.fingerprint === fingerprint) return structuredClone(cached.turns);
    let window = Math.min(before.size, initialActivityBytes);
    let turns: AppSessionTurn[];
    for (;;) {
      const start = before.size - window;
      const projected = await this.projectJournal(sessionId, path, start, before.size);
      turns = projected.snapshot.turns.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.index - b.index).slice(-2);
      const needsEvidence = projected.unconfirmedActivityAt &&
        (!turns.length || Date.parse(projected.unconfirmedActivityAt) >= Date.parse(turns[0]!.timestamp));
      if (start === 0 || (turns.length === 2 && !needsEvidence)) break;
      window = Math.min(before.size, window * 2);
    }
    // Preview identities are local to this view, never admission/history cursors.
    turns = turns.map((turn) => ({ ...turn, assistantResponse: safeText(turn.assistantResponse, 600) }));
    const after = await stat(path);
    if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` === fingerprint) {
      this.previewCache.delete(path);
      this.previewCache.set(path, { fingerprint, turns });
      if (this.previewCache.size > 24) this.previewCache.delete(this.previewCache.keys().next().value!);
    }
    return structuredClone(turns);
  }

  private async conversationActivity(sessionId: string, path: string): Promise<string | undefined> {
    const fingerprint = async () => {
      const file = await stat(path);
      return { file, key: `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}` };
    };
    const before = await fingerprint();
    const cached = this.activityCache.get(path);
    if (cached?.fingerprint === before.key) return cached.lastConversationAt;
    let window = Math.min(before.file.size, initialActivityBytes);
    let result: Awaited<ReturnType<LocalAppSessions["projectJournal"]>>;
    for (;;) {
      const start = before.file.size - window;
      result = await this.projectJournal(sessionId, path, start, before.file.size);
      const needsEarlierEvidence = result.unconfirmedActivityAt &&
        (!result.lastConversationAt || Date.parse(result.unconfirmedActivityAt) > Date.parse(result.lastConversationAt));
      if (start === 0 || (result.lastConversationAt && !needsEarlierEvidence)) break;
      // An empty window is not an empty conversation. Widen backwards through
      // the same safe streaming projection until dialogue or the real BOF.
      window = Math.min(before.file.size, window * 2);
    }
    if ((await fingerprint()).key === before.key) {
      this.activityCache.delete(path);
      this.activityCache.set(path, {
        fingerprint: before.key,
        ...(result.lastConversationAt ? { lastConversationAt: result.lastConversationAt } : {}),
      });
      if (this.activityCache.size > 2000) this.activityCache.delete(this.activityCache.keys().next().value!);
    }
    return result.lastConversationAt;
  }

  private async projectJournal(
    sessionId: string, eventsPath: string, start = 0, size?: number, messageIds?: readonly string[],
  ): Promise<{ snapshot: AppSessionSnapshot; lastConversationAt?: string; unconfirmedActivityAt?: string }> {
    const turns: AppSessionTurn[] = [];
    const seenOutputs = new Set<string>();
    const requests = new Map<string, TaskCompleteRequest>();
    const starts = new Set<string>();
    const completions = new Map<string, AppSessionCompletion>();
    const consumed = new Map<string, { index: number; messageId: string }>();
    const tracked = messageIds ? new Set(messageIds) : undefined;
    const targetedFinals = new Map<string, { key: string; turn: AppSessionTurn }>();
    const targetedProgress: Array<{ turn: AppSessionTurn; bytes: number }> = [];
    let progressBytes = 0;
    let activeTurn: { turnId: string; interactionId: string; origins: Set<string>; unconfirmed: boolean } | undefined;
    let completedThrough = -1;
    let lineIndex = 0;
    let lastConversationAt: string | undefined;
    let unconfirmedActivityAt: string | undefined;
    const addTurn = (
      index: number,
      content: string,
      eventTimestamp: string,
      turnId: unknown,
      interactionId: unknown,
      phase?: "commentary",
      role?: "user",
      originatingMessageId?: string,
    ) => {
      const visible = safeText(content, 8000);
      if (visible.trim() && (!lastConversationAt || Date.parse(eventTimestamp) > Date.parse(lastConversationAt))) {
        lastConversationAt = eventTimestamp;
      }
      if (tracked && (role === "user" || !originatingMessageId || !tracked.has(originatingMessageId))) return;
      const correlated = typeof turnId === "string" && turnId &&
        typeof interactionId === "string" && interactionId;
      const key = originatingMessageId && role !== "user" && phase !== "commentary"
        ? `${originatingMessageId}\u0000final\u0000${visible}` : correlated && role !== "user"
        ? `${originatingMessageId ?? ""}\u0000${turnId}\u0000${interactionId}\u0000${phase ?? "final"}\u0000${visible}` : `line:${index}`;
      const turn: AppSessionTurn = {
        index, assistantResponse: visible, timestamp: eventTimestamp,
        ...(phase ? { phase } : {}), ...(role ? { role } : {}),
        ...(originatingMessageId ? { originatingMessageId } : {}),
      };
      if (tracked && originatingMessageId) {
        if (phase === "commentary") {
          const bytes = Buffer.byteLength(JSON.stringify(turn), "utf8");
          targetedProgress.push({ turn, bytes });
          progressBytes += bytes;
          while (targetedProgress.length > 50 || progressBytes > maximumHistoryBytes) {
            progressBytes -= targetedProgress.shift()!.bytes;
          }
        } else if (targetedFinals.get(originatingMessageId)?.key !== key) {
          // One final slot per requested identity cannot be evicted by any
          // request's progress; duplicate task_complete summaries keep the
          // original physical result identity.
          targetedFinals.set(originatingMessageId, { key, turn });
        }
        return;
      }
      if (seenOutputs.has(key)) return;
      seenOutputs.add(key);
      turns.push(turn);
      if (turns.length > 50) turns.shift();
    };
    const complete = (index: number, origin: string | undefined) => {
      if (!origin || (tracked && !tracked.has(origin))) return;
      completions.delete(origin);
      completions.set(origin, { index, originatingMessageId: origin });
      if (completions.size > 50) completions.delete(completions.keys().next().value!);
    };
    const execution = (index: number, messageId: unknown) => {
      if (!string(messageId, 512) || (tracked && !tracked.has(messageId)) || consumed.has(messageId)) return;
      consumed.set(messageId, { index, messageId });
      if (consumed.size > 50) consumed.delete(consumed.keys().next().value!);
    };
    if (size === 0) return { snapshot: { turns: [], completions: [], consumed: [], throughIndex: -1, completedThrough: -1 } };
    const lines = boundedJournalLines(createReadStream(eventsPath, {
      start, highWaterMark: 64 * 1024,
      ...(size === undefined ? {} : { end: size - 1 }),
    }));
    let partial = start > 0;
    for await (const record of lines) {
      if (partial) { partial = false; continue; }
      if (record.text === undefined && !record.terminated) break;
      let event: unknown;
      try {
        if (record.text !== undefined) event = JSON.parse(record.text);
      } catch {
        // Keep unfinished EOF JSON uncovered for the next append/poll.
        // Complete JSON without a newline is still a covered physical record.
        if (!record.terminated) break;
      }
      const currentIndex = lineIndex++;
      if (!object(event) || !string(event.type, 100) || !object(event.data)) continue;
      const data = event.data;
      if (event.checkpoint === true || event.agentId || data.parentToolCallId) continue;
      if (event.type === "session.start" && data.sessionId !== undefined &&
        (typeof data.sessionId !== "string" || data.sessionId.toLowerCase() !== sessionId.toLowerCase())) {
        throw new UserError("APP_HISTORY_IDENTITY_MISMATCH: the root journal belongs to another session.");
      }

      if (["session.start", "session.resume", "session.shutdown", "abort"].includes(event.type)) activeTurn = undefined;
      if (event.type === "assistant.turn_start") {
        const turnId = correlation(event, "turnId");
        const interactionId = correlation(event, "interactionId");
        activeTurn = turnId && interactionId && string(event.id, 200)
          ? { turnId, interactionId, origins: new Set(), unconfirmed: false } : undefined;
        continue;
      }

      if (event.type === "assistant.turn_end") {
        completedThrough = currentIndex;
        // A reusable turn number alone cannot attribute a completion. Require
        // this start/interaction scope and one authoritative message origin.
        if (activeTurn && correlation(event, "turnId") === activeTurn.turnId &&
          ((event.interactionId === undefined && data.interactionId === undefined) ||
            correlation(event, "interactionId") === activeTurn.interactionId) &&
          !activeTurn.unconfirmed && activeTurn.origins.size === 1) {
          complete(currentIndex, consistentOrigin(event, activeTurn.origins.values().next().value));
        }
        activeTurn = undefined;
        continue;
      }

      if (event.type === "user.message") {
        const content = visibleUserContent(data);
        const eventTimestamp = timestamp(event.timestamp);
        if (content?.trim() && eventTimestamp) {
          execution(currentIndex, data.messageId);
          addTurn(currentIndex, content, eventTimestamp, correlation(event, "turnId"), correlation(event, "interactionId"), undefined, "user");
        }
        continue;
      }

      if (event.type === "assistant.message") {
        if (data.phase !== undefined && !["commentary", "final", "final_answer", "response"].includes(String(data.phase))) continue;
        const origin = correlation(event, "originatingMessageId");
        execution(currentIndex, origin);
        if (activeTurn) {
          if (correlation(event, "turnId") === activeTurn.turnId &&
            correlation(event, "interactionId") === activeTurn.interactionId && origin) activeTurn.origins.add(origin);
          else activeTurn.unconfirmed = true;
        }
        let taskCompleteRequest = false;
        const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
        for (const request of toolRequests) {
          const toolName = property(request, "name");
          if (!visibleTool(toolName)) continue;
          if (toolName === "publish_chat_update" && !originAgrees(event, origin)) continue;
          const toolCallId = property(request, "toolCallId");
          const summary = visibleArgument(toolName, property(request, "arguments"));
          const turnId = correlation(event, "turnId");
          const interactionId = correlation(event, "interactionId");
          if (!string(toolCallId, 200) || !string(event.id, 200) || !summary || !turnId || !interactionId) continue;
          if (tracked && (!origin || !tracked.has(origin))) continue;
          requests.set(toolCallId, {
            summary, toolName,
            messageEventId: event.id,
            turnId, interactionId,
            ...(origin ? { originatingMessageId: origin } : {}),
          });
          starts.delete(toolCallId);
          taskCompleteRequest = true;
        }
        if (taskCompleteRequest) continue;
        const eventTimestamp = timestamp(event.timestamp);
        if (typeof data.content === "string" && data.content.trim() && eventTimestamp) {
          addTurn(currentIndex, data.content, eventTimestamp, correlation(event, "turnId"), correlation(event, "interactionId"),
            data.phase === "commentary" || toolRequests.length > 0 ? "commentary" : undefined, undefined, origin);
        }
        continue;
      }

      if (event.type === "tool.execution_start" && visibleTool(data.toolName)) {
        const toolCallId = data.toolCallId;
        if (!string(toolCallId, 200)) continue;
        const request = requests.get(toolCallId);
        if (!request) continue;
        const summary = visibleArgument(request.toolName, data.arguments);
        if (data.toolName === request.toolName && summary === request.summary &&
          (event.parentId === request.messageEventId || request.toolName === "publish_chat_update" && event.parentId === undefined) &&
          correlation(event, "turnId") === request.turnId) {
          if (request.toolName === "publish_chat_update" && !originAgrees(event, request.originatingMessageId)) continue;
          if (!consistentOrigin(event, request.originatingMessageId)) delete request.originatingMessageId;
          starts.add(toolCallId);
        }
        continue;
      }

      if (event.type === "tool.execution_complete") {
        const toolCallId = data.toolCallId;
        if (!string(toolCallId, 200)) continue;
        const request = requests.get(toolCallId);
        const eventTimestamp = timestamp(event.timestamp);
        const rawContent = property(data.result, "content");
        const content = request?.toolName === "publish_chat_update" ? publishedMessage(rawContent) : rawContent;
        if (!request) {
          // A newer completion may need a request outside this search range.
          // Its text/time is never published without that earlier evidence.
          if (start > 0 && data.success === true && eventTimestamp &&
            typeof content === "string" && content.trim() && content.length <= maximumHistoryBytes &&
            correlation(event, "turnId") && correlation(event, "interactionId") &&
            (!unconfirmedActivityAt || Date.parse(eventTimestamp) > Date.parse(unconfirmedActivityAt))) {
            unconfirmedActivityAt = eventTimestamp;
          }
          continue;
        }
        if (starts.has(toolCallId) && data.success === true && content === request.summary &&
          correlation(event, "turnId") === request.turnId && correlation(event, "interactionId") === request.interactionId &&
          eventTimestamp && (request.toolName !== "publish_chat_update" || originAgrees(event, request.originatingMessageId))) {
          const origin = consistentOrigin(event, request.originatingMessageId);
          addTurn(currentIndex, content, eventTimestamp, request.turnId, request.interactionId, undefined, undefined, origin);
          if (request.toolName === "task_complete") {
            complete(currentIndex, origin);
            completedThrough = currentIndex;
          }
        }
        requests.delete(toolCallId);
        starts.delete(toolCallId);
      }
    }
    const completedMessages = [...completions.values()];
    const consumedMessages = [...consumed.values()];
    const snapshot = (entries: AppSessionTurn[]): AppSessionSnapshot => ({
      turns: entries, completedThrough, completions: completedMessages, consumed: consumedMessages, throughIndex: lineIndex - 1,
    });
    let entries = turns;
    if (tracked) {
      const finals = [...targetedFinals.values()].map((entry) => entry.turn);
      const finalBytes = Buffer.byteLength(JSON.stringify(snapshot(finals)), "utf8");
      // Text/identity bounds cap each reserved final; only finals may exceed
      // the ordinary shared byte budget, never commentary.
      const maximumFinalBytes = maximumTargetedMessages * (8000 * 4 + 4096);
      if (finalBytes > maximumFinalBytes) throw new UserError("Targeted App final evidence exceeds its bounded response budget.");
      const budget = Math.max(maximumHistoryBytes, finalBytes);
      const progress = targetedProgress.map((entry) => entry.turn);
      const combine = () => [...finals, ...progress].sort((a, b) => a.index - b.index);
      entries = combine();
      while (progress.length && (entries.length > 50 || Buffer.byteLength(JSON.stringify(snapshot(entries)), "utf8") > budget)) {
        progress.shift();
        entries = combine();
      }
    } else {
      while (entries.length && Buffer.byteLength(JSON.stringify(snapshot(entries)), "utf8") > maximumHistoryBytes) entries.shift();
    }
    return {
      snapshot: snapshot(entries),
      ...(lastConversationAt ? { lastConversationAt } : {}),
      ...(unconfirmedActivityAt ? { unconfirmedActivityAt } : {}),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.activityCache.clear();
    this.previewCache.clear();
  }

  private requireStarted(): void {
    if (!this.started || this.closed) throw new UserError("Local App session directory is not running.");
  }

  private async optionalDirectory(path: string): Promise<string | undefined> {
    try {
      const root = await realpath(path);
      if (!(await stat(root)).isDirectory()) throw new UserError("Local App session path is not a directory.");
      return root;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  private async childPath(root: string, ...segments: string[]): Promise<string> {
    const expected = join(root, ...segments);
    const path = await realpath(expected);
    if (relative(root, path).toLowerCase() !== relative(root, expected).toLowerCase()) {
      throw new UserError("APP_PATH_IDENTITY_MISMATCH: a local session path redirects outside its canonical location.");
    }
    return path;
  }

  private async profileFile(root: string, sessionId: string, file: "workspace.yaml" | "events.jsonl"): Promise<string> {
    const path = await this.childPath(root, sessionId, file);
    if (!(await stat(path)).isFile()) throw new UserError("App session metadata/history is not a regular file.");
    return path;
  }

  private async writableDirectory(root: string, ...segments: string[]): Promise<string> {
    const prefix: string[] = [];
    for (const segment of segments) {
      prefix.push(segment);
      try { await mkdir(join(root, ...prefix), { mode: 0o700 }); } catch (error) {
        if (!object(error) || error.code !== "EEXIST") throw error;
      }
      const path = await this.childPath(root, ...prefix);
      if (!(await stat(path)).isDirectory()) throw new UserError("APP_ENDPOINT_PATH_INVALID: expected a private broker directory.");
    }
    return join(root, ...segments);
  }

  private async broker(): Promise<EndpointBroker | undefined> {
    const root = await this.optionalDirectory(this.brokerDirectory);
    if (!root) return undefined;
    const config = await this.readBoundedJson(await this.childPath(root, "config.json"), maximumRegistrationBytes);
    const ttl = object(config) ? config.registrationTtlMs : undefined;
    if (!object(config) || config.schema !== 1 || !Array.isArray(config.operations) ||
      !config.operations.includes("send_message") || typeof ttl !== "number" ||
      !Number.isInteger(ttl) || ttl < 5000 || ttl > 120_000) {
      throw new UserError("APP_ENDPOINT_CONFIG_INVALID: the local endpoint broker config is malformed.");
    }
    return { root, registrationTtlMs: ttl };
  }

  private async endpointRegistrations(knownBroker?: EndpointBroker): Promise<Map<string, EndpointRegistration>> {
    const registrations = new Map<string, EndpointRegistration>();
    const broker = knownBroker ?? await this.broker();
    if (!broker) return registrations;
    let names: string[];
    try {
      names = (await readdir(await this.childPath(broker.root, "sessions")))
        .filter((name) => name.endsWith(".json") && canonicalId(name.slice(0, -5)));
    } catch (error) {
      if (missing(error)) return registrations;
      throw error;
    }
    if (names.length > 1000) throw new UserError("APP_ENDPOINT_REGISTRY_BOUND: too many local endpoint registrations to verify.");
    for (const name of names) {
      try {
        const path = await this.childPath(broker.root, "sessions", name);
        const value = await this.readBoundedJson(path, maximumRegistrationBytes);
        if (!object(value) || value.schema !== 1 || !canonicalId(value.sessionId) ||
          !canonicalId(value.instanceId) || !["idle", "busy"].includes(String(value.status)) ||
          value.sessionId.toLowerCase() !== name.slice(0, -5).toLowerCase() ||
          !string(value.name, 200) || typeof value.workspace !== "string" || value.workspace.length > 2048 ||
          typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 2_147_483_647 ||
          typeof value.heartbeatAt !== "string") {
          throw new UserError("APP_ENDPOINT_REGISTRATION_INVALID");
        }
        const heartbeat = Date.parse(value.heartbeatAt);
        if (!Number.isFinite(heartbeat) || heartbeat > Date.now() + 5000) {
          throw new UserError("APP_ENDPOINT_HEARTBEAT_INVALID");
        }
        if (Date.now() - heartbeat > broker.registrationTtlMs) continue;
        try { process.kill(value.pid, 0); } catch (error) {
          if (object(error) && error.code === "ESRCH") continue;
          throw error;
        }
        registrations.set(value.sessionId.toLowerCase(), {
          sessionId: value.sessionId.toLowerCase(),
          instanceId: value.instanceId.toLowerCase(),
          pid: value.pid, name: safeText(value.name, 100), workspace: safeText(value.workspace, 1000),
          heartbeatAt: value.heartbeatAt,
          liveUntil: heartbeat + broker.registrationTtlMs,
          status: value.status as EndpointRegistration["status"],
        });
      } catch (error) {
        if (!missing(error)) logError("app-endpoint-registration", error);
      }
    }
    return registrations;
  }

  private async sendDirect(sessionId: string, message: string): Promise<string> {
    const broker = await this.broker();
    const registration = broker ? (await this.endpointRegistrations(broker)).get(sessionId) : undefined;
    if (!broker || !registration) {
      throw new UserError("APP_ENDPOINT_UNAVAILABLE: no fresh live endpoint for this session. Nothing was sent; refresh the catalogue after opening the original App session. Offline wake/takeover and coordinator fallback are unsupported.");
    }
    const id = randomUUID();
    const [requestDirectory, staging] = await Promise.all([
      this.writableDirectory(broker.root, "requests", sessionId),
      this.writableDirectory(broker.root, "staging"),
      this.writableDirectory(broker.root, "responses", sessionId),
    ]);
    const now = new Date();
    const request = {
      schema: 1,
      id,
      sessionId,
      operation: "send_message",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.options.timeoutMs).toISOString(),
      payload: { message },
    };
    const temporary = join(staging, `${sessionId}.${id}.${randomUUID()}.request.tmp`);
    const target = join(requestDirectory, `${id}.json`);
    const encoded = JSON.stringify(request);
    if (Buffer.byteLength(encoded) > 32 * 1024) throw new UserError("APP_MESSAGE_BOUND: the unchanged request exceeds the endpoint's 32 KiB envelope limit; nothing was sent.");
    await writeFile(temporary, encoded, { flag: "wx", mode: 0o600 });
    try {
      const current = (await this.endpointRegistrations(broker)).get(sessionId);
      if (this.closed || !current || current.instanceId !== registration.instanceId || current.pid !== registration.pid) {
        throw new UserError("APP_ENDPOINT_CHANGED: the endpoint expired/restarted before admission. Nothing was sent.");
      }
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary);
      throw error;
    }
    const deadline = performance.now() + this.options.timeoutMs;
    while (!this.closed && performance.now() < deadline) {
      try {
        const responsePath = await this.childPath(broker.root, "responses", sessionId, `${id}.json`);
        const response = await this.readBoundedJson(responsePath);
        if (!object(response) || response.schema !== 1 || response.id !== id ||
          typeof response.ok !== "boolean" || !Number.isFinite(Date.parse(String(response.completedAt)))) {
          throw new UncertainOperationError("APP_ADMISSION_UNCERTAIN: the direct response is malformed. The message may have been accepted; it will not be resent.");
        }
        await unlink(responsePath);
        if (!response.ok) {
          const code = object(response.error) && typeof response.error.code === "string" &&
            /^[A-Z0-9_]{1,60}$/.test(response.error.code) ? response.error.code : "SESSION_SEND_FAILED";
          if (code === "INVALID_REQUEST") throw new UserError("APP_ENDPOINT_REJECTED: the endpoint rejected invalid input before sending. No retry was made.");
          throw new UncertainOperationError(`APP_ADMISSION_UNCERTAIN: ${code}. The message may have been accepted; it will not be resent.`);
        }
        if (!object(response.result) || response.result.accepted !== true ||
          !string(response.result.messageId, 512)) {
          throw new UncertainOperationError("APP_ADMISSION_UNCERTAIN: the endpoint returned no valid message ID. The message may have been accepted; it will not be resent.");
        }
        console.log(JSON.stringify({
          area: "app-session-admission",
          route: "session-extension",
          messageId: safeText(response.result.messageId, 512),
        }));
        return response.result.messageId;
      } catch (error) {
        if (object(error) && error.code === "ENOENT") {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        if (error instanceof UserError && /^APP_(?:ENDPOINT_REJECTED|ADMISSION_UNCERTAIN):/.test(error.message)) throw error;
        logError("app-endpoint-admission", error);
        throw new UncertainOperationError("APP_ADMISSION_UNCERTAIN: the direct response could not be verified. The message may have been accepted; it will not be resent.");
      }
    }
    throw new UncertainOperationError("APP_ADMISSION_UNCERTAIN: the direct endpoint timed out or closed. The message may have been accepted; it will not be resent or routed through a coordinator.");
  }

  private async readBoundedJson(path: string, maximum = maximumBytes): Promise<unknown> {
    const file = await stat(path);
    if (!file.isFile() || file.size > maximum) throw new UserError("App endpoint JSON exceeds the supported bound.");
    try { return JSON.parse(await this.readBoundedText(path, maximum)); } catch (error) {
      if (error instanceof SyntaxError) throw new UserError("APP_ENDPOINT_JSON_INVALID: malformed local JSON; no automatic retry was made.");
      throw error;
    }
  }

  private async readBoundedText(path: string, maximum: number): Promise<string> {
    if ((await stat(path)).size > maximum) throw new UserError("Local App metadata exceeds its supported bound.");
    const bytes = await readFile(path);
    if (bytes.length > maximum) throw new UserError("Local App metadata exceeds its supported bound.");
    return bytes.toString("utf8");
  }
}
