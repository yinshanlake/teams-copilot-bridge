import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Activity } from "@microsoft/agents-activity";
import type { BridgeState, InteractionSurface, SessionRecord } from "../src/domain.js";
import { interactionConfiguration } from "../src/config.js";
import { interactionDefaults, interactionState, renderInteractionSurface } from "../src/interaction.js";
import { mockEnvelope } from "../src/simulator.js";
import { Store } from "../src/store.js";
import { digest } from "../src/safety.js";
import { createWorking, eventually, findAction, harness, temporary } from "./helpers.js";

const options = { ...interactionDefaults, statusUpdateMs: 5000, digestMs: 60_000 };

function surface(state: BridgeState, kind: InteractionSurface["kind"], sessionId?: string): InteractionSurface {
  const found = Object.values(state.interaction?.surfaces ?? {}).findLast((entry) =>
    entry.kind === kind && !entry.frozen && (sessionId === undefined || entry.sessionId === sessionId));
  assert.ok(found, `Missing ${kind} surface`);
  return found;
}

test("v3 direct results retain their original recipient through mute and selection; Show full is exact, scoped and once-only", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const a = await createWorking(h, "Original source");
  await h.text("literal work", "teams-original-prompt");
  const admitted = Object.values(h.bridge.store.snapshot().interaction!.turns)[0]!;
  assert.equal(admitted.state, "executing");
  assert.ok(admitted.messageId);
  assert.equal(h.bridge.store.snapshot().interaction!.follows[digest(`${h.key}:${a}`)]?.mode, "automatic");
  await h.text("!unsubscribe");
  const b = await createWorking(h, "New focus");
  const content = "A long, precise answer.\r\n" + "detail ".repeat(600);
  h.runtime.emit(a, "assistant.message", { messageId: "answer-a", originatingMessageId: admitted.messageId, content, phase: "final" });
  h.runtime.emit(a, "session.task_complete", { success: true });
  await h.bridge.flush();
  const state = h.bridge.store.snapshot();
  const item = state.outbox.find((entry) => entry.eventId === "answer-a")!;
  assert.equal(item.direct, true);
  assert.equal(item.status, "sent");
  assert.equal(item.originReference?.activityId, "teams-original-prompt");
  assert.equal(item.text, content);
  const resultCard = renderInteractionSurface(state, surface(state, "result", a), h.bridge.cards);
  assert.ok(JSON.stringify(resultCard).length < content.length);
  const full = findAction(resultCard, "Show full");
  const received = h.runtime.received.length;
  await h.action(full);
  await h.bridge.flush();
  const after = h.bridge.store.snapshot();
  assert.equal(after.conversations[h.key]!.selectedId, b);
  const readId = after.conversations[h.key]!.historyRead!.id;
  const fullRows = after.outbox.filter((entry) => entry.historyId === readId);
  assert.equal(fullRows.map((entry) => entry.text).join(""), content);
  await h.action(full);
  await h.bridge.flush();
  assert.deepEqual(h.bridge.store.snapshot().outbox.filter((entry) => entry.historyId === readId), fullRows);
  assert.equal(h.runtime.received.length, received);
});

test("v3 request surfaces survive Inbox/navigation/focus updates and still answer only their exact native request once", async (t) => {
  const h = await harness(t, true, undefined, { interaction: options });
  const a = await createWorking(h, "Approval source");
  await h.text("permission");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[a]?.pending.length));
  await h.bridge.flush();
  const before = h.bridge.store.snapshot();
  const request = surface(before, "request", a);
  const approval = findAction(renderInteractionSurface(before, request, h.bridge.cards), "Approve once");
  await h.text("!home");
  const b = await createWorking(h, "Other source");
  await h.text("!sessions");
  await h.action(approval);
  await h.bridge.flush();
  assert.equal(h.runtime.answers.length, 1);
  assert.equal(h.runtime.answers[0]!.id, a);
  assert.equal(h.runtime.answers[0]!.requestId, request.requestId);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
  await h.action(approval);
  assert.equal(h.runtime.answers.length, 1);
});

test("v3 read-only History does not select, while explicit Open still selects and preserves unresolved focus protection", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const a = await createWorking(h, "Read target");
  await h.text("work a");
  await h.bridge.flush();
  const state = h.bridge.store.snapshot();
  const history = findAction(renderInteractionSurface(state, surface(state, "turn", a), h.bridge.cards), "History");
  const b = await createWorking(h, "Current target");
  await h.action(history);
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
  await h.text("!use nonexistent-source");
  await h.action(history, {}, "another-history-activity");
  await h.text("must not reach the retained selection");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectionBlocked, true);
  assert.equal(h.runtime.received.length, 1);
});

test("v3 automatic following overrides Mute on a new accepted send, expires without cancelling direct obligations, and explicit Follow has no expiry", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const id = await createWorking(h);
  await h.text("first");
  await h.text("!unsubscribe");
  await h.text("second");
  const followId = digest(`${h.key}:${id}`);
  assert.equal(h.bridge.store.snapshot().interaction!.follows[followId]!.mode, "automatic");
  await h.bridge.store.mutate((state) => { state.interaction!.follows[followId]!.expiresAt = Date.now() - 1; });
  await h.bridge.checkSubscriptions();
  assert.equal(h.bridge.store.snapshot().interaction!.follows[followId]!.mode, "muted");
  const origin = Object.values(h.bridge.store.snapshot().directOrigins).at(-1)!.messageId!;
  h.runtime.emit(id, "assistant.message", { messageId: "after-expiry", originatingMessageId: origin, content: "Direct reply after expiry." });
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().outbox.find((entry) => entry.eventId === "after-expiry")?.status, "sent");
  await h.text("!subscribe");
  await h.text("third");
  const manual = h.bridge.store.snapshot().interaction!.follows[followId]!;
  assert.equal(manual.mode, "explicit");
  assert.equal(manual.expiresAt, undefined);
});

test("v3 three passive sources become one durable digest, never including a direct result", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const sources: string[] = [];
  for (let index = 0; index < 3; index++) {
    const id = await createWorking(h, `Followed ${index}`);
    sources.push(id);
    await h.text("!subscribe");
  }
  for (const [index, id] of sources.entries()) h.runtime.emit(id, "assistant.message", {
    messageId: `passive-${index}`, content: `Background result ${index}`, phase: "final",
  });
  await h.text("direct task");
  const directOrigin = Object.values(h.bridge.store.snapshot().directOrigins).at(-1)!.messageId!;
  h.runtime.emit(sources[2]!, "assistant.message", {
    messageId: "direct-result", originatingMessageId: directOrigin, content: "Separate direct result", phase: "final",
  });
  await h.bridge.flush();
  const items = h.bridge.store.snapshot().outbox;
  const digestItem = items.find((item) => item.digest)!;
  assert.ok(digestItem);
  assert.equal(digestItem.status, "sent");
  assert.equal(digestItem.digest!.memberIds.length, 3);
  assert.ok(digestItem.digest!.memberIds.every((id) => !items.find((item) => item.id === id)!.direct));
  assert.ok(digestItem.digest!.memberIds.every((id) => items.find((item) => item.id === id)!.activityId === digestItem.activityId));
  const direct = items.find((item) => item.eventId === "direct-result")!;
  assert.equal(direct.status, "sent");
  assert.equal(direct.digestId, undefined);
  assert.notEqual(direct.activityId, digestItem.activityId);
});

test("v3 each card coalesces progress independently but state transitions update immediately", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const h = await harness(t, false, undefined, { interaction: options });
  const id = await createWorking(h);
  await h.text("work");
  await h.bridge.flush();
  let state = h.bridge.store.snapshot();
  const turn = surface(state, "turn", id);
  const updates = t.mock.method(h.transport, "update", h.transport.update.bind(h.transport));
  h.runtime.emit(id, "assistant.intent", { intent: "Inspecting safe source" }, { ephemeral: true });
  await h.bridge.flush();
  assert.equal(updates.mock.calls.filter((call) => call.arguments[1] === turn.activityId).length, 0);
  now += 5000;
  await h.bridge.flush();
  state = h.bridge.store.snapshot();
  // flush has no dirty conversation after the prior flush; explicitly schedule an event at this boundary.
  h.runtime.emit(id, "assistant.intent", { intent: "Checking the next step" }, { ephemeral: true });
  await h.bridge.flush();
  assert.equal(updates.mock.calls.filter((call) => call.arguments[1] === turn.activityId).length, 1);
  h.runtime.emit(id, "abort");
  await h.bridge.flush();
  assert.equal(updates.mock.calls.filter((call) => call.arguments[1] === turn.activityId).length, 2);
});

test("v3 schema migration preserves a populated legacy journal, sent bytes, uncertainty and enabled-but-paused subscription", async (t) => {
  const directory = await temporary(t);
  const original = await Store.open(directory, "test-owner");
  const legacy = original.snapshot();
  await original.close();
  legacy.schema = 1;
  const ids = Array.from({ length: 357 }, () => randomUUID());
  legacy.conversations.legacy = {
    key: "legacy", reference: Activity.fromObject(mockEnvelope()).getConversationReference(), selectedId: ids[0]!,
    revision: 1, view: "dashboard", page: 0, notice: "Synthetic previous state", read: {},
  };
  for (const id of ids) {
    const session: SessionRecord = {
      id, name: "Synthetic legacy source", kind: "peer", peerSource: "app", status: "offline",
      workspace: "fixture", capability: "Read-only", timeline: [], pending: [], seenEvents: [], sequence: 0, updatedAt: 0,
    };
    legacy.sessions[id] = session;
  }
  for (let index = 0; index < 317; index++) {
    const id = digest(`receipt-${index}`);
    legacy.receipts[id] = { id, conversationKey: "legacy", operation: "view",
      status: index < 2 ? "uncertain" : "accepted", detail: "Synthetic historical receipt", at: 1 };
  }
  for (let index = 0; index < 54; index++) legacy.outbox.push({
    id: digest(`outbox-${index}`), conversationKey: "legacy", sessionId: ids[0]!, eventId: `final-${index}`,
    text: `Exact legacy bytes ${index}\r\n`, status: "sent", activityId: `sent-${index}`,
    ...(index % 2 ? { presentation: { version: 4 as const, kind: "session" as const, title: "Legacy",
      sourceId: ids[0]!, format: "xml" as const, groupId: digest(`group-${index}`), part: 1, parts: 1 } } : {}),
  });
  for (let index = 0; index < 12; index++) {
    const messageId = `admitted-${index}`;
    const id = digest(`${ids[0]}:${messageId}`);
    legacy.admissions[id] = {
      id, sessionId: ids[0]!, messageId, conversationKey: "legacy", receiptIds: [], baselineIndex: -1,
      acceptedAt: 1, deadlineAt: 2, checkedAt: 3, phase: "accepted", observation: "timed_out", resultIds: [],
    };
  }
  const subscriptionId = digest(`legacy:${ids[0]}`);
  legacy.subscriptions[subscriptionId] = {
    id: subscriptionId, conversationKey: "legacy", sessionId: ids[0]!, enabled: true, status: "paused", revision: 1,
    detail: "Synthetic paused cursor", cursor: { generation: "fixture", offset: 0, index: 0, anchor: digest(""),
      eofRecord: false, requests: [], starts: [], outputs: [] },
  };
  await writeFile(join(directory, "state.json"), JSON.stringify(legacy));
  const migrated = await Store.open(directory, "test-owner");
  const current = migrated.snapshot();
  assert.equal(current.schema, 2);
  assert.equal(Object.keys(current.sessions).length, 357);
  assert.equal(Object.keys(current.conversations).length, 1);
  assert.deepEqual(current.outbox, legacy.outbox);
  assert.deepEqual(current.admissions, legacy.admissions);
  assert.deepEqual(current.subscriptions, legacy.subscriptions);
  assert.equal(Object.values(current.receipts).filter((entry) => entry.status === "uncertain").length, 2);
  assert.equal(current.interaction, undefined, "migration must not invent running turns from historical admissions");
  await migrated.mutate((state) => { interactionState(state); });
  assert.equal(migrated.snapshot().interaction!.follows[subscriptionId]!.mode, "explicit");
  assert.deepEqual(migrated.snapshot().subscriptions, legacy.subscriptions);
  assert.deepEqual(migrated.snapshot().interaction!.turns, {});
  await migrated.close();
});

test("v3 an uncertain digest keeps every member uncertain through restart instead of individually reposting", async (t) => {
  const directory = await temporary(t);
  const h = await harness(t, false, directory, { interaction: options });
  for (let index = 0; index < 3; index++) {
    const id = await createWorking(h, `Uncertain source ${index}`);
    await h.text("!subscribe");
    h.runtime.emit(id, "assistant.message", { messageId: `uncertain-${index}`, content: "Passive result" });
  }
  const send = h.transport.send.bind(h.transport);
  t.mock.method(h.transport, "send", async (reference: Parameters<typeof send>[0], message: Parameters<typeof send>[1]) => {
    if (message.type === "card" && message.summary?.startsWith("Followed")) throw new Error("Synthetic uncertain connector outcome");
    return send(reference, message);
  });
  await h.bridge.flush();
  const first = h.bridge.store.snapshot();
  const digestItem = first.outbox.find((item) => item.digest)!;
  assert.equal(digestItem.status, "uncertain");
  const memberIds = digestItem.digest!.memberIds;
  assert.ok(memberIds.every((id) => first.outbox.find((item) => item.id === id)?.status === "uncertain"));
  await h.bridge.close();
  const reopened = await harness(t, false, directory, { interaction: options, inventoryOnStart: false, initializeConversation: false });
  await reopened.bridge.flush();
  const current = reopened.bridge.store.snapshot();
  assert.equal(current.outbox.find((item) => item.id === digestItem.id)?.status, "uncertain");
  assert.ok(memberIds.every((id) => current.outbox.find((item) => item.id === id)?.status === "uncertain"));
  assert.equal(reopened.runtime.received.length, 0);
  assert.equal(reopened.runtime.resumed.length, 0);
});

test("v3 reposting the Inbox freezes its predecessor and App busy metadata cannot invent a pending approval", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const appId = randomUUID();
  h.runtime.foreign.push({
    id: appId, name: "Synthetic App source", kind: "peer", peerSource: "app", status: "busy", workspace: h.directory,
    capability: "Live endpoint, original host owns approvals", access: { read: true, send: true }, liveUntil: Date.now() + 60_000,
  });
  await h.text("!sessions");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[appId]));
  await h.text("!home");
  await h.bridge.flush();
  const first = h.bridge.store.snapshot();
  const previous = surface(first, "inbox");
  const oldAction = findAction(renderInteractionSurface(first, previous, h.bridge.cards), "All sessions");
  await h.text("!home");
  await h.bridge.flush();
  const current = h.bridge.store.snapshot();
  assert.equal(Object.values(current.interaction!.surfaces).filter((entry) => entry.kind === "inbox" && !entry.frozen).length, 1);
  assert.match(JSON.stringify(h.transport.messages.get(previous.activityId!)), /Updated below/);
  assert.match(JSON.stringify(h.bridge.render(h.key)), /pending questions\/approvals are unknown/);
  assert.equal(Object.values(current.interaction!.surfaces).filter((entry) => entry.kind === "request").length, 0);
  await h.action(oldAction);
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /replaced or resolved/);
  assert.equal(h.runtime.received.length, 0);
  assert.equal(h.runtime.resumed.length, 0);
});

test("v3 timer configuration rejects invalid bounds without changing legacy dependency or authority settings", () => {
  assert.equal(interactionConfiguration({}).followMs, 86_400_000);
  for (const environment of [
    { BRIDGE_STATUS_UPDATE_SECONDS: "1" }, { BRIDGE_STATUS_UPDATE_SECONDS: "2.5" },
    { BRIDGE_FOLLOW_HOURS: "0" }, { BRIDGE_FOLLOW_HOURS: "Infinity" },
  ]) assert.throws(() => interactionConfiguration(environment), /must be an integer/);
});
