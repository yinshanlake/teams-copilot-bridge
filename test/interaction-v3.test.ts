import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Activity } from "@microsoft/agents-activity";
import type { BridgeState, Card, InteractionSurface, SessionRecord } from "../src/domain.js";
import { interactionConfiguration } from "../src/config.js";
import { acknowledgementDelayMs, interactionDefaults, interactionState, renderInteractionSurface } from "../src/interaction.js";
import { mockEnvelope, mockIdentity } from "../src/simulator.js";
import { authorizeActivity, outboundActivity } from "../src/teams.js";
import { inputSuffix } from "../src/cards.js";
import { Store } from "../src/store.js";
import { DeliveryError, digest, object, UncertainOperationError } from "../src/safety.js";
import { createWorking, eventually, findAction, harness, temporary, type Harness } from "./helpers.js";

const options = { ...interactionDefaults, statusUpdateMs: 5000, digestMs: 60_000 };

function surface(state: BridgeState, kind: InteractionSurface["kind"], sessionId?: string): InteractionSurface {
  const found = Object.values(state.interaction?.surfaces ?? {}).findLast((entry) =>
    entry.kind === kind && !entry.frozen && (sessionId === undefined || entry.sessionId === sessionId));
  assert.ok(found, `Missing ${kind} surface`);
  return found;
}

function delivered(h: Harness, id: string | undefined): Card {
  assert.ok(id);
  const message = h.transport.messages.get(id)?.message;
  assert.ok(message?.type === "card");
  return message.card;
}

function firstLayer(value: unknown): string {
  if (Array.isArray(value)) return value.map(firstLayer).join("\n");
  if (!object(value) || value.type === "Action.ShowCard" || value.isVisible === false) return "";
  return [typeof value.text === "string" ? value.text : "",
    ...Object.entries(value).filter(([key]) => !["data", "fallback"].includes(key)).map(([, item]) => firstLayer(item))].join("\n");
}

async function openActions(h: Harness, id?: string, query = ""): Promise<Card> {
  const state = h.bridge.store.snapshot();
  const origin = id
    ? Object.values(state.interaction!.surfaces).findLast((item) =>
      item.sessionId === id && !item.frozen && (item.kind === "header" || item.kind === "turn" || item.kind === "result"))
    : surface(state, "inbox");
  assert.ok(origin);
  await h.action(findAction(renderInteractionSurface(state, origin, h.bridge.cards), "All actions"));
  await h.bridge.flush();
  const panel = surface(h.bridge.store.snapshot(), "actions", id);
  if (query) {
    await h.action(findAction(delivered(h, panel.activityId), "Search actions"), { actionQuery: query });
    await h.bridge.flush();
  }
  return delivered(h, panel.activityId);
}

for (const style of ["submit", "execute"] as const) test(`compact Open: one fresh ${style} card, no implicit history, exact same-source and cross-view selection`, async (t) => {
  const h = await harness(t, false, undefined, { interaction: options, cardActions: style });
  const a = await createWorking(h, "Harbor audit");
  await h.text("fixture task");
  h.runtime.emit(a, "assistant.message", { messageId: "harbor-result", content: "Published fixture reply.", phase: "final" });
  h.runtime.emit(a, "session.task_complete", { success: true });
  h.runtime.emit(a, "session.idle");
  await h.bridge.flush();
  const b = await createWorking(h, "Other source");
  const rich = "\r\n| Name | Details |\r\n| -- | -- |\r\n| [Check](https://example.test/a) | `code` |\r\n".repeat(90);
  await h.bridge.store.mutate((state) => {
    state.sessions[a]!.timeline = [
      { id: "old", kind: "assistant", phase: "final", text: `OLD-MESSAGE${rich}` },
      { id: "q", kind: "user", text: `# Latest question, password=only-a-fixture ${"long ".repeat(100)}${rich}` },
      { id: "a", kind: "assistant", phase: "final", text: `**Latest answer** ${"more ".repeat(100)}${rich}` },
      { id: "hidden", kind: "assistant", phase: "commentary", text: "NOT-FOR-PREVIEW" },
      { id: "tool", kind: "tool", text: "NOT-FOR-PREVIEW" },
    ];
    for (const [index, entry] of state.sessions[a]!.timeline.entries()) entry.timestamp = new Date(Date.now() + index + 1).toISOString();
  });
  await h.text("!sessions"); await h.bridge.flush();
  const snap = () => h.bridge.store.snapshot();
  const result = surface(snap(), "result", a);
  const messages = h.runtime.received.slice();
  const follows = snap().interaction!.follows;
  const originalOutbox = snap().outbox;
  const full = t.mock.method(h.runtime, "history");
  const preview = t.mock.method(h.runtime, "preview");
  const picker = surface(snap(), "picker");
  const row = () => delivered(h, picker.activityId).body.find((entry) => entry.type === "ColumnSet" && firstLayer(entry).includes("Harbor audit"))!;
  const checkOpen = async (click: () => Promise<unknown>) => {
    await h.bridge.flush();
    const previous = surface(snap(), "header");
    const previousCount = h.transport.messages.size;
    const peekCount = preview.mock.callCount();
    await click(); await h.bridge.flush();
    const state = snap();
    const header = surface(state, "header", a);
    assert.equal(state.conversations[h.key]!.selectedId, a);
    assert.equal(h.transport.messages.size, previousCount + 1);
    assert.equal([...h.transport.messages.keys()].at(-1), header.activityId);
    assert.notEqual(header.id, previous.id);
    assert.ok(state.interaction!.surfaces[previous.id]!.frozen);
    assert.equal(state.conversations[h.key]!.historyRead, undefined);
    assert.deepEqual(state.outbox, originalOutbox);
    assert.deepEqual(state.interaction!.follows, follows);
    assert.deepEqual(h.runtime.received, messages);
    assert.equal(full.mock.callCount(), 0);
    assert.equal(preview.mock.callCount(), peekCount, "Open uses only known dialogue");
    const card = delivered(h, header.activityId);
    assert.ok(card.body.some((block) => block.text === "● Ready" && block.color === "Good"));
    for (const [label, limit] of [["You", 120], ["Copilot", 180]] as const) {
      const offset = card.body.findIndex((entry) => entry.text === label);
      assert.notEqual(offset, -1);
      const excerpt = card.body[offset + 1]!;
      assert.equal(excerpt.type, "TextBlock"); assert.equal(excerpt.maxLines, 2);
      assert.ok(typeof excerpt.text === "string" && [...excerpt.text].length <= limit);
    }
    const text = firstLayer(card);
    assert.match(text, /Latest question.*\[REDACTED\\?\]/s);
    assert.match(text, /Latest answer/);
    assert.doesNotMatch(text, /OLD-MESSAGE|NOT-FOR-PREVIEW|only-a-fixture|https:|HISTORY snapshot/);
    for (const title of ["Unsubscribe", "Recent conversation", "Change next target", "All actions"]) assert.ok(findAction(card, title));
    assert.ok(Buffer.byteLength(JSON.stringify(outboundActivity({ type: "card", card }))) <= 27_000);
    return header;
  };
  const first = findAction(row(), "Open");
  const staleRow = row().selectAction;
  assert.ok(object(staleRow));
  const activity = randomUUID();
  const header = await checkOpen(() => h.action(first, {}, activity));
  assert.equal(snap().receipts[digest(`${h.key}:${activity}`)]?.sessionId, a);
  const n = h.transport.messages.size;
  await h.action(first, {}, activity); await h.action(first); await h.bridge.flush();
  assert.equal(surface(snap(), "header", a).id, header.id);
  assert.equal(h.transport.messages.size, n, "both ingress and signed-nonce redelivery are once-only");
  const gesture = row().selectAction;
  assert.ok(object(gesture));
  await checkOpen(() => h.action(gesture));
  await checkOpen(() => h.action(findAction(delivered(h, result.activityId), "Open")));
  const panel = await openActions(h, a, "Open session");
  await checkOpen(() => h.action(findAction(panel, "Open session")));
  await checkOpen(() => h.text("!use Harbor audit"));
  const inbox = surface(snap(), "inbox");
  await checkOpen(() => h.action(findAction(delivered(h, inbox.activityId), "Open")));
  await h.text(`!use ${b}`); await h.bridge.flush();
  await h.action(staleRow); await h.bridge.flush();
  assert.equal(snap().conversations[h.key]!.selectedId, b, "a retained old row cannot select A again");
  assert.equal(snap().conversations[h.key]!.selectionBlocked, false);
  assert.deepEqual(h.runtime.received, messages);
});

test("compact Recent conversation stays on its signed source; full history is explicit, exact and survives a re-open", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const a = await createWorking(h, "Source A");
  const latest = "A latest answer\n\n```ts\n" + "const value = ['a', 'b'];\r\n".repeat(400) + "```\r\nA-END";
  await h.text("A latest question");
  h.runtime.emit(a, "assistant.message", { messageId: "answer-a", content: latest, phase: "final" });
  h.runtime.emit(a, "session.task_complete", { success: true });
  h.runtime.emit(a, "session.idle"); await h.bridge.flush();
  const turn = surface(h.bridge.store.snapshot(), "turn", a);
  const historyButton = findAction(renderInteractionSurface(h.bridge.store.snapshot(), turn, h.bridge.cards), "History");
  const b = await createWorking(h, "Keep B");
  const count = h.runtime.received.length;
  const read = t.mock.method(h.runtime, "history");
  const previews = t.mock.method(h.runtime, "preview");
  await h.action(historyButton); await h.bridge.flush();
  const first = h.bridge.store.snapshot();
  const panel = surface(first, "actions", a);
  const recent = delivered(h, panel.activityId);
  assert.equal(recent.body[0]?.text, "Recent conversation");
  assert.equal(recent.body[1]?.text, "Source A");
  assert.equal(first.conversations[h.key]!.selectedId, b);
  assert.deepEqual(previews.mock.calls.map((call) => call.arguments[0]), [a]);
  assert.equal(read.mock.callCount(), 0);
  assert.ok(recent.body.filter((block) => block.text === "You" || block.text === "Copilot").length <= 2);
  assert.match(firstLayer(recent), /You[\s\S]*A latest question[\s\S]*Copilot[\s\S]*A latest answer/);
  assert.doesNotMatch(firstLayer(recent), /A-END|```|Keep B|fixture tool/);
  assert.ok(recent.body.every((entry) => String(entry.text).length <= 260));
  assert.equal(first.outbox.filter((item) => item.historyId).length, 0);
  // Hold a real explicit A read while B is explicitly reopened. A's read-only intent must survive.
  read.mock.restore();
  const history = h.runtime.history.bind(h.runtime);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const requests = t.mock.method(h.runtime, "history", async (id: string) => { await held; return history(id); });
  const full = findAction(recent, "Post full history");
  try {
    await h.action(full, { count: "1" });
    await h.text(`!use ${b}`); // No hydration and no waiting for A's read.
    assert.equal(h.bridge.store.snapshot().conversations[h.key]!.historyRead!.sessionId, a);
  } finally { release(); }
  await h.bridge.flush();
  const after = h.bridge.store.snapshot();
  assert.equal(after.conversations[h.key]!.selectedId, b);
  const parts = after.outbox.filter((item) => item.historyId === after.conversations[h.key]!.historyRead!.id);
  assert.ok(parts.length && parts.every((item) => item.sessionId === a && item.status === "sent"));
  assert.ok(parts.map((part) => part.text).join("").endsWith(latest));
  await h.action(full, { count: "10" }); await h.bridge.flush();
  assert.equal(requests.mock.callCount(), 1);
  assert.equal(h.runtime.received.length, count);
  await h.text(`!use ${a}`);
  await h.text("!history 2"); await h.bridge.flush();
  const command = h.bridge.store.snapshot().conversations[h.key]!.historyRead!;
  assert.equal(command.count, 2);
  assert.ok(h.bridge.store.snapshot().outbox.filter((item) => item.historyId === command.id).map((part) => part.text).join("").endsWith(latest));
});

test("compact first-contact !use posts only a header; lost header ACK, restart and unreadable targets never replay or route work", async (t) => {
  const dir = await temporary(t);
  const h = await harness(t, false, dir, { interaction: options, initializeConversation: false });
  const a = randomUUID(), b = randomUUID();
  await h.bridge.store.mutate((state) => {
    const sample = state.sessions[state.controllerId!]!;
    state.sessions[a] = { ...sample, id: a, name: "Retained", kind: "saved", access: { read: true, send: false } };
    state.sessions[b] = { ...sample, id: b, name: "No access", kind: "unavailable", access: { read: false, send: false } };
  });
  await h.text(`!use ${a}`); await h.bridge.flush();
  assert.equal(h.transport.messages.size, 1);
  assert.equal(delivered(h, surface(h.bridge.store.snapshot(), "header", a).activityId).body.some((item) => item.text === "You"), false);
  await h.text("!sessions"); await h.bridge.flush();
  const row = delivered(h, surface(h.bridge.store.snapshot(), "picker").activityId).body.find((item) =>
    item.type === "ColumnSet" && firstLayer(item).includes("Retained"));
  const open = findAction(row, "Open");
  const send = h.transport.send.bind(h.transport);
  let attempts = 0;
  t.mock.method(h.transport, "send", async (...args: Parameters<typeof send>) => {
    if (args[1].type === "card" && String(args[1].card.body[0]?.text).includes("Next message -> Retained")) {
      attempts++; throw new DeliveryError("uncertain", "TIMEOUT");
    }
    return send(...args);
  });
  await h.action(open); await h.bridge.flush();
  const header = surface(h.bridge.store.snapshot(), "header", a);
  assert.equal(header.delivery, "uncertain");
  await h.action(open); await h.bridge.flush();
  assert.equal(attempts, 1);
  // Older saves can still point at an earlier picker after leaving its view.
  await h.bridge.store.mutate((state) => {
    state.conversations[h.key]!.dashboardId = surface(state, "picker").activityId!;
    state.conversations[h.key]!.dashboardState = "ready";
  });
  await h.bridge.close();
  const restarted = await harness(t, false, dir, { interaction: options, initializeConversation: false, inventoryOnStart: false });
  await restarted.bridge.flush();
  const saved = restarted.bridge.store.snapshot().interaction!.surfaces[header.id]!;
  assert.equal(saved.delivery, "uncertain");
  assert.equal(saved.activityId, undefined, "a previous picker's ID is not a header ACK");
  await restarted.text(`!use ${b}`);
  const state = restarted.bridge.store.snapshot();
  assert.equal(state.conversations[h.key]!.selectedId, a);
  assert.equal(state.conversations[h.key]!.selectionBlocked, true);
  assert.equal(state.outbox.some((item) => item.historyId), false);
  assert.deepEqual(restarted.runtime.received, []);
  assert.deepEqual(restarted.runtime.resumed, []);
});

test("quiet conversation delivers a fast actual answer first without a redundant turn card or generic relay summary", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const h = await harness(t, false, undefined, { interaction: options });
  const id = await createWorking(h);
  await h.bridge.flush();
  const initialMessages = h.transport.messages.size;
  const prompt = "  sessions, Stop and All actions are literal work\r\nleave this unchanged  ";
  await h.text(prompt, "quiet-original");
  const answer = "The answer is 42.\nThis is the actual response.";
  h.runtime.emit(id, "assistant.message", { messageId: "quiet-answer", phase: "final", content: answer });
  h.runtime.emit(id, "session.task_complete", { success: true, summary: "Generic task completion summary" });
  h.runtime.emit(id, "session.idle");
  await h.bridge.flush();
  const state = h.bridge.store.snapshot();
  const turn = Object.values(state.interaction!.turns)[0]!;
  assert.equal(state.interaction!.surfaces[turn.surfaceId]!.activityId, undefined);
  assert.equal(state.interaction!.surfaces[turn.surfaceId]!.suppressed, true);
  const result = state.outbox.find((item) => item.eventId === "quiet-answer")!;
  assert.equal(result.status, "sent");
  assert.equal(result.originReference?.activityId, "quiet-original");
  const message = h.transport.messages.get(result.activityId!)!.message;
  assert.ok(message.type === "card");
  assert.equal(message.card.body[0]?.text, answer);
  assert.doesNotMatch(firstLayer(message.card), /Generic task completion|Task receipt|queue|Native message/);
  assert.equal(message.summary, undefined);
  assert.equal(outboundActivity(message).text, undefined);
  assert.throws(() => findAction(message.card, "Show full"), /not found/);
  assert.equal(h.transport.messages.size, initialMessages + 1);
  assert.deepEqual(h.runtime.received, [{ sessionId: id, text: prompt }]);
});

test("quiet received hint precedes liveness, connection and native ACK; one status activity advances only on evidence", { timeout: 15_000 }, async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const h = await harness(t, false, undefined, { interaction: options });
  const id = await createWorking(h);
  await h.bridge.flush();
  const peer = randomUUID();
  await h.bridge.store.mutate((state) => {
    state.sessions[peer] = { ...state.sessions[id]!, id: peer, kind: "peer", peerSource: "app", status: "offline",
      access: { read: true, send: false } };
  });
  let releaseLiveness!: () => void;
  let releaseConnection!: () => void;
  let releaseAck!: () => void;
  const liveness = new Promise<void>((resolve) => { releaseLiveness = resolve; });
  const connection = new Promise<void>((resolve) => { releaseConnection = resolve; });
  const ack = new Promise<void>((resolve) => { releaseAck = resolve; });
  t.mock.method(h.runtime, "appLiveness", async () => { await liveness; return []; });
  const resume = h.runtime.resume.bind(h.runtime);
  let connecting = false;
  t.mock.method(h.runtime, "resume", async (...args: Parameters<typeof resume>) => {
    connecting = true; await connection; return resume(...args);
  });
  let sending = false;
  const nativeId = randomUUID();
  const send = t.mock.method(h.runtime, "send", async () => {
    sending = true; await ack; return { id: nativeId, peer: false };
  });
  const received = h.text("delayed task", "delayed-original");
  try {
    await eventually(() => Boolean(Object.values(h.bridge.store.snapshot().interaction!.turns).length));
    now += acknowledgementDelayMs + 1;
    await h.bridge.flush();
    const turn = Object.values(h.bridge.store.snapshot().interaction!.turns)[0]!;
    const status = h.bridge.store.snapshot().interaction!.surfaces[turn.surfaceId]!;
    assert.ok(status.activityId);
    assert.match(firstLayer(delivered(h, status.activityId)), /Received by bridge - not yet accepted/);
    assert.equal(send.mock.callCount(), 0);
    releaseLiveness();
    await eventually(() => connecting);
    await h.bridge.flush();
    assert.match(firstLayer(delivered(h, status.activityId)), /Received by bridge - not yet accepted/);
    releaseConnection();
    await eventually(() => sending);
    await h.bridge.flush();
    assert.match(firstLayer(delivered(h, status.activityId)), /Received by bridge - not yet accepted/);
    releaseAck();
    await received;
    await h.bridge.flush();
    assert.match(firstLayer(delivered(h, status.activityId)), /Accepted by source - queued; execution not yet observed/);
    h.runtime.emit(id, "user.message", { messageId: nativeId, content: "delayed task" });
    h.runtime.emit(id, "assistant.turn_start", { turnId: "observed-root" });
    await h.bridge.flush();
    assert.match(firstLayer(delivered(h, status.activityId)), /Running - execution observed/);
    const current = h.bridge.store.snapshot().interaction!.surfaces[turn.surfaceId]!;
    assert.equal(current.activityId, status.activityId);
    assert.equal(delivered(h, status.activityId).body.length, 1);
    h.runtime.emit(id, "assistant.message", { originatingMessageId: nativeId, messageId: "delayed-result", content: "Done with the actual task." });
    h.runtime.emit(id, "session.task_complete", { success: true });
    await h.bridge.flush();
    const result = h.bridge.store.snapshot().outbox.find((item) => item.eventId === "delayed-result")!;
    assert.notEqual(result.activityId, status.activityId);
    assert.equal(delivered(h, result.activityId).body[0]?.text, "Done with the actual task.");
    assert.equal(h.bridge.store.snapshot().interaction!.surfaces[turn.surfaceId]!.activityId, status.activityId);
    assert.match(firstLayer(delivered(h, status.activityId)), /Reply delivered/);
  } finally { releaseLiveness(); releaseConnection(); releaseAck(); await received; }
});

test("quiet first contact discovers sessions/help without sending or waking a native session", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options, initializeConversation: false });
  const card = await h.text("hello from Teams");
  await h.bridge.flush();
  assert.match(firstLayer(card), /Choose a session/);
  const home = delivered(h, surface(h.bridge.store.snapshot(), "inbox").activityId);
  assert.match(firstLayer(home), /!sessions.*!help/);
  assert.ok(findAction(home, "Choose a session"));
  await h.action(findAction(home, "All actions"));
  await h.bridge.flush();
  let panel = delivered(h, surface(h.bridge.store.snapshot(), "actions").activityId);
  await h.action(findAction(panel, "Search actions"), { actionQuery: "help" });
  await h.bridge.flush();
  panel = delivered(h, surface(h.bridge.store.snapshot(), "actions").activityId);
  await h.action(findAction(panel, "Commands and help"));
  await h.bridge.flush();
  assert.match(firstLayer(delivered(h, surface(h.bridge.store.snapshot(), "actions").activityId)), /Ordinary Teams composer text.*unchanged/);
  assert.deepEqual(h.runtime.received, []);
  assert.deepEqual(h.runtime.resumed, []);
  assert.equal(h.runtime.live.size, 0);
});

test("quiet one-tap row subscriptions are source scoped, sticky across tasks/restart, and never select or send work", async (t) => {
  const directory = await temporary(t);
  const h = await harness(t, false, directory, { interaction: options });
  const a = await createWorking(h, "Notification A");
  const b = await createWorking(h, "Keep selected B");
  await h.text("!sessions");
  await h.bridge.flush();
  const picker = surface(h.bridge.store.snapshot(), "picker");
  const row = delivered(h, picker.activityId).body.find((entry) => entry.type === "ColumnSet" && firstLayer(entry).includes("Notification A"));
  assert.ok(row);
  const subscribe = findAction(row, "Subscribe");
  await h.action(subscribe);
  await h.bridge.flush();
  const preferenceId = digest(`${h.key}:${a}`);
  assert.equal(h.bridge.store.snapshot().interaction!.follows[preferenceId]!.mode, "explicit");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
  assert.deepEqual(h.runtime.received, []);
  const updatedRow = delivered(h, picker.activityId).body.find((entry) => entry.type === "ColumnSet" && firstLayer(entry).includes("Notification A"));
  await h.action(findAction(updatedRow, "Unsubscribe"));
  await h.bridge.flush();
  const muted = h.bridge.store.snapshot().interaction!.follows[preferenceId]!;
  assert.equal(muted.explicitMute, true);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
  await h.text(`!use ${a}`);
  await h.text("direct task still allowed");
  assert.deepEqual(h.bridge.store.snapshot().interaction!.follows[preferenceId], muted);
  await h.bridge.close();
  const reopened = await harness(t, false, directory, { interaction: options, initializeConversation: false, inventoryOnStart: false });
  await reopened.text("another task after restart");
  assert.deepEqual(reopened.bridge.store.snapshot().interaction!.follows[preferenceId], muted);
  reopened.runtime.emit(a, "assistant.message", { messageId: "muted-direct", content: "Direct reply survives mute." });
  await reopened.bridge.flush();
  assert.equal(reopened.bridge.store.snapshot().outbox.find((item) => item.eventId === "muted-direct")?.status, "sent");
});

test("quiet automatic expiry can renew, but legacy muted intent is never guessed or silently resubscribed", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const a = await createWorking(h);
  await h.text("automatic");
  const id = digest(`${h.key}:${a}`);
  await h.bridge.store.mutate((state) => { state.interaction!.follows[id]!.expiresAt = Date.now() - 1; });
  await h.bridge.checkSubscriptions();
  assert.equal(h.bridge.store.snapshot().interaction!.follows[id]!.explicitMute, false);
  await h.text("new work renews an automatic expiry");
  assert.equal(h.bridge.store.snapshot().interaction!.follows[id]!.mode, "automatic");
  await h.bridge.store.mutate((state) => {
    state.interaction!.follows[id]!.mode = "muted";
    delete state.interaction!.follows[id]!.explicitMute;
  });
  const legacy = h.bridge.store.snapshot().interaction!.follows[id]!;
  await h.text("do not infer the old mute's intent");
  assert.deepEqual(h.bridge.store.snapshot().interaction!.follows[id], legacy);
});

test("quiet picker, Focus and Inbox share host-derived status and update their existing activities across views", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const id = randomUUID();
  h.runtime.foreign.push({ id, name: "Host-derived peer", kind: "peer", peerSource: "app", status: "idle",
    workspace: h.directory, capability: "Live endpoint", access: { read: true, send: true }, liveUntil: Date.now() + 60_000 });
  await h.text("!sessions");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[id]));
  await h.bridge.flush();
  const picker = surface(h.bridge.store.snapshot(), "picker");
  const row = delivered(h, picker.activityId).body.find((item) => item.type === "ColumnSet" && firstLayer(item).includes("Host-derived peer"));
  await h.action(findAction(row, "Open"));
  await h.bridge.flush();
  const header = surface(h.bridge.store.snapshot(), "header", id);
  const inbox = surface(h.bridge.store.snapshot(), "inbox");
  const appearance = (card: Card) => {
    const values: Array<{ text: string; color: unknown }> = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (object(value) && value.type !== "Action.ShowCard") {
        if (typeof value.text === "string" && /^[●○▲?!] /u.test(value.text)) values.push({ text: value.text, color: value.color });
        for (const [key, item] of Object.entries(value)) if (key !== "data") visit(item);
      }
    };
    visit(card);
    return values;
  };
  for (const activityId of [picker.activityId, header.activityId, inbox.activityId]) {
    assert.ok(appearance(delivered(h, activityId)).some((status) => status.text === "● Ready" && status.color === "Good"));
  }
  h.runtime.foreign[0]!.status = "busy";
  await h.text("!home");
  await eventually(() => h.bridge.store.snapshot().sessions[id]!.status === "busy");
  await h.bridge.flush();
  const currentInbox = surface(h.bridge.store.snapshot(), "inbox");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.view, "home");
  for (const activityId of [picker.activityId, header.activityId, currentInbox.activityId]) {
    assert.ok(appearance(delivered(h, activityId)).some((status) => status.text === "● Working" && status.color === "Accent"));
  }
  assert.equal(h.bridge.store.snapshot().sessions[id]!.pending.length, 0);
  assert.deepEqual(h.runtime.received, []);
  assert.deepEqual(h.runtime.resumed, []);
});

for (const style of ["submit", "execute"] as const) test(`quiet searchable All actions executes scoped Steer/Stop/settings/Control and stays in the ${style} budget`, async (t) => {
  const h = await harness(t, false, undefined, { interaction: options, cardActions: style });
  const a = await createWorking(h, "Actions source");
  await h.text("original task");
  const b = await createWorking(h, "Keep B selected");
  let menu = await openActions(h, a);
  assert.ok(findAction(menu, "Steer"));
  assert.ok(findAction(menu, "Stop"));
  const panelId = surface(h.bridge.store.snapshot(), "actions", a).id;
  const panel = () => delivered(h, h.bridge.store.snapshot().interaction!.surfaces[panelId]!.activityId);
  assert.ok(Buffer.byteLength(JSON.stringify(outboundActivity({ type: "card", card: menu }))) <= 27_000);
  await h.action(findAction(menu, "Steer"));
  await h.bridge.flush();
  const steering = "  exact steering\r\nfor the original A task  ";
  await h.action(findAction(panel(), "Send steering"), { steering });
  await h.bridge.flush();
  assert.deepEqual(h.runtime.received.at(-1), { sessionId: a, text: steering });
  assert.equal(h.runtime.sendModes.at(-1)?.mode, "immediate");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
  await h.action(findAction(panel(), "All actions"));
  await h.bridge.flush();
  await h.action(findAction(panel(), "Stop"));
  await h.bridge.flush();
  assert.deepEqual(h.runtime.stopped, []);
  await h.action(findAction(delivered(h, surface(h.bridge.store.snapshot(), "stop", a).activityId), "Confirm Stop"));
  await h.bridge.flush();
  assert.deepEqual(h.runtime.stopped, [a]);
  await h.action(findAction(panel(), "Search actions"), { actionQuery: "model" });
  await h.bridge.flush();
  await h.action(findAction(panel(), "Model and mode"));
  await h.bridge.flush();
  await h.action(findAction(panel(), "Load options"), { modelKey: "mock-deep", mode: "interactive", effort: "__default__" });
  await h.bridge.flush();
  await h.action(findAction(panel(), "Apply"), { modelKey: "mock-deep", mode: "plan", effort: "max" });
  await h.bridge.flush();
  assert.deepEqual(h.runtime.settingsCalls.at(-1), { id: a, change: { modelKey: "mock-deep", mode: "plan", effort: "max" } });
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
  await h.action(findAction(panel(), "All actions"));
  await h.bridge.flush();
  await h.action(findAction(panel(), "Search actions"), { actionQuery: "Control" });
  await h.bridge.flush();
  await h.action(findAction(panel(), "Control"));
  await h.bridge.flush();
  const control = findAction(panel(), "Send Control instruction");
  await h.action(control, { instruction: "list only, explicitly requested management" });
  await h.action(control, { instruction: "must not replay with changed input" });
  assert.equal(h.runtime.received.filter((item) => item.sessionId === h.bridge.store.snapshot().controllerId).length, 1);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
  assert.ok(Buffer.byteLength(JSON.stringify(outboundActivity({ type: "card", card: panel() }))) <= 27_000);
});

test("quiet All actions reaches exact native requests and keeps other sources' approvals intact", async (t) => {
  const h = await harness(t, true, undefined, { interaction: options });
  const a = await createWorking(h, "Approval A");
  await h.text("permission");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[a]!.pending.length));
  const aRequest = h.bridge.store.snapshot().sessions[a]!.pending[0]!.id;
  const b = await createWorking(h, "Question B");
  await h.text("ask");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[b]!.pending.length));
  const unrelated = surface(h.bridge.store.snapshot(), "request", b);
  const menu = await openActions(h, a, "Review approval");
  await h.action(findAction(menu, "Review approval"));
  await h.bridge.flush();
  const panel = surface(h.bridge.store.snapshot(), "actions", a);
  const allow = findAction(delivered(h, panel.activityId), "Allow once");
  await h.action(allow);
  await h.bridge.flush();
  assert.deepEqual(h.runtime.answers[0], { id: a, requestId: aRequest, answer: { approve: true, permission: "once" } });
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
  assert.equal(h.bridge.store.snapshot().interaction!.surfaces[unrelated.id]!.revision, unrelated.revision);
  await h.action(allow);
  assert.equal(h.runtime.answers.length, 1);
});

test("quiet Steer opener cannot silently retarget a retained task-A button to a later task B", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const id = await createWorking(h);
  await h.text("task A");
  const old = findAction(await openActions(h, id), "Steer");
  const a = h.bridge.store.snapshot().interaction!.active[id]!;
  h.runtime.emit(id, "session.task_complete", { success: true });
  h.runtime.emit(id, "session.idle");
  await h.text("task B");
  await h.bridge.flush();
  const b = h.bridge.store.snapshot().interaction!.active[id]!;
  assert.notEqual(a, b);
  assert.equal(h.bridge.store.snapshot().interaction!.turns[b]!.state, "executing");
  const count = h.runtime.received.length;
  await h.action(old);
  await h.bridge.flush();
  const state = h.bridge.store.snapshot();
  assert.equal(h.runtime.received.length, count);
  assert.notEqual(surface(state, "actions", id).section, "steer");
  assert.throws(() => findAction(delivered(h, surface(state, "actions", id).activityId), "Send steering"), /not found/);
  assert.match(state.conversations[h.key]!.notice, /originally offered processing request ended or changed/);
});

for (const style of ["submit", "execute"] as const) test(`quiet picker retains three rows and subscription controls within signed ${style} wire budgets`, async (t) => {
  const h = await harness(t, false, undefined, { interaction: options, cardActions: style });
  for (let index = 0; index < 3; index++) {
    const id = await createWorking(h, `Budget ${index}`);
    await h.bridge.store.mutate((state) => {
      state.sessions[id]!.name = "\u{1f680}".repeat(98) + index;
      state.sessions[id]!.timeline = [
        { id: `q-${index}`, kind: "user", text: "\u{1f680}".repeat(700) },
        { id: `a-${index}`, kind: "assistant", phase: "final", text: "\u{1f680}".repeat(700) },
      ];
    });
  }
  await h.text("!sessions");
  await h.bridge.flush();
  const picker = surface(h.bridge.store.snapshot(), "picker");
  const card = delivered(h, picker.activityId);
  const rows = card.body.filter((entry) => entry.type === "ColumnSet");
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(findAction(row, "Subscribe"));
    assert.ok(findAction(row, "Open"));
  }
  assert.ok(Buffer.byteLength(JSON.stringify(outboundActivity({ type: "card", card }))) <= 27_000);
});

test("quiet native-only Actions explain unavailable control instead of offering an App permission or settings mutation", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const id = randomUUID();
  h.runtime.foreign.push({ id, name: "Original App host", kind: "peer", peerSource: "app", status: "busy",
    workspace: h.directory, capability: "Original host owns control", access: { read: true, send: true }, liveUntil: Date.now() + 60_000 });
  await h.text("!sessions");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[id]));
  await h.bridge.flush();
  await h.action(findAction(delivered(h, surface(h.bridge.store.snapshot(), "picker").activityId), "Open"));
  await h.bridge.flush();
  const menu = await openActions(h, id, "model");
  assert.match(firstLayer(menu), /Native-only.*original host/);
  assert.throws(() => findAction(menu, "Model and mode"), /not found/);
  assert.throws(() => findAction(menu, "Stop"), /not found/);
  assert.throws(() => findAction(menu, "Allow once"), /not found/);
  assert.deepEqual(h.runtime.received, []);
  assert.deepEqual(h.runtime.resumed, []);
  assert.deepEqual(h.runtime.settingsCalls, []);
});

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
  assert.ok(String(resultCard.body[0]?.text).length < content.length);
  assert.ok(Buffer.byteLength(JSON.stringify(outboundActivity({ type: "card", card: resultCard }))) <= 27_000);
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

for (const completion of [
  { name: "native completion", type: "permission.completed", data: {} },
  { name: "timeout", type: "bridge.permission_resolved", data: { outcome: "timeout" } },
  { name: "abort", type: "abort", data: {} },
  { name: "shutdown", type: "session.shutdown", data: {} },
]) test(`R2-F3: ${completion.name} clears the last pending request on the same header without staling another source`, async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const h = await harness(t, false, undefined, { interaction: options });
  const a = await createWorking(h, "Unrelated approval");
  await h.text("work A");
  h.runtime.emit(a, "permission.requested", { requestId: randomUUID(),
    permissionRequest: { kind: "shell", fullCommandText: "Write-Output 'A'" } });
  await h.bridge.flush();
  const unrelated = surface(h.bridge.store.snapshot(), "request", a);
  const b = await createWorking(h, "Native completion");
  await h.text("work B");
  const requestId = randomUUID();
  h.runtime.emit(b, "permission.requested", { requestId,
    permissionRequest: { kind: "shell", fullCommandText: "Write-Output 'B'" } });
  await h.text("!home");
  await h.bridge.flush();
  const before = h.bridge.store.snapshot();
  const header = surface(before, "header", b);
  const request = surface(before, "request", b);
  assert.ok(header.activityId);
  assert.match(JSON.stringify(h.transport.messages.get(header.activityId)), /Needs reply/);
  assert.ok(findAction(h.transport.messages.get(header.activityId), "All actions"));
  assert.ok(findAction(h.transport.messages.get(request.activityId!), "Allow once"));
  const messages = h.transport.messages.size;
  const updates = t.mock.method(h.transport, "update", h.transport.update.bind(h.transport));
  h.runtime.emit(b, completion.type, completion.type === "abort" || completion.type === "session.shutdown"
    ? {} : { requestId, ...completion.data });
  await h.bridge.flush();
  now += 6000;
  await h.bridge.flush();
  const after = h.bridge.store.snapshot();
  assert.equal(after.sessions[b]!.pending.length, 0);
  assert.equal(after.conversations[h.key]!.view, "home");
  assert.equal(surface(after, "header", b).activityId, header.activityId);
  const visible = h.transport.messages.get(header.activityId);
  assert.doesNotMatch(JSON.stringify(visible), /Needs reply|"title":"Review approval"/);
  assert.throws(() => findAction(visible, "Allow once"), /not found/);
  assert.ok(after.interaction!.surfaces[request.id]!.frozen);
  assert.deepEqual(after.interaction!.surfaces[unrelated.id], unrelated);
  assert.equal(h.runtime.answers.length, 0);
  assert.ok(h.transport.messages.size - messages <= 1, "only an undelivered task's compact safety status may be added");
  if (h.transport.messages.size > messages) {
    const turn = after.interaction!.turns[request.turnId!]!;
    assert.ok(after.interaction!.surfaces[turn.surfaceId]!.activityId);
  }
  assert.equal(updates.mock.calls.filter((call) => call.arguments[1] === header.activityId).length, 1);
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

for (const kind of ["inbox", "header", "turn"] as const) test(`v3 picker entry from ${kind} posts below newer activity and keeps picker navigation in place`, async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const h = await harness(t, false, undefined, { interaction: options, cardActions: "submit" });
  const b = await createWorking(h, "Switch destination");
  await createWorking(h, "Other one");
  await createWorking(h, "Other two");
  const a = await createWorking(h, "Original focus");
  const deliveredCard = (id: string | undefined) => {
    assert.ok(id);
    const delivered = h.transport.messages.get(id);
    assert.ok(delivered?.message.type === "card");
    return delivered.message.card;
  };
  await h.text("!sessions");
  await h.bridge.flush();
  await h.action(findAction(deliveredCard(h.bridge.store.snapshot().conversations[h.key]!.dashboardId), "Search"),
    { query: "Original focus" });
  await h.bridge.flush();
  const oldPicker = h.bridge.store.snapshot().conversations[h.key]!;
  const oldOpen = findAction(deliveredCard(oldPicker.dashboardId), "Open");
  await h.text("work after opening the old picker");
  now += acknowledgementDelayMs;
  await h.bridge.flush();
  h.runtime.emit(a, "assistant.message", { messageId: "picker-result", content: "Visible newer result ".repeat(300), phase: "final" });
  h.runtime.emit(a, "session.task_complete", { success: true });
  h.runtime.emit(a, "session.idle");
  await h.bridge.flush();
  await h.action(findAction(deliveredCard(surface(h.bridge.store.snapshot(), "result", a).activityId), "Show full"));
  await h.bridge.flush();
  const before = h.bridge.store.snapshot();
  const history = before.outbox.findLast((item) => item.historyId)!;
  assert.equal(history.status, "sent");
  assert.ok(history.activityId);
  assert.equal(before.conversations[h.key]!.view, "sessions", "an old list view does not prove its card is visible");
  assert.equal(before.conversations[h.key]!.dashboardId, oldPicker.dashboardId);
  const entry = findAction(deliveredCard(surface(before, kind, kind === "inbox" ? undefined : a).activityId),
    kind === "inbox" ? "All sessions" : "Change next target");
  const sends = structuredClone(h.runtime.received);
  const activityId = randomUUID();
  await h.action(entry, {}, activityId);
  await h.bridge.flush();
  const picker = h.bridge.store.snapshot().conversations[h.key]!;
  assert.ok(picker.dashboardId);
  assert.notEqual(picker.dashboardId, oldPicker.dashboardId);
  assert.notEqual(picker.surfaceId, oldPicker.surfaceId);
  const activities = [...h.transport.messages.keys()];
  assert.ok(activities.indexOf(picker.dashboardId) > activities.indexOf(history.activityId),
    "explicit entry must create the picker after the newer history, not update the offscreen message");
  assert.equal(deliveredCard(picker.dashboardId).body[0]?.text, "Sessions");
  assert.equal(picker.selectedId, a);
  assert.equal(picker.query, undefined);
  assert.deepEqual(h.runtime.received, sends);
  const messageCount = h.transport.messages.size;
  await h.action(entry, {}, activityId);
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.dashboardId, picker.dashboardId);
  assert.equal(h.transport.messages.size, messageCount, "a duplicate activity must not post another picker");
  await h.action(findAction(deliveredCard(picker.dashboardId), "Next"));
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.page, 1);
  await h.action(findAction(deliveredCard(picker.dashboardId), "Search"), { query: "Switch destination" });
  await h.bridge.flush();
  await h.action(findAction(deliveredCard(picker.dashboardId), "Refresh"));
  await h.bridge.flush();
  const filtered = h.bridge.store.snapshot().conversations[h.key]!;
  assert.equal(filtered.dashboardId, picker.dashboardId);
  assert.equal(filtered.surfaceId, picker.surfaceId);
  assert.equal(filtered.query, "Switch destination");
  assert.equal(filtered.page, 0);
  assert.equal(filtered.selectedId, a);
  assert.equal(h.transport.messages.size, messageCount, "page/search/refresh must update the same picker");
  assert.deepEqual(h.runtime.received, sends);
  await h.action(findAction(deliveredCard(picker.dashboardId), "Open"));
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
  assert.deepEqual(h.runtime.received, sends, "explicit Open selects but never sends work");
  await h.action(oldOpen);
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b, "a replaced picker's Open cannot retarget work");
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /card was replaced/);
  assert.deepEqual(h.runtime.received, sends);
});

test("v3 picker entry with an uncertain send is not replayed by duplicate clicks or background progress", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const id = await createWorking(h);
  await h.text("!sessions");
  await h.bridge.flush();
  const before = h.bridge.store.snapshot();
  const header = surface(before, "header", id);
  const entry = findAction(h.transport.messages.get(header.activityId!), "Change next target");
  const send = h.transport.send.bind(h.transport);
  let pickerSends = 0;
  t.mock.method(h.transport, "send", async (reference: Parameters<typeof send>[0], message: Parameters<typeof send>[1]) => {
    if (message.type === "card" && message.card.body[0]?.text === "Sessions") {
      pickerSends++;
      throw new DeliveryError("uncertain", "TIMEOUT");
    }
    return send(reference, message);
  });
  const activityId = randomUUID();
  await h.action(entry, {}, activityId);
  await h.bridge.flush();
  assert.equal(pickerSends, 1);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.dashboardState, "uncertain");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.dashboardId, undefined);
  await h.action(entry, {}, activityId);
  h.runtime.emit(id, "session.idle");
  await h.bridge.flush();
  await h.bridge.flush();
  assert.equal(pickerSends, 1);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.dashboardState, "uncertain");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, id);
  assert.deepEqual(h.runtime.received, []);
});

test("v3 explicit unsubscribe survives later tasks, leaves direct replies enabled, and explicit subscribe has no expiry", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const id = await createWorking(h);
  await h.text("first");
  await h.text("!unsubscribe");
  await h.text("second");
  const followId = digest(`${h.key}:${id}`);
  assert.equal(h.bridge.store.snapshot().interaction!.follows[followId]!.mode, "muted");
  assert.equal(h.bridge.store.snapshot().interaction!.follows[followId]!.explicitMute, true);
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
  now += acknowledgementDelayMs;
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

test("R2-F2: replaying an exact completed event cannot finish the next executing turn on its source", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const id = await createWorking(h);
  await h.text("task A");
  const event = { id: randomUUID(), timestamp: new Date().toISOString(), data: { success: true, summary: "Task A only" } };
  h.runtime.emit(id, "session.task_complete", event.data, event);
  h.runtime.emit(id, "session.idle");
  await h.bridge.flush();
  const a = Object.values(h.bridge.store.snapshot().interaction!.turns)[0]!;
  assert.equal(a.state, "done");
  await h.text("task B");
  await h.bridge.flush();
  const before = h.bridge.store.snapshot();
  const b = before.interaction!.turns[before.interaction!.active[id]!]!;
  assert.notEqual(b.id, a.id);
  assert.equal(b.state, "executing");
  assert.equal(b.summary, undefined);
  assert.ok(before.sessions[id]!.seenEvents.includes(event.id));
  h.runtime.emit(id, "session.task_complete", event.data, event);
  await h.bridge.flush();
  const after = h.bridge.store.snapshot();
  assert.deepEqual(after.interaction!.turns[b.id], b);
  assert.deepEqual(after.interaction!.turns[a.id], a);
  assert.deepEqual(after.interaction!.surfaces, before.interaction!.surfaces);
  assert.deepEqual(after.outbox, before.outbox);
});

test("R2-F2: first-time ephemeral intent and progress are observed but replayed intent cannot cross turns", async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const id = await createWorking(h);
  await h.text("task A");
  const intent = { id: randomUUID(), timestamp: new Date().toISOString(), ephemeral: true, data: { intent: "Task A intent" } };
  h.runtime.emit(id, "assistant.intent", intent.data, intent);
  await h.bridge.flush();
  const a = Object.values(h.bridge.store.snapshot().interaction!.turns)[0]!;
  assert.equal(a.intent, "Task A intent");
  h.runtime.emit(id, "session.task_complete", { success: true });
  h.runtime.emit(id, "session.idle");
  await h.text("task B");
  h.runtime.emit(id, "assistant.intent", { intent: "Task B intent" }, { ephemeral: true });
  const toolCallId = randomUUID();
  h.runtime.emit(id, "tool.execution_start", { toolCallId, toolName: "mock_inspect" }, { ephemeral: true });
  h.runtime.emit(id, "tool.execution_complete", { toolCallId, success: true }, { ephemeral: true });
  await h.bridge.flush();
  const before = h.bridge.store.snapshot();
  const b = before.interaction!.turns[before.interaction!.active[id]!]!;
  assert.equal(b.state, "executing");
  assert.equal(b.intent, "Task B intent");
  assert.deepEqual(b.steps, [{ id: toolCallId, name: "mock_inspect", state: "done" }]);
  assert.ok(!before.sessions[id]!.seenEvents.includes(intent.id), "ephemeral dedup must not depend on the durable journal IDs");
  h.runtime.emit(id, "assistant.intent", intent.data, intent);
  await h.bridge.flush();
  const after = h.bridge.store.snapshot();
  assert.deepEqual(after.interaction!.turns[b.id], b);
  assert.deepEqual(after.interaction!.surfaces, before.interaction!.surfaces);
  h.runtime.emit(id, "session.idle");
  await h.bridge.flush();
  const sequence = h.bridge.store.snapshot().sessions[id]!.sequence;
  assert.equal(h.bridge.store.snapshot().interaction!.active[id], undefined);
  h.runtime.emit(id, "user.message", { messageId: b.messageId, content: "" }, { ephemeral: true });
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().sessions[id]!.sequence, sequence, "consumption need not change the visible timeline");
  assert.equal(h.bridge.store.snapshot().interaction!.active[id], b.id, "a new event must still update native correlation");
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
  for (const schema of [1, 2, 3, 4] as const) {
    legacy.schema = schema;
    await writeFile(join(directory, "state.json"), JSON.stringify(legacy));
    const migrated = await Store.open(directory, "test-owner");
    const current = migrated.snapshot();
    assert.equal(current.schema, 5);
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
  }
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
  const oldAction = findAction(renderInteractionSurface(first, previous, h.bridge.cards), "Choose a session");
  await h.text("!home");
  await h.bridge.flush();
  const current = h.bridge.store.snapshot();
  assert.equal(Object.values(current.interaction!.surfaces).filter((entry) => entry.kind === "inbox" && !entry.frozen).length, 1);
  assert.match(JSON.stringify(h.transport.messages.get(previous.activityId!)), /Updated below/);
  const actions = await openActions(h, undefined, "Details");
  await h.action(findAction(actions, "Details"));
  await h.bridge.flush();
  assert.match(firstLayer(delivered(h, surface(h.bridge.store.snapshot(), "actions").activityId)), /pending questions and approvals are unknown/);
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
  t.mock.method(h.runtime, "preview", async () => { throw new Error("Synthetic bounded preview failure"); });
  await h.action(findAction(renderInteractionSurface(first, surface(first, "turn", a), h.bridge.cards), "History"));
  await h.bridge.flush();
  const recent = delivered(h, surface(h.bridge.store.snapshot(), "actions", a).activityId);
  assert.match(firstLayer(recent), /Preview refresh unavailable/);
  const read = findAction(recent, "Post full history");
  const b = await createWorking(h, "B remains selected");
  const history = h.runtime.history.bind(h.runtime);
  let reads = 0;
  t.mock.method(h.runtime, "history", async (id: string) => {
    if (id === a) { reads++; throw new Error("Synthetic read failure after actual source dispatch"); }
    return history(id);
  });
  await h.action(read, { count: "10" });
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

for (const decision of ["Confirm Stop", "Cancel"] as const) test(`v3 Stop notice stays accurate in the delivered header after ${decision}`, async (t) => {
  const h = await harness(t, true, undefined, { interaction: options });
  const id = await createWorking(h);
  await h.text("ask");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[id]?.pending.length));
  await h.text("!stop");
  await h.bridge.flush();
  const before = h.bridge.store.snapshot();
  const header = surface(before, "header", id);
  const stop = surface(before, "stop", id);
  assert.ok(header.activityId && stop.activityId);
  await h.action(findAction(h.transport.messages.get(stop.activityId), decision));
  await h.bridge.flush();
  const after = h.bridge.store.snapshot();
  const confirmed = decision === "Confirm Stop";
  assert.equal(after.interaction!.surfaces[stop.id]!.stop!.state, confirmed ? "accepted" : "cancelled");
  assert.equal(after.interaction!.turns[stop.turnId!]!.state, confirmed ? "stopped" : "waiting");
  assert.equal(after.sessions[id]!.pending.length, confirmed ? 0 : 1);
  assert.deepEqual(h.runtime.stopped, confirmed ? [id] : []);
  assert.equal(surface(after, "header", id).activityId, header.activityId);
  const delivered = h.transport.messages.get(header.activityId);
  assert.ok(delivered?.message.type === "card");
  const text = delivered.message.card.body.flatMap((entry) => typeof entry.text === "string" ? [entry.text] : []).join("\n");
  assert.doesNotMatch(text, /Confirm Stop on its separate card|No stop has been sent yet/);
  assert.ok(findAction(delivered.message.card, "All actions"));
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
  await h.action(findAction(await openActions(h, a, "Steer"), "Steer"));
  await h.bridge.flush();
  const steering = findAction(delivered(h, surface(h.bridge.store.snapshot(), "actions", a).activityId), "Send steering");
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

for (const path of ["result", "steering"] as const) test(`R2-F1: real Control-origin ${path} receipts retain their IDs and reopen safely`, async (t) => {
  const h = await harness(t, false, undefined, { interaction: options });
  const id = await createWorking(h, "Control destination");
  await h.text("!control send the exact task to the selected source");
  const controller = h.bridge.store.snapshot().controllerId!;
  const send = h.runtime.live.get(controller)!.tools.find((tool) => tool.name === "bridge_send");
  assert.ok(send?.handler);
  const invoke = send.handler;
  const parameters = { sessionId: id, text: "Exact Control-origin task" };
  const invocation = { sessionId: controller, toolCallId: randomUUID(), toolName: "bridge_send", arguments: parameters };
  const receiptId = `control-tool:${controller}:${invocation.toolCallId}`;
  assert.equal(receiptId.length, 86);
  await invoke(parameters, invocation);
  await h.bridge.flush();
  let state = h.bridge.store.snapshot();
  assert.equal(state.receipts[receiptId]!.status, "accepted");
  const turn = state.interaction!.turns[receiptId]!;
  assert.equal(turn.state, "executing");
  assert.ok(turn.messageId);
  if (path === "result") {
    h.runtime.emit(id, "assistant.message", { messageId: "control-result", originatingMessageId: turn.messageId,
      content: "Correlated Control-origin result", phase: "final" });
    h.runtime.emit(id, "session.task_complete", { success: true });
    h.runtime.emit(id, "session.idle");
    await h.bridge.flush();
    state = h.bridge.store.snapshot();
    const result = state.outbox.find((item) => item.eventId === "control-result")!;
    assert.equal(result.status, "sent");
    assert.equal(result.direct, true);
    assert.equal(result.publication?.taskReceiptId, receiptId);
  } else {
    await h.action(findAction(await openActions(h, id, "Steer"), "Steer"));
    await h.bridge.flush();
    await h.action(findAction(delivered(h, surface(h.bridge.store.snapshot(), "actions", id).activityId), "Send steering"),
      { steering: "Preserve the original Control task" });
    await h.bridge.flush();
    state = h.bridge.store.snapshot();
    const steer = Object.values(state.interaction!.steers!)[0]!;
    assert.equal(steer.state, "accepted");
    assert.equal(steer.parentTurnId, receiptId);
    assert.equal(state.directOrigins[steer.id]!.parentTurnId, receiptId);
    assert.equal(state.outbox.length, 0, "restart must cover steering before any result");
  }
  const received = h.runtime.received.length;
  await assert.rejects(async () => invoke(parameters, invocation), /already received/);
  assert.equal(h.runtime.received.length, received);
  await h.bridge.close();
  const reopened = await Store.open(h.directory, "test-owner");
  try {
    const restored = reopened.snapshot();
    assert.deepEqual(restored.receipts, state.receipts);
    assert.equal(JSON.stringify(restored.outbox), JSON.stringify(state.outbox));
    assert.equal(JSON.stringify(restored.directOrigins), JSON.stringify(state.directOrigins));
    assert.deepEqual(restored.interaction!.steers, state.interaction!.steers);
    assert.equal(restored.interaction!.turns[receiptId]!.id, receiptId);
    assert.equal(restored.interaction!.turns[receiptId]!.state, path === "result" ? "done" : "uncertain");
  } finally { await reopened.close(); }
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
