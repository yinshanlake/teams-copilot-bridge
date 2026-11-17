import { randomUUID } from "node:crypto";
import type { Tool } from "@github/copilot-sdk";
import type {
  Answer, AppAdmissionSeed, ConversationPreview, CreateOptions, InteractionOptions, ModelChoice, Runtime, RuntimeEvent, SessionRecord, Settings, SettingsChange, SettingsResult, JournalCursor, FinalPage, SendOptions,
} from "./domain.js";
import { Projector, recentDialogue } from "./projection.js";
import { digest, UserError } from "./safety.js";

interface FakeSession {
  id: string;
  settings: Settings;
  controller: boolean;
  tools: Tool<unknown>[];
  events: unknown[];
  generation: number;
  busy: boolean;
  origin?: string;
}

export const mockModels: ModelChoice[] = [
  { key: "mock-code", id: "mock-code", name: "MOCK Code", efforts: ["low", "high"] },
  { key: "mock-fast", id: "mock-fast", name: "MOCK Fast (no reasoning control)", efforts: [] },
  { key: "mock-deep", id: "mock-deep", name: "MOCK Deep", efforts: ["high", "max"] },
];

export class FakeRuntime implements Runtime {
  readonly description = "MOCK runtime - no Copilot cloud, shell, files or Teams sends";
  readonly received: Array<{ sessionId: string; text: string }> = [];
  readonly sendModes: Array<{ sessionId: string; mode: "enqueue" | "immediate" }> = [];
  readonly resumed: string[] = [];
  readonly stopped: string[] = [];
  readonly settingsCalls: Array<{ id: string; change: SettingsChange }> = [];
  readonly answers: Array<{ id: string; requestId: string; answer: Answer }> = [];
  readonly live = new Map<string, FakeSession>();
  readonly foreign: Awaited<ReturnType<Runtime["inventory"]>> = [];
  private readonly pending = new Map<string, { id: string; kind: "input" | "permission" | "plan"; choices: string[]; expiresAt?: number; complete(answer: Answer): void }>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private listener: (event: RuntimeEvent) => void = () => { throw new Error("Mock runtime not started"); };
  private closed = false;

  constructor(private readonly tickMs = 180, private readonly autonomous = true, private readonly interactionEvents = false,
    private readonly controls?: InteractionOptions) {}

  async start(listener: (event: RuntimeEvent) => void): Promise<void> {
    this.listener = listener;
  }

  async inventory(_controllerId: string): Promise<Awaited<ReturnType<Runtime["inventory"]>>> {
    return structuredClone(this.foreign);
  }

  async appLiveness(): ReturnType<Runtime["appLiveness"]> {
    return this.foreign.flatMap((session) =>
      session.peerSource === "app" && session.liveUntil !== undefined && session.liveUntil > Date.now() &&
        (session.status === "idle" || session.status === "busy")
        ? [{ id: session.id, status: session.status, liveUntil: session.liveUntil }] : []);
  }

  async reconcileAdmissions(): Promise<void> {}

  settleAdmission(_admissionId: string): void {}

  async create(options: CreateOptions): Promise<Settings> {
    if (this.live.has(options.id)) throw new UserError("Mock session already exists.");
    const settings: Settings = { mode: "interactive", modelId: "mock-code", effort: "high" };
    this.live.set(options.id, {
      id: options.id, settings, controller: options.controller, tools: options.tools ?? [],
      generation: 0, events: [], busy: false,
    });
    return structuredClone(settings);
  }

  async resume(record: SessionRecord, tools?: Tool<unknown>[]): Promise<Settings> {
    if (this.foreign.some((item) => item.id === record.id)) throw new UserError("Foreign live owner: mock resume refused.");
    if (!this.live.has(record.id)) {
      if (record.kind !== "owned" && record.kind !== "controller") throw new UserError("Cannot resume a foreign session.");
      this.resumed.push(record.id);
      this.live.set(record.id, {
        id: record.id, settings: record.settings ?? { mode: "interactive", modelId: "mock-code", effort: "high" },
        controller: record.kind === "controller", tools: tools ?? [], generation: 0, events: [], busy: false,
      });
    }
    return this.settings(record.id);
  }

  emit(id: string, type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): void {
    const origin = this.live.get(id)?.origin;
    if (type === "assistant.message" && origin && data.originatingMessageId === undefined) data = { ...data, originatingMessageId: origin };
    const event = { type, id: randomUUID(), timestamp: new Date().toISOString(), parentId: null, data, ...extra };
    this.live.get(id)?.events.push(event);
    this.listener({ sessionId: id, event });
    if (type === "session.idle") {
      const session = this.live.get(id);
      if (session) delete session.origin;
    }
  }

  private later(action: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) action();
    }, delay);
    this.timers.add(timer);
  }

  async send(id: string, text: string, _persist?: (admission: AppAdmissionSeed) => Promise<void>, options?: SendOptions): Promise<{ id: string; peer: boolean }> {
    const session = this.live.get(id);
    if (!session) throw new UserError("Mock session is not live.");
    if (options?.mode === "immediate" && (!session.busy || session.origin !== options.expectedMessageId)) {
      throw new UserError("The mock steering request is no longer processing.");
    }
    this.received.push({ sessionId: id, text });
    this.sendModes.push({ sessionId: id, mode: options?.mode ?? "enqueue" });
    session.busy = true;
    const messageId = randomUUID();
    if (options?.mode === "immediate") {
      this.emit(id, "user.message", { messageId, content: text });
      this.emit(id, "assistant.message", { messageId: randomUUID(), originatingMessageId: session.origin, phase: "commentary",
        content: "MOCK steering received; the original task keeps its recipient. No real model runs." });
      return { id: messageId, peer: false };
    }
    session.origin = messageId;
    if (this.interactionEvents) this.emit(id, "user.message", { messageId, content: text });
    this.emit(id, "assistant.turn_start", { turnId: randomUUID() });
    if (this.autonomous) {
      const generation = session.generation;
      this.later(() => {
        if (session.generation !== generation) return;
        if (session.controller) {
          void this.control(session, text).catch(() => this.finish(session, "MOCK control tool failed; no code was executed."));
        } else this.work(session, text);
      }, this.tickMs);
    }
    return { id: messageId, peer: false };
  }

  private work(session: FakeSession, text: string): void {
    const id = session.id;
    const callId = randomUUID();
    this.emit(id, "assistant.message", {
      messageId: randomUUID(), phase: "commentary",
      content: "MOCK: working on the exact forwarded text. This preview runs no real tools or models.",
    });
    this.emit(id, "tool.execution_start", {
      toolCallId: callId, toolName: "mock_inspect", arguments: { secret: "not displayed", prompt: "internal fixture" },
    });
    this.emit(id, "subagent.started", {
      toolCallId: `agent-${callId}`, agentName: "mock-helper", agentDisplayName: "Mock helper", agentDescription: "Mock only",
    });
    this.emit(id, "subagent.completed", { toolCallId: `agent-${callId}`, agentName: "mock-helper", agentDisplayName: "Mock helper" });
    this.emit(id, "tool.execution_complete", { toolCallId: callId, success: true, result: { content: "unfiltered tool fixture - not displayed" } });
    if (/^ask\b/i.test(text)) {
      this.question(session, "input");
      return;
    }
    if (/^permission\b/i.test(text)) {
      this.question(session, "permission");
      return;
    }
    if (/^plan\b/i.test(text)) {
      this.question(session, "plan");
      return;
    }
    if (this.interactionEvents && /^form\b/i.test(text)) {
      this.emit(id, "elicitation.requested", { requestId: randomUUID(), message: "MOCK structured form",
        mode: "form", requestedSchema: { type: "object", properties: { answer: { type: "string" } } } }, { ephemeral: true });
      return;
    }
    if (/^error\b/i.test(text)) {
      session.busy = false;
      this.emit(id, "session.error", { message: "MOCK error with api_key=never-export-this" });
      return;
    }
    const generation = session.generation;
    const delay = /^background\b/i.test(text) ? this.tickMs * 15 : this.tickMs * 2;
    this.later(() => {
      if (session.generation !== generation) return;
      const response = /^long\b/i.test(text)
        ? "MOCK long answer:\n" + "Safe text \u{1f680} ".repeat(4500)
        : `MOCK response to your unchanged message:\n${text}`;
      this.finish(session, response);
    }, delay);
  }

  private question(session: FakeSession, kind: "input" | "permission" | "plan"): void {
    const requestId = randomUUID();
    const choices = kind === "input" ? ["Proceed", "Revise"] : kind === "plan" ? ["interactive", "autopilot", "exit_only"] : [];
    const expiresAt = this.interactionEvents && kind !== "input" ? Date.now() + (this.controls?.approvalTimeoutMs ?? 15 * 60_000) : undefined;
    this.pending.set(`${session.id}:${requestId}`, {
      id: session.id, kind, choices, ...(expiresAt === undefined ? {} : { expiresAt }),
      complete: (answer) => {
        if (kind === "permission" && this.interactionEvents && this.controls?.remoteApprovals !== false) {
          this.emit(session.id, "bridge.permission_resolved", {
            requestId, outcome: answer.permission === "session" ? "session" : answer.approve === false ? "deny" : "once",
          });
        }
        this.emit(session.id, kind === "input" ? "user_input.completed" : kind === "plan" ? "exit_plan_mode.completed" : "permission.completed", {
          requestId,
          ...(kind === "input" ? (answer.skip ? {} : { answer: answer.choice === undefined ? answer.text : choices[answer.choice], wasFreeform: answer.choice === undefined })
            : { approved: answer.approve === true }),
        });
        if (kind === "plan" && answer.approve && answer.choice !== undefined) {
          const action = choices[answer.choice];
          if (action === "interactive" || action === "autopilot") session.settings.mode = action;
        }
        this.finish(session, `MOCK ${kind} response ${answer.skip ? "skipped" : answer.approve === false ? "denied" : "accepted"} for native request ${requestId}.`);
      },
    });
    this.emit(session.id, kind === "input" ? "user_input.requested" : kind === "plan" ? "exit_plan_mode.requested" : "permission.requested", {
      requestId,
      ...(kind !== "input" && this.interactionEvents ? {
        bridgeRemoteApprovalAllowed: this.controls?.remoteApprovals !== false, bridgeApprovalExpiresAt: expiresAt,
      } : {}),
      ...(kind === "input" ? { question: "MOCK question: how should this task continue?", choices, allowFreeform: true }
        : kind === "plan" ? { summary: "MOCK plan review", planContent: "Inspect the fixture, then produce a mock result. No real execution.", actions: choices, recommendedAction: "interactive" }
          : { permissionRequest: { kind: "shell", intention: "MOCK permission only. No shell is ever run.",
            fullCommandText: "Write-Output 'MOCK only'; password=hidden-fixture", canOfferSessionApproval: true } }),
    });
    if (kind !== "input" && this.controls?.remoteApprovals === false) {
      const request = this.pending.get(`${session.id}:${requestId}`)!;
      this.pending.delete(`${session.id}:${requestId}`);
      request.complete({ approve: false });
    } else if (expiresAt !== undefined) this.later(() => {
      const key = `${session.id}:${requestId}`;
      if (!this.pending.has(key)) return;
      this.pending.delete(key);
      this.emit(session.id, kind === "permission" ? "bridge.permission_resolved" : "exit_plan_mode.completed",
        { requestId, outcome: "timeout", approved: false });
      this.finish(session, "MOCK approval timeout: user not available.");
    }, Math.max(0, expiresAt - Date.now()));
  }

  private finish(session: FakeSession, text: string): void {
    this.emit(session.id, "assistant.message", { messageId: randomUUID(), phase: "final_answer", content: text });
    this.emit(session.id, "session.task_complete", { success: true, summary: "Mock scenario completed." });
    session.busy = false;
    this.emit(session.id, "session.idle");
  }

  private async control(session: FakeSession, text: string): Promise<void> {
    let name = "bridge_list";
    let parameters: Record<string, unknown> = {};
    if (/^create\s+/i.test(text)) {
      name = "bridge_create";
      const tool = session.tools.find((item) => item.name === name);
      const schema: unknown = tool?.parameters;
      let workspace = "local";
      if (schema && typeof schema === "object" && "properties" in schema) {
        const properties = schema.properties;
        if (properties && typeof properties === "object" && "workspace" in properties) {
          const field = properties.workspace;
          if (field && typeof field === "object" && "enum" in field && Array.isArray(field.enum) && typeof field.enum[0] === "string") workspace = field.enum[0];
        }
      }
      parameters = { name: text.replace(/^create\s+/i, "").trim(), workspace };
    }
    const tool = session.tools.find((item) => item.name === name);
    if (!tool?.handler) throw new Error("Missing mock control tool");
    const callId = randomUUID();
    this.emit(session.id, "tool.execution_start", { toolCallId: callId, toolName: name });
    const result = await tool.handler(parameters, { sessionId: session.id, toolCallId: callId, toolName: name, arguments: parameters });
    this.emit(session.id, "tool.execution_complete", { toolCallId: callId, success: true });
    this.finish(session, `MOCK control executed the real bounded bridge tool ${name}:\n${JSON.stringify(result, null, 2)}`);
  }

  async stop(id: string, expectedMessageId?: string): Promise<void> {
    const session = this.live.get(id);
    if (!session) throw new UserError("Only a mock-owned session may be stopped.");
    if (expectedMessageId && session.origin !== expectedMessageId) throw new UserError("The processing mock request changed.");
    session.generation++;
    session.busy = false;
    for (const [key, request] of this.pending) if (request.id === id) this.pending.delete(key);
    this.stopped.push(id);
    this.emit(id, "abort");
    this.emit(id, "session.idle");
  }

  async settings(id: string): Promise<Settings> {
    const session = this.live.get(id);
    if (!session) throw new UserError("Mock-owned session required.");
    return structuredClone(session.settings);
  }

  async models(id: string): Promise<ModelChoice[]> {
    if (!this.live.has(id)) throw new UserError("Mock-owned session required.");
    return structuredClone(mockModels);
  }

  async configure(id: string, change: SettingsChange): Promise<SettingsResult> {
    const session = this.live.get(id);
    if (!session || session.busy) throw new UserError("Session is busy or foreign; settings not changed.");
    const model = mockModels.find((item) => item.key === change.modelKey);
    if (!model || (change.effort && !model.efforts.includes(change.effort))) throw new UserError("Model/effort compatibility is invalid.");
    this.settingsCalls.push({ id, change });
    session.settings = { mode: change.mode, modelId: model.id, ...(change.effort ? { effort: change.effort } : {}) };
    this.emit(id, "session.mode_changed", { newMode: change.mode });
    this.emit(id, "session.model_change", { newModel: model.id });
    return { status: "applied", actual: await this.settings(id), expected: await this.settings(id), detail: "MOCK settings applied and read back." };
  }

  async answer(id: string, requestId: string, answer: Answer): Promise<void> {
    const key = `${id}:${requestId}`;
    const request = this.pending.get(key);
    if (!request) throw new UserError("Mock native request is stale.");
    if (request.kind !== "input" && (this.controls?.remoteApprovals === false ||
      request.expiresAt !== undefined && request.expiresAt <= Date.now())) throw new UserError("Mock approval is disabled or expired.");
    if (answer.choice !== undefined && request.choices[answer.choice] === undefined) throw new UserError("Invalid choice.");
    this.answers.push({ id, requestId, answer });
    this.pending.delete(key);
    request.complete(answer);
  }

  async history(id: string): Promise<unknown[]> {
    return [...(this.live.get(id)?.events ?? [])];
  }

  discoveryStatus(): string { return "MOCK side-chat metadata only; no real App database is read."; }
  async subscriptionBaseline(id: string): Promise<JournalCursor> {
    const size = this.live.get(id)?.events.length ?? 0;
    return { generation: `mock:${id}`, offset: size, index: size, anchor: digest("mock"), eofRecord: false,
      requests: [], starts: [], outputs: [] };
  }
  async subscriptionRead(id: string, cursor: JournalCursor): Promise<FinalPage> {
    const all = this.live.get(id)?.events ?? [];
    const entries = all.slice(cursor.index, cursor.index + 128);
    return { cursor: { ...cursor, offset: cursor.offset + entries.length, index: cursor.index + entries.length },
      events: entries.filter((entry) => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "assistant.message"),
      hasMore: cursor.index + entries.length < all.length };
  }

  async preview(id: string): Promise<ConversationPreview> {
    const record: SessionRecord = {
      id, name: "MOCK preview", workspace: "", kind: "owned", status: "offline", capability: "",
      timeline: [], pending: [], seenEvents: [], sequence: 0, updatedAt: 0,
    };
    const projector = new Projector(512);
    for (const event of this.live.get(id)?.events ?? []) projector.apply(record, event, true);
    return { entries: recentDialogue(record.timeline), complete: true };
  }

  async watchPeer(_record: SessionRecord): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

export function fixtureId(label: string): string {
  const hash = digest(label);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
