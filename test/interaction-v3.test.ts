import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Activity } from "@microsoft/agents-activity";
import type { BridgeState, InteractionSurface, SessionRecord } from "../src/domain.js";
import { interactionConfiguration } from "../src/config.js";
import { interactionDefaults, interactionState, renderInteractionSurface } from "../src/interaction.js";
import { mockEnvelope, mockIdentity } from "../src/simulator.js";
import { authorizeActivity, outboundActivity } from "../src/teams.js";
import { inputSuffix } from "../src/cards.js";
import { Store } from "../src/store.js";
import { digest, object, UncertainOperationError } from "../src/safety.js";
import { createWorking, eventually, findAction, harness, temporary, type Harness } from "./helpers.js";

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
  const approval = findAction(renderInteractionSurface(before, request, h.bridge.cards), "Allow once");
  await h.text("!home");
  const b = await createWorking(h, "Other source");
  await h.text("ask");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[b]?.pending.length));
  const otherState = h.bridge.store.snapshot();
  const otherRequest = surface(otherState, "request", b);
  const otherAnswer = findAction(renderInteractionSurface(otherState, otherRequest, h.bridge.cards), "Answer");
  await h.text("!sessions");
  await h.action(approval);
  await h.bridge.flush();
  assert.equal(h.runtime.answers.length, 1);
  assert.equal(h.runtime.answers[0]!.id, a);
  assert.equal(h.runtime.answers[0]!.requestId, request.requestId);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
  await h.action(approval);
  assert.equal(h.runtime.answers.length, 1);
  assert.equal(h.bridge.store.snapshot().interaction!.surfaces[otherRequest.id]!.revision, otherRequest.revision);
  await h.action(otherAnswer, { [`choice_${inputSuffix(otherRequest.requestId!)}`]: "0" });
  assert.equal(h.runtime.answers.length, 2);
  assert.equal(h.runtime.answers[1]!.requestId, otherRequest.requestId);
});

test("UI-H1: the current session header clears completed approval controls while Inbox remains selected, using the same message", async (t) => {
  const h = await harness(t, true, undefined, { interaction: options });
  const a = await createWorking(h, "A");
  await h.text("ordinary work");
  await eventually(() => h.bridge.store.snapshot().sessions[a]?.status === "idle");
  await h.bridge.flush();
  const b = await createWorking(h, "B");
  await h.text("permission");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[b]?.pending.length));
  await h.bridge.flush();
  const before = h.bridge.store.snapshot();
  const header = surface(before, "header", b);
  assert.ok(header.activityId);
  assert.match(JSON.stringify(h.transport.messages.get(header.activityId)), /Needs reply/);
  const request = surface(before, "request", b);
  const approval = findAction(renderInteractionSurface(before, request, h.bridge.cards), "Allow once");
  const currentInbox = surface(before, "inbox");
  await h.action(findAction(renderInteractionSurface(before, currentInbox, h.bridge.cards), "Refresh"));
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.view, "home");
  await h.action(approval);
  await eventually(() => h.bridge.store.snapshot().sessions[b]?.status === "idle");
  await h.bridge.flush();
  const after = h.bridge.store.snapshot();
  assert.equal(surface(after, "header", b).activityId, header.activityId);
  const visible = h.transport.messages.get(header.activityId)!;
  assert.equal(visible.message.type, "card");
  assert.doesNotMatch(JSON.stringify(visible), /Needs reply|"title":"Review approval"/);
  assert.throws(() => findAction(visible, "Allow once"), /not found/);
  assert.equal(after.conversations[h.key]!.view, "home");
  assert.equal(Object.values(after.interaction!.surfaces).filter((entry) => entry.kind === "header" && !entry.frozen).length, 1);
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
  assert.equal(current.schema, 4);
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
  assert.throws(() => interactionConfiguration({ BRIDGE_THREADS: "on" }), /auto or off/);
  assert.throws(() => interactionConfiguration({ BRIDGE_REACTIONS: "yes" }), /auto or off/);
});

function threadEnvelope(text: string, id: string, rootId: string, conversationId?: string): Record<string, unknown> {
  const body = mockEnvelope(text);
  assert.ok(object(body.conversation) && object(body.channelData));
  return {
    ...body, id, conversation: { ...body.conversation, ...(conversationId ? { id: conversationId } : {}) },
    channelData: { ...body.channelData, chat: { id: "19:synthetic-containing-chat" }, replyChain: { id: rootId } },
  };
}

async function incoming(h: Harness, body: Record<string, unknown>) {
  const turn = authorizeActivity(body, { aud: mockIdentity.appId }, mockIdentity);
  return h.bridge.handle(turn.key, turn.reference, turn.activity.id!, turn.incoming);
}

test("v3 Focus fallback retains unbound thread text until explicit routing and deduplicates opaque aliases without parsing them", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const id = await createWorking(h, "Explicit thread target");
  await incoming(h, threadEnvelope("!home", "root-a", "root-a"));
  const prompt = "  literal prompt\r\n  preserve whitespace and \u{1f680}  ";
  await incoming(h, threadEnvelope(prompt, "original-thread-prompt", "root-a", "a:opaque;messageid=not-the-real-root"));
  let state = h.bridge.store.snapshot();
  assert.equal(Object.keys(state.conversations).length, 1);
  assert.equal(h.runtime.received.length, 0);
  const intent = Object.values(state.interaction!.routes!)[0]!;
  assert.equal(intent.prompt, prompt);
  await incoming(h, threadEnvelope("different redelivery text", "original-thread-prompt", "root-a", "a:another-opaque-id"));
  assert.equal(Object.values(h.bridge.store.snapshot().interaction!.routes!).length, 1);
  const picker = renderInteractionSurface(state, surface(state, "routing"), h.bridge.cards);
  const send = findAction(picker, "Send once");
  await h.action(send, { source: id });
  await h.bridge.flush();
  state = h.bridge.store.snapshot();
  assert.deepEqual(h.runtime.received, [{ sessionId: id, text: prompt }]);
  assert.equal(state.interaction!.routes![intent.id]!.state, "sent");
  assert.equal(state.interaction!.turns[intent.receiptId]!.teamsActivityId, "original-thread-prompt");
  const next = await createWorking(h, "New focus after admission");
  await h.action(send, { source: next });
  assert.equal(h.runtime.received.length, 1);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, next);
});

test("v3 a read-only routing choice never falls back to the old focus and can only be retried through fresh explicit selection", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const writable = await createWorking(h);
  const readOnly = randomUUID();
  await h.bridge.store.mutate((state) => {
    state.sessions[readOnly] = {
      ...state.sessions[writable]!, id: readOnly, name: "Read-only fixture", kind: "peer", peerSource: "app",
      access: { read: true, send: false }, status: "offline",
    };
  });
  await incoming(h, threadEnvelope("!home", "root", "root"));
  await incoming(h, threadEnvelope("retained draft", "reply", "root"));
  let state = h.bridge.store.snapshot();
  const routeSurface = surface(state, "routing");
  const picker = renderInteractionSurface(state, routeSurface, h.bridge.cards);
  await h.action(findAction(picker, "Send once"), { source: readOnly });
  assert.equal(h.runtime.received.length, 0);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectionBlocked, true);
  await h.text("not allowed to leak to the prior focus");
  assert.equal(h.runtime.received.length, 0);
  await h.action(findAction(picker, "Refresh choices"));
  state = h.bridge.store.snapshot();
  const fresh = renderInteractionSurface(state, surface(state, "routing"), h.bridge.cards);
  await h.action(findAction(fresh, "Send once"), { source: writable });
  assert.deepEqual(h.runtime.received, [{ sessionId: writable, text: "retained draft" }]);
});

test("v3 routing uncertainty and pending drafts survive restart without native replay or automatic target selection", async (t) => {
  const directory = await temporary(t);
  const h = await harness(t, false, directory, { interaction: options });
  const id = await createWorking(h);
  await incoming(h, threadEnvelope("!home", "root", "root"));
  await incoming(h, threadEnvelope("draft that may be accepted", "reply", "root"));
  const before = h.bridge.store.snapshot();
  const action = findAction(renderInteractionSurface(before, surface(before, "routing"), h.bridge.cards), "Send once");
  const send = h.runtime.send.bind(h.runtime);
  t.mock.method(h.runtime, "send", async (target: string, text: string) => {
    await send(target, text);
    throw new UncertainOperationError("Synthetic lost native ACK.");
  });
  await h.action(action, { source: id });
  assert.equal(h.runtime.received.length, 1);
  const uncertain = Object.values(h.bridge.store.snapshot().interaction!.routes!)[0]!;
  assert.equal(uncertain.state, "uncertain");
  await incoming(h, threadEnvelope("still an unsent draft", "pending-reply", "root"));
  await h.bridge.close();
  const reopened = await harness(t, false, directory, { interaction: options, inventoryOnStart: false, initializeConversation: false });
  await reopened.action(action, { source: id });
  await reopened.bridge.flush();
  assert.equal(reopened.runtime.received.length, 0);
  assert.equal(reopened.runtime.resumed.length, 0);
  const current = reopened.bridge.store.snapshot();
  const rendered = renderInteractionSurface(current, current.interaction!.surfaces[uncertain.surfaceId]!, reopened.bridge.cards);
  assert.match(JSON.stringify(rendered), /May have been accepted/);
  assert.throws(() => findAction(rendered, "Send once"), /not found/);
  const pending = Object.values(current.interaction!.routes!).filter((route) => route.state === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.prompt, "still an unsent draft");
});

test("v3 routing creates and sends only after an explicit allowed-workspace action and never repeats a consumed creation", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  await incoming(h, threadEnvelope("!home", "root", "root"));
  await incoming(h, threadEnvelope("new task unchanged", "reply", "root"));
  let state = h.bridge.store.snapshot();
  const first = renderInteractionSurface(state, surface(state, "routing"), h.bridge.cards);
  await h.action(findAction(first, "Create and send once"), { sessionName: "New source", workspace: "not-allowed" });
  assert.equal(h.runtime.live.size, 0);
  await h.action(findAction(first, "Refresh choices"));
  state = h.bridge.store.snapshot();
  const create = findAction(renderInteractionSurface(state, surface(state, "routing"), h.bridge.cards), "Create and send once");
  await h.action(create, { sessionName: "New source", workspace: "local" });
  assert.equal(h.runtime.live.size, 1);
  assert.equal(h.runtime.received[0]!.text, "new task unchanged");
  await h.action(create, { sessionName: "A duplicate must not create this", workspace: "local" });
  assert.equal(h.runtime.live.size, 1);
  assert.equal(h.runtime.received.length, 1);
});

test("v3 containing-chat metadata never relaxes owner/personal checks or merges conflicting stable chat identities", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  await incoming(h, threadEnvelope("!home", "root", "root"));
  const before = h.bridge.store.snapshot();
  const group = threadEnvelope("blocked", "group-reply", "root");
  assert.ok(object(group.conversation));
  group.conversation.conversationType = "groupChat";
  assert.throws(() => authorizeActivity(group, { aud: mockIdentity.appId }, mockIdentity), /one-to-one/);
  const malformed = threadEnvelope("blocked", "malformed-reply", "root");
  assert.ok(object(malformed.channelData));
  malformed.channelData.chat = { id: false };
  assert.throws(() => authorizeActivity(malformed, { aud: mockIdentity.appId }, mockIdentity), /Malformed containing-chat/);
  const conflict = threadEnvelope("blocked", "conflict", "conflict");
  assert.ok(object(conflict.channelData));
  conflict.channelData.chat = { id: "19:conflicting-chat" };
  await assert.rejects(() => incoming(h, conflict), /identity changed/);
  assert.deepEqual(h.bridge.store.snapshot().interaction!.aliases, before.interaction!.aliases);
  assert.equal(h.runtime.received.length, 0);
});

test("F1: an expiry snapshot cannot mute a concurrently renewed automatic Follow or cancel its pending publication", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options, deliveryInitiallyPaused: true });
  const id = await createWorking(h);
  await h.text("start following");
  h.runtime.emit(id, "assistant.message", { messageId: "pending-passive", originatingMessageId: "external-origin", content: "Still eligible" });
  await h.text("!status");
  const followId = digest(`${h.key}:${id}`);
  await h.bridge.store.mutate((state) => { state.interaction!.follows[followId]!.expiresAt = Date.now() - 1; });
  const revision = h.bridge.store.snapshot().interaction!.follows[followId]!.revision;
  const previousQueue: unknown = Reflect.get(h.bridge.store, "queue");
  const renew: unknown = Reflect.get(h.bridge, "changeFollow");
  const expire: unknown = Reflect.get(h.bridge, "expireFollows");
  assert.ok(previousQueue instanceof Promise && typeof renew === "function" && typeof expire === "function");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  Reflect.set(h.bridge.store, "queue", previousQueue.then(() => held));
  try {
    const renewing: unknown = Reflect.apply(renew, h.bridge, [h.key, id, "automatic"]);
    const expiring: unknown = Reflect.apply(expire, h.bridge, []);
    assert.ok(renewing instanceof Promise && expiring instanceof Promise);
    release();
    await Promise.all([renewing, expiring]);
  } finally { release(); }
  const current = h.bridge.store.snapshot();
  const preference = current.interaction!.follows[followId]!;
  assert.equal(preference.mode, "automatic");
  assert.equal(preference.revision, revision);
  assert.ok(preference.expiresAt! > Date.now());
  assert.equal(current.outbox.find((item) => item.eventId === "pending-passive")!.status, "pending");
});

test("F2: a real cross-focus History read failure is delivered visibly for A while B remains selected", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const a = await createWorking(h, "A history source");
  await h.text("work A");
  const first = h.bridge.store.snapshot();
  const read = findAction(renderInteractionSurface(first, surface(first, "turn", a), h.bridge.cards), "History");
  const b = await createWorking(h, "B remains selected");
  const history = h.runtime.history.bind(h.runtime);
  let reads = 0;
  t.mock.method(h.runtime, "history", async (id: string) => {
    if (id === a) { reads++; throw new Error("Synthetic read failure after actual source dispatch"); }
    return history(id);
  });
  await h.action(read);
  await h.bridge.flush();
  const state = h.bridge.store.snapshot();
  assert.equal(reads, 1);
  assert.equal(state.conversations[h.key]!.selectedId, b);
  assert.equal(state.conversations[h.key]!.historyRead?.status, "failed");
  const errors = state.outbox.filter((item) => item.eventId.startsWith("operation-error:") && item.text.includes(`History for ${a}`));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.sessionId, a);
  assert.equal(errors[0]!.status, "sent");
  assert.equal(h.runtime.received.length, 1);
  assert.equal(h.bridge.healthy, true);
});

async function seedPassiveSources(h: Harness, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await h.bridge.store.mutate((state) => {
    for (const id of ids) {
      state.sessions[id] = {
        id, name: "Shared display title", kind: "owned", status: "idle", workspace: h.directory,
        capability: "Synthetic live owned source", timeline: [], pending: [], seenEvents: [], sequence: 0, updatedAt: 1,
      };
      const followId = digest(`${h.key}:${id}`);
      state.interaction!.follows[followId] = {
        id: followId, conversationKey: h.key, sessionId: id, revision: 1, mode: "explicit",
        observation: "live", detail: "Synthetic already-established live following",
      };
    }
  });
  return ids;
}

for (const style of ["submit", "execute"] as const) {
  test(`F3: 64 passive publications from four canonical sources fit one signed ${style} digest without consuming oversized notifications`, async (t) => {
    const h = await harness(t, false, undefined, { interaction: options, deliveryInitiallyPaused: true, cardActions: style });
    const ids = await seedPassiveSources(h, 4);
    for (const id of ids) for (let index = 0; index < 16; index++) {
      h.runtime.emit(id, "assistant.message", { messageId: `result-${index}`, content: `Short passive result ${index}`, phase: "final" });
    }
    await h.text("!home");
    const send = h.transport.send.bind(h.transport);
    const sizes: number[] = [];
    t.mock.method(h.transport, "send", async (reference: Parameters<typeof send>[0], message: Parameters<typeof send>[1]) => {
      if (message.type === "card" && message.summary?.startsWith("Followed")) {
        const bytes = Buffer.byteLength(JSON.stringify(outboundActivity(message)));
        sizes.push(bytes);
        if (bytes > 27_000) throw new Error("Synthetic transport rejects oversized digest");
      }
      return send(reference, message);
    });
    h.bridge.enableDelivery();
    await h.bridge.flush();
    const state = h.bridge.store.snapshot();
    const groups = state.outbox.filter((item) => item.digest);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.status, "sent");
    assert.equal(groups[0]!.digest!.memberIds.length, 64);
    assert.equal(sizes.length, 1);
    assert.ok(sizes[0]! <= 27_000);
    const publication = h.transport.messages.get(groups[0]!.activityId!)!;
    assert.match(JSON.stringify(publication), /4 followed sessions have 64 new replies/);
    assert.equal(state.outbox.filter((item) => item.publication && item.status === "sent").length, 64);
    assert.equal(state.outbox.filter((item) => item.status === "uncertain").length, 0);
    const digestSurface = state.interaction!.surfaces[groups[0]!.digest!.surfaceId]!;
    const firstPage = renderInteractionSurface(state, digestSurface, h.bridge.cards);
    const selected = state.conversations[h.key]!.selectedId;
    await h.action(findAction(firstPage, "More sources"));
    await h.bridge.flush();
    assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, selected);
    assert.equal(h.bridge.store.snapshot().outbox.filter((item) => item.digest).length, 1);
    assert.equal(h.runtime.received.length, 0);
  });
}

test("F3: more than 64 distinct sources use bounded digest pages and the two-source remainder is delivered once after its window", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const h = await harness(t, false, undefined, { interaction: options, deliveryInitiallyPaused: true });
  const ids = await seedPassiveSources(h, 66);
  for (const id of ids) h.runtime.emit(id, "assistant.message", { messageId: "same-message-id", content: "One source-specific result" });
  await h.text("!home");
  h.bridge.enableDelivery();
  await h.bridge.flush();
  let state = h.bridge.store.snapshot();
  assert.equal(state.outbox.filter((item) => item.publication && item.status === "sent").length, 64);
  assert.equal(state.outbox.filter((item) => item.publication && item.status === "pending").length, 2);
  for (const message of h.transport.messages.values()) if (message.message.type === "card") {
    assert.ok(Buffer.byteLength(JSON.stringify(outboundActivity(message.message))) <= 27_000);
  }
  now += 60_001;
  await h.text("!home");
  await h.bridge.flush();
  state = h.bridge.store.snapshot();
  assert.equal(state.outbox.filter((item) => item.publication && item.status === "sent").length, 66);
  assert.equal(state.outbox.filter((item) => item.status === "uncertain").length, 0);
  assert.equal(h.runtime.received.length, 0);
});

test("F3: the final signed payload budget is checked before members are claimed, retaining individual delivery after a local rejection", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const h = await harness(t, false, undefined, { interaction: options, deliveryInitiallyPaused: true });
  const ids = await seedPassiveSources(h, 3);
  for (const id of ids) h.runtime.emit(id, "assistant.message", { messageId: "budget-result", content: "Retained body" });
  await h.text("!home");
  const action = h.bridge.cards.scopedAction.bind(h.bridge.cards);
  t.mock.method(h.bridge.cards, "scopedAction", (...args: Parameters<typeof action>) => {
    const value = action(...args);
    return args[1].startsWith("Open ") ? { ...value, tooltip: "x".repeat(28_000) } : value;
  });
  const send = h.transport.send.bind(h.transport);
  let digestCalls = 0;
  t.mock.method(h.transport, "send", async (reference: Parameters<typeof send>[0], message: Parameters<typeof send>[1]) => {
    if (message.type === "card" && message.summary?.startsWith("Followed")) digestCalls++;
    return send(reference, message);
  });
  h.bridge.enableDelivery();
  await h.bridge.flush();
  let state = h.bridge.store.snapshot();
  assert.equal(digestCalls, 0);
  assert.equal(state.outbox.find((item) => item.digest)?.status, "rejected");
  assert.equal(state.outbox.filter((item) => item.publication && item.status === "pending" && !item.digestId).length, 3);
  now += 60_001;
  await h.text("!home");
  await h.bridge.flush();
  state = h.bridge.store.snapshot();
  assert.equal(state.outbox.filter((item) => item.publication && item.status === "sent").length, 3);
  assert.equal(state.outbox.filter((item) => item.status === "uncertain").length, 0);
});

test("v3 Stop requires a distinct owner confirmation, preserves the current focus and never repeats a consumed stop", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const a = await createWorking(h, "Stop A only");
  await h.text("work A");
  await h.text("!stop");
  assert.equal(h.runtime.stopped.length, 0);
  let state = h.bridge.store.snapshot();
  await h.action(findAction(renderInteractionSurface(state, surface(state, "stop", a), h.bridge.cards), "Cancel"));
  assert.equal(h.runtime.stopped.length, 0);
  await h.text("!stop");
  state = h.bridge.store.snapshot();
  const confirm = findAction(renderInteractionSurface(state, surface(state, "stop", a), h.bridge.cards), "Confirm Stop");
  const b = await createWorking(h, "Keep B selected");
  await h.action(confirm);
  assert.deepEqual(h.runtime.stopped, [a]);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
  await h.action(confirm);
  assert.deepEqual(h.runtime.stopped, [a]);
});

test("v3 an old Stop confirmation cannot abort a different observed request and App sources never expose remote Stop", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const id = await createWorking(h);
  await h.text("first request");
  await h.text("!stop");
  const state = h.bridge.store.snapshot();
  const old = findAction(renderInteractionSurface(state, surface(state, "stop", id), h.bridge.cards), "Confirm Stop");
  h.runtime.emit(id, "abort");
  h.runtime.emit(id, "session.idle");
  await h.text("next request");
  await h.action(old);
  assert.equal(h.runtime.stopped.length, 0);
  await h.bridge.store.mutate((draft) => {
    draft.sessions[id]!.kind = "peer";
    draft.sessions[id]!.peerSource = "app";
  });
  await h.text("!stop");
  assert.equal(h.runtime.stopped.length, 0);
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /original host/);
});

test("v3 Steer sends immediate unchanged text to the original owned source without redirecting its result or the next focus", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const a = await createWorking(h, "Steered source");
  await h.text("original task", "original-steering-context");
  let state = h.bridge.store.snapshot();
  const turn = Object.values(state.interaction!.turns)[0]!;
  const b = await createWorking(h, "Current other focus");
  state = h.bridge.store.snapshot();
  const steering = findAction(renderInteractionSurface(state, surface(state, "turn", a), h.bridge.cards), "Send steering");
  const text = "  steer this exact text\r\nwithout changing it  ";
  await h.action(steering, { steering: text });
  assert.deepEqual(h.runtime.received.at(-1), { sessionId: a, text });
  assert.equal(h.runtime.sendModes.at(-1)!.mode, "immediate");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
  assert.equal(Object.values(h.bridge.store.snapshot().interaction!.turns).length, 1, "steering is not claimed to be a new completed turn");
  const receipt = Object.values(h.bridge.store.snapshot().interaction!.steers!)[0]!;
  assert.equal(receipt.state, "accepted");
  h.runtime.emit(a, "assistant.message", { messageId: "steered-result", originatingMessageId: turn.messageId, content: "Original task result" });
  await h.bridge.flush();
  const result = h.bridge.store.snapshot().outbox.find((item) => item.eventId === "steered-result")!;
  assert.equal(result.direct, true);
  assert.equal(result.originReference?.activityId, "original-steering-context");
  await h.action(steering, { steering: "a changed duplicate cannot run" });
  assert.equal(h.runtime.received.length, 2);
});

test("v3 permission details are redacted, session approval is explicit, and off offers no permission or plan Allow controls", async (t) => {
  const on = await harness(t, true, undefined, { interaction: options });
  const id = await createWorking(on);
  await on.text("permission");
  await eventually(() => Boolean(on.bridge.store.snapshot().sessions[id]?.pending.length));
  const state = on.bridge.store.snapshot();
  const request = surface(state, "request", id);
  const card = renderInteractionSurface(state, request, on.bridge.cards);
  assert.match(JSON.stringify(card), /Sensitive values are masked/);
  assert.doesNotMatch(JSON.stringify(card), /hidden-fixture/);
  await on.action(findAction(card, "Allow for this session"));
  assert.equal(on.runtime.answers[0]!.answer.permission, "session");
  assert.equal(on.bridge.store.snapshot().interaction!.surfaces[request.id]!.frozen, "Allowed for this session by you.");
  const off = await harness(t, true, undefined, { interaction: { ...options, remoteApprovals: false } });
  const offId = await createWorking(off);
  await off.text("permission");
  await eventually(() => off.bridge.store.snapshot().sessions[offId]?.status === "idle");
  const rendered = JSON.stringify(off.bridge.render(off.key));
  assert.doesNotMatch(rendered, /"title":"(?:Allow once|Allow for this session|Approve once|Approve plan)"/);
  assert.equal(off.runtime.answers.length, 0);
});

test("v3 unrenderable approval details cannot be allowed, while forms remain visibly unavailable rather than answered by text", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const id = await createWorking(h);
  await h.text("request");
  const requestId = randomUUID();
  h.runtime.emit(id, "permission.requested", { requestId,
    permissionRequest: { kind: "shell", intention: "Oversized command", fullCommandText: "x".repeat(33_000), canOfferSessionApproval: true } });
  await h.bridge.flush();
  let state = h.bridge.store.snapshot();
  const request = renderInteractionSurface(state, surface(state, "request", id), h.bridge.cards);
  assert.throws(() => findAction(request, "Allow once"), /not found/);
  assert.throws(() => findAction(request, "Allow for this session"), /not found/);
  assert.ok(findAction(request, "Deny"));
  h.runtime.emit(id, "permission.completed", { requestId, result: { kind: "denied-interactively-by-user" } });
  const formId = randomUUID();
  h.runtime.emit(id, "elicitation.requested", { requestId: formId, message: "Structured input", mode: "form",
    requestedSchema: { type: "object", properties: { value: { type: "string" } } } }, { ephemeral: true });
  await h.bridge.flush();
  state = h.bridge.store.snapshot();
  const form = Object.values(state.interaction!.surfaces).find((entry) => entry.requestId === formId)!;
  const output = renderInteractionSurface(state, form, h.bridge.cards);
  assert.match(JSON.stringify(output), /Structured form responses are unavailable/);
  assert.throws(() => findAction(output, "Answer"), /not found/);
  assert.equal(h.runtime.answers.length, 0);
});

test("v3 permission expiry does not invent an owner response and invalid approval configuration fails closed", async (t) => {
  const h = await harness(t, true, undefined, { interaction: { ...options, approvalTimeoutMs: 40 } });
  const id = await createWorking(h);
  await h.text("permission");
  await eventually(() => Object.values(h.bridge.store.snapshot().interaction!.surfaces).some((entry) =>
    entry.kind === "request" && entry.sessionId === id && Boolean(entry.frozen?.startsWith("Timed out"))));
  assert.equal(h.runtime.answers.length, 0);
  assert.throws(() => interactionConfiguration({ BRIDGE_REMOTE_APPROVALS: "yes" }), /on or off/);
  assert.throws(() => interactionConfiguration({ BRIDGE_APPROVAL_TIMEOUT_MINUTES: "0" }), /positive integer/);
});

test("v3 a locally submitted question answer remains pending native confirmation without offering a second response", async (t) => {
  const h = await harness(t, true, undefined, { interaction: options });
  const id = await createWorking(h);
  await h.text("ask");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[id]?.pending.length));
  const before = h.bridge.store.snapshot();
  const request = surface(before, "request", id);
  const answer = findAction(renderInteractionSurface(before, request, h.bridge.cards), "Answer");
  const submit = t.mock.method(h.runtime, "answer", async () => undefined);
  await h.action(answer, { [`choice_${inputSuffix(request.requestId!)}`]: "0" });
  let state = h.bridge.store.snapshot();
  assert.equal(state.sessions[id]!.pending[0]!.responseState, "submitted");
  const pending = renderInteractionSurface(state, state.interaction!.surfaces[request.id]!, h.bridge.cards);
  assert.match(JSON.stringify(pending), /Awaiting native confirmation/);
  assert.throws(() => findAction(pending, "Answer"), /not found/);
  await h.action(answer, { [`choice_${inputSuffix(request.requestId!)}`]: "1" });
  assert.equal(submit.mock.callCount(), 1);
  h.runtime.emit(id, "user_input.completed", { requestId: request.requestId, answer: "Proceed", wasFreeform: false });
  await h.bridge.flush();
  state = h.bridge.store.snapshot();
  assert.equal(state.sessions[id]!.pending.length, 0);
  assert.ok(state.interaction!.surfaces[request.id]!.frozen);
});
