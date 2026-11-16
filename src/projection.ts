import type { PendingRequest, SessionRecord, TimelineEntry } from "./domain.js";
import { object, safeText, string } from "./safety.js";

export interface Projection {
  changed: boolean;
  final?: { id: string; text: string };
  requestChanged?: boolean;
}

function text(value: unknown, fallback: string, limit = 4000): string {
  return typeof value === "string" ? safeText(value, limit) : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isFinalPhase(phase: string | undefined): boolean {
  return phase === "final" || phase === "final_answer" || phase === "response";
}

export function visibleUserContent(data: Record<string, unknown>): string | undefined {
  if (data.isAutopilotContinuation === true ||
    (typeof data.source === "string" && /^(?:skill-|agent-)/u.test(data.source))) return undefined;
  return typeof data.content === "string" ? safeText(data.content, Number.MAX_SAFE_INTEGER) : undefined;
}

export function rememberConversation(record: SessionRecord, candidate: unknown): boolean {
  if (typeof candidate !== "string" || !Number.isFinite(Date.parse(candidate)) ||
    (record.lastConversationAt && Date.parse(record.lastConversationAt) >= Date.parse(candidate))) return false;
  record.lastConversationAt = candidate;
  return true;
}

export function chronologicalTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  return entries.sort((a, b) => {
    if (!a.timestamp) return b.timestamp ? -1 : 0;
    if (!b.timestamp) return 1;
    return Date.parse(a.timestamp) - Date.parse(b.timestamp);
  });
}

export function recentDialogue(entries: readonly TimelineEntry[]): TimelineEntry[] {
  return chronologicalTimeline(entries.filter((entry) =>
    (entry.kind === "user" || entry.kind === "assistant") && entry.state !== "running" && entry.text.trim()))
    .slice(-2).map((entry) => ({ ...entry, text: safeText(entry.text, 600) }));
}

export function mergeDialoguePreview(preview: readonly TimelineEntry[], timeline: readonly TimelineEntry[]): TimelineEntry[] {
  const entries = recentDialogue(preview);
  const matched = new Set<number>();
  for (const entry of recentDialogue(timeline)) {
    let index = entries.findIndex((previous) => previous.id === entry.id);
    // App excerpts and canonical history can identify the same root row differently.
    if (index < 0) index = entries.findIndex((previous, candidate) => !matched.has(candidate) &&
      entry.timestamp !== undefined && previous.timestamp === entry.timestamp &&
      previous.kind === entry.kind && previous.text === entry.text);
    if (index < 0) index = entries.push(entry) - 1;
    else entries[index] = entry;
    matched.add(index);
  }
  return recentDialogue(entries);
}

export class Projector {
  private readonly phases = new Map<string, string>();
  private readonly streams = new Map<string, string>();
  private readonly ephemeralIds = new Map<string, string[]>();

  constructor(private readonly timelineLimit = 160) {}

  apply(record: SessionRecord, event: unknown, historical = false): Projection {
    if (!object(event) || !string(event.type) || !string(event.id) || !object(event.data) || event.checkpoint === true) {
      return { changed: false };
    }
    const ephemeral = event.ephemeral === true || event.type.endsWith("_delta") || event.type === "assistant.message_start";
    if (ephemeral) {
      const recent = this.ephemeralIds.get(record.id) ?? [];
      if (recent.includes(event.id)) return { changed: false };
      recent.push(event.id);
      this.ephemeralIds.set(record.id, recent.slice(-1000));
    } else {
      if (record.seenEvents.includes(event.id)) return { changed: false };
      record.seenEvents.push(event.id);
      record.seenEvents = record.seenEvents.slice(-4000);
    }
    const data = event.data;
    const eventId = event.id;
    let final: Projection["final"];
    let requestChanged = false;
    let changed = true;
    const key = `${record.id}:${typeof data.messageId === "string" ? data.messageId : event.id}`;
    const upsert = (entry: TimelineEntry) => {
      const index = record.timeline.findIndex((item) => item.id === entry.id);
      const timestamp = typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp))
        ? event.timestamp : record.timeline[index]?.timestamp;
      const projected = { ...entry, ...(timestamp ? { timestamp } : {}) };
      if (index >= 0) record.timeline[index] = projected;
      else record.timeline.push(projected);
    };
    const append = (kind: TimelineEntry["kind"], content: string, state?: TimelineEntry["state"]) => {
      upsert({ id: eventId, kind, text: content, ...(state ? { state } : {}) });
    };
    const request = (pending: PendingRequest) => {
      if (historical) {
        upsert({ id: `request:${pending.id}`, kind: pending.kind, text: pending.title, state: "skipped" });
        return;
      }
      if (!record.pending.some((item) => item.id === pending.id)) {
        record.pending.push(pending);
        requestChanged = true;
      }
      record.status = "awaiting";
      upsert({ id: `request:${pending.id}`, kind: pending.kind, text: pending.title, state: "waiting" });
    };
    const completed = (kind: PendingRequest["kind"], state: "answered" | "skipped") => {
      if (!string(data.requestId)) return;
      const pending = record.pending.find((item) => item.id === data.requestId);
      const previous = record.timeline.find((item) => item.id === `request:${data.requestId}`);
      record.pending = record.pending.filter((item) => item.id !== data.requestId);
      requestChanged = pending !== undefined;
      upsert({
        id: `request:${data.requestId}`, kind, text: pending?.title ?? previous?.text ?? `${kind} request resolved`,
        state: previous?.state === "cancelled" && (state === "skipped" || kind !== "input") ? "cancelled" : state,
      });
      if (record.status === "awaiting" && record.pending.length === 0) record.status = "busy";
    };

    switch (event.type) {
      case "assistant.message_start":
        if (typeof data.phase === "string") this.phases.set(key, data.phase);
        changed = false;
        break;
      case "assistant.message_delta": {
        if (event.agentId || data.parentToolCallId) { changed = false; break; }
        const phase = this.phases.get(key);
        if (phase !== "commentary" && !isFinalPhase(phase)) { changed = false; break; }
        if (typeof data.deltaContent !== "string") { changed = false; break; }
        const combined = ((this.streams.get(key) ?? "") + data.deltaContent).slice(0, 64_000);
        this.streams.set(key, combined);
        upsert({
          id: `message:${data.messageId}`, kind: "assistant", text: safeText(combined),
          phase: phase === "commentary" ? "commentary" : "final", state: "running",
        });
        break;
      }
      case "assistant.message": {
        if (event.agentId || data.parentToolCallId) {
          append("agent", "Subagent message received (internal text withheld).");
          break;
        }
        const phase = typeof data.phase === "string" ? data.phase : this.phases.get(key);
        this.phases.delete(key);
        this.streams.delete(key);
        if (phase !== undefined && phase !== "commentary" && !isFinalPhase(phase)) {
          upsert({ id: `message:${data.messageId}`, kind: "status", text: "Native phase activity (text withheld)." });
          break;
        }
        const commentary = phase === "commentary" || (Array.isArray(data.toolRequests) && data.toolRequests.length > 0);
        const content = text(data.content, "", Number.MAX_SAFE_INTEGER);
        if (!content) { changed = false; break; }
        const id = typeof data.messageId === "string" ? data.messageId : event.id;
        upsert({
          id: `message:${id}`, kind: "assistant", text: content,
          phase: commentary ? "commentary" : "final", state: "done",
        });
        if (content.trim()) rememberConversation(record, event.timestamp);
        if (!historical && !commentary) final = { id, text: content };
        break;
      }
      case "assistant.turn_start":
        if (!event.agentId && !data.parentToolCallId) {
          record.status = "busy";
          if (!historical) record.executionObserved = true;
        }
        else append("agent", "Subagent working.", "running");
        break;
      case "tool.execution_start": {
        const name = typeof data.toolName === "string" && /^[\w.-]{1,100}$/.test(data.toolName) ? data.toolName : "Tool";
        upsert({ id: `tool:${data.toolCallId}`, kind: "tool", text: name, state: "running" });
        break;
      }
      case "tool.execution_complete": {
        const existing = record.timeline.find((item) => item.id === `tool:${data.toolCallId}`);
        upsert({
          id: `tool:${data.toolCallId}`, kind: "tool", text: existing?.text ?? "Tool",
          state: data.success === true ? "done" : "failed",
        });
        break;
      }
      case "subagent.started":
        upsert({ id: `agent:${data.toolCallId}`, kind: "agent", text: text(data.agentDisplayName, "Subagent", 100), state: "running" });
        break;
      case "subagent.completed":
      case "subagent.failed": {
        const existing = record.timeline.find((item) => item.id === `agent:${data.toolCallId}`);
        upsert({
          id: `agent:${data.toolCallId}`, kind: "agent", text: existing?.text ?? "Subagent",
          state: event.type === "subagent.completed" ? "done" : "failed",
        });
        break;
      }
      case "user_input.requested":
        if (string(data.requestId)) request({
          id: data.requestId, kind: "input", title: text(data.question, "Native question"),
          choices: strings(data.choices).map((choice) => safeText(choice, 200)),
          allowFreeform: data.allowFreeform !== false,
        });
        break;
      case "permission.requested": {
        if (data.resolvedByHook === true || !string(data.requestId)) break;
        const raw = object(data.permissionRequest) ? data.permissionRequest : {};
        const kind = typeof raw.kind === "string" && /^[\w-]{1,40}$/.test(raw.kind) ? raw.kind : "tool";
        request({
          id: data.requestId, kind: "permission",
          title: `Approval required: ${kind}. ` + text(raw.intention, "Arguments/output withheld. Approve once only.", 400),
          choices: [], allowFreeform: false,
        });
        break;
      }
      case "exit_plan_mode.requested":
        if (string(data.requestId)) request({
          id: data.requestId, kind: "plan",
          title: text(data.summary, "Review the proposed plan", 2000) + "\n" + text(data.planContent, "", 3000),
          choices: strings(data.actions), allowFreeform: true,
        });
        break;
      case "user_input.completed":
        completed("input", typeof data.answer === "string" ? "answered" : "skipped");
        break;
      case "permission.completed":
        completed("permission", "answered");
        break;
      case "exit_plan_mode.completed":
        completed("plan", data.approved === true ? "answered" : "skipped");
        break;
      case "session.idle":
        // App observation completion is scoped to this bot's admissions, not
        // proof that the original host has no other work. Its registry owns status.
        if (!event.agentId && record.peerSource !== "app") record.status = record.pending.length ? "awaiting" : "idle";
        if (!event.agentId && !historical) record.executionObserved = false;
        break;
      case "session.autopilot_stopped":
        if (!event.agentId && !data.parentToolCallId) {
          record.status = record.pending.length ? "awaiting" : "idle";
          if (!historical) record.executionObserved = false;
        }
        append("status", "Autopilot stopped. This is not a task-success assertion.");
        break;
      case "bridge.journal_notice":
        append("status", "Peer journal preview was bounded or contained an unreadable/oversized record. That content was not displayed.");
        break;
      case "bridge.app_output_unavailable": {
        const code = data.code === "APP_OUTPUT_TIMEOUT" ? "APP_OUTPUT_TIMEOUT" : "APP_OUTPUT_READ_FAILED";
        const content = `App result observation stopped (${code}). Completion could not be confirmed for every admitted instruction; unrelated or unattributed output was not forwarded. Use Read transcript to inspect any later result; the original request was not replayed.`;
        if (typeof data.messageId !== "string") record.status = "error";
        append("error", content, "failed");
        if (!historical) final = { id: eventId, text: content };
        break;
      }
      case "bridge.app_admission_consumed":
        append("status", "Execution observed for the admitted App instruction. Its own message ID was found; no user prompt was echoed.");
        break;
      case "bridge.app_admission_confirmed":
        append("task", "Result confirmed for the admitted App instruction. Teams delivery requires an outbox acknowledgement.", "done");
        break;
      case "session.task_complete":
        append("task", (data.success === true ? "Task completion accepted by native runtime." : "Task completion was not confirmed.") +
          (typeof data.summary === "string" ? `\n${safeText(data.summary, 2000)}` : ""),
          data.success === true ? "done" : "failed");
        break;
      case "session.error":
        record.status = "error";
        append("error", "Native session error. Details withheld; inspect the local runtime log.", "failed");
        break;
      case "abort":
        for (const pending of record.pending) {
          upsert({ id: `request:${pending.id}`, kind: pending.kind, text: pending.title, state: "cancelled" });
        }
        record.pending = [];
        requestChanged = true;
        record.status = "idle";
        record.executionObserved = false;
        append("status", "Turn stopped; session history is preserved.");
        break;
      case "session.shutdown":
        for (const pending of record.pending) {
          upsert({ id: `request:${pending.id}`, kind: pending.kind, text: pending.title, state: "cancelled" });
        }
        record.pending = [];
        requestChanged = true;
        record.status = "offline";
        record.executionObserved = false;
        append("status", "Session disconnected; saved history is preserved.");
        break;
      case "session.model_change":
      case "session.mode_changed":
        append("status", "Native session settings changed; authoritative readback requested.");
        break;
      case "user.message": {
        const content = !event.agentId && !data.parentToolCallId ? visibleUserContent(data) : undefined;
        if (content?.trim()) {
          rememberConversation(record, event.timestamp);
          upsert({
            id: `message:${typeof data.messageId === "string" ? data.messageId : event.id}`,
            kind: "user", text: content, state: "done",
          });
        } else changed = false;
        break;
      }
      case "assistant.reasoning":
      case "assistant.reasoning_delta":
      case "assistant.streaming_delta":
      case "assistant.tool_call_delta":
      case "tool.execution_partial_result":
      case "tool.shell_output":
      case "tool.execution_progress":
      case "system.message":
      case "system.notification":
      case "session.start":
      case "session.resume":
        changed = false;
        break;
      default:
        upsert({ id: "native-status", kind: "status", text: "Native activity received (unrecognized payload withheld)." });
    }
    record.timeline = record.timeline.slice(-this.timelineLimit);
    if (changed) {
      record.sequence++;
      record.updatedAt = Date.now();
    }
    return { changed, ...(final ? { final } : {}), ...(requestChanged ? { requestChanged: true } : {}) };
  }
}
