import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import type {
  CopilotClientOptions, ModelInfo, SessionConfig, ResumeSessionConfig, SessionEvent,
} from "@github/copilot-sdk";
import type { BridgeState, CreateOptions, RuntimeEvent, SessionRecord } from "../src/domain.js";
import { NativeRuntime, catalogue, childEnvironment, type NativeOptions, type SdkClient, type SdkSession } from "../src/native.js";
import { Bridge } from "../src/bridge.js";
import { Store } from "../src/store.js";
import { PreviewTransport, mockEnvelope, mockIdentity } from "../src/simulator.js";
import { authorizeActivity } from "../src/teams.js";
import type {
  AppSessionsOptions, AppSessionClient, AppSessionCompletion, AppSessionInfo, AppSessionSnapshot, AppSessionTurn,
} from "../src/app-sessions.js";
import { LocalAppSessions } from "../src/app-sessions.js";
import { digest, object } from "../src/safety.js";
import { Projector } from "../src/projection.js";
import { completeAppSend, eventually, findAction, temporary, legacySend } from "./helpers.js";

const models: ModelInfo[] = [
  {
    id: "native-alpha", name: "Alpha", capabilities: {
      supports: { vision: false, reasoningEffort: true }, limits: { max_context_window_tokens: 100_000 },
    }, supportedReasoningEfforts: ["low", "max"], defaultReasoningEffort: "low",
  },
  {
    id: "native-fast", name: "Fast", capabilities: {
      supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 80_000 },
    },
  },
];

interface DoubleSession {
  port: SdkSession;
  config: SessionConfig | ResumeSessionConfig;
  mode: "interactive" | "plan" | "autopilot";
  modelId: string;
  effort?: string;
  required: boolean;
  disconnected: boolean;
  events: SessionEvent[];
  pendingPermission: string | undefined;
  permissionResults: unknown[];
  switchCalls: unknown[];
}

class SdkDouble implements SdkClient {
  readonly sessions = new Map<string, DoubleSession>();
  readonly created: SessionConfig[] = [];
  readonly resumed: Array<{ id: string; config: ResumeSessionConfig }> = [];
  readonly sent: Array<{ id: string; prompt: string }> = [];
  locks: string[] = [];
  deferred = false;
  wrongReadback = false;
  permissionSuccess = true;
  peers: Awaited<ReturnType<SdkSession["rpc"]["management"]["list"]>> = { sessions: [] };
  managementMessages: unknown[] = [];
  policies: unknown[] = [];
  metadata: Awaited<ReturnType<SdkClient["listSessions"]>> = [];
  status = { isAuthenticated: true };
  startupModels = models;
  rpc: SdkClient["rpc"] = {
    sessions: {
      checkInUse: async () => ({ inUse: this.locks }),
      readPersistedEvents: async () => ({ events: [], cursor: "end", hasMore: false, cursorStatus: "ok" }),
    },
  };
  async start(): Promise<void> {}
  async stop(): Promise<Error[]> { return []; }
  async getAuthStatus() { return this.status; }
  async listModels() { return this.startupModels; }
  async listSessions() { return this.metadata; }
  async createSession(config: SessionConfig): Promise<SdkSession> {
    this.created.push(config);
    return this.session(config.sessionId ?? randomUUID(), config);
  }
  async resumeSession(id: string, config: ResumeSessionConfig): Promise<SdkSession> {
    this.resumed.push({ id, config });
    return this.session(id, config);
  }
  private session(id: string, config: SessionConfig | ResumeSessionConfig): SdkSession {
    const state: DoubleSession = {
      config, mode: "interactive", modelId: config.model ?? "native-alpha",
      required: false, disconnected: false, events: [], pendingPermission: undefined,
      permissionResults: [], switchCalls: [],
      port: {
        sessionId: id, permissionModeResult: { success: true, mode: "manual" },
        send: async (message) => {
          this.sent.push({ id, prompt: typeof message === "string" ? message : message.prompt });
          return randomUUID();
        },
        abort: async () => undefined,
        disconnect: async () => { state.disconnected = true; },
        getEvents: async () => state.events,
        rpc: {
          management: {
            configure: async (policy) => {
              this.policies.push(policy);
              return { enabled: true, scope: "all", list: true, create: false, message: true, close: false };
            },
            list: async () => this.peers,
            message: async (message) => { this.managementMessages.push(message); return { accepted: true }; },
          },
          model: {
            list: async () => ({ list: models.map((model) => ({
              id: model.id, name: model.name,
              capabilities: {
                supports: { vision: false, reasoningEffort: model.capabilities.supports.reasoningEffort },
                limits: { max_context_window_tokens: model.capabilities.limits.max_context_window_tokens },
              },
              ...(model.supportedReasoningEfforts ? { supportedReasoningEfforts: model.supportedReasoningEfforts } : {}),
            })) }),
            getCurrent: async () => ({
              modelId: this.wrongReadback ? "unexpected-model" : state.modelId,
              ...(state.effort ? { reasoningEffort: state.effort } : {}),
            }),
            switchTo: async (change) => {
              state.switchCalls.push(change);
              if (!this.deferred) {
                state.modelId = change.modelId;
                if (typeof change.reasoningEffort === "string") state.effort = change.reasoningEffort;
                else delete state.effort;
              }
              return { modelId: state.modelId, ...(this.deferred ? { deferred: true, queueId: "native-queue" } : {}) };
            },
          },
          mode: {
            get: async () => state.mode,
            set: async ({ mode }) => {
              state.mode = mode;
              return { status: "unchanged", modeApplied: true, modelChanged: false };
            },
          },
          permissions: {
            getMode: async () => ({ mode: "manual" }),
            setRequired: async ({ required }) => { state.required = required; return { success: true }; },
            pendingRequests: async () => ({
              items: state.pendingPermission ? [{ requestId: state.pendingPermission, request: {
                kind: "read", path: "fixture.txt", intention: "Read a test fixture",
              } }] : [],
            }),
            handlePendingPermissionRequest: async (request) => {
              state.permissionResults.push(request);
              if (this.permissionSuccess) state.pendingPermission = undefined;
              return { success: this.permissionSuccess };
            },
          },
        },
      },
    };
    this.sessions.set(id, state);
    return state.port;
  }
}

class AppSessionsDouble implements AppSessionClient {
  sessions: AppSessionInfo[] = [];
  sent: Array<{ sessionId: string; message: string }> = [];
  turns: AppSessionTurn[] = [{ index: 1, assistantResponse: "App response", timestamp: "2026-11-11T13:00:00.000Z" }];
  started = false;
  closed = false;
  reads = 0;
  lists = 0;
  completedThrough = -1;
  completions: AppSessionCompletion[] = [];
  consumed: AppSessionSnapshot["consumed"] = [];
  async start() { this.started = true; }
  async listSessions() { this.lists++; return this.sessions; }
  async liveness() {
    return this.sessions.flatMap((session) => session.direct && (session.liveUntil ?? Infinity) > Date.now() &&
      (session.status === "idle" || session.status === "busy")
      ? [{ id: session.id, status: session.status, liveUntil: session.liveUntil ?? Date.now() + 20_000 }] : []);
  }
  async sendMessage(sessionId: string, message: string) {
    this.sent.push({ sessionId, message });
    return `app-message-${this.sent.length}`;
  }
  async readSession() { this.reads++; return this.turns.map((turn) => ({ ...turn })); }
  async readPreview() { return this.turns.slice(-2).map((turn) => ({ ...turn })); }
  discoveryStatus() { return "Synthetic App metadata"; }
  async subscriptionBaseline(): Promise<import("../src/domain.js").JournalCursor> { throw new Error("No synthetic durable cursor configured."); }
  async subscriptionRead(): Promise<import("../src/domain.js").FinalPage> { throw new Error("No synthetic durable cursor configured."); }
  async readSessionState() {
    this.reads++;
    return {
      turns: this.turns.map((turn) => ({ ...turn })), completedThrough: this.completedThrough,
      completions: this.completions.map((completion) => ({ ...completion })),
      consumed: this.consumed.map((message) => ({ ...message })),
      throughIndex: Math.max(this.completedThrough, ...this.turns.map((turn) => turn.index)),
    };
  }
  async close() { this.closed = true; }
}

test("v2 current-page previews use real LocalAppSessions and NativeRuntime without reading off-page history or starting the SDK", async (t) => {
  const directory = await temporary(t);
  const sessionStateDirectory = join(directory, "sessions");
  const brokerDirectory = join(directory, "broker");
  await mkdir(sessionStateDirectory, { recursive: true });
  const ids = Array.from({ length: 8 }, () => randomUUID());
  for (const [index, id] of ids.entries()) {
    const root = join(sessionStateDirectory, id);
    await mkdir(root);
    await writeFile(join(root, "workspace.yaml"), `name: "Preview ${index}"\ncwd: "${directory.replaceAll("\\", "\\\\")}"\n`);
    await writeFile(join(root, "events.jsonl"), [
      { id: "root-user", type: "user.message", timestamp: `2026-11-16T00:00:0${index}Z`,
        data: { content: `Input ${index} 🚀`, messageId: `user-${index}` } },
      { id: "root-assistant", type: "assistant.message", timestamp: `2026-11-16T00:01:0${index}Z`,
        data: { content: `Output ${index}`, originatingMessageId: `user-${index}` } },
      { id: "hidden", type: "assistant.message", timestamp: `2026-11-16T00:02:0${index}Z`,
        data: { content: "HIDDEN_PREVIEW", phase: "analysis" } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  }
  const app = new LocalAppSessions({ timeoutMs: 1000, sessionStateDirectory, brokerDirectory });
  let sdkCalls = 0;
  const runtime = new NativeRuntime({
    home: join(directory, "native"), configDirectory: join(directory, "native"), defaultModel: "", peers: false,
  }, () => { sdkCalls++; throw new Error("SDK_MUST_NOT_START_FOR_PREVIEWS"); }, app);
  const reads = t.mock.method(app, "readPreview");
  const history = t.mock.method(app, "readSessionState");
  const store = await Store.open(join(directory, "bridge"), "v2-previews");
  const bridge = new Bridge(store, runtime, new PreviewTransport(), {
    owner: "v2-previews", workspaces: [{ id: "local", name: "Local", path: directory }], coalesceMs: 5,
  });
  try {
    await bridge.start();
    assert.equal(reads.mock.callCount(), 0, "inventory must not load per-row previews");
    const turn = authorizeActivity(mockEnvelope("!sessions"), { aud: mockIdentity.appId }, mockIdentity);
    const first = await bridge.handle(turn.key, turn.reference, turn.activity.id!, turn.incoming);
    await eventually(() => /Session list refreshed/.test(store.snapshot().conversations[turn.key]!.notice));
    assert.deepEqual([...new Set(reads.mock.calls.map((call) => call.arguments[0]))].sort(), ids.slice(5).sort());
    assert.match(JSON.stringify(first), /Input 7/);
    assert.match(JSON.stringify(first), /Output 7/);
    assert.ok(!JSON.stringify(first).includes("HIDDEN_PREVIEW"));
    const next = findAction(bridge.render(turn.key), "Next");
    assert.ok(object(next.data));
    await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "action", data: next.data });
    assert.deepEqual([...new Set(reads.mock.calls.map((call) => call.arguments[0]))].sort(), ids.slice(2).sort());
    const search = findAction(bridge.render(turn.key), "Search");
    assert.ok(object(search.data));
    await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "action", data: { ...search.data, query: "Preview 0" } });
    assert.ok(reads.mock.calls.some((call) => call.arguments[0] === ids[0]));
    assert.ok(!reads.mock.calls.some((call) => call.arguments[0] === ids[1]), "a filtered-out row must not trigger preview I/O");
    assert.equal(history.mock.callCount(), 0, "preview must not use full admission/history reads");
    assert.equal(sdkCalls, 0);
    assert.equal(Object.keys(store.snapshot().admissions).length, 0);
    assert.equal(store.snapshot().outbox.filter((item) => !item.historyId).length, 0);
    assert.equal(store.snapshot().conversations[turn.key]!.selectedId, undefined);
  } finally { await bridge.close(); }
});

test("v2 native previews stay read-only and bounded to existing SDK backward pages without initializing a disconnected session", async (t) => {
  const h = await setup(t);
  const id = randomUUID();
  try {
    assert.deepEqual(await h.runtime.preview(id), { entries: [], complete: false });
    assert.equal(h.captured, undefined);
    await h.runtime.create({ id, name: "Existing native preview", workspace: h.directory, controller: false });
    const calls: Parameters<SdkClient["rpc"]["sessions"]["readPersistedEvents"]>[0][] = [];
    t.mock.method(h.client.rpc.sessions, "readPersistedEvents", async (request: Parameters<SdkClient["rpc"]["sessions"]["readPersistedEvents"]>[0]) => {
      calls.push(request);
      return calls.length === 1 ? {
        events: [
          { id: randomUUID(), type: "assistant.message", timestamp: "2026-11-16T00:02:00Z", parentId: null,
            data: { phase: "analysis", content: "HIDDEN_NATIVE_PREVIEW", messageId: "hidden" } },
          { id: randomUUID(), type: "assistant.message", timestamp: "2026-11-16T00:03:00Z", parentId: null,
            agentId: "child", data: { content: "CHILD_NATIVE_PREVIEW", messageId: "child" } },
        ], cursor: "older-page", cursorStatus: "ok", hasMore: true,
      } : {
        events: [
          { id: randomUUID(), type: "user.message", timestamp: "2026-11-16T00:00:00Z", parentId: null,
            data: { content: "Actual native input", messageId: "user" } },
          { id: randomUUID(), type: "assistant.message", timestamp: "2026-11-16T00:01:00Z", parentId: null,
            data: { content: "Actual native output", phase: "final", messageId: "answer" } },
        ], cursor: "end", cursorStatus: "ok", hasMore: false,
      };
    });
    const preview = await h.runtime.preview(id);
    assert.deepEqual(preview.entries.map((entry) => [entry.kind, entry.text]), [["user", "Actual native input"], ["assistant", "Actual native output"]]);
    assert.equal(preview.complete, true);
    assert.deepEqual(calls, [
      { sessionId: id, direction: "backward", max: 64 },
      { sessionId: id, direction: "backward", max: 64, cursor: "older-page" },
    ]);
    assert.equal(h.client.created.length, 1);
    assert.equal(h.client.resumed.length, 0);
    assert.equal(h.client.sent.length, 0);
    assert.ok(!JSON.stringify(preview).includes("HIDDEN_NATIVE_PREVIEW"));
    assert.ok(!JSON.stringify(preview).includes("CHILD_NATIVE_PREVIEW"));
  } finally { await h.runtime.close(); }
});

async function setup(
  t: TestContext,
  appSessions?: AppSessionClient,
  timing?: Pick<AppSessionsOptions, "outputPollIntervalMs" | "outputWatchTimeoutMs">,
  start = true,
  peers = false,
) {
  const directory = await temporary(t);
  const client = new SdkDouble();
  let captured: CopilotClientOptions | undefined;
  const options: NativeOptions = {
    auth: "token",
    home: join(directory, "native"), configDirectory: join(directory, "native"), defaultModel: "native-alpha",
    token: "explicit-test-only-token", peers,
    ...(timing && appSessions ? {
      appSessions: { timeoutMs: 10_000, ...timing },
    } : {}),
  };
  const runtime = new NativeRuntime(options, (configuration) => { captured = configuration; return client; }, appSessions);
  const events: RuntimeEvent[] = [];
  if (start) await runtime.start((event) => events.push(event));
  // temporary() owns cleanup; tests explicitly close before it runs.
  return { runtime, client, options, get captured() { return captured; }, events, directory };
}

async function admissionFixture(t: TestContext, timeoutMs = 1000, pollIntervalMs = 2) {
  const directory = await temporary(t);
  const id = randomUUID();
  const sessionStateDirectory = join(directory, "session-state");
  const brokerDirectory = join(directory, "broker");
  const storeDirectory = join(directory, "bridge");
  const journal = join(sessionStateDirectory, id, "events.jsonl");
  await mkdir(join(sessionStateDirectory, id), { recursive: true });
  await writeFile(join(sessionStateDirectory, id, "workspace.yaml"), "name: Durable App\ncwd: C:\\fixture\n");
  await writeFile(journal, JSON.stringify({
    id: "baseline", type: "assistant.message", timestamp: "2026-11-14T01:00:00Z", data: { content: "Old safe history" },
  }) + "\n");
  await mkdir(join(brokerDirectory, "sessions"), { recursive: true });
  await writeFile(join(brokerDirectory, "config.json"), JSON.stringify({
    schema: 1, registrationTtlMs: 20_000, operations: ["send_message"],
  }));
  await writeFile(join(brokerDirectory, "sessions", `${id}.json`), JSON.stringify({
    schema: 1, sessionId: id, instanceId: randomUUID(), pid: process.pid,
    name: "Durable App", workspace: directory, status: "busy", heartbeatAt: new Date().toISOString(),
  }));
  const initial = authorizeActivity(mockEnvelope(), { aud: mockIdentity.appId }, mockIdentity);
  const open = async () => {
    const app = new LocalAppSessions({ timeoutMs: 1000, sessionStateDirectory, brokerDirectory });
    const h = await setup(t, app, { outputPollIntervalMs: pollIntervalMs, outputWatchTimeoutMs: timeoutMs }, false);
    const store = await Store.open(storeDirectory, "durable-admission-test");
    const transport = new PreviewTransport();
    const bridge = new Bridge(store, h.runtime, transport, {
      owner: "durable-admission-test", workspaces: [{ id: "local", name: "Local", path: h.directory }], coalesceMs: 2,
    });
    await bridge.start();
    const text = (value: string) => bridge.handle(initial.key, initial.reference, randomUUID(), { kind: "text", text: value });
    if (!store.snapshot().conversations[initial.key]) await text(`!use ${id}`);
    return { ...h, app, store, transport, bridge, text, key: initial.key };
  };
  const submit = (h: Awaited<ReturnType<typeof open>>, prompt = "A synthetic queued instruction") => {
    const action = legacySend(h.bridge, h.key);
    assert.ok(object(action.data));
    const activityId = randomUUID();
    return {
      activityId, data: { ...action.data, message: prompt },
      sending: h.bridge.handle(h.key, initial.reference, activityId, {
        kind: "action", data: { ...action.data, message: prompt },
      }),
    };
  };
  const appendResult = async (messageId: string, content: string) => {
    const interactionId = randomUUID();
    const requestId = randomUUID();
    const toolCallId = randomUUID();
    await appendFile(journal, [
      { id: randomUUID(), type: "user.message", timestamp: "2026-11-15T09:00:00Z",
        data: { messageId, content: "Visible consumed task" } },
      { id: requestId, type: "assistant.message", timestamp: "2026-11-15T09:00:01Z",
        data: { turnId: "0", interactionId, originatingMessageId: messageId, toolRequests: [
          { toolCallId, name: "task_complete", arguments: { summary: content } },
        ] } },
      { id: randomUUID(), parentId: requestId, type: "tool.execution_start",
        data: { turnId: "0", toolCallId, toolName: "task_complete", arguments: { summary: content } } },
      { id: randomUUID(), type: "tool.execution_complete", timestamp: "2026-11-15T09:00:03Z",
        data: { turnId: "0", interactionId, toolCallId, success: true, result: { content } } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  };
  return { directory, id, brokerDirectory, storeDirectory, journal, initial, open, submit, appendResult };
}

test("App acceptance persists the native message identity and receipts before replying and a restart reconciles its late result without replay", async (t) => {
  const fixture = await admissionFixture(t);
  const h = await fixture.open();
  const messageId = randomUUID();
  const prompt = "A private task draft that must not be stored as an admission";
  const form = legacySend(h.bridge, h.key);
  assert.ok(object(form.data));
  const action = h.bridge.actions.authenticate(form.data.token, h.store.snapshot().conversations[h.key]!);
  const activityId = randomUUID();
  try {
    const sending = h.bridge.handle(h.key, fixture.initial.reference, activityId, {
      kind: "action", data: { ...form.data, message: prompt },
    });
    await completeAppSend(fixture.brokerDirectory, fixture.id, { accepted: true, messageId });
    await sending;
    const persisted: unknown = JSON.parse(await readFile(join(fixture.storeDirectory, "state.json"), "utf8"));
    assert.ok(object(persisted) && object(persisted.admissions), "accepted App message identity must survive outside an in-memory watch");
    const admissions = Object.values(persisted.admissions);
    assert.equal(admissions.length, 1);
    const admission = admissions[0];
    assert.ok(object(admission));
    assert.equal(admission.messageId, messageId);
    assert.equal(admission.sessionId, fixture.id);
    assert.equal(admission.conversationKey, h.key);
    assert.deepEqual(admission.receiptIds, [digest(`${h.key}:${activityId}`), `action:${action.nonce}`]);
    assert.ok(!JSON.stringify(persisted.admissions).includes(prompt));
    assert.match(JSON.stringify(h.bridge.render(h.key)), /execution not yet observed/i);
    const duplicateActivity = randomUUID();
    await h.bridge.handle(h.key, fixture.initial.reference, duplicateActivity, {
      kind: "action", data: { ...form.data, message: "a repeated button cannot create another admission" },
    });
    assert.equal(h.store.snapshot().receipts[digest(`${h.key}:${duplicateActivity}`)]!.admissionId, admission.id);
    assert.equal(Object.keys(h.store.snapshot().admissions).length, 1);
  } finally { await h.bridge.close(); }
  await fixture.appendResult(messageId, "A late result for the persisted admission");
  const restored = await fixture.open();
  try {
    await eventually(() => restored.store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.status === "sent" &&
      item.text.includes("A late result for the persisted admission")));
    await restored.text("!read");
    await restored.bridge.flush();
    assert.equal(restored.store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text.includes("A late result for the persisted admission")).length, 1);
    assert.equal((await readdir(join(fixture.brokerDirectory, "processing", fixture.id))).length, 1);
    assert.equal(restored.captured, undefined);
    assert.deepEqual(restored.client.sent, []);
  } finally { await restored.bridge.close(); }
  const onceMore = await fixture.open();
  try {
    await onceMore.bridge.flush();
    assert.equal(onceMore.store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text.includes("A late result for the persisted admission")).length, 1);
    assert.equal([...onceMore.transport.messages.values()].filter((item) => item.message.type === "text").length, 0);
    assert.equal((await readdir(join(fixture.brokerDirectory, "processing", fixture.id))).length, 1);
  } finally { await onceMore.bridge.close(); }
});

test("a fast App result cannot race ahead of its durable admission checkpoint or produce an accepted fallback after a write failure", async (t) => {
  for (const fail of [false, true]) {
    const fixture = await admissionFixture(t);
    const h = await fixture.open();
    const messageId = randomUUID();
    const original = h.store.mutate.bind(h.store);
    let release: (() => void) | undefined;
    let committing = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writes = t.mock.method(h.store, "mutate", async <T>(change: (state: BridgeState) => T): Promise<T> => {
      const snapshot = h.store.snapshot();
      const before = Object.keys(snapshot.admissions).length;
      change(snapshot);
      if (Object.keys(snapshot.admissions).length > before) {
        committing = true;
        await gate;
        if (fail) throw new Error("Fixture durable admission write failed.");
      }
      return original(change);
    });
    let submitted: ReturnType<typeof fixture.submit> | undefined;
    try {
      submitted = fixture.submit(h, "Do not persist this task draft");
      await completeAppSend(fixture.brokerDirectory, fixture.id, { accepted: true, messageId });
      await eventually(() => committing);
      await fixture.appendResult(messageId, "A fast result after host admission");
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(Object.keys(h.store.snapshot().admissions).length, 0);
      assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).length, 0, "the observer cannot emit output before identity persistence");
      release!();
      const response = await submitted.sending;
      const receipt = h.store.snapshot().receipts[digest(`${h.key}:${submitted.activityId}`)]!;
      if (fail) {
        assert.equal(receipt.status, "uncertain");
        assert.equal(Object.keys(h.store.snapshot().admissions).length, 0);
        assert.match(JSON.stringify(response), /persistent admission tracking failed/);
        assert.ok(!JSON.stringify(response).includes("App host accepted this instruction"));
        await h.text("!read");
        await h.bridge.flush();
        assert.ok(!h.store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.text.includes("A fast result after host admission")));
      } else {
        assert.equal(receipt.status, "accepted");
        assert.equal(receipt.admissionId, digest(`${fixture.id}:${messageId}`));
        await eventually(() => h.store.snapshot().admissions[receipt.admissionId!]?.phase === "confirmed");
        await h.bridge.flush();
        const results = h.store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text.includes("A fast result after host admission"));
        assert.equal(results.length, 1);
        assert.equal(results[0]!.status, "sent");
      }
      await h.bridge.handle(h.key, fixture.initial.reference, randomUUID(), {
        kind: "action", data: submitted.data,
      });
      assert.equal((await readdir(join(fixture.brokerDirectory, "processing", fixture.id))).length, 1);
      assert.equal(h.captured, undefined);
    } finally {
      release?.();
      await submitted?.sending.catch(() => undefined);
      writes.mock.restore();
      await h.bridge.close();
    }
  }
});

test("timed-out App admission survives and a later explicit read confirms one result without making the session permanently erroneous", async (t) => {
  const fixture = await admissionFixture(t, 45, 1000);
  const h = await fixture.open();
  const messageId = randomUUID();
  const admissionId = digest(`${fixture.id}:${messageId}`);
  try {
    const sending = fixture.submit(h);
    await completeAppSend(fixture.brokerDirectory, fixture.id, { accepted: true, messageId });
    await sending.sending;
    await eventually(() => h.store.snapshot().admissions[admissionId]?.observation === "timed_out");
    assert.equal(h.store.snapshot().admissions[admissionId]!.phase, "accepted");
    assert.equal(h.store.snapshot().sessions[fixture.id]!.status, "busy");
    assert.match(h.store.snapshot().conversations[h.key]!.notice, /timed out; result remains unconfirmed/);
    assert.ok(!h.store.snapshot().conversations[h.key]!.notice.includes("accepted"));
    const unconfirmed = h.bridge.render(h.key);
    assert.match(JSON.stringify(unconfirmed), /execution not yet observed/);
    await fixture.appendResult(messageId, "Late explicit reconciliation result");
    const action = findAction(h.bridge.render(h.key), "Check status");
    assert.ok(object(action.data));
    await h.bridge.handle(h.key, fixture.initial.reference, randomUUID(), { kind: "action", data: action.data });
    await h.text("!read");
    await h.bridge.flush();
    const admission = h.store.snapshot().admissions[admissionId]!;
    assert.equal(admission.phase, "confirmed");
    assert.equal(admission.observation, "settled");
    assert.equal(admission.executionIndex, 1);
    const results = h.store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text.includes("Late explicit reconciliation result"));
    assert.equal(results.length, 1);
    assert.equal(results[0]!.status, "sent");
    assert.ok(results[0]!.activityId);
    assert.match(JSON.stringify(h.bridge.render(h.key)), /Reply delivered/);
    assert.equal((await readdir(join(fixture.brokerDirectory, "processing", fixture.id))).length, 1);
    assert.equal(h.captured, undefined);
  } finally { await h.bridge.close(); }
});

test("only the admission's visible root user or authoritative originating message proves execution, not busy state, child text or another instruction", async (t) => {
  const fixture = await admissionFixture(t);
  const h = await fixture.open();
  const messageId = randomUUID();
  const admissionId = digest(`${fixture.id}:${messageId}`);
  try {
    const submitted = fixture.submit(h);
    await completeAppSend(fixture.brokerDirectory, fixture.id, { accepted: true, messageId });
    await submitted.sending;
    await appendFile(fixture.journal, [
      { id: randomUUID(), type: "user.message", timestamp: "2026-11-15T09:00:00Z",
        data: { messageId: "another-message", content: "Unrelated user" } },
      { id: randomUUID(), type: "user.message", agentId: "child", timestamp: "2026-11-15T09:00:01Z",
        data: { messageId, content: "Child user is not root execution" } },
      { id: randomUUID(), type: "assistant.message", timestamp: "2026-11-15T09:00:02Z",
        data: { originatingMessageId: "another-message", content: "Unrelated response" } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    await h.text("!read");
    assert.equal(h.store.snapshot().admissions[admissionId]!.phase, "accepted");
    assert.ok(!h.store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.text.includes("Unrelated response")));
    await appendFile(fixture.journal, JSON.stringify({
      id: randomUUID(), type: "user.message", timestamp: "2026-11-15T09:00:03Z",
      data: { messageId, content: "The actual root user task", parentAgentTaskId: randomUUID(), isAutopilotContinuation: false },
    }) + "\n");
    await h.text("!read");
    assert.equal(h.store.snapshot().admissions[admissionId]!.phase, "executing");
    assert.equal(h.store.snapshot().admissions[admissionId]!.executionIndex, 4);
    assert.match(JSON.stringify(h.bridge.render(h.key)), /Execution observed for this App instruction/);
    assert.ok(!h.store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.text.includes("The actual root user task")));
    assert.equal((await readdir(join(fixture.brokerDirectory, "processing", fixture.id))).length, 1);
  } finally { await h.bridge.close(); }
});

test("two saved admissions keep their independent deadlines, execution and results while repeated read-only checks are idempotent", async (t) => {
  const fixture = await admissionFixture(t, 45, 1000);
  const h = await fixture.open();
  const first = randomUUID();
  const second = randomUUID();
  try {
    for (const messageId of [first, second]) {
      const submitted = fixture.submit(h);
      await completeAppSend(fixture.brokerDirectory, fixture.id, { accepted: true, messageId });
      await submitted.sending;
    }
    await eventually(() => Object.values(h.store.snapshot().admissions).every((item) => item.observation === "timed_out"));
    assert.equal(Object.keys(h.store.snapshot().admissions).length, 2);
    await fixture.appendResult(second, "Second admission result");
    await h.text("!read");
    await h.bridge.flush();
    assert.equal(h.store.snapshot().admissions[digest(`${fixture.id}:${second}`)]!.phase, "confirmed");
    assert.equal(h.store.snapshot().admissions[digest(`${fixture.id}:${first}`)]!.phase, "accepted");
    await fixture.appendResult(first, "First admission result");
    await Promise.all([
      h.runtime.reconcileAdmissions(Object.values(h.store.snapshot().admissions)),
      h.runtime.reconcileAdmissions(Object.values(h.store.snapshot().admissions)),
    ]);
    await h.text("!read");
    await h.bridge.flush();
    assert.ok(Object.values(h.store.snapshot().admissions).every((item) => item.phase === "confirmed"));
    for (const result of ["First admission result", "Second admission result"]) {
      assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text.includes(result)).length, 1);
    }
    assert.equal((await readdir(join(fixture.brokerDirectory, "processing", fixture.id))).length, 2);
    assert.equal(h.captured, undefined);
  } finally { await h.bridge.close(); }
});

test("round2 R1: a poll filtered for A cannot advance past B results admitted and persisted before that poll returns", async (t) => {
  const fixture = await admissionFixture(t, 3000, 5);
  const h = await fixture.open();
  const a = randomUUID();
  const b = randomUUID();
  const original = h.app.readSessionState.bind(h.app);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let oldReadStarted = false;
  let oldSnapshot: AppSessionSnapshot | undefined;
  const reads = t.mock.method(h.app, "readSessionState", async (sessionId: string, messageIds?: readonly string[]) => {
    const filter = messageIds ? [...messageIds] : undefined;
    if (!oldReadStarted && filter?.length === 1 && filter[0] === a) {
      oldReadStarted = true;
      await gate;
      oldSnapshot = await original(sessionId, filter);
      return oldSnapshot;
    }
    return original(sessionId, filter);
  });
  try {
    const first = fixture.submit(h, "First isolated instruction");
    await completeAppSend(fixture.brokerDirectory, fixture.id, { accepted: true, messageId: a });
    await first.sending;
    await eventually(() => oldReadStarted);
    const second = fixture.submit(h, "Second isolated instruction");
    await completeAppSend(fixture.brokerDirectory, fixture.id, { accepted: true, messageId: b });
    await second.sending;
    assert.ok(h.store.snapshot().admissions[digest(`${fixture.id}:${b}`)]);
    await fixture.appendResult(a, "A result in the old filtered read");
    await fixture.appendResult(b, "B result excluded by the old filtered read");
    release!();
    await eventually(() => oldSnapshot !== undefined);
    assert.ok(!oldSnapshot!.turns.some((turn) => turn.originatingMessageId === b),
      "the paused read must really filter with the original A-only set");
    assert.equal(oldSnapshot!.throughIndex, 8, "the old filtered read nevertheless scanned B's physical lines");
    await eventually(() => h.store.snapshot().admissions[digest(`${fixture.id}:${b}`)]?.phase === "confirmed", 1500);
    await h.bridge.flush();
    for (const text of ["A result in the old filtered read", "B result excluded by the old filtered read"]) {
      assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text.includes(text) && item.status === "sent").length, 1);
    }
    assert.equal((await readdir(join(fixture.brokerDirectory, "processing", fixture.id))).length, 2);
    assert.equal(h.captured, undefined);
  } finally {
    release?.();
    await h.bridge.close();
    reads.mock.restore();
  }
});

test("round2 R3: persistent read-only confirmation cancels its old live watch and cannot emit a later unconfirmed timeout", async (t) => {
  const fixture = await admissionFixture(t, 300, 1000);
  const h = await fixture.open();
  const messageId = randomUUID();
  const admissionId = digest(`${fixture.id}:${messageId}`);
  try {
    const submitted = fixture.submit(h);
    await completeAppSend(fixture.brokerDirectory, fixture.id, { accepted: true, messageId });
    await submitted.sending;
    const staleAdmission = h.store.snapshot().admissions[admissionId]!;
    const deadlineAt = h.store.snapshot().admissions[admissionId]!.deadlineAt;
    await fixture.appendResult(messageId, "Confirmed before the old watch deadline");
    await h.text("!read");
    await h.bridge.flush();
    assert.equal(h.store.snapshot().admissions[admissionId]!.phase, "confirmed");
    assert.ok(Date.now() < deadlineAt, "reconciliation must finish before the old live deadline is reached");
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadlineAt - Date.now()) + 30));
    await h.bridge.flush();
    const state = h.store.snapshot();
    assert.equal(state.admissions[admissionId]!.phase, "confirmed");
    assert.equal(state.admissions[admissionId]!.observation, "settled");
    assert.ok(!state.sessions[fixture.id]!.timeline.some((entry) => entry.text.includes("APP_OUTPUT_TIMEOUT")),
      "confirmed admissions must suppress stale timeout projection, not just protect their phase");
    assert.equal(state.outbox.filter((item) => !item.historyId).length, 1, "confirmation must not be followed by an unconfirmed-error post");
    assert.equal(state.outbox.filter((item) => !item.historyId)[0]!.status, "sent");
    assert.match(JSON.stringify(h.bridge.render(h.key)), /Result confirmed/);
    const sequence = state.sessions[fixture.id]!.sequence;
    const seenEvents = state.sessions[fixture.id]!.seenEvents;
    const notice = state.conversations[h.key]!.notice;
    t.mock.method(h.app, "readSessionState", async () => { throw new Error("Fixture stale reconciliation failed"); });
    await h.runtime.reconcileAdmissions([staleAdmission]);
    await h.bridge.flush();
    const afterStaleFailure = h.store.snapshot();
    assert.equal(afterStaleFailure.sessions[fixture.id]!.sequence, sequence,
      "even a late read-failed event from stale admission state must be rejected before projection");
    assert.deepEqual(afterStaleFailure.sessions[fixture.id]!.seenEvents, seenEvents);
    assert.equal(afterStaleFailure.conversations[h.key]!.notice, notice);
    assert.equal(afterStaleFailure.outbox.filter((item) => !item.historyId).length, 1);
    assert.equal((await readdir(join(fixture.brokerDirectory, "processing", fixture.id))).length, 1);
    assert.equal(h.captured, undefined);
  } finally { await h.bridge.close(); }
});

test("round3 R4: a split-appended final stays uncovered until its JSON completes and is delivered once at the same physical index", async (t) => {
  const fixture = await admissionFixture(t, 3000, 5);
  const h = await fixture.open();
  const messageId = randomUUID();
  const admissionId = digest(`${fixture.id}:${messageId}`);
  const interactionId = randomUUID();
  const content = "Complete split-append result 🚀";
  const encoded = Buffer.from(JSON.stringify({
    id: "split-final", type: "assistant.message", timestamp: "2026-11-15T09:00:02Z",
    data: { messageId: "split-final", originatingMessageId: messageId, turnId: "0", interactionId, content },
  }));
  const split = encoded.indexOf(Buffer.from("🚀")) + 2;
  assert.ok(split > 2 && split < encoded.length, "the writer must split inside the UTF-8 emoji before JSON completion");
  const original = h.app.readSessionState.bind(h.app);
  let partialWritten = false;
  let partialSnapshot: AppSessionSnapshot | undefined;
  const reads = t.mock.method(h.app, "readSessionState", async (sessionId: string, messageIds?: readonly string[]) => {
    const snapshot = await original(sessionId, messageIds);
    if (partialWritten && messageIds?.includes(messageId) && snapshot.throughIndex >= 2 && !partialSnapshot) {
      partialSnapshot = snapshot;
    }
    return snapshot;
  });
  try {
    const submitted = fixture.submit(h);
    await completeAppSend(fixture.brokerDirectory, fixture.id, { accepted: true, messageId });
    await submitted.sending;
    await appendFile(fixture.journal, Buffer.concat([
      Buffer.from([
        { id: "split-user", type: "user.message", timestamp: "2026-11-15T09:00:00Z",
          data: { messageId, content: "A root instruction for the split-tail fixture" } },
        { id: "split-start", type: "assistant.turn_start", data: { turnId: "0", interactionId } },
      ].map((event) => JSON.stringify(event)).join("\r\n") + "\r\n"),
      encoded.subarray(0, split),
    ]));
    partialWritten = true;
    await eventually(() => partialSnapshot !== undefined);
    await h.bridge.flush();
    assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).length, 0, "an incomplete final must not produce a result");
    assert.equal(h.store.snapshot().admissions[admissionId]!.phase, "executing");
    await appendFile(fixture.journal, Buffer.concat([
      encoded.subarray(split),
      Buffer.from("\r\n" + JSON.stringify({
        id: "split-end", type: "assistant.turn_end", data: { turnId: "0" },
      }) + "\r\n"),
    ]));
    await eventually(() => h.store.snapshot().admissions[admissionId]?.phase === "confirmed", 1500);
    await h.bridge.flush();
    assert.equal(partialSnapshot!.throughIndex, 2, "coverage must stop before the unfinished physical final at index 3");
    const snapshot = await original(fixture.id, [messageId]);
    assert.equal(snapshot.throughIndex, 4);
    assert.deepEqual(snapshot.turns.map((turn) => [turn.index, turn.assistantResponse]), [[3, content]]);
    const results = h.store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text.includes(content));
    assert.equal(results.length, 1);
    assert.equal(results[0]!.status, "sent");
    assert.ok(results[0]!.activityId);
    assert.ok(!h.store.snapshot().sessions[fixture.id]!.timeline.some((entry) => entry.text.includes("APP_OUTPUT_TIMEOUT")));
    assert.equal((await readdir(join(fixture.brokerDirectory, "processing", fixture.id))).length, 1);
    assert.equal(h.captured, undefined);
  } finally {
    await h.bridge.close();
    reads.mock.restore();
  }
});

test("concurrent read-only reconciliation is single-flight and delivers only to each admission's originating conversation", async (t) => {
  const fixture = await admissionFixture(t, 45, 1000);
  const h = await fixture.open();
  const otherEnvelope = mockEnvelope();
  assert.ok(object(otherEnvelope.conversation));
  const other = authorizeActivity({
    ...otherEnvelope, conversation: { ...otherEnvelope.conversation, id: "a:second-durable-admission-conversation" },
  }, { aud: mockIdentity.appId }, mockIdentity);
  let release: (() => void) | undefined;
  let restoring: Array<Promise<unknown>> = [];
  try {
    const first = randomUUID();
    const second = randomUUID();
    const left = fixture.submit(h);
    await completeAppSend(fixture.brokerDirectory, fixture.id, { accepted: true, messageId: first });
    await left.sending;
    await h.bridge.handle(other.key, other.reference, randomUUID(), { kind: "text", text: `!use ${fixture.id}` });
    const form = legacySend(h.bridge, other.key);
    assert.ok(object(form.data));
    const right = h.bridge.handle(other.key, other.reference, randomUUID(), {
      kind: "action", data: { ...form.data, message: "A second conversation's instruction" },
    });
    await completeAppSend(fixture.brokerDirectory, fixture.id, { accepted: true, messageId: second });
    await right;
    await eventually(() => Object.values(h.store.snapshot().admissions).every((admission) => admission.observation === "timed_out"));
    await fixture.appendResult(first, "First conversation result");
    await fixture.appendResult(second, "Second conversation result");
    const original = h.app.readSessionState.bind(h.app);
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reads = t.mock.method(h.app, "readSessionState", async (sessionId: string, messageIds?: readonly string[]) => {
      if (messageIds) await gate;
      return original(sessionId, messageIds);
    });
    const admissions = Object.values(h.store.snapshot().admissions);
    restoring = [
      h.runtime.reconcileAdmissions(admissions.filter((item) => item.messageId === first)),
      h.runtime.reconcileAdmissions(admissions.filter((item) => item.messageId === second)),
      h.runtime.reconcileAdmissions(admissions),
    ];
    await eventually(() => reads.mock.callCount() === 1);
    release!();
    await Promise.all(restoring);
    await h.bridge.flush();
    assert.equal(reads.mock.callCount(), 1);
    const state = h.store.snapshot();
    const firstResult = state.outbox.filter((item) => item.text.includes("First conversation result"));
    const secondResult = state.outbox.filter((item) => item.text.includes("Second conversation result"));
    assert.equal(firstResult.length, 1);
    assert.equal(secondResult.length, 1);
    assert.equal(firstResult[0]!.conversationKey, h.key);
    assert.equal(secondResult[0]!.conversationKey, other.key);
    assert.equal(state.conversations[h.key]!.selectedId, fixture.id);
    assert.equal(state.conversations[other.key]!.selectedId, fixture.id);
    assert.equal((await readdir(join(fixture.brokerDirectory, "processing", fixture.id))).length, 2);
    assert.equal(h.captured, undefined);
  } finally {
    release?.();
    await Promise.all(restoring);
    await h.bridge.close();
  }
});

test("a result with uncertain Teams delivery remains confirmed but is never resent after read-only reconciliation or restart", async (t) => {
  const fixture = await admissionFixture(t, 45, 1000);
  const h = await fixture.open();
  const messageId = randomUUID();
  try {
    const submitted = fixture.submit(h);
    await completeAppSend(fixture.brokerDirectory, fixture.id, { accepted: true, messageId });
    await submitted.sending;
    await eventually(() => h.store.snapshot().admissions[digest(`${fixture.id}:${messageId}`)]?.observation === "timed_out");
    await h.bridge.flush();
    const send = h.transport.send.bind(h.transport);
    t.mock.method(h.transport, "send", async (
      reference: Parameters<PreviewTransport["send"]>[0], message: Parameters<PreviewTransport["send"]>[1],
    ) => {
      if (message.type === "text" && message.text.includes("Result with uncertain delivery")) throw new Error("Fixture connector ack was lost");
      return send(reference, message);
    });
    await fixture.appendResult(messageId, "Result with uncertain delivery");
    await h.text("!read");
    await h.bridge.flush();
    const result = h.store.snapshot().outbox.filter((item) => !item.historyId).find((item) => item.text.includes("Result with uncertain delivery"))!;
    assert.equal(result.status, "uncertain");
    assert.equal(h.store.snapshot().admissions[digest(`${fixture.id}:${messageId}`)]!.phase, "confirmed");
    await h.text("!read");
    await h.bridge.flush();
    assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text.includes("Result with uncertain delivery")).length, 1);
  } finally { await h.bridge.close(); }
  const restored = await fixture.open();
  try {
    await restored.text("!read");
    await restored.bridge.flush();
    assert.equal(restored.store.snapshot().outbox.filter((item) => !item.historyId).find((item) => item.text.includes("Result with uncertain delivery"))!.status, "uncertain");
    assert.ok(![...restored.transport.messages.values()].some((item) =>
      item.message.type === "text" && item.message.text.includes("Result with uncertain delivery")));
    assert.equal((await readdir(join(fixture.brokerDirectory, "processing", fixture.id))).length, 1);
  } finally { await restored.bridge.close(); }
});

test("an uncertain App ACK and legacy receipts without native identities cannot invent a recovery or replay their task", async (t) => {
  const fixture = await admissionFixture(t);
  const h = await fixture.open();
  try {
    const submitted = fixture.submit(h);
    await completeAppSend(fixture.brokerDirectory, fixture.id, { accepted: true });
    const result = await submitted.sending;
    assert.match(JSON.stringify(result), /APP_ADMISSION_UNCERTAIN/);
    assert.equal(h.store.snapshot().receipts[digest(`${h.key}:${submitted.activityId}`)]!.status, "uncertain");
    assert.equal(Object.keys(h.store.snapshot().admissions).length, 0);
    await h.store.mutate((state) => {
      state.receipts["legacy-app-send"] = {
        id: "legacy-app-send", conversationKey: h.key, operation: "send", status: "accepted", at: 0,
        detail: "Legacy host acceptance without a returned message ID",
      };
    });
  } finally { await h.bridge.close(); }
  const statePath = join(fixture.storeDirectory, "state.json");
  const oldState: unknown = JSON.parse(await readFile(statePath, "utf8"));
  assert.ok(object(oldState));
  delete oldState.admissions;
  await writeFile(statePath, JSON.stringify(oldState));
  await fixture.appendResult(randomUUID(), "A similar-looking legacy result is not a recovered admission");
  const restored = await fixture.open();
  try {
    assert.equal(restored.store.snapshot().receipts["legacy-app-send"]!.status, "uncertain");
    assert.match(restored.store.snapshot().receipts["legacy-app-send"]!.detail, /no native admission ID/);
    await restored.text("!read");
    await restored.bridge.flush();
    assert.equal(Object.keys(restored.store.snapshot().admissions).length, 0);
    assert.ok(!restored.store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.text.includes("similar-looking legacy result")));
    assert.match(JSON.stringify(restored.bridge.render(restored.key)), /cannot be reconciled or replayed/);
    assert.equal((await readdir(join(fixture.brokerDirectory, "processing", fixture.id))).length, 1);
    assert.equal(restored.captured, undefined);
  } finally { await restored.bridge.close(); }
});

test("the eight-active-App-session observation limit refuses a ninth send before host admission", async (t) => {
  const app = new AppSessionsDouble();
  const ids = Array.from({ length: 9 }, () => randomUUID());
  app.sessions = ids.map((id) => ({
    id, name: "Pending App", status: "busy", workspace: "fixture", readable: true, direct: true,
  }));
  const h = await setup(t, app, { outputPollIntervalMs: 1000, outputWatchTimeoutMs: 3000 });
  try {
    await h.runtime.inventory(randomUUID());
    for (const id of ids.slice(0, 8)) await h.runtime.send(id, "one queued instruction");
    await assert.rejects(() => h.runtime.send(ids[8]!, "not admitted beyond the active limit"), /Eight App sessions/);
    assert.equal(app.sent.length, 8);
    assert.equal(h.captured, undefined);
  } finally { await h.runtime.close(); }
});

test("local App sessions join inventory and messages stay at their App owner", async (t) => {
  const app = new AppSessionsDouble();
  const appSessionId = randomUUID();
  app.sessions = [{
    id: appSessionId, name: "App work", status: "idle", workspace: "C:\\app-work",
    readable: true, direct: true,
  }];
  const h = await setup(t, app);
  try {
    assert.equal(app.started, true);
    const inventory = await h.runtime.inventory(randomUUID());
    const record = inventory.find((item) => item.id === appSessionId);
    assert.ok(record);
    assert.equal(record.kind, "peer");
    assert.match(record.capability, /Copilot App session/);
    await h.runtime.send(appSessionId, "exact app message");
    assert.deepEqual(app.sent, [{ sessionId: appSessionId, message: "exact app message" }]);
    const history = await h.runtime.history(appSessionId);
    assert.equal(history.length, 1);
    assert.match(JSON.stringify(history[0]), /App response/);
  } finally {
    await h.runtime.close();
    assert.equal(app.closed, true);
  }
});

test("a fresh Bot card sends to its local App endpoint with one origin-matched result and zero SDK management calls", async (t) => {
  const directory = await temporary(t);
  const sessionStateDirectory = join(directory, "profile", "session-state");
  const brokerDirectory = join(directory, "endpoints");
  const liveId = randomUUID();
  const savedId = randomUUID();
  const metadataId = randomUUID();
  for (const [id, name] of [[liveId, "Live existing App"], [savedId, "Offline saved App"], [metadataId, "Metadata only"]]) {
    await mkdir(join(sessionStateDirectory, id!), { recursive: true });
    await writeFile(join(sessionStateDirectory, id!, "workspace.yaml"), `name: ${JSON.stringify(name)}\ncwd: 'C:\\fixture\\work'\n`);
    if (id !== metadataId) await writeFile(join(sessionStateDirectory, id!, "events.jsonl"), JSON.stringify({
      id: `baseline-${id}`, type: "assistant.message", timestamp: "2026-11-14T01:00:00Z",
      data: { messageId: `baseline-${id}`, content: "Original local history" },
    }) + "\n");
  }
  await mkdir(join(brokerDirectory, "sessions"), { recursive: true });
  await writeFile(join(brokerDirectory, "config.json"), JSON.stringify({
    schema: 1, registrationTtlMs: 20_000, operations: ["send_message"],
  }));
  const registration = {
    schema: 1, sessionId: liveId, instanceId: randomUUID(), pid: process.pid,
    name: "Live existing App", workspace: "C:\\fixture\\work", status: "idle", heartbeatAt: new Date().toISOString(),
  };
  await writeFile(join(brokerDirectory, "sessions", `${liveId}.json`), JSON.stringify(registration));
  const app = new LocalAppSessions({ timeoutMs: 1000, sessionStateDirectory, brokerDirectory });
  const h = await setup(t, app, { outputPollIntervalMs: 2, outputWatchTimeoutMs: 3000 }, false, false);
  h.options.defaultModel = "";
  const store = await Store.open(join(h.directory, "bridge"), "fixed-session-test");
  const transport = new PreviewTransport();
  const bridge = new Bridge(store, h.runtime, transport, {
    owner: "fixed-session-test", workspaces: [{ id: "local", name: "Local", path: h.directory }], coalesceMs: 2,
  });
  try {
    await bridge.start();
    assert.equal(h.client.created.length, 0, "discovery must not implicitly create a controller or management observer");
    const turn = authorizeActivity(mockEnvelope(), { aud: mockIdentity.appId }, mockIdentity);
    const text = (value: string) => bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: value });
    const state = store.snapshot();
    assert.equal(Object.keys(state.sessions).length, 4, "fresh state must discover saved sessions as well as a live endpoint");
    assert.deepEqual(state.sessions[savedId]?.access, { read: true, send: false });
    assert.deepEqual(state.sessions[metadataId]?.access, { read: false, send: false });
    assert.deepEqual(state.sessions[liveId]?.access, { read: true, send: true });
    await text(`!use ${savedId}`);
    await bridge.flush();
    assert.ok(store.snapshot().outbox.some((item) => item.historyId && item.text.includes("Original local history")));
    assert.match(JSON.stringify(bridge.render(turn.key)), /Offline · History only/);
    await text(`!use ${metadataId}`);
    assert.match(JSON.stringify(bridge.render(turn.key)), /History unavailable/);
    assert.equal(store.snapshot().conversations[turn.key]!.selectedId, savedId);
    await text(`!use ${liveId}`);
    const dashboard = await text("!status");
    assert.throws(() => findAction(dashboard, "Send"), /not found/);
    const send = legacySend(bridge, turn.key);
    assert.ok(object(send.data));
    const prompt = "control: keep this literal\u00a0\r\nlist sessions\nKeep <span>text</span> 🚀  ";
    const submit = authorizeActivity({
      ...mockEnvelope(""), value: { ...send.data, message: prompt },
    }, { aud: mockIdentity.appId }, mockIdentity);
    assert.equal(submit.incoming.kind, "action");
    await store.mutate((state) => { state.sessions[liveId]!.liveUntil = Date.now() - 1; });
    const sending = bridge.handle(submit.key, submit.reference, submit.activity.id!, submit.incoming);
    const request = await completeAppSend(brokerDirectory, liveId, { accepted: true, messageId: "owner-admission-1" });
    assert.ok(object(request.payload));
    assert.equal(request.payload.message, prompt);
    const admitted = await sending;
    assert.match(JSON.stringify(admitted), /Queued/);
    assert.ok(store.snapshot().sessions[liveId]!.liveUntil! > Date.now(),
      "the signed card send must use the existing registry-only refresh for an expired cached lease");
    await bridge.handle(submit.key, submit.reference, randomUUID(), submit.incoming);
    await appendFile(join(sessionStateDirectory, liveId, "events.jsonl"), [
      { id: "displayed-owner-request", type: "user.message", timestamp: "2026-11-14T01:59:59Z",
        data: { messageId: "owner-admission-1", content: prompt, transformedContent: "INTERNAL_TRANSFORMED_PROMPT",
          parentAgentTaskId: randomUUID(), isAutopilotContinuation: false } },
      { id: "root-request", type: "assistant.message", timestamp: "2026-11-14T02:00:00Z",
        data: { originatingMessageId: "owner-admission-1", turnId: "root-turn", interactionId: "root-interaction", toolRequests: [
          { name: "task_complete", toolCallId: "root-call", arguments: { summary: "Task-complete-only observed result" } },
        ] } },
      { id: "root-start", parentId: "root-request", type: "tool.execution_start",
        data: { toolCallId: "root-call", toolName: "task_complete", turnId: "root-turn",
          arguments: { summary: "Task-complete-only observed result" } } },
      { id: "root-complete", type: "tool.execution_complete", timestamp: "2026-11-14T02:00:02Z",
        data: { toolCallId: "root-call", turnId: "root-turn", interactionId: "root-interaction", success: true,
          result: { content: "Task-complete-only observed result" } } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    await eventually(() => store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.status === "sent" && item.text.includes("Task-complete-only observed result")));
    await text(`!use ${liveId}`);
    await bridge.flush();
    assert.equal(store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text.includes("Task-complete-only observed result")).length, 1);
    assert.ok(store.snapshot().sessions[liveId]?.timeline.some((entry) => entry.kind === "user" && entry.text === prompt));
    assert.ok(!JSON.stringify(store.snapshot()).includes("INTERNAL_TRANSFORMED_PROMPT"));
    assert.ok(!store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.text.includes(prompt)), "loaded user messages must never echo to Teams");
    await writeFile(join(brokerDirectory, "sessions", `${liveId}.json`), JSON.stringify({
      ...registration, heartbeatAt: "2020-01-01T00:00:00Z",
    }));
    await text("!sessions");
    await eventually(() => store.snapshot().sessions[liveId]?.access?.send === false);
    await text("must not be forwarded through a controller");
    assert.match(store.snapshot().conversations[turn.key]!.notice, /APP_SESSION_READ_ONLY/);
    assert.equal((await readdir(join(brokerDirectory, "processing", liveId))).length, 1);
    assert.deepEqual(await readdir(join(brokerDirectory, "requests", liveId)), []);
    assert.deepEqual(h.client.created, []);
    assert.deepEqual(h.client.resumed, []);
    assert.deepEqual(h.client.sent, []);
    assert.deepEqual(h.client.managementMessages, []);
    assert.equal(h.captured, undefined);
    await assert.rejects(() => stat(join(directory, "pending")), { code: "ENOENT" });
    await assert.rejects(() => stat(join(directory, ".runtime")), { code: "ENOENT" });
  } finally { await bridge.close(); }
});

test("App startup and restored Control views route ordinary text only to the selected App even when every native SDK entry point fails", async (t) => {
  for (const view of ["control", "transcript"] as const) {
    const directory = await temporary(t);
    const id = randomUUID();
    const controllerId = randomUUID();
    const ownedId = randomUUID();
    const sessionStateDirectory = join(directory, "session-state");
    const brokerDirectory = join(directory, "broker");
    const journal = join(sessionStateDirectory, id, "events.jsonl");
    await mkdir(join(sessionStateDirectory, id), { recursive: true });
    await writeFile(join(sessionStateDirectory, id, "workspace.yaml"), "name: Original App target\ncwd: C:\\fixture\n");
    await writeFile(journal, [
      { id: "history-user", type: "user.message", timestamp: "2026-11-14T06:00:00Z", data: { content: "Original user question" } },
      { id: "history-assistant", type: "assistant.message", timestamp: "2026-11-14T06:00:01Z", data: { content: "Original App response" } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    await mkdir(join(brokerDirectory, "sessions"), { recursive: true });
    await writeFile(join(brokerDirectory, "config.json"), JSON.stringify({
      schema: 1, registrationTtlMs: 20_000, operations: ["send_message"],
    }));
    await writeFile(join(brokerDirectory, "sessions", `${id}.json`), JSON.stringify({
      schema: 1, sessionId: id, instanceId: randomUUID(), pid: process.pid,
      name: "Original App target", workspace: directory, status: "idle", heartbeatAt: new Date().toISOString(),
    }));
    const app = new LocalAppSessions({ timeoutMs: 1000, sessionStateDirectory, brokerDirectory });
    const h = await setup(t, app, { outputPollIntervalMs: 2, outputWatchTimeoutMs: 3000 }, false, false);
    const failSdk = async () => { throw new Error("NATIVE_SDK_MUST_NOT_BE_USED_FOR_APP"); };
    const nativeCalls = [
      t.mock.method(h.client, "start", failSdk), t.mock.method(h.client, "getAuthStatus", failSdk),
      t.mock.method(h.client, "listModels", failSdk), t.mock.method(h.client, "listSessions", failSdk),
      t.mock.method(h.client, "createSession", failSdk), t.mock.method(h.client, "resumeSession", failSdk),
      t.mock.method(h.client.rpc.sessions, "checkInUse", failSdk),
      t.mock.method(h.client.rpc.sessions, "readPersistedEvents", failSdk),
    ];
    const initial = authorizeActivity(mockEnvelope(), { aud: mockIdentity.appId }, mockIdentity);
    const path = join(h.directory, "bridge");
    const old = await Store.open(path, "app-only-sdk-isolation");
    await old.mutate((state) => {
      state.controllerId = controllerId;
      state.sessions[controllerId] = {
        ...saved(controllerId, h.directory), kind: "controller",
        settings: { mode: "interactive", modelId: "native-alpha" },
      };
      state.sessions[ownedId] = { ...saved(ownedId, h.directory), settings: { mode: "plan", modelId: "native-alpha" } };
      state.sessions[id] = {
        ...saved(id, directory), kind: "peer", peerSource: "app", access: { read: true, send: true },
      };
      state.conversations[initial.key] = {
        key: initial.key, reference: initial.reference, revision: 1, view,
        ...(view === "transcript" ? { transcriptId: controllerId } : {}),
        selectedId: id, page: 0, notice: "Old Control view", read: {},
      };
    });
    await old.close();
    const store = await Store.open(path, "app-only-sdk-isolation");
    const bridge = new Bridge(store, h.runtime, new PreviewTransport(), {
      owner: "app-only-sdk-isolation", workspaces: [{ id: "local", name: "Local", path: h.directory }], coalesceMs: 2,
    });
    try {
      await bridge.start();
      assert.equal(bridge.healthy, true);
      assert.equal(store.snapshot().sessions[ownedId]!.status, "offline");
      assert.ok(store.snapshot().sessions[id]);
      assert.ok((await h.runtime.appLiveness()).some((endpoint) => endpoint.id === id));
      assert.match(JSON.stringify(await h.runtime.history(id)), /Original user question/);
      assert.match(JSON.stringify(await h.runtime.history(id)), /Original App response/);
      const prompt = "  Exact task while viewing Control\r\nLiteral <span>text</span> 🚀  ";
      const sending = bridge.handle(initial.key, initial.reference, randomUUID(), { kind: "text", text: prompt });
      const admission = `admission-${view}`;
      const request = await completeAppSend(brokerDirectory, id, { accepted: true, messageId: admission });
      assert.ok(object(request.payload));
      assert.equal(request.payload.message, prompt);
      await sending;
      const interactionId = `interaction-${view}`;
      await appendFile(journal, [
        { id: "answer-start", type: "assistant.turn_start", data: { turnId: "0", interactionId } },
        { id: "answer", type: "assistant.message", timestamp: "2026-11-14T06:01:00Z",
          data: { originatingMessageId: admission, turnId: "0", interactionId, content: "Correct App instruction result" } },
        { id: "answer-end", type: "assistant.turn_end", data: { turnId: "0" } },
      ].map((event) => JSON.stringify(event)).join("\n") + "\n");
      await eventually(() => store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.status === "sent" && item.text.includes("Correct App instruction result")));
      assert.equal(store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text.includes("Correct App instruction result")).length, 1);
      assert.equal((await readdir(join(brokerDirectory, "processing", id))).length, 1);
      assert.equal(store.snapshot().conversations[initial.key]!.selectedId, id);
      assert.ok(!JSON.stringify(bridge.render(initial.key)).includes("CONTROL: messages manage sessions"));
      await store.mutate((state) => { delete state.conversations[initial.key]!.selectedId; });
      const noTarget = await bridge.handle(initial.key, initial.reference, randomUUID(), { kind: "text", text: "do not fall back to Control" });
      assert.match(JSON.stringify(noTarget), /Choose a source/);
      assert.ok(nativeCalls.every((method) => method.mock.callCount() === 0),
        "App discovery/history/liveness/send/output and a missing target must make zero native SDK calls");
      assert.equal(h.captured, undefined, "App-only operations must not even construct a private SDK client");
      assert.equal((await readdir(join(brokerDirectory, "processing", id))).length, 1);
    } finally { await bridge.close(); }
  }
});

test("App navigation refreshes an expired Store lease from the same live registry without resetting search, page or selection", async (t) => {
  const directory = await temporary(t);
  const sessionStateDirectory = join(directory, "session-state");
  const brokerDirectory = join(directory, "broker");
  const ids = Array.from({ length: 7 }, (_, index) => `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`);
  const instances = ids.map(() => randomUUID());
  const renew = async (except?: string) => {
    for (const [index, id] of ids.entries()) await writeFile(join(brokerDirectory, "sessions", `${id}.json`), JSON.stringify({
      schema: 1, sessionId: id, instanceId: instances[index], pid: process.pid,
      name: `App ${index + 1}`, workspace: directory, status: index === 0 ? "busy" : "idle",
      heartbeatAt: id === except ? "2020-01-01T00:00:00Z" : new Date().toISOString(),
    }));
  };
  await mkdir(join(brokerDirectory, "sessions"), { recursive: true });
  await writeFile(join(brokerDirectory, "config.json"), JSON.stringify({
    schema: 1, registrationTtlMs: 20_000, operations: ["send_message"],
  }));
  for (const [index, id] of ids.entries()) {
    await mkdir(join(sessionStateDirectory, id), { recursive: true });
    await writeFile(join(sessionStateDirectory, id, "workspace.yaml"), `name: App ${index + 1}\ncwd: C:\\fixture\n`);
    await writeFile(join(sessionStateDirectory, id, "events.jsonl"), JSON.stringify({
      id: randomUUID(), type: "assistant.message", timestamp: "2026-11-14T06:35:10.385Z",
      data: { content: `History for App ${index + 1}` },
    }) + "\n");
  }
  await renew();
  const app = new LocalAppSessions({ timeoutMs: 1000, sessionStateDirectory, brokerDirectory });
  const h = await setup(t, app, undefined, false, false);
  const store = await Store.open(join(h.directory, "bridge"), "interaction-liveness");
  const bridge = new Bridge(store, h.runtime, new PreviewTransport(), {
    owner: "interaction-liveness", workspaces: [{ id: "local", name: "Local", path: h.directory }], coalesceMs: 2,
  });
  try {
    await bridge.start();
    const turn = authorizeActivity(mockEnvelope(), { aud: mockIdentity.appId }, mockIdentity);
    await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: "!status" });
    const selected = ids.at(-1)!;
    await store.mutate((state) => {
      const conversation = state.conversations[turn.key]!;
      conversation.selectedId = selected;
      conversation.view = "sessions";
      conversation.query = "App";
      conversation.page = 0;
      for (const id of ids) state.sessions[id]!.liveUntil = Date.now() - 1;
    });
    const inventory = t.mock.method(app, "listSessions");
    const liveness = t.mock.method(app, "liveness");
    const history = t.mock.method(app, "readSessionState");
    const expire = () => store.mutate((state) => {
      for (const id of ids) state.sessions[id]!.liveUntil = Date.now() - 1;
    });
    const action = (card: import("../src/domain.js").Card, title: string, fields: Record<string, unknown> = {}) => {
      const entry = findAction(card, title);
      assert.ok(object(entry.data));
      return bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "action", data: { ...entry.data, ...fields } });
    };
    const next = await action(bridge.render(turn.key), "Next");
    const current = store.snapshot().conversations[turn.key]!;
    assert.equal(current.page, 1);
    assert.equal(current.query, "App");
    assert.equal(current.selectedId, selected);
    assert.ok(store.snapshot().sessions[selected]!.liveUntil! > Date.now(),
      "expired Store liveness must be refreshed before a pagination result advertises read-only");
    assert.match(JSON.stringify(next), /Ready/);
    assert.ok(!JSON.stringify(next).includes("History only / No live send route"));
    await renew();
    await expire();
    const filtered = await action(next, "Search", { query: "App 7" });
    assert.equal(store.snapshot().conversations[turn.key]!.query, "App 7");
    assert.ok(store.snapshot().sessions[selected]!.liveUntil! > Date.now());
    assert.equal(history.mock.callCount(), 0, "page/search refreshes must never scan any journal");
    await renew();
    await expire();
    const opened = await action(filtered, "Open");
    assert.equal(store.snapshot().conversations[turn.key]!.selectedId, selected);
    assert.throws(() => findAction(opened, "Send"), /not found/);
    await bridge.flush();
    await renew();
    await expire();
    const dashboard = await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: "!status" });
    assert.throws(() => findAction(dashboard, "Send"), /not found/);
    assert.equal(liveness.mock.callCount(), 4, "every expired navigation path must obtain renewed registry evidence");
    assert.equal(history.mock.callCount(), 1, "only opening the explicit target reads its own history");
    await renew(selected);
    await expire();
    const offline = await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: "!status" });
    assert.equal(store.snapshot().sessions[selected]!.access?.send, false);
    assert.equal(store.snapshot().sessions[selected]!.status, "offline");
    assert.match(JSON.stringify(offline), /Offline · History only/);
    assert.equal(store.snapshot().conversations[turn.key]!.selectedId, selected);
    assert.equal(store.snapshot().sessions[selected]!.lastConversationAt, "2026-11-14T06:35:10.385Z");
    assert.equal(inventory.mock.callCount(), 0, "liveness navigation must not enumerate profile histories");
    assert.deepEqual(h.client.created, []);
    assert.deepEqual(h.client.sent, []);
    assert.deepEqual(await readdir(join(brokerDirectory, "requests")).catch((error: unknown) => {
      if (object(error) && error.code === "ENOENT") return [];
      throw error;
    }), []);
  } finally { await bridge.close(); }
});

test("App observation ignores an earlier TARGET_READY completion and delivers only the endpoint's admitted instruction result", async (t) => {
  const directory = await temporary(t);
  const id = randomUUID();
  const oldMessageId = randomUUID();
  const admittedMessageId = randomUUID();
  const sessionStateDirectory = join(directory, "session-state");
  const brokerDirectory = join(directory, "broker");
  const journal = join(sessionStateDirectory, id, "events.jsonl");
  await mkdir(join(sessionStateDirectory, id), { recursive: true });
  await writeFile(join(sessionStateDirectory, id, "workspace.yaml"), "name: Origin-scoped App\ncwd: C:\\fixture\n");
  await writeFile(journal, "\n".repeat(3962));
  await mkdir(join(brokerDirectory, "sessions"), { recursive: true });
  await writeFile(join(brokerDirectory, "config.json"), JSON.stringify({
    schema: 1, registrationTtlMs: 20_000, operations: ["send_message"],
  }));
  await writeFile(join(brokerDirectory, "sessions", `${id}.json`), JSON.stringify({
    schema: 1, sessionId: id, instanceId: randomUUID(), pid: process.pid,
    name: "Origin-scoped App", workspace: directory, status: "idle", heartbeatAt: new Date().toISOString(),
  }));
  const app = new LocalAppSessions({ timeoutMs: 1000, sessionStateDirectory, brokerDirectory });
  const readState = app.readSessionState.bind(app);
  let observedThrough = -1;
  t.mock.method(app, "readSessionState", async (sessionId: string) => {
    const snapshot = await readState(sessionId);
    observedThrough = snapshot.completedThrough;
    return snapshot;
  });
  const h = await setup(t, app, { outputPollIntervalMs: 2, outputWatchTimeoutMs: 3000 }, false, false);
  const store = await Store.open(join(h.directory, "bridge"), "origin-test");
  const transport = new PreviewTransport();
  const bridge = new Bridge(store, h.runtime, transport, {
    owner: "origin-test", workspaces: [{ id: "local", name: "Local", path: h.directory }], coalesceMs: 2,
  });
  let nextIndex = 3962;
  const append = async (rows: Array<[number, unknown]>) => {
    const lines: string[] = [];
    for (const [index, event] of rows) {
      while (nextIndex < index) { lines.push(""); nextIndex++; }
      lines.push(JSON.stringify(event));
      nextIndex++;
    }
    await appendFile(journal, lines.join("\n") + "\n");
  };
  const completionRows = (messageId: string, turnId: string, summary: string, start: number, complete: number): Array<[number, unknown]> => {
    const interactionId = randomUUID();
    const requestId = randomUUID();
    const toolCallId = randomUUID();
    return [
      [start, { id: requestId, type: "assistant.message", timestamp: "2026-11-14T05:53:09Z",
        data: { originatingMessageId: messageId, turnId, interactionId, content: "",
          toolRequests: [{ name: "task_complete", toolCallId, arguments: { summary } }] } }],
      [start + 1, { id: randomUUID(), parentId: requestId, type: "tool.execution_start",
        data: { toolCallId, toolName: "task_complete", turnId, arguments: { summary } } }],
      [complete, { id: randomUUID(), type: "tool.execution_complete", timestamp: "2026-11-14T05:53:17.692Z",
        data: { toolCallId, turnId, interactionId, success: true, result: { content: summary } } }],
      [complete + 2, { id: randomUUID(), type: "assistant.turn_end", data: { turnId } }],
    ];
  };
  try {
    await bridge.start();
    const turn = authorizeActivity(mockEnvelope(), { aud: mockIdentity.appId }, mockIdentity);
    const text = (value: string) => bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: value });
    await text(`!use ${id}`);
    const sending = text("one synthetic origin-scoped instruction");
    await completeAppSend(brokerDirectory, id, { accepted: true, messageId: admittedMessageId });
    await sending;
    await append(completionRows(oldMessageId, "1", "TARGET_READY", 3962, 3968));
    await eventually(() => observedThrough === 3970);
    await bridge.flush();
    assert.ok(!store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.text.includes("TARGET_READY")),
      "a prior instruction completing after admission must not be sent as this instruction's result");
    await append([
      [3977, { id: randomUUID(), type: "user.message", timestamp: "2026-11-14T05:53:09.589Z",
        data: { messageId: admittedMessageId, content: "one synthetic origin-scoped instruction" } }],
      ...completionRows(admittedMessageId, "0", "CURRENT_RESULT: 2021", 3980, 3986),
    ]);
    await eventually(() => store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.status === "sent" && item.text.includes("CURRENT_RESULT: 2021")));
    assert.equal(store.snapshot().outbox.filter((item) => !item.historyId).length, 1);
    assert.equal((await readdir(join(brokerDirectory, "processing", id))).length, 1);
    await text(`!use ${id}`);
    await bridge.flush();
    assert.ok(store.snapshot().sessions[id]!.timeline.some((entry) => entry.text === "TARGET_READY"),
      "explicit history still includes safe results from other instructions");
    assert.equal(store.snapshot().outbox.filter((item) => !item.historyId).length, 1, "history must not replay old or already-delivered results");
  } finally { await bridge.close(); }
});

test("returning-user discovery and App read/send work even when the optional persisted Control history is broken", async (t) => {
  const app = new AppSessionsDouble();
  const id = randomUUID();
  const controller = randomUUID();
  app.sessions = [{ id, name: "Existing App", status: "idle", workspace: "workspace", readable: true, direct: true }];
  const h = await setup(t, app, { outputPollIntervalMs: 2, outputWatchTimeoutMs: 1000 }, false, false);
  const path = join(h.directory, "bridge");
  const initial = await Store.open(path, "old-control-test");
  await initial.mutate((state) => {
    state.controllerId = controller;
    state.sessions[controller] = {
      ...saved(controller, h.directory), kind: "controller",
      settings: { mode: "interactive", modelId: "native-alpha" },
    };
  });
  await initial.close();
  const brokenHistory = t.mock.method(h.client.rpc.sessions, "readPersistedEvents", async () => {
    throw new Error("Old optional Control journal is missing or damaged.");
  });
  const store = await Store.open(path, "old-control-test");
  const bridge = new Bridge(store, h.runtime, new PreviewTransport(), {
    owner: "old-control-test", workspaces: [{ id: "local", name: "Local", path: h.directory }], coalesceMs: 2,
  });
  try {
    await bridge.start();
    assert.equal(bridge.healthy, true);
    assert.ok(store.snapshot().sessions[id]);
    const turn = authorizeActivity(mockEnvelope(), { aud: mockIdentity.appId }, mockIdentity);
    await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: `!use ${id}` });
    const history = await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: "!read" });
    assert.match(JSON.stringify(history), /App response/);
    await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: "one original target instruction" });
    assert.deepEqual(app.sent, [{ sessionId: id, message: "one original target instruction" }]);
    app.turns.push({ index: 10, assistantResponse: "App still responds", timestamp: "2026-11-14T03:00:00Z",
      originatingMessageId: "app-message-1" });
    app.completedThrough = 11;
    app.completions = [{ index: 11, originatingMessageId: "app-message-1" }];
    await eventually(() => store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.status === "sent" && item.text.includes("App still responds")));
    assert.equal(brokenHistory.mock.callCount(), 0, "ordinary startup and App operations must never depend on Control history");
    assert.deepEqual(h.client.created, []);
    assert.deepEqual(h.client.resumed, []);
    assert.deepEqual(h.client.sent, []);
  } finally { await bridge.close(); }
});

test("a failed App catalogue refresh does not revoke a previously discovered message route", async (t) => {
  const app = new AppSessionsDouble();
  const id = randomUUID();
  app.sessions = [{ id, name: "Retained App", status: "idle", workspace: "workspace", readable: true, direct: true }];
  const h = await setup(t, app);
  try {
    await h.runtime.inventory(randomUUID());
    t.mock.method(app, "listSessions", async () => { throw new Error("Host unavailable."); });
    await assert.rejects(() => h.runtime.inventory(randomUUID()), /Host unavailable/);
    await h.runtime.send(id, "one request after a failed refresh");
    assert.deepEqual(app.sent, [{ sessionId: id, message: "one request after a failed refresh" }]);
  } finally { await h.runtime.close(); }
});

test("cached App provenance restores owner-routed history and messaging without an inventory agent turn or native takeover", async (t) => {
  const app = new AppSessionsDouble();
  const id = randomUUID();
  app.sessions = [{ id, name: "Saved App route", status: "idle", workspace: "workspace", readable: true, direct: true }];
  const first = await setup(t, app);
  let saved: SessionRecord;
  try {
    const entry = (await first.runtime.inventory(randomUUID())).find((item) => item.id === id);
    assert.ok(entry);
    assert.equal(entry.peerSource, "app");
    saved = { ...entry, timeline: [], pending: [], seenEvents: [], sequence: 0, updatedAt: Date.now() };
  } finally { await first.runtime.close(); }
  const second = await setup(t, app);
  try {
    const lists = app.lists;
    await second.runtime.watchPeer(saved);
    assert.match(JSON.stringify(await second.runtime.history(id)), /App response/);
    await second.runtime.send(id, "one fresh owner message");
    assert.equal(app.lists, lists);
    assert.deepEqual(app.sent, [{ sessionId: id, message: "one fresh owner message" }]);
    assert.deepEqual(second.client.resumed, []);
    assert.deepEqual(second.client.managementMessages, []);
  } finally { await second.runtime.close(); }
});

test("accepted App sends observe only new stable results without another user request, with no duplicate or historical replay", async (t) => {
  const app = new AppSessionsDouble();
  const id = randomUUID();
  app.sessions = [{ id, name: "App work", status: "busy", workspace: "workspace", readable: true, direct: true }];
  const h = await setup(t, app, { outputPollIntervalMs: 2, outputWatchTimeoutMs: 1000 });
  try {
    await h.runtime.inventory(randomUUID());
    const listCalls = app.lists;
    await h.runtime.send(id, "one exact App request");
    app.turns.push({ index: 2086, assistantResponse: "Successful task_complete summary", timestamp: "2026-11-11T13:58:34.080Z",
      originatingMessageId: "app-message-1" });
    app.completedThrough = 2087;
    app.completions = [{ index: 2087, originatingMessageId: "app-message-1" }];
    await eventually(() => h.events.some((event) => JSON.stringify(event).includes("Successful task_complete summary")));
    const count = () => h.events.filter((event) => JSON.stringify(event).includes("Successful task_complete summary")).length;
    await eventually(() => h.events.some((event) => JSON.stringify(event).includes("session.idle")));
    assert.equal(app.reads, 2, "one local baseline plus one local completion read should finish the common path");
    assert.equal(count(), 1);
    assert.ok(!h.events.some((event) => JSON.stringify(event).includes("App response")));
    const history = await h.runtime.history(id);
    assert.ok(JSON.stringify(history).includes("Successful task_complete summary"));
    const live = h.events.find((event) => JSON.stringify(event).includes("Successful task_complete summary"))?.event;
    const historical = history.find((event) => JSON.stringify(event).includes("Successful task_complete summary"));
    assert.ok(object(live) && object(historical) && object(live.data) && object(historical.data));
    assert.notEqual(live.id, historical.id);
    assert.equal(live.data.messageId, historical.data.messageId);
    assert.equal(app.lists, listCalls, "single-send completion must not wake the agent for status polling");
    assert.equal(count(), 1);
    assert.deepEqual(app.sent, [{ sessionId: id, message: "one exact App request" }]);
  } finally { await h.runtime.close(); }
});

test("App completion-only results enter the real bridge durable outbox and deliver in the background without user polling", async (t) => {
  const app = new AppSessionsDouble();
  const id = randomUUID();
  app.sessions = [{ id, name: "Background App", status: "busy", workspace: "workspace", readable: true, direct: true }];
  const h = await setup(t, app, { outputPollIntervalMs: 2, outputWatchTimeoutMs: 1000 }, false);
  const store = await Store.open(join(h.directory, "bridge"), "app-output-test");
  const transport = new PreviewTransport();
  const bridge = new Bridge(store, h.runtime, transport, {
    owner: "app-output-test", workspaces: [{ id: "local", name: "Local", path: h.directory }], coalesceMs: 2,
  });
  try {
    await bridge.start();
    const turn = authorizeActivity(mockEnvelope(), { aud: mockIdentity.appId }, mockIdentity);
    await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: `!use ${id}` });
    await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: "return the session result" });
    const nativeId = randomUUID();
    const actual = await h.runtime.create({ id: nativeId, name: "Foreground native", workspace: h.directory, controller: false });
    await store.mutate((state) => {
      state.sessions[nativeId] = {
        id: nativeId, name: "Foreground native", kind: "owned", status: "idle", workspace: h.directory,
        capability: "Native", settings: actual, pending: [], timeline: [], seenEvents: [], sequence: 0, updatedAt: Date.now(),
      };
    });
    await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: `!use ${nativeId}` });
    app.turns.push({
      index: 2155, assistantResponse: "Completion-only result api_key=never-export-this", timestamp: "2026-11-11T14:03:36.768Z",
      originatingMessageId: "app-message-1",
    });
    app.completedThrough = 2156;
    app.completions = [{ index: 2156, originatingMessageId: "app-message-1" }];
    await eventually(() => store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.status === "sent"));
    const outbox = store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text.includes("Completion-only result"));
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]!.presentation?.kind, "background");
    assert.equal(outbox[0]!.presentation?.title, "Background App");
    assert.ok(outbox[0]?.activityId);
    assert.ok(!JSON.stringify(store.snapshot()).includes("never-export-this"));
    assert.equal(app.sent.length, 1);
    const messages = [...transport.messages.values()].filter((item) =>
      item.message.type === "text" && item.message.text.includes("Completion-only result"));
    assert.equal(messages.length, 1);
    await bridge.flush();
    assert.equal(store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text.includes("Completion-only result")).length, 1);
  } finally { await bridge.close(); }
});

test("App baseline failure prevents admission and repeated admitted messages share one deduplicated observer", async (t) => {
  const app = new AppSessionsDouble();
  const id = randomUUID();
  app.sessions = [{ id, name: "App work", status: "busy", workspace: "workspace", readable: true, direct: true }];
  const h = await setup(t, app, { outputPollIntervalMs: 2, outputWatchTimeoutMs: 1000 });
  try {
    await h.runtime.inventory(randomUUID());
    const read = app.readSessionState.bind(app);
    app.readSessionState = async () => { throw new Error("baseline unavailable"); };
    await assert.rejects(() => h.runtime.send(id, "not admitted"), /baseline unavailable/);
    assert.equal(app.sent.length, 0);
    app.readSessionState = read;
    await h.runtime.send(id, "first");
    const listCalls = app.lists;
    app.turns.push({ index: 10, assistantResponse: "first result", timestamp: "2026-11-11T14:00:00Z",
      originatingMessageId: "app-message-1" });
    await eventually(() => h.events.some((event) => JSON.stringify(event).includes("first result")));
    await h.runtime.send(id, "second");
    app.turns.push({ index: 20, assistantResponse: "second result", timestamp: "2026-11-11T14:01:00Z",
      originatingMessageId: "app-message-2" });
    app.completedThrough = 21;
    app.completions = [{ index: 21, originatingMessageId: "app-message-2" }];
    await eventually(() => h.events.some((event) => JSON.stringify(event).includes("second result")));
    app.sessions[0]!.status = "idle";
    assert.ok(!h.events.some((event) => JSON.stringify(event).includes("session.idle")),
      "the second completion and an idle heartbeat cannot finish the first admission");
    app.completions.push({ index: 22, originatingMessageId: "app-message-1" });
    await eventually(() => h.events.some((event) => JSON.stringify(event).includes("session.idle")));
    for (const result of ["first result", "second result"]) {
      assert.equal(h.events.filter((event) => JSON.stringify(event).includes(result)).length, 1);
    }
    assert.equal(app.lists, listCalls, "overlapping completions cannot use idle/host status to guess ownership");
    assert.deepEqual(app.sent.map((item) => item.message), ["first", "second"]);
  } finally { await h.runtime.close(); }
});

test("unattributed or foreign-origin output stays historical and an idle heartbeat cannot turn it into an admitted result", async (t) => {
  const app = new AppSessionsDouble();
  const id = randomUUID();
  app.sessions = [{ id, name: "App work", status: "idle", workspace: "workspace", readable: true, direct: true }];
  const h = await setup(t, app, { outputPollIntervalMs: 2, outputWatchTimeoutMs: 60 });
  try {
    await h.runtime.inventory(randomUUID());
    await h.runtime.send(id, "accepted once");
    app.turns.push(
      { index: 10, assistantResponse: "UNATTRIBUTED_RESULT", timestamp: "2026-11-14T05:00:00Z" },
      { index: 20, assistantResponse: "OTHER_INSTRUCTION_RESULT", timestamp: "2026-11-14T05:00:01Z",
        originatingMessageId: "a-different-message" },
    );
    app.completedThrough = 21;
    app.completions = [{ index: 21, originatingMessageId: "a-different-message" }];
    await eventually(() => h.events.some((event) => object(event.event) && event.event.type === "bridge.app_output_unavailable"));
    assert.ok(!JSON.stringify(h.events).includes("UNATTRIBUTED_RESULT"));
    assert.ok(!JSON.stringify(h.events).includes("OTHER_INSTRUCTION_RESULT"));
    assert.ok(!JSON.stringify(h.events).includes("session.idle"));
    const notice = h.events.find((event) => object(event.event) && event.event.type === "bridge.app_output_unavailable")!;
    const result = new Projector().apply(saved(id, h.directory), notice.event);
    assert.match(result.final!.text, /Completion could not be confirmed for every admitted instruction/);
    assert.match(result.final!.text, /unattributed output was not forwarded/);
    assert.match(JSON.stringify(await h.runtime.history(id)), /UNATTRIBUTED_RESULT/);
    assert.match(JSON.stringify(await h.runtime.history(id)), /OTHER_INSTRUCTION_RESULT/);
    assert.equal(app.sent.length, 1);
  } finally { await h.runtime.close(); }
});

test("a fast second-admission result observed before its acknowledgement is re-read and attributed once after ack", async (t) => {
  const app = new AppSessionsDouble();
  const id = randomUUID();
  app.sessions = [{ id, name: "App work", status: "busy", workspace: "workspace", readable: true, direct: true }];
  const h = await setup(t, app, { outputPollIntervalMs: 2, outputWatchTimeoutMs: 1000 });
  const readState = app.readSessionState.bind(app);
  let releaseRead: ((snapshot: AppSessionSnapshot) => void) | undefined;
  let acknowledge: ((messageId: string) => void) | undefined;
  let readReturned = false;
  let second: Promise<unknown> | undefined;
  try {
    await h.runtime.inventory(randomUUID());
    await h.runtime.send(id, "first");
    app.readSessionState = async () => {
      app.reads++;
      const snapshot = await new Promise<AppSessionSnapshot>((resolve) => { releaseRead = resolve; });
      readReturned = true;
      return snapshot;
    };
    await eventually(() => releaseRead !== undefined);
    app.sendMessage = async (sessionId, message) => {
      app.sent.push({ sessionId, message });
      return new Promise<string>((resolve) => { acknowledge = resolve; });
    };
    second = h.runtime.send(id, "second");
    await eventually(() => acknowledge !== undefined);
    app.turns.push(
      { index: 10, originatingMessageId: "app-message-1", assistantResponse: "first owned result", timestamp: "2026-11-14T05:00:00Z" },
      { index: 20, originatingMessageId: "app-message-2", assistantResponse: "fast second result", timestamp: "2026-11-14T05:00:01Z" },
    );
    app.completions = [
      { index: 11, originatingMessageId: "app-message-1" }, { index: 21, originatingMessageId: "app-message-2" },
    ];
    app.completedThrough = 21;
    releaseRead!(await readState());
    await eventually(() => readReturned);
    assert.equal(h.events.length, 0, "an in-flight admission cannot lose output to an unrecognized message ID");
    app.readSessionState = readState;
    acknowledge!("app-message-2");
    await second;
    await eventually(() => h.events.some((event) => object(event.event) && event.event.type === "session.idle"));
    for (const text of ["first owned result", "fast second result"]) {
      assert.equal(h.events.filter((event) => JSON.stringify(event).includes(text)).length, 1);
    }
    assert.deepEqual(app.sent.map((entry) => entry.message), ["first", "second"]);
  } finally {
    releaseRead?.({ turns: [], completedThrough: -1, completions: [], consumed: [], throughIndex: -1 });
    acknowledge?.("app-message-2");
    await second?.catch(() => undefined);
    await h.runtime.close();
  }
});

test("reading App history before live observation does not suppress the automatic final delivery", async (t) => {
  const app = new AppSessionsDouble();
  const id = randomUUID();
  app.sessions = [{ id, name: "App history race", status: "busy", workspace: "workspace", readable: true, direct: true }];
  const h = await setup(t, app, { outputPollIntervalMs: 1000, outputWatchTimeoutMs: 5000 }, false);
  const store = await Store.open(join(h.directory, "bridge"), "app-history-test");
  const transport = new PreviewTransport();
  const bridge = new Bridge(store, h.runtime, transport, {
    owner: "app-history-test", workspaces: [{ id: "local", name: "Local", path: h.directory }], coalesceMs: 2,
  });
  try {
    await bridge.start();
    const turn = authorizeActivity(mockEnvelope(), { aud: mockIdentity.appId }, mockIdentity);
    await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: `!use ${id}` });
    await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: "produce one result" });
    app.turns.push({ index: 40, assistantResponse: "history won the race", timestamp: "2026-11-11T14:03:00Z",
      originatingMessageId: "app-message-1" });
    app.completedThrough = 41;
    app.completions = [{ index: 41, originatingMessageId: "app-message-1" }];
    await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: `!use ${id}` });
    await bridge.flush();
    assert.ok(store.snapshot().sessions[id]!.timeline.some((entry) => entry.text === "history won the race"));
    assert.equal(store.snapshot().outbox.filter((item) => !item.historyId).length, 1, "explicit history now reconciles the saved admission as well as showing history");
    await eventually(() => store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.status === "sent"));
    assert.equal(store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text.includes("history won the race")).length, 1);
    assert.equal(app.sent.length, 1);
  } finally { await bridge.close(); }
});

test("closing the runtime cancels scheduled App reads and suppresses an in-flight result", async (t) => {
  const app = new AppSessionsDouble();
  const id = randomUUID();
  app.sessions = [{ id, name: "App work", status: "busy", workspace: "workspace", readable: true, direct: true }];
  const h = await setup(t, app, { outputPollIntervalMs: 2, outputWatchTimeoutMs: 1000 });
  let release: ((snapshot: AppSessionSnapshot) => void) | undefined;
  try {
    await h.runtime.inventory(randomUUID());
    await h.runtime.send(id, "only once");
    app.readSessionState = () => new Promise((resolve) => { app.reads++; release = resolve; });
    app.close = async () => {
      app.closed = true;
      release?.({
        turns: [{ index: 30, assistantResponse: "late result", timestamp: "2026-11-11T14:02:00Z" }],
        completedThrough: 31,
        completions: [],
        consumed: [], throughIndex: 31,
      });
    };
    await eventually(() => release !== undefined);
    await h.runtime.close();
    const reads = app.reads;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(app.reads, reads);
    assert.equal(h.events.length, 0);
    assert.equal(app.sent.length, 1);
  } finally { await h.runtime.close(); }
});

test("App observation failure/expiry is visible and never resends the accepted message", async (t) => {
  for (const outcome of ["expired", "failed", "stalled"] as const) {
    const app = new AppSessionsDouble();
    const id = randomUUID();
    app.sessions = [{ id, name: "App work", status: "busy", workspace: "workspace", readable: true, direct: true }];
    const h = await setup(t, app, { outputPollIntervalMs: 2, outputWatchTimeoutMs: 25 });
    let release: ((snapshot: AppSessionSnapshot) => void) | undefined;
    try {
      await h.runtime.inventory(randomUUID());
      await h.runtime.send(id, "accepted once");
      if (outcome === "failed") app.readSessionState = async () => { throw new Error("private reader failure"); };
      if (outcome === "stalled") {
        app.readSessionState = () => new Promise((resolve) => { release = resolve; });
        app.close = async () => {
          app.closed = true;
          release?.({ turns: [], completedThrough: -1, completions: [], consumed: [], throughIndex: -1 });
        };
      }
      await eventually(() => h.events.some((event) => JSON.stringify(event).includes("bridge.app_output_unavailable")));
      assert.deepEqual(app.sent, [{ sessionId: id, message: "accepted once" }]);
      assert.ok(!JSON.stringify(h.events).includes("private reader failure"));
      if (outcome === "stalled") assert.ok(release, "the deadline must also interrupt an in-flight read");
      const event = h.events.find((event) => object(event.event) && event.event.type === "bridge.app_output_unavailable");
      assert.ok(event);
      const session = saved(id, h.directory);
      const result = new Projector().apply(session, event.event);
      assert.equal(session.status, "offline", "one App observation failure must not mark the entire target permanently erroneous");
      assert.match(result.final!.text, new RegExp(outcome === "failed" ? "APP_OUTPUT_READ_FAILED" : "APP_OUTPUT_TIMEOUT"));
    } finally { await h.runtime.close(); }
  }
});

function createOptions(id: string, workspace: string, controller = false): CreateOptions {
  return { id, workspace, name: controller ? "Control" : "Work", controller };
}

function saved(id: string, workspace: string): SessionRecord {
  return {
    id, workspace, name: "Saved work", kind: "owned", status: "offline", capability: "",
    timeline: [], pending: [], seenEvents: [], sequence: 0, updatedAt: 0,
  };
}

test("native client is persistent, explicitly isolated and never inherits Teams/Twin/token variables", async (t) => {
  const h = await setup(t);
  try {
    const env = childEnvironment({ PATH: "tools", TEAMS_APP_SECRET: "secret", GH_TOKEN: "ambient", TWIN_TOKEN: "twin" });
    assert.equal(env.PATH, "tools");
    assert.equal(env.TEAMS_APP_SECRET, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.TWIN_TOKEN, undefined);
    assert.equal(env.COPILOT_TELEMETRY_DISABLED, "true");
    const id = randomUUID();
    await h.runtime.create(createOptions(id, h.directory));
    const configured = h.captured;
    assert.ok(configured);
    assert.equal(configured.mode, "empty");
    assert.equal(configured.useLoggedInUser, false);
    assert.equal(configured.baseDirectory, h.options.home);
    await h.runtime.send(id, " exact\r\nprompt ");
    await h.runtime.send(id, "next");
    assert.equal(h.client.created.length, 1);
    assert.deepEqual(h.client.sent.map((entry) => entry.prompt), [" exact\r\nprompt ", "next"]);
    assert.equal(h.client.sessions.get(id)?.required, true);
    assert.equal(h.client.created[0]?.onPermissionRequest, undefined);
    assert.equal(h.client.created[0]?.permissionMode, "manual");
    assert.equal(h.client.created[0]?.enableConfigDiscovery, false);
  } finally { await h.runtime.close(); }
});

test("native initialization is lazy and shared across concurrent explicit owned/Control operations", async (t) => {
  const h = await setup(t, undefined, undefined, false);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const starts = t.mock.method(h.client, "start", () => gate);
  const auth = t.mock.method(h.client, "getAuthStatus");
  const catalogue = t.mock.method(h.client, "listModels");
  try {
    await h.runtime.start(() => undefined);
    await h.runtime.inventory(randomUUID());
    await h.runtime.appLiveness();
    assert.equal(starts.mock.callCount(), 0);
    const workId = randomUUID();
    const controllerId = randomUUID();
    const operations = Promise.all([
      h.runtime.create(createOptions(workId, h.directory)),
      h.runtime.create(createOptions(controllerId, h.directory, true)),
    ]);
    await eventually(() => starts.mock.callCount() === 1);
    assert.equal(auth.mock.callCount(), 0);
    assert.equal(h.client.created.length, 0);
    release!();
    await operations;
    assert.equal(starts.mock.callCount(), 1);
    assert.equal(auth.mock.callCount(), 1);
    assert.equal(catalogue.mock.callCount(), 1);
    assert.equal(h.client.created.length, 2);
    assert.equal(h.client.created.find((config) => config.sessionId === workId)?.permissionMode, "manual");
    assert.deepEqual(h.client.sent, []);
  } finally { release?.(); await h.runtime.close(); }
});

test("a failed explicit native initialization is surfaced, cleaned up and retried only by a later explicit operation", async (t) => {
  for (const stage of ["start", "auth", "models"] as const) {
    const h = await setup(t, undefined, undefined, false);
    let first = true;
    const starts = t.mock.method(h.client, "start", async () => {
      if (stage === "start" && first) {
        first = false;
        throw new Error("PRIVATE_STARTUP_DETAIL");
      }
    });
    const auth = t.mock.method(h.client, "getAuthStatus", async () => {
      if (stage === "auth" && first) { first = false; return { isAuthenticated: false }; }
      return { isAuthenticated: true };
    });
    const catalogue = t.mock.method(h.client, "listModels", async () => {
      if (stage === "models" && first) { first = false; return []; }
      return models;
    });
    const stop = t.mock.method(h.client, "stop");
    try {
      await h.runtime.start(() => undefined);
      const attempts = await Promise.allSettled([
        h.runtime.create(createOptions(randomUUID(), h.directory)),
        h.runtime.create(createOptions(randomUUID(), h.directory, true)),
      ]);
      for (const result of attempts) {
        assert.equal(result.status, "rejected");
        if (result.status !== "rejected") throw new Error("An initialization failure unexpectedly created a session.");
        const error: unknown = result.reason;
        assert.ok(error instanceof Error && !error.message.includes("PRIVATE_STARTUP_DETAIL") &&
          /Existing App sessions remain available|existing App sessions remain available/.test(error.message));
      }
      assert.equal(starts.mock.callCount(), 1);
      assert.equal(stop.mock.callCount(), 1);
      assert.equal(h.client.created.length, 0);
      await h.runtime.inventory(randomUUID());
      await h.runtime.appLiveness();
      assert.equal(starts.mock.callCount(), 1, "browsing after failure must not retry the SDK");
      const next = randomUUID();
      await h.runtime.create(createOptions(next, h.directory));
      assert.equal(starts.mock.callCount(), 2);
      assert.ok(auth.mock.callCount() >= 1);
      assert.ok(catalogue.mock.callCount() >= 1);
      assert.deepEqual(h.client.created.map((config) => config.sessionId), [next]);
      assert.deepEqual(h.client.sent, []);
    } finally { await h.runtime.close(); }
  }
});

test("incomplete SDK cleanup blocks new startup attempts until a subsequent explicit retry can cleanly finish", async (t) => {
  const h = await setup(t, undefined, undefined, false);
  h.client.status = { isAuthenticated: false };
  let canStop = false;
  const starts = t.mock.method(h.client, "start");
  const stop = t.mock.method(h.client, "stop", async () =>
    canStop ? [] : [new Error("PRIVATE_CLEANUP_DETAIL")]);
  try {
    await h.runtime.start(() => undefined);
    await assert.rejects(() => h.runtime.create(createOptions(randomUUID(), h.directory)), /cleanup is incomplete/);
    assert.equal(starts.mock.callCount(), 1);
    await h.runtime.inventory(randomUUID());
    await assert.rejects(() => h.runtime.create(createOptions(randomUUID(), h.directory)), /cleanup is still incomplete/);
    assert.equal(starts.mock.callCount(), 1, "failed cleanup must never spawn a duplicate runtime");
    h.client.status = { isAuthenticated: true };
    canStop = true;
    await h.runtime.create(createOptions(randomUUID(), h.directory));
    assert.equal(starts.mock.callCount(), 2);
    assert.equal(stop.mock.callCount(), 3);
    assert.equal(h.client.created.length, 1);
    assert.equal(h.client.sent.length, 0);
  } finally { canStop = true; await h.runtime.close(); }
});

test("only explicit Control instructions and the New submit action initialize the SDK, with visible auth failure and a fresh retry", async (t) => {
  const app = new AppSessionsDouble();
  const appId = randomUUID();
  app.sessions = [{ id: appId, name: "Existing App", status: "idle", workspace: "fixture", readable: true, direct: true }];
  const h = await setup(t, app, { outputPollIntervalMs: 2, outputWatchTimeoutMs: 1000 }, false);
  const starts = t.mock.method(h.client, "start");
  const auth = t.mock.method(h.client, "getAuthStatus");
  const stop = t.mock.method(h.client, "stop");
  h.client.status = { isAuthenticated: false };
  const store = await Store.open(join(h.directory, "bridge"), "explicit-sdk-test");
  const bridge = new Bridge(store, h.runtime, new PreviewTransport(), {
    owner: "explicit-sdk-test", workspaces: [{ id: "local", name: "Local", path: h.directory }], coalesceMs: 2,
  });
  try {
    await bridge.start();
    const turn = authorizeActivity(mockEnvelope(), { aud: mockIdentity.appId }, mockIdentity);
    const text = (value: string) => bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: value });
    await text("!new");
    await text("!control");
    await text("!read");
    await text("not an explicit Control instruction");
    assert.equal(starts.mock.callCount(), 0);
    const failed = await text("!control list sessions");
    assert.match(JSON.stringify(failed), /not signed in/);
    assert.equal(starts.mock.callCount(), 1);
    assert.equal(auth.mock.callCount(), 1);
    assert.equal(stop.mock.callCount(), 1);
    assert.deepEqual(h.client.created, []);
    assert.equal(h.client.sent.length, 0);
    await text(`!use ${appId}`);
    await text("App instructions remain available after a native login failure");
    assert.deepEqual(app.sent, [{ sessionId: appId, message: "App instructions remain available after a native login failure" }]);
    assert.equal(starts.mock.callCount(), 1, "App traffic after native auth failure must not retry or depend on it");
    h.client.status = { isAuthenticated: true };
    const form = await text("!new");
    assert.equal(starts.mock.callCount(), 1, "viewing New must not silently retry login");
    const create = findAction(form, "Create");
    assert.ok(object(create.data));
    await bridge.handle(turn.key, turn.reference, randomUUID(), {
      kind: "action", data: { ...create.data, sessionName: "Explicit native work", workspace: "local" },
    });
    const selectedId = store.snapshot().conversations[turn.key]!.selectedId!;
    assert.equal(store.snapshot().sessions[selectedId]!.status, "idle");
    assert.equal(starts.mock.callCount(), 2);
    assert.equal(h.client.created.length, 1);
    assert.equal(h.client.sent.length, 0, "New creates a native session but runs no task");
    await text("!control list sessions");
    assert.equal(starts.mock.callCount(), 2, "a ready native SDK remains persistent");
    assert.equal(h.client.sent.at(-1)?.id, store.snapshot().controllerId);
    await text("ordinary selected work even while Control is shown");
    assert.deepEqual(h.client.sent.at(-1), { id: selectedId, prompt: "ordinary selected work even while Control is shown" });
  } finally { await bridge.close(); }
});

test("controller tools use custom-only allowlist, deny execution, and are not exposed as native peers", async (t) => {
  const h = await setup(t);
  try {
    const id = randomUUID();
    await h.runtime.create({ ...createOptions(id, h.directory, true), tools: [{ name: "bridge_list", description: "safe", handler: () => [] }] });
    const config = h.client.created[0]!;
    assert.deepEqual(config.availableTools, ["custom:bridge_list"]);
    assert.deepEqual(config.excludedTools, ["builtin:*", "mcp:*"]);
    assert.deepEqual(config.includedBuiltinAgents, []);
    assert.equal(h.client.policies.length, 0);
    assert.ok(config.onPermissionRequest);
    assert.deepEqual(await config.onPermissionRequest({
      kind: "shell", intention: "fixture", fullCommandText: "do not execute", commands: [],
      possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: false,
    }, { sessionId: id }), { kind: "reject", feedback: "Controller execution is forbidden." });
  } finally { await h.runtime.close(); }
});

test("selected native settings honor live capability catalogue, report readback and distinguish deferred switches", async (t) => {
  const h = await setup(t);
  try {
    const id = randomUUID();
    await h.runtime.create(createOptions(id, h.directory));
    const catalogue = await h.runtime.models(id);
    const alpha = catalogue.find((item) => item.id === "native-alpha")!;
    const fast = catalogue.find((item) => item.id === "native-fast")!;
    await assert.rejects(() => h.runtime.configure(id, { mode: "plan", modelKey: fast.key, effort: "max" }), /not advertised/);
    assert.equal(h.client.sessions.get(id)?.switchCalls.length, 0);
    const applied = await h.runtime.configure(id, { mode: "plan", modelKey: alpha.key, effort: "max" });
    assert.equal(applied.status, "applied");
    assert.deepEqual(applied.actual, { mode: "plan", modelId: "native-alpha", effort: "max" });
    assert.equal(h.client.sessions.get(id)?.events.length, 0);
    h.client.deferred = true;
    const deferred = await h.runtime.configure(id, { mode: "plan", modelKey: fast.key });
    assert.equal(deferred.status, "queued");
    assert.equal(deferred.actual.modelId, "native-alpha");
    assert.equal(deferred.expected?.modelId, "native-fast");
    h.client.deferred = false;
    h.client.wrongReadback = true;
    const unmatched = await h.runtime.configure(id, { mode: "interactive", modelKey: fast.key });
    assert.equal(unmatched.status, "accepted");
    assert.equal(unmatched.actual.modelId, "unexpected-model");
  } finally { await h.runtime.close(); }
});

test("foreign in-use owner is refused before resume; unknown saved handlers and shared-runtime resident sessions are never replaced", async (t) => {
  const h = await setup(t);
  try {
    const id = randomUUID();
    h.client.locks = [id];
    await assert.rejects(() => h.runtime.resume(saved(id, h.directory)), /foreign live owner/);
    assert.equal(h.client.resumed.length, 0);
    await assert.rejects(() => h.runtime.resume({ ...saved(id, h.directory), kind: "saved" }), /not resumed/);
    assert.equal(h.client.resumed.length, 0);
    h.client.locks = [];
    await h.runtime.resume(saved(id, h.directory));
    assert.equal(h.client.resumed.length, 1);
    assert.equal(h.client.resumed[0]?.id, id);
    assert.equal(h.client.resumed[0]?.config.continuePendingWork, false);
    assert.equal(h.client.resumed[0]?.config.allowTranscriptRecovery, false);
    assert.equal(h.client.resumed[0]?.config.model, undefined);
    const { token: _token, ...configuration } = h.options;
    const uri = new NativeRuntime({ ...configuration, auth: "runtime", runtimeUri: "127.0.0.1:12345", runtimeToken: "explicit" }, () => h.client);
    await uri.start(() => undefined);
    await assert.rejects(() => uri.resume(saved(randomUUID(), h.directory)), /shared existing runtime/);
    await uri.close();
  } finally { await h.runtime.close(); }
});

test("native management peers stay read-only before admission when the protocol cannot return a correlated response identity", async (t) => {
  const h = await setup(t, undefined, undefined, true, true);
  try {
    const id = randomUUID();
    await h.runtime.create(createOptions(randomUUID(), h.directory));
    h.client.peers = { sessions: [{ sessionId: id, name: "Foreign root", cwd: h.directory, state: "busy", model: "native-alpha" }] };
    const found = await h.runtime.inventory(randomUUID());
    assert.equal(found[0]?.id, id);
    assert.equal(found[0]?.kind, "peer");
    assert.match(found[0]?.capability ?? "", /no originating message ID/);
    assert.deepEqual(found[0]?.access, { read: false, send: false });
    const prompt = " exact owner message ";
    await assert.rejects(() => h.runtime.send(id, prompt), /NATIVE_PEER_ORIGIN_UNAVAILABLE/);
    assert.deepEqual(h.client.managementMessages, []);
    assert.equal(h.client.resumed.length, 0);
    assert.equal(h.client.created.length, 2, "peer discovery starts only after an explicit native operation");
    assert.deepEqual(h.client.created[0]?.availableTools, []);
    assert.deepEqual(h.client.policies[0], { enabled: true, scope: "all", tools: { close: false, create: false } });
    await assert.rejects(() => h.runtime.settings(id), /foreign handlers/);
    await assert.rejects(() => h.runtime.stop(id), /foreign handlers/);
    await assert.rejects(() => h.runtime.answer(id, "request", { approve: true }), /foreign handlers/);
  } finally { await h.runtime.close(); }
});

test("S3: an actual Bridge/native management-peer route rejects before sending when the supported protocol returns no authoritative message ID", async (t) => {
  const h = await setup(t, undefined, undefined, false, true);
  const peerId = randomUUID();
  h.client.peers = { sessions: [{ sessionId: peerId, name: "Management peer", cwd: h.directory, state: "idle" }] };
  const store = await Store.open(join(h.directory, "bridge"), "peer-route-owner");
  const bridge = new Bridge(store, h.runtime, new PreviewTransport(), {
    owner: "peer-route-owner", workspaces: [{ id: "local", name: "Synthetic only", path: h.directory }],
    coalesceMs: 60_000,
  });
  try {
    await bridge.start();
    const turn = authorizeActivity(mockEnvelope("!home"), { aud: mockIdentity.appId }, mockIdentity);
    const text = (value: string) => bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: value });
    const form = await text("!new");
    const create = findAction(form, "Create");
    assert.ok(object(create.data));
    await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "action",
      data: { ...create.data, sessionName: "Owned control fixture", workspace: "local" } });
    await text("!sessions");
    await eventually(() => Boolean(store.snapshot().sessions[peerId]));
    const opened = await text(`!use ${peerId}`);
    const result = await text("A peer task that cannot be safely correlated");
    const state = store.snapshot();
    assert.equal(h.client.managementMessages.length, 0,
      "accepted:true plus targetSessionName is not a native message ID and must not be sent before reporting unsupported");
    assert.equal(state.sessions[peerId]!.access?.send, false);
    assert.throws(() => findAction(opened, "Send"), /not found/);
    assert.match(JSON.stringify(opened), /origin|correlat|message ID/iu);
    assert.match(JSON.stringify(result), /Destination unresolved/);
    assert.ok(!Object.values(state.directOrigins).some((item) => item.sessionId === peerId && item.status === "accepted"));
    await assert.rejects(() => h.runtime.send(peerId, "Direct API must refuse too"), /origin|correlat|message ID/iu);
    assert.equal(h.client.managementMessages.length, 0);
    assert.equal(h.client.resumed.length, 0);
  } finally { await bridge.close(); }
});

test("S3: an independently discovered local App endpoint keeps precedence over the same read-only native management peer ID", async (t) => {
  const app = new AppSessionsDouble();
  const h = await setup(t, app, { outputPollIntervalMs: 60_000, outputWatchTimeoutMs: 60_000 }, true, true);
  const id = randomUUID();
  try {
    await h.runtime.create(createOptions(randomUUID(), h.directory));
    app.sessions = [{ id, name: "Original App endpoint", status: "idle", workspace: h.directory, readable: true, direct: true, liveUntil: Date.now() + 60_000 }];
    h.client.peers = { sessions: [{ sessionId: id, name: "Same native peer", cwd: h.directory, state: "idle" }] };
    const inventory = await h.runtime.inventory(randomUUID());
    const target = inventory.find((session) => session.id === id);
    assert.equal(inventory.filter((session) => session.id === id).length, 1);
    assert.equal(target?.peerSource, "app");
    assert.equal(target?.access?.send, true);
    const prompt = " exact App-owned task, not a native management message ";
    const admitted = await h.runtime.send(id, prompt);
    assert.equal(admitted.id, "app-message-1");
    assert.equal(admitted.peer, true);
    assert.deepEqual(app.sent, [{ sessionId: id, message: prompt }]);
    assert.deepEqual(h.client.managementMessages, []);
    assert.deepEqual(h.client.resumed, []);
  } finally { await h.runtime.close(); }
});

test("native ask_user callback uses the exact runtime request ID and original choice, and stale/cancelled answers reject", async (t) => {
  const h = await setup(t);
  try {
    const id = randomUUID();
    await h.runtime.create(createOptions(id, h.directory));
    const config = h.client.created[0]!;
    assert.ok(config.onUserInputRequest);
    const requestId = randomUUID();
    const pending = config.onUserInputRequest({ requestId, question: "Continue?", choices: ["Exact A", "Exact B"], allowFreeform: false }, { sessionId: id });
    await h.runtime.answer(id, requestId, { choice: 1 });
    assert.deepEqual(await pending, { answer: "Exact B", wasFreeform: false });
    await assert.rejects(() => h.runtime.answer(id, requestId, { choice: 0 }), /stale/);
    const cancelledId = randomUUID();
    const cancelled = config.onUserInputRequest({ requestId: cancelledId, question: "Cancelled?" }, { sessionId: id });
    const rejects = assert.rejects(async () => cancelled, /resolved or cancelled/);
    config.onEvent?.({
      type: "user_input.completed", id: randomUUID(), timestamp: new Date().toISOString(), parentId: null,
      ephemeral: true, data: { requestId: cancelledId },
    });
    await rejects;
    await assert.rejects(() => h.runtime.answer(id, cancelledId, { text: "late" }), /stale/);
  } finally { await h.runtime.close(); }
});

test("native permission approval is one-shot and runtime success=false is stale, never success-shaped", async (t) => {
  const h = await setup(t);
  try {
    const id = randomUUID();
    await h.runtime.create(createOptions(id, h.directory));
    const state = h.client.sessions.get(id)!;
    const requestId = randomUUID();
    state.pendingPermission = requestId;
    await h.runtime.answer(id, requestId, { approve: true });
    assert.deepEqual(state.permissionResults[0], {
      requestId, result: { kind: "approve-once", approvedInteractively: true },
    });
    state.pendingPermission = randomUUID();
    h.client.permissionSuccess = false;
    await assert.rejects(() => h.runtime.answer(id, state.pendingPermission!, { approve: false }), /not accepted/);
  } finally { await h.runtime.close(); }
});

test("session catalogue exposes native snake-case reasoning efforts without inventing denied capabilities", () => {
  const raw = {
    id: "native-scoped", name: "Scoped native model", provider: { id: "copilot" },
    capabilities: { supports: { reasoning_effort: ["none", "low", "max"] } },
  };
  const choices = catalogue([
    raw,
    { ...raw, id: "explicitly-disabled", capabilities: { supports: { reasoningEffort: false, reasoning_effort: ["max"] } } },
    { ...raw, id: "no-advertised-values", capabilities: { supports: { reasoning_effort: true } } },
  ]);
  assert.deepEqual(choices[0]?.efforts, ["none", "low", "max"]);
  assert.equal(choices[0]?.providerId, "copilot");
  assert.deepEqual(choices[1]?.efforts, []);
  assert.deepEqual(choices[2]?.efforts, []);
});

test("unique Copilot model changes keep the resumable bare identity and ambiguous provider choices fail before changes", async (t) => {
  const h = await setup(t);
  try {
    const id = randomUUID();
    await h.runtime.create({ id, name: "Model identity", workspace: h.directory, controller: false });
    const session = h.client.sessions.get(id)!;
    const copilotModel = {
      id: "native-alpha", name: "Alpha",
      capabilities: { supports: { reasoning_effort: ["low", "max"] } },
      provider: { id: "copilot", kind: "copilot", label: "GitHub Copilot" },
    };
    session.port.rpc.model.list = async () => ({ list: [copilotModel] });
    const choice = (await h.runtime.models(id)).find((model) => model.id === "native-alpha")!;
    const result = await h.runtime.configure(id, { mode: "plan", modelKey: choice.key, effort: "max" });
    assert.equal(result.status, "applied");
    assert.deepEqual(session.switchCalls, [{ modelId: "native-alpha", reasoningEffort: "max", reasoningSummary: "none" }]);
    session.port.rpc.model.list = async () => ({
      list: [
        copilotModel,
        { ...copilotModel, provider: { id: "other", kind: "loki", label: "Another provider" } },
      ],
    });
    await assert.rejects(() => h.runtime.configure(id, { mode: "interactive", modelKey: choice.key }), /provider-qualified/i);
    assert.equal(session.mode, "plan");
    assert.equal(session.switchCalls.length, 1);
  } finally { await h.runtime.close(); }
});

test("catalogue keys preserve provider identity and never invent effort support", () => {
  const row = { id: "shared", name: "Shared", capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ["unusual-provider-effort"] };
  const choices = catalogue([
    { ...row, provider: { id: "provider-a" } }, { ...row, provider: { id: "provider-b" } },
    { ...row, capabilities: { supports: { reasoningEffort: false } } }, { ...row, policy: { state: "disabled" } },
  ]);
  assert.equal(choices.length, 3);
  assert.notEqual(choices[0]?.key, choices[1]?.key);
  assert.deepEqual(choices[0]?.efforts, ["unusual-provider-effort"]);
  assert.deepEqual(choices[2]?.efforts, []);
});

test("concurrent resume is single-owner and sends cannot interleave with an idle-boundary settings mutation", async (t) => {
  const h = await setup(t);
  try {
    const id = randomUUID();
    await Promise.all([h.runtime.resume(saved(id, h.directory)), h.runtime.resume(saved(id, h.directory))]);
    assert.equal(h.client.resumed.length, 1);
    const session = h.client.sessions.get(id)!;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = session.port.rpc.model.list;
    session.port.rpc.model.list = async () => { await gate; return original(); };
    const model = catalogue(models).find((item) => item.id === "native-alpha")!;
    const configuring = h.runtime.configure(id, { mode: "plan", modelKey: model.key, effort: "max" });
    const sending = h.runtime.send(id, "after configuration");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.client.sent.length, 0);
    release!();
    assert.equal((await configuring).status, "applied");
    await sending;
    assert.equal(h.client.sent.length, 1);
    assert.equal(session.mode, "plan");
    await assert.rejects(() => h.runtime.configure(id, { mode: "interactive", modelKey: model.key }), /busy/);
  } finally { await h.runtime.close(); }
});

test("a native model mutation failure surfaces authoritative partial mode readback, not a fictional old/applied setting", async (t) => {
  const h = await setup(t);
  try {
    const id = randomUUID();
    await h.runtime.create(createOptions(id, h.directory));
    const session = h.client.sessions.get(id)!;
    session.port.rpc.model.switchTo = async () => { throw new Error("fixture mutation failure"); };
    const model = (await h.runtime.models(id)).find((item) => item.id === "native-fast")!;
    const result = await h.runtime.configure(id, { mode: "plan", modelKey: model.key });
    assert.equal(result.status, "rejected");
    assert.equal(result.actual.mode, "plan");
    assert.equal(result.actual.modelId, "native-alpha");
    assert.match(result.detail, /partial mode change/);
  } finally { await h.runtime.close(); }
});

test("event-driven native peer tail handles a missing initial journal, split Unicode and later opt-out without resuming the owner", async (t) => {
  const h = await setup(t, undefined, undefined, true, true);
  try {
    const id = randomUUID();
    await h.runtime.create(createOptions(randomUUID(), h.directory));
    const directory = join(h.directory, "peer-journal");
    await mkdir(directory);
    h.client.peers = { sessions: [{ sessionId: id, name: "Peer", cwd: directory, state: "idle", sessionStatePath: directory }] };
    await h.runtime.inventory(randomUUID());
    await h.runtime.watchPeer({ ...saved(id, directory), kind: "peer", peerStatePath: directory });
    const line = Buffer.from(JSON.stringify({
      id: randomUUID(), type: "assistant.message", data: { messageId: "peer-final", phase: "final", content: "Peer \u{1f680} completed" },
    }) + "\n");
    const emoji = line.indexOf(Buffer.from("\u{1f680}"));
    await appendFile(join(directory, "events.jsonl"), line.subarray(0, emoji + 2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await appendFile(join(directory, "events.jsonl"), line.subarray(emoji + 2));
    await eventually(() => h.events.some((event) => {
      if (typeof event !== "object" || event === null || !("event" in event)) return false;
      return JSON.stringify(event.event).includes("peer-final");
    }));
    const final = h.events.find((event) => JSON.stringify(event).includes("peer-final"));
    assert.ok(final && typeof final === "object" && "historical" in final);
    assert.equal(final.historical, false);
    assert.ok(JSON.stringify(final).includes("Peer \u{1f680} completed"));
    assert.ok(!JSON.stringify(final).includes("\ufffd"));
    h.client.peers = { sessions: [] };
    await appendFile(join(directory, "events.jsonl"), JSON.stringify({
      id: randomUUID(), type: "assistant.message", data: { messageId: "after-opt-out", phase: "final", content: "must not read" },
    }) + "\n");
    await eventually(() => h.events.some((event) => JSON.stringify(event).includes("session.shutdown")));
    assert.ok(!h.events.some((event) => JSON.stringify(event).includes("after-opt-out")));
    assert.equal(h.client.resumed.length, 0);
  } finally { await h.runtime.close(); }
});

test("native pending-request receipt blocks ordinary text before the asynchronous card projection can catch up", async (t) => {
  const h = await setup(t);
  try {
    const id = randomUUID();
    await h.runtime.create(createOptions(id, h.directory));
    const requestId = randomUUID();
    const config = h.client.created[0]!;
    config.onEvent?.({
      id: randomUUID(), parentId: null, timestamp: new Date().toISOString(), type: "user_input.requested", ephemeral: true,
      data: { requestId, question: "Scoped response only", choices: ["A", "B"], allowFreeform: false },
    });
    await assert.rejects(() => h.runtime.send(id, "approve"), /scoped response/);
    assert.equal(h.client.sent.length, 0);
    config.onEvent?.({
      id: randomUUID(), parentId: null, timestamp: new Date().toISOString(), type: "user_input.completed", ephemeral: true,
      data: { requestId, answer: "A", wasFreeform: false },
    });
    await h.runtime.send(id, "ordinary text after native completion");
    assert.equal(h.client.sent.length, 1);
  } finally { await h.runtime.close(); }
});
