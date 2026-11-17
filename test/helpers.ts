import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Card, InteractionOptions } from "../src/domain.js";
import { Bridge } from "../src/bridge.js";
import { FakeRuntime } from "../src/fake-runtime.js";
import { Store } from "../src/store.js";
import { PreviewTransport, mockEnvelope, mockIdentity } from "../src/simulator.js";
import { authorizeActivity } from "../src/teams.js";
import { object } from "../src/safety.js";

const disposers = new Map<string, Array<() => Promise<void>>>();

export async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "copilot-teams-test-"));
  disposers.set(directory, []);
  t.after(async () => {
    for (const dispose of disposers.get(directory) ?? []) await dispose();
    disposers.delete(directory);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

export interface Harness {
  bridge: Bridge;
  runtime: FakeRuntime;
  transport: PreviewTransport;
  key: string;
  directory: string;
  text(text: string, activityId?: string): Promise<Card>;
  action(action: Record<string, unknown>, fields?: Record<string, unknown>, activityId?: string): Promise<Card>;
}

export async function harness(
  t: TestContext, autonomous = false, directory?: string,
  options: { initializeConversation?: boolean; inventoryOnStart?: boolean; appLivenessTimeoutMs?: number; historyReadTimeoutMs?: number; deliveryInitiallyPaused?: boolean; interaction?: InteractionOptions; cardActions?: "submit" | "execute" } = {},
): Promise<Harness> {
  const path = directory ?? await temporary(t);
  const store = await Store.open(path, "test-owner");
  const runtime = new FakeRuntime(2, autonomous, Boolean(options.interaction), options.interaction);
  const transport = new PreviewTransport();
  const bridge = new Bridge(store, runtime, transport, {
    owner: "test-owner", workspaces: [{ id: "local", name: "Test workspace", path }],
    coalesceMs: 20, cardActions: options.cardActions ?? "execute",
    ...(options.inventoryOnStart === undefined ? {} : { inventoryOnStart: options.inventoryOnStart }),
    ...(options.appLivenessTimeoutMs === undefined ? {} : { appLivenessTimeoutMs: options.appLivenessTimeoutMs }),
    ...(options.historyReadTimeoutMs === undefined ? {} : { historyReadTimeoutMs: options.historyReadTimeoutMs }),
    ...(options.deliveryInitiallyPaused === undefined ? {} : { deliveryInitiallyPaused: options.deliveryInitiallyPaused }),
    ...(options.interaction ? { interaction: options.interaction } : {}),
  });
  await bridge.start();
  const initial = authorizeActivity(mockEnvelope(), { aud: mockIdentity.appId }, mockIdentity);
  const text = async (text: string, activityId = randomUUID()) => {
    const envelope = { ...mockEnvelope(text), id: activityId };
    const turn = authorizeActivity(envelope, { aud: mockIdentity.appId }, mockIdentity);
    return bridge.handle(turn.key, turn.reference, activityId, turn.incoming);
  };
  const action = async (action: Record<string, unknown>, fields: Record<string, unknown> = {}, activityId = randomUUID()) => {
    assert.ok(object(action.data));
    const envelope = {
      ...mockEnvelope(""), id: activityId, type: "invoke", name: "adaptiveCard/action",
      value: { action: { type: "Action.Execute", verb: "bridge", data: { ...action.data, ...fields } }, trigger: "manual" },
    };
    const turn = authorizeActivity(envelope, { aud: mockIdentity.appId }, mockIdentity);
    return bridge.handle(turn.key, turn.reference, activityId, turn.incoming);
  };
  let closed = false;
  const original = bridge.close.bind(bridge);
  bridge.close = async () => { if (!closed) { closed = true; await original(); } };
  const cleanup = disposers.get(path);
  if (cleanup) cleanup.push(() => bridge.close());
  else t.after(async () => bridge.close());
  if (options.initializeConversation !== false) await text("!sessions");
  return { bridge, runtime, transport, key: initial.key, directory: path, text, action };
}

export function findAction(value: unknown, title: string): Record<string, unknown> {
  if (Array.isArray(value)) {
    for (const child of value) {
      try { return findAction(child, title); } catch { /* Continue traversing card nodes. */ }
    }
  } else if (object(value)) {
    if ((value.type === "Action.Execute" || value.type === "Action.Submit") && value.title === title) return value;
    for (const [key, child] of Object.entries(value)) {
      if (key === "fallback") continue;
      try { return findAction(child, title); } catch { /* Continue traversing card nodes. */ }
    }
  }
  throw new Error(`Card action not found: ${title}`);
}

export function findAllActions(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(findAllActions);
  if (!object(value)) return [];
  if (value.type === "Action.Execute" || value.type === "Action.Submit") return [value];
  // Count visible buttons, not the row gesture that duplicates its Open fallback.
  return Object.entries(value).filter(([key]) => key !== "fallback" && key !== "selectAction").flatMap(([, child]) => findAllActions(child));
}

// Exercise the retained signed handler, not a composer offered by new cards.
export function legacySend(bridge: Bridge, key: string): Record<string, unknown> {
  const conversation = bridge.store.snapshot().conversations[key]!;
  return { type: "Action.Submit", title: "Send", associatedInputs: "auto",
    data: { token: bridge.actions.issue(conversation, { op: "send", targetId: conversation.selectedId! }) } };
}

export async function createWorking(h: Harness, name = "Test work"): Promise<string> {
  const form = await h.text("!new");
  await h.action(findAction(form, "Create"), { sessionName: name, workspace: "local" });
  const id = h.bridge.store.snapshot().conversations[h.key]?.selectedId;
  assert.ok(id);
  return id;
}

export async function eventually(predicate: () => boolean, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("Expected condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

}

export async function completeAppSend(
  root: string, sessionId: string, result: unknown,
  response: { ok?: boolean; id?: string; error?: { code: string } } = {},
): Promise<Record<string, unknown>> {
  const directory = join(root, "requests", sessionId);
  let file = "";
  const deadline = Date.now() + 3000;
  while (!file) {
    try { file = (await readdir(directory)).find((name) => name.endsWith(".json")) ?? ""; } catch (error) {
      if (!object(error) || error.code !== "ENOENT") throw error;
    }
    if (file) break;
    if (Date.now() >= deadline) throw new Error("Local App endpoint request did not appear.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const request: unknown = JSON.parse(await readFile(join(directory, file), "utf8"));
  assert.ok(object(request) && typeof request.id === "string");
  await Promise.all([
    mkdir(join(root, "processing", sessionId), { recursive: true }),
    mkdir(join(root, "responses", sessionId), { recursive: true }),
  ]);
  await rename(join(directory, file), join(root, "processing", sessionId, file));
  await writeFile(join(root, "responses", sessionId, file), JSON.stringify({
    schema: 1, id: request.id, completedAt: new Date().toISOString(), ok: true, result, ...response,
  }));
  return request;
}
