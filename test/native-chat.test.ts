import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { OutboxItem } from "../src/domain.js";
import { outboundActivity } from "../src/teams.js";
import { digest, object } from "../src/safety.js";
import { createWorking, eventually, findAction, harness, temporary } from "./helpers.js";

function historyItems(items: OutboxItem[]): OutboxItem[] {
  return items.filter((item) => item.historyId);
}

function fixtureEvents(prefix: string, count = 12): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`, type: index % 2 ? "assistant.message" : "user.message",
    timestamp: new Date(Date.UTC(2026, 10, 16, 0, index)).toISOString(),
    data: { messageId: `local-${index}`, ...(index % 2 ? { phase: "final" } : {}), content: `${prefix}_BODY_${index}\r\nconst error = 'tool'; 🚀` },
  }));
}

test("native chat recognizes only explicit valid ! commands; old entry words, slash text and code stay literal", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  for (const text of ["Home", "Sessions", "history", "Working", "list sessions", "选择会话 x", "/stop", "/control list",
    "control: list sessions", "```ps1\r\n!status\r\n```", "  exact <b>HTML</b>\r\n中文 🚀  "]) {
    await h.text(text);
    assert.deepEqual(h.runtime.received.at(-1), { sessionId: id, text });
  }
  const received = structuredClone(h.runtime.received);
  for (const command of ["!unknown", "!sessions extra", "!status x", "!use", "!history 0", "!history 51", "!history 1.5",
    "!history 2 extra", "!subscribe x", "!!sessions"]) {
    await h.text(command);
    assert.deepEqual(h.runtime.received, received, `${command} must fail closed instead of becoming work`);
    assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, id);
    assert.deepEqual(h.bridge.store.snapshot().subscriptions, {});
    assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /!|command|History/iu);
  }
  await h.text("!help");
  await h.text("!status");
  await h.text("!sessions");
  assert.deepEqual(h.runtime.received, received);
  assert.equal(h.runtime.live.has(h.bridge.store.snapshot().controllerId!), false);
});

test("!use resolves names and canonical prefixes only when unambiguous and never chooses by shared cwd", async (t) => {
  const h = await harness(t);
  const a = await createWorking(h, "Same name");
  const b = await createWorking(h, "Same name");
  const side = await createWorking(h, "Actual side");
  await h.bridge.store.mutate((state) => { state.sessions[side]!.sideChat = { parentId: a }; });
  const history = t.mock.method(h.runtime, "history", async (id: string) => fixtureEvents(id, 2));
  await h.text("!use Same name");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, side);
  assert.equal(history.mock.callCount(), 0);
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /ambiguous/iu);
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, new RegExp(a));
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, new RegExp(b));
  await h.text(`!use ${a.slice(0, 8)}`);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, a);
  await h.text("!use Actual side");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, side);
  assert.deepEqual(h.runtime.received, []);
  assert.deepEqual(h.runtime.resumed, []);
});

test("queued !use B and native work preserve order, while ambiguous or failed selection blocks work on the retained old source across restart", async (t) => {
  const directory = await temporary(t);
  const h = await harness(t, false, directory);
  const a = await createWorking(h, "Same name");
  const b = await createWorking(h, "Same name");
  const selecting = h.text(`!use ${a}`);
  const work = h.text("TASK_FOR_A");
  await Promise.all([selecting, work]);
  assert.deepEqual(h.runtime.received, [{ sessionId: a, text: "TASK_FOR_A" }]);
  await h.text("!use Same name");
  await h.text("MUST_NOT_FALL_BACK");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, a);
  assert.equal(h.runtime.received.length, 1);
  assert.match(JSON.stringify(h.bridge.render(h.key).body), /Destination unresolved/);
  await h.text("!sessions");
  await h.text("STILL_BLOCKED_AFTER_BROWSING");
  assert.equal(h.runtime.received.length, 1);
  await h.text(`!use ${b}`);
  await h.text("TASK_FOR_B");
  assert.deepEqual(h.runtime.received.at(-1), { sessionId: b, text: "TASK_FOR_B" });
  await h.text(`!use ${randomUUID()}`);
  await h.text("NOT_SENT_TO_B");
  assert.equal(h.runtime.received.length, 2);
  await h.bridge.close();
  const restored = await harness(t, false, directory, { initializeConversation: false });
  await restored.text("BLOCK_SURVIVES_RESTART");
  assert.deepEqual(restored.runtime.received, []);
  assert.equal(restored.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
  await restored.text(`!use ${b}`);
  await restored.text("EXPLICIT_VALID_TARGET");
  assert.deepEqual(restored.runtime.received, [{ sessionId: b, text: "EXPLICIT_VALID_TARGET" }]);
});

test("the selected-source card is status-only with full source identity and notifications; no card composer or transcript", async (t) => {
  const h = await harness(t);
  const parent = await createWorking(h, "Parent");
  const side = await createWorking(h, "Same title");
  await h.bridge.store.mutate((state) => { state.sessions[side]!.sideChat = { parentId: parent }; });
  h.runtime.live.get(side)!.events.push(...fixtureEvents("PRIVATE_SOURCE"));
  await h.text(`!use ${side}`);
  const card = await h.text("!status");
  const primary = JSON.stringify(card.body);
  assert.match(primary, new RegExp(side));
  assert.match(primary, /Parent|Side chat/);
  assert.match(primary, /Notifications: Not subscribed/);
  assert.match(primary, /!history|!help/);
  assert.ok(!primary.includes("PRIVATE_SOURCE"));
  assert.ok(!primary.includes('"id":"message"') && !primary.includes("entry-context"));
  assert.throws(() => findAction(card, "Send"), /not found/);
  assert.ok(Buffer.byteLength(JSON.stringify(card)) <= 27_000);
});

test("selecting a source sends one labelled latest-ten HISTORY group without asking the source to summarize or forwarding it", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h, "History source");
  const events = fixtureEvents("ORIGINAL");
  events.push({ id: "comment", type: "assistant.message", data: { messageId: "comment", phase: "commentary", content: "HIDDEN_COMMENTARY" } });
  h.runtime.live.get(id)!.events.push(...events);
  const unchanged = structuredClone(h.runtime.live.get(id)!.events);
  const activityId = randomUUID();
  await h.text(`!use ${id}`, activityId);
  await eventually(() => historyItems(h.bridge.store.snapshot().outbox).length > 0);
  await h.bridge.flush();
  const group = historyItems(h.bridge.store.snapshot().outbox);
  const text = group.map((item) => item.text).join("");
  assert.ok(!text.includes("ORIGINAL_BODY_0\r\n") && !text.includes("ORIGINAL_BODY_1\r\n"));
  assert.match(text, /ORIGINAL_BODY_2\r\n/);
  assert.match(text, /ORIGINAL_BODY_11\r\n/);
  assert.match(text, /\*\*You\*\*[\s\S]*\*\*Copilot\*\*/);
  assert.ok(!text.includes("HIDDEN_COMMENTARY"));
  assert.deepEqual(h.runtime.live.get(id)!.events, unchanged);
  assert.deepEqual(h.runtime.received, []);
  const sent = [...h.transport.messages.values()].filter((item) => item.message.type === "text" && String(item.message.presentation?.kind) === "history");
  assert.equal(sent.length, group.length);
  for (const item of sent) {
    const activity = outboundActivity(item.message);
    assert.match(activity.text!, /HISTORY/);
    assert.match(activity.text!, new RegExp(id));
    assert.match(activity.text!, /read-only/iu);
    assert.ok(Buffer.byteLength(activity.text!) <= 12_000);
  }
  await h.text(`!use ${id}`, activityId);
  await h.bridge.flush();
  assert.deepEqual(historyItems(h.bridge.store.snapshot().outbox), group);
});

test("History read actions consume their nonce once across distinct activity retries and restart never regenerates the group", async (t) => {
  const directory = await temporary(t);
  const h = await harness(t, false, directory);
  const id = await createWorking(h);
  h.runtime.live.get(id)!.events.push(...fixtureEvents("RESTART", 2));
  const action = findAction(h.bridge.render(h.key), "History");
  await h.action(action);
  await eventually(() => historyItems(h.bridge.store.snapshot().outbox).length > 0);
  await h.bridge.flush();
  const before = historyItems(h.bridge.store.snapshot().outbox);
  await h.action(action);
  await h.bridge.flush();
  assert.deepEqual(historyItems(h.bridge.store.snapshot().outbox), before);
  await h.bridge.close();
  const restored = await harness(t, false, directory, { initializeConversation: false });
  await restored.bridge.flush();
  assert.deepEqual(historyItems(restored.bridge.store.snapshot().outbox), before);
  assert.deepEqual(restored.runtime.received, []);
  assert.deepEqual(restored.runtime.resumed, []);
  assert.ok(![...restored.transport.messages.values()].some((item) => item.message.type === "text" && item.message.text.includes("RESTART_BODY")));
});

test("a superseded slow A history cannot be delivered or relabelled after canonical B selection", async (t) => {
  const h = await harness(t);
  const a = await createWorking(h, "Shared title");
  const b = await createWorking(h, "Shared title");
  let release: ((events: unknown[]) => void) | undefined;
  const paused = new Promise<unknown[]>((resolve) => { release = resolve; });
  const history = t.mock.method(h.runtime, "history", async (id: string) => id === a ? paused : fixtureEvents("B_ONLY", 2));
  const requestId = randomUUID();
  try {
    await h.text(`!use ${a}`, requestId);
    await eventually(() => history.mock.callCount() === 1);
    await h.text(`!use ${b}`);
    await eventually(() => historyItems(h.bridge.store.snapshot().outbox).some((item) => item.sessionId === b));
    release!(fixtureEvents("STALE_A", 2));
    await h.bridge.flush();
    assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
    assert.ok(!historyItems(h.bridge.store.snapshot().outbox).some((item) => item.sessionId === a && item.status !== "cancelled"));
    assert.ok(![...h.transport.messages.values()].some((item) => item.message.type === "text" && item.message.text.includes("STALE_A")));
    assert.match(h.bridge.store.snapshot().receipts[Object.keys(h.bridge.store.snapshot().receipts).find((key) =>
      h.bridge.store.snapshot().receipts[key]!.detail.includes("supersed")) ?? ""]?.detail ?? "", /supersed/iu);
    assert.deepEqual(h.runtime.received, []);
  } finally { release?.([]); }
});

test("history count and native compose preserve whole Unicode/CRLF bodies and explicit subscription/direct-response ownership", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const body = "Original `code` PROTECTED_17\r\n```ts\r\nconst tool = 'error';\r\n```\r\n中文 🚀".repeat(150);
  h.runtime.live.get(id)!.events.push(
    { id: "question", type: "user.message", data: { messageId: "local", content: "Genuine user body" } },
    { id: "answer", type: "assistant.message", data: { messageId: "local-reply", phase: "final", content: body } },
  );
  await h.text("!history 1");
  await eventually(() => historyItems(h.bridge.store.snapshot().outbox).length > 0);
  const history = historyItems(h.bridge.store.snapshot().outbox);
  assert.ok(history.map((item) => item.text).join("").endsWith(body));
  assert.ok(!history.map((item) => item.text).join("").includes("Genuine user body"));
  await h.text("!subscribe");
  assert.equal(Object.values(h.bridge.store.snapshot().subscriptions).filter((item) => item.enabled).length, 1);
  const saved = structuredClone(Object.values(h.bridge.store.snapshot().subscriptions)[0]!.cursor);
  await h.text("literal direct task\r\n!unsubscribe stays inside this task");
  const origin = h.runtime.live.get(id)!.origin!;
  await h.text("!unsubscribe");
  const subscription = Object.values(h.bridge.store.snapshot().subscriptions)[0]!;
  assert.equal(subscription.enabled, false);
  assert.deepEqual(subscription.cursor, saved);
  h.runtime.emit(id, "assistant.message", { messageId: "direct-final", phase: "final", content: "DIRECT_FINAL", originatingMessageId: origin });
  await h.bridge.flush();
  const finals = h.bridge.store.snapshot().outbox.filter((item) => item.eventId === "direct-final");
  assert.equal(finals.length, 1);
  assert.equal(finals[0]!.direct, true);
  assert.equal(finals[0]!.status, "sent");
  assert.ok(historyItems(h.bridge.store.snapshot().outbox).every((item) => item.status !== "cancelled"));
});

test("new formatter is versioned without rewriting legacy v2/plain message bytes, status or final identity", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.bridge.store.mutate((state) => { state.outbox.push({
    id: "legacy-v2", conversationKey: h.key, sessionId: id, eventId: "legacy-v2", status: "uncertain", text: "ORIGINAL `code`",
    presentation: { version: 2, kind: "session", title: "Original title", groupId: "legacy", part: 1, parts: 1 },
  }); });
  const legacy = structuredClone(h.bridge.store.snapshot().outbox.find((item) => item.id === "legacy-v2")!);
  await h.text("ordinary task");
  h.runtime.emit(id, "assistant.message", { messageId: "new-format", phase: "final", content: "UNCHANGED `code` PROTECTED_17" });
  await h.bridge.flush();
  const current = h.bridge.store.snapshot().outbox.find((item) => item.eventId === "new-format")!;
  assert.equal(current.presentation?.version, 4);
  assert.equal(outboundActivity({ type: "text", text: current.text, presentation: current.presentation! }).textFormat, "markdown");
  assert.equal(outboundActivity({ type: "text", text: legacy.text, presentation: legacy.presentation! }).textFormat, "extendedmarkdown");
  assert.equal(current.text, "UNCHANGED `code` PROTECTED_17");
  assert.deepEqual(h.bridge.store.snapshot().outbox.find((item) => item.id === "legacy-v2"), legacy);
  assert.ok(object(current.presentation));
  assert.match(outboundActivity({ type: "text", text: current.text, presentation: current.presentation }).text!, new RegExp(id.slice(0, 8)));
});

test("timed-out history attempts retain actual concurrency slots and cannot publish old data into a fresh selection", async (t) => {
  const h = await harness(t, false, undefined, { historyReadTimeoutMs: 30 });
  const a = await createWorking(h);
  const b = await createWorking(h);
  let release: ((events: unknown[]) => void) | undefined;
  const paused = new Promise<unknown[]>((resolve) => { release = resolve; });
  const reads = t.mock.method(h.runtime, "history", () => paused);
  try {
    await h.text("!history");
    await eventually(() => h.bridge.store.snapshot().conversations[h.key]!.historyRead?.status === "failed");
    await h.text("!history");
    await eventually(() => reads.mock.callCount() === 2);
    await eventually(() => h.bridge.store.snapshot().conversations[h.key]!.historyRead?.status === "failed");
    await h.text(`!use ${a}`);
    assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /Two history reads/);
    assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
    release!(fixtureEvents("OLD_TIMEOUT_BODY", 2));
    await h.bridge.flush();
    assert.equal(historyItems(h.bridge.store.snapshot().outbox).length, 0);
    assert.ok(!JSON.stringify(h.bridge.store.snapshot()).includes("OLD_TIMEOUT_BODY"));
  } finally { release?.([]); reads.mock.restore(); }
  await h.text(`!use ${a}`);
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, a);
  assert.ok(historyItems(h.bridge.store.snapshot().outbox).every((item) => item.sessionId === a));
});

test("interrupted history intent and uncertain history delivery survive restart without automatic read, resend or task replay", async (t) => {
  const directory = await temporary(t);
  const h = await harness(t, false, directory);
  const id = await createWorking(h);
  h.runtime.live.get(id)!.events.push(...fixtureEvents("UNCERTAIN_HISTORY", 2));
  await h.text("!history");
  await h.bridge.flush();
  const group = historyItems(h.bridge.store.snapshot().outbox);
  assert.ok(group.length);
  const interruptedId = digest("synthetic-interrupted-history");
  await h.bridge.store.mutate((state) => {
    state.outbox.find((item) => item.id === group[0]!.id)!.status = "sending";
    state.conversations[h.key]!.historyRead = { id: interruptedId, sessionId: id, count: 10,
      status: "reading", receiptIds: [] };
  });
  await h.bridge.close();
  const restored = await harness(t, false, directory, { initializeConversation: false });
  const reads = t.mock.method(restored.runtime, "history");
  await restored.bridge.flush();
  assert.equal(restored.bridge.store.snapshot().conversations[h.key]!.historyRead?.status, "interrupted");
  assert.match(JSON.stringify(restored.bridge.render(h.key).body), /interrupted|incomplete/iu);
  assert.equal(restored.bridge.store.snapshot().outbox.find((item) => item.id === group[0]!.id)!.status, "uncertain");
  assert.equal(reads.mock.callCount(), 0);
  assert.deepEqual(restored.runtime.received, []);
  assert.deepEqual(restored.runtime.resumed, []);
  assert.ok(![...restored.transport.messages.values()].some((item) => item.message.type === "text"));
});

test("!unsubscribe cancels the exact persisted absent source without liveness, history or baseline reads and preserves direct responses", async (t) => {
  const h = await harness(t, false, undefined, { deliveryInitiallyPaused: true });
  const id = await createWorking(h);
  await h.text("!subscribe");
  const subscription = Object.values(h.bridge.store.snapshot().subscriptions)[0]!;
  await h.bridge.store.mutate((state) => {
    state.outbox.push(
      { id: "notification", conversationKey: h.key, sessionId: id, eventId: "notification", text: "not yet sent",
        status: "pending", subscription: { id: subscription.id, revision: subscription.revision } },
      { id: "direct", conversationKey: h.key, sessionId: id, eventId: "direct", text: "direct result", status: "pending", direct: true },
    );
    delete state.sessions[id];
  });
  const history = t.mock.method(h.runtime, "history");
  const baseline = t.mock.method(h.runtime, "subscriptionBaseline");
  const liveness = t.mock.method(h.runtime, "appLiveness");
  const preview = t.mock.method(h.runtime, "preview");
  await h.text("!unsubscribe");
  const state = h.bridge.store.snapshot();
  assert.equal(state.subscriptions[subscription.id]!.enabled, false);
  assert.equal(state.outbox.find((item) => item.id === "notification")!.status, "cancelled");
  assert.notEqual(state.outbox.find((item) => item.id === "direct")!.status, "cancelled");
  assert.match(JSON.stringify(h.bridge.render(h.key).body), new RegExp(id));
  assert.match(JSON.stringify(h.bridge.render(h.key).body), /Notifications: Not subscribed/);
  assert.deepEqual(state.subscriptions[subscription.id]!.cursor, subscription.cursor);
  assert.deepEqual([history, baseline, liveness, preview].map((mock) => mock.mock.callCount()), [0, 0, 0, 0]);
});

test("over-budget HISTORY fails explicitly without truncating the safe source body or becoming a live result", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const original = "完整原文 🚀\r\n".repeat(9000);
  h.runtime.live.get(id)!.events.push({ id: "large", type: "assistant.message",
    data: { messageId: "large", phase: "final", content: original } });
  await h.text("!history 1");
  await h.bridge.flush();
  assert.equal(historyItems(h.bridge.store.snapshot().outbox).length, 0);
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /128000-byte group budget/);
  assert.ok(h.bridge.store.snapshot().sessions[id]!.timeline.some((entry) => entry.text === original));
  assert.deepEqual(h.runtime.received, []);
});

test("history intents occupy a distinct delivery namespace even when a native final reuses the same local event ID", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.text("!history");
  await h.bridge.flush();
  const history = historyItems(h.bridge.store.snapshot().outbox)[0]!;
  await h.text("explicit work");
  h.runtime.emit(id, "assistant.message", { messageId: history.eventId, phase: "final", content: "GENUINE_FINAL" });
  await h.bridge.flush();
  const result = h.bridge.store.snapshot().outbox.find((item) => item.direct && item.eventId === history.eventId)!;
  assert.ok(result && result.id !== history.id);
  assert.equal(result.text, "GENUINE_FINAL");
  assert.equal(result.status, "sent");
  assert.equal(result.id, digest(`${h.key}:${id}:${history.eventId}:0`), "canonical live result identities remain unchanged");
  assert.deepEqual(h.bridge.store.snapshot().outbox.find((item) => item.id === history.id), history);
});

test("plain HISTORY uses plain generated source and role headers while preserving every original local-reference/code byte", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const input = "Question with `inline code` and PROTECTED_0\r\n";
  const body = "| File |\r\n| --- |\r\n| [`Label`](<Q:\\MOCK\\source.rs#L1>) |\r\n\r\n```rs\r\nlet x = \"<raw>\";\r\n```\r\n中文 🚀";
  h.runtime.live.get(id)!.events.push(
    { id: "q", type: "user.message", data: { messageId: "q", content: input } },
    { id: "a", type: "assistant.message", data: { messageId: "a", phase: "final", content: body } },
  );
  await h.text("!history 2");
  await h.bridge.flush();
  const items = historyItems(h.bridge.store.snapshot().outbox);
  const text = items.map((item) => item.text).join("");
  assert.match(text, /You\n\nQuestion/);
  assert.match(text, /Copilot\n\n\| File/);
  assert.ok(!text.includes("**You**") && !text.includes("**Copilot**"));
  assert.ok(text.includes(input) && text.endsWith(body));
  for (const item of items) {
    const activity = outboundActivity({ type: "text", text: item.text, presentation: item.presentation! });
    assert.equal(activity.textFormat, "xml");
    assert.ok(!activity.text!.startsWith("**") && activity.text!.includes(id) && activity.text!.includes("<br>"));
  }
});

test("repeated explicit !subscribe is idempotent and a paused subscription never silently gets a new baseline", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.text("!subscribe");
  const saved = structuredClone(Object.values(h.bridge.store.snapshot().subscriptions)[0]!);
  const baseline = t.mock.method(h.runtime, "subscriptionBaseline");
  await h.text("!subscribe");
  assert.deepEqual(Object.values(h.bridge.store.snapshot().subscriptions)[0], saved);
  await h.bridge.store.mutate((state) => { state.subscriptions[saved.id]!.status = "paused"; });
  await h.text("!subscribe");
  const paused = h.bridge.store.snapshot().subscriptions[saved.id]!;
  assert.equal(paused.status, "paused");
  assert.deepEqual(paused.cursor, saved.cursor);
  assert.equal(paused.revision, saved.revision);
  assert.equal(baseline.mock.callCount(), 0);
  assert.match(JSON.stringify(h.bridge.render(h.key).body), /Notifications: Paused/);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, id);
});
