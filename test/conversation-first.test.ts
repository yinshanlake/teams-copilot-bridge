import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Card, TimelineEntry } from "../src/domain.js";
import { inputSuffix, latestTranscriptPage, transcriptPages } from "../src/cards.js";
import { digest, object, UserError } from "../src/safety.js";
import { createWorking, eventually, findAction, harness, temporary } from "./helpers.js";
import { authorizeActivity } from "../src/teams.js";
import { mockEnvelope, mockIdentity } from "../src/simulator.js";

function visibleText(value: unknown): string {
  if (Array.isArray(value)) return value.map(visibleText).join("\n");
  if (!object(value) || value.type === "Action.ShowCard" || value.isVisible === false) return "";
  return [typeof value.text === "string" ? value.text : "", ...Object.entries(value)
    .filter(([key]) => key !== "data" && key !== "fallback").map(([, item]) => visibleText(item))].join("\n");
}

function notification(card: Card, id: string): Record<string, unknown> {
  const block = card.body.find((entry) => entry.id === `notification-state-${id}`);
  assert.ok(block);
  assert.equal(block.weight, "Bolder");
  assert.equal(block.size, "Default");
  assert.notEqual(block.isSubtle, true);
  return block;
}

test("entry sends labelled conversation to chat once and later finals do not mirror into its status card or replay history", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  h.runtime.live.get(id)!.events.push(
    { id: "q", type: "user.message", data: { messageId: "q", content: "Inspect this error/tool code.\r\n  Keep whitespace 🚀" } },
    { id: "comment", type: "assistant.message", data: { messageId: "comment", phase: "commentary", content: "INTERMEDIATE_PROGRESS" } },
    { id: "a", type: "assistant.message", data: { messageId: "a", phase: "final", content: "Substantive final.\n\n[Reference](https://example.test/a)" } },
  );
  await h.text(`!use ${id}`);
  await h.bridge.flush();
  const history = h.bridge.store.snapshot().outbox.filter((item) => item.historyId);
  assert.match(history.map((item) => item.text).join(""), /You[\s\S]*Inspect this error\/tool code\.\r\n  Keep whitespace 🚀[\s\S]*Copilot[\s\S]*Substantive final\./);
  assert.ok(!JSON.stringify(history).includes("INTERMEDIATE_PROGRESS"));
  const calls = t.mock.method(h.runtime, "history");
  await h.text("new explicit task after opening");
  h.runtime.emit(id, "assistant.message", { messageId: "live-final", phase: "final", content: "NEW_LIVE_RESULT_ONLY_ONCE" });
  h.runtime.emit(id, "session.idle");
  await h.bridge.flush();
  assert.ok(!visibleText(h.bridge.render(h.key)).includes("NEW_LIVE_RESULT_ONLY_ONCE"));
  assert.equal(h.bridge.store.snapshot().outbox.filter((item) => item.text === "NEW_LIVE_RESULT_ONLY_ONCE").length, 1);
  await h.action(findAction(h.bridge.render(h.key), "Check status"));
  assert.equal(calls.mock.callCount(), 0, "status checks no longer refresh a conversation body");
  assert.deepEqual(h.bridge.store.snapshot().outbox.filter((item) => item.historyId), history);
});

test("chat History distinguishes loading, failed reads and no available retained dialogue", async (t) => {
  const h = await harness(t);
  await createWorking(h);
  await h.text("!history");
  await h.bridge.flush();
  assert.match(h.bridge.store.snapshot().outbox.find((item) => item.historyId)!.text, /does not prove.*no older conversation/);
  let release: ((events: unknown[]) => void) | undefined;
  const pending = new Promise<unknown[]>((resolve) => { release = resolve; });
  const history = t.mock.method(h.runtime, "history", () => pending);
  try {
    await h.text("!history");
    await eventually(() => history.mock.callCount() === 1);
    assert.match(visibleText(h.bridge.render(h.key)), /Reading HISTORY snapshot/);
    release!([{ id: "loaded", type: "assistant.message", data: { messageId: "loaded", phase: "final", content: "Actual read completed" } }]);
    await h.bridge.flush();
    assert.ok(h.bridge.store.snapshot().outbox.some((item) => item.historyId && item.text.includes("Actual read completed")));
  } finally { release?.([]); history.mock.restore(); }
  t.mock.method(h.runtime, "history", async () => { throw new UserError("Synthetic readable-history failure."); });
  await h.text("!history");
  await h.bridge.flush();
  assert.match(visibleText(h.bridge.render(h.key)), /HISTORY read incomplete/);
  assert.ok(h.bridge.store.snapshot().outbox.some((item) => !item.historyId && item.text.includes("Synthetic readable-history failure")));
});

test("a stale A read cannot replace B or send A content when a bounded Control selection completes first", async (t) => {
  const h = await harness(t);
  const a = await createWorking(h, "Same display name");
  const b = await createWorking(h, "Same display name");
  await h.text("!control initialize bounded selection");
  const controller = h.bridge.store.snapshot().controllerId!;
  const select = h.runtime.live.get(controller)!.tools.find((tool) => tool.name === "bridge_select")!.handler;
  assert.ok(select);
  let release: ((events: unknown[]) => void) | undefined;
  const pending = new Promise<unknown[]>((resolve) => { release = resolve; });
  t.mock.method(h.runtime, "history", async (id: string) => id === a ? pending : [
    { id: "b-message", type: "assistant.message", data: { messageId: "shared-local-id", phase: "final", content: "B_EXACT_SOURCE_CONTEXT" } },
  ]);
  try {
    await h.text(`!use ${a}`);
    await select({ sessionId: b }, { sessionId: controller, toolCallId: randomUUID(), toolName: "bridge_select", arguments: { sessionId: b } });
    release!([{ id: "a-message", type: "assistant.message", data: { messageId: "shared-local-id", phase: "final", content: "A_MUST_NOT_REPLACE_B" } }]);
    await h.bridge.flush();
    assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
    const groups = h.bridge.store.snapshot().outbox.filter((item) => item.historyId && item.status !== "cancelled");
    assert.ok(groups.some((item) => item.sessionId === b && item.text.includes("B_EXACT_SOURCE_CONTEXT")));
    assert.ok(!groups.some((item) => item.text.includes("A_MUST_NOT_REPLACE_B")));
  } finally { release?.([]); }
});

test("History defaults to complete real dialogue without keyword-filtering code, technical questions or published replies", () => {
  const code = "```ts\r\nconst error = 'tool';\r\nconsole.log(error);\r\n```\n\n[Reference](https://example.test/tool-error)";
  const entries: TimelineEntry[] = [
    { id: "q", kind: "user", text: code, timestamp: "2026-11-16T00:00:00Z" },
    { id: "comment", kind: "assistant", phase: "commentary", state: "done", text: "TYPED_INTERMEDIATE_PROGRESS" },
    { id: "tool", kind: "tool", text: "RAW_TOOL_DIAGNOSTIC" },
    { id: "agent", kind: "agent", text: "AGENT_DIAGNOSTIC" },
    { id: "task", kind: "task", text: "TASK_COMPLETION_DIAGNOSTIC" },
    { id: "status", kind: "status", text: "NATIVE_STATUS_DIAGNOSTIC" },
    { id: "question", kind: "assistant", phase: "final", text: "Which error/tool example?", timestamp: "2026-11-16T00:01:00Z" },
    { id: "answer", kind: "user", text: "Use the tool failure example.", timestamp: "2026-11-16T00:02:00Z" },
    { id: "published", kind: "assistant", phase: "final", text: "PUBLISHED_VISIBLE_REPLY\r\nOriginal code error/tool explanation 🚀", timestamp: "2026-11-16T00:03:00Z" },
  ];
  assert.deepEqual(transcriptPages(entries), [
    `**You**\n\n${code}\n\n**Copilot**\n\nWhich error/tool example?\n\n**You**\n\nUse the tool failure example.\n\n**Copilot**\n\nPUBLISHED_VISIBLE_REPLY\r\nOriginal code error/tool explanation 🚀`,
  ]);
  const long = `${code}\n\n中文 🚀\r\n`.repeat(1000) + "FULL_UNICODE_SUFFIX";
  const pages = transcriptPages([...entries, { id: "long", kind: "assistant", phase: "final", text: long, timestamp: "2026-11-16T00:04:00Z" }]);
  assert.equal(pages.slice(1).join(""), `**Copilot**\n\n${long}`);
  assert.ok(pages.every((page) => Buffer.byteLength(page) <= 7000 && !page.includes("\uFFFD")));
  assert.equal(entries.length, 9);
});

test("initial advanced History paging includes the newest unanswered multi-page user message, not the previous answer", () => {
  const entries: TimelineEntry[] = [
    { id: "previous", kind: "assistant", phase: "final", text: "PREVIOUS ANSWER" },
    { id: "question", kind: "user", text: `NEW QUESTION\n${"x".repeat(7500)}\r\nNEW_QUESTION_END 🚀` },
    { id: "comment", kind: "assistant", phase: "commentary", text: "HIDDEN_COMMENTARY" },
  ];
  const pages = transcriptPages(entries);
  assert.equal(pages.length, 3);
  assert.equal(latestTranscriptPage(entries), pages.length - 1);
  assert.match(pages.at(-1)!, /NEW_QUESTION_END 🚀$/u);
});

test("signed History emits chat while retained advanced paging keeps canonical scopes, latest dialogue and notification state", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  h.runtime.live.get(id)!.events.push(
    { id: "answer", type: "assistant.message", data: { messageId: "answer", phase: "final", content: "PREVIOUS ANSWER" } },
    { id: "question", type: "user.message", data: { messageId: "question", content: `NEW QUESTION\n${"x".repeat(7500)}\r\nNEW_QUESTION_END 🚀` } },
  );
  const before = notification(h.bridge.render(h.key), id);
  await h.action(findAction(h.bridge.render(h.key), "History"));
  await h.bridge.flush();
  assert.ok(h.bridge.store.snapshot().outbox.some((item) => item.historyId && item.text.includes("NEW_QUESTION_END")));
  const history = await h.text("!read");
  const state = h.bridge.store.snapshot();
  const conversation = state.conversations[h.key]!;
  const pages = transcriptPages(state.sessions[id]!.timeline);
  assert.equal(conversation.transcriptId, id);
  assert.equal(conversation.page, pages.length - 1);
  assert.equal(history.body.find((entry) => entry.id === "transcript-page-text")?.text, pages.at(-1));
  assert.deepEqual(notification(history, id), before);
  const older = findAction(history, "Older");
  assert.ok(object(older.data));
  assert.equal(h.bridge.actions.verify(older.data.token, conversation).targetId, id);
  const previous = await h.action(older);
  const current = await h.action(findAction(previous, "Newer"));
  assert.equal(current.body.find((entry) => entry.id === "transcript-page-text")?.text, pages.at(-1));
});

test("notification headers reflect exact-source on/off/paused on root, side, Home and History, never optimistic inheritance", async (t) => {
  const h = await harness(t);
  const parent = await createWorking(h, "Parent");
  const side = await createWorking(h, "Side");
  await h.bridge.store.mutate((state) => { state.sessions[side]!.sideChat = { parentId: parent }; });
  await h.text(`!use ${parent}`);
  await h.text("!subscribe");
  assert.equal(notification(h.bridge.render(h.key), parent).text, "Notifications: Subscribed");
  await h.text(`!use ${side}`);
  assert.equal(notification(await h.text("!home"), side).text, "Notifications: Not subscribed");
  await h.bridge.store.mutate((state) => {
    state.conversations[h.key]!.view = "transcript";
    state.conversations[h.key]!.transcriptId = parent;
    state.subscriptions[digest(`${h.key}:${parent}`)]!.status = "paused";
    state.subscriptions[digest(`${h.key}:${parent}`)]!.detail = "Subscription paused: observed journal changed.";
  });
  assert.equal(notification(h.bridge.render(h.key), parent).text, "Notifications: Paused");
  assert.match(visibleText(h.bridge.render(h.key)), /observed journal changed/);
  await h.bridge.store.mutate((state) => { state.subscriptions[digest(`${h.key}:${parent}`)]!.enabled = false; });
  assert.equal(notification(h.bridge.render(h.key), parent).text, "Notifications: Not subscribed");
  await h.text("!status");
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(h.runtime, "subscriptionBaseline", async () => {
    await pending;
    return { generation: "mock", offset: 0, index: 0, anchor: digest(""), eofRecord: false, requests: [], starts: [], outputs: [] };
  });
  const subscribing = h.text("!subscribe");
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(notification(h.bridge.render(h.key), side).text, "Notifications: Not subscribed");
  } finally { release?.(); await subscribing; }
  assert.equal(notification(h.bridge.render(h.key), side).text, "Notifications: Subscribed");
});

test("chat history keeps Unicode/CRLF and 12KB messages while pending forms contain only their own request inputs", async (t) => {
  const h = await harness(t, true);
  const id = await createWorking(h);
  h.runtime.live.get(id)!.events.push(
    { id: "q", type: "user.message", data: { messageId: "q", content: "长输入 🚀\r\n".repeat(1500) } },
    { id: "a", type: "assistant.message", data: { messageId: "a", phase: "final", content: "长回复 🌍\r\n".repeat(1500) + "EXACT_LONG_END" } },
  );
  await h.text(`!use ${id}`);
  await h.bridge.flush();
  const history = h.bridge.store.snapshot().outbox.filter((item) => item.historyId);
  assert.ok(history.map((item) => item.text).join("").endsWith("EXACT_LONG_END"));
  assert.ok(history.every((item) => Buffer.byteLength(item.text) < 12_000 && !item.text.includes("\uFFFD")));
  await h.text("ask");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[id]!.pending.length));
  const pending = h.bridge.store.snapshot().sessions[id]!.pending[0]!;
  const form = h.bridge.render(h.key);
  assert.ok(!JSON.stringify(form).includes('"id":"message"') && !JSON.stringify(form).includes("entry-context"));
  assert.ok(Buffer.byteLength(JSON.stringify(form)) <= 27_000);
  const answer = findAction(form, "Answer");
  assert.ok(object(answer.data));
  assert.equal(h.bridge.actions.verify(answer.data.token, h.bridge.store.snapshot().conversations[h.key]!).requestId, pending.id);
  await h.action(answer, { [`choice_${inputSuffix(pending.id)}`]: "0", [`text_${inputSuffix(pending.id)}`]: "" });
  assert.equal(h.runtime.answers.length, 1);
  assert.equal(h.runtime.received.length, 1);
});

test("restart retains the canonical selected source and its completed history without replay or SDK resume", async (t) => {
  const directory = await temporary(t);
  const first = await harness(t, false, directory);
  const a = await createWorking(first, "Same title");
  const b = await createWorking(first, "Same title");
  first.runtime.live.get(a)!.events.push({ id: "only-a", type: "assistant.message", data: { messageId: "reused", phase: "final", content: "RETAINED_A" } });
  first.runtime.live.get(b)!.events.push({ id: "only-b", type: "assistant.message", data: { messageId: "reused", phase: "final", content: "RETAINED_B" } });
  await first.text(`!use ${b}`);
  await first.bridge.flush();
  const history = first.bridge.store.snapshot().outbox.filter((item) => item.historyId);
  await first.bridge.close();
  const second = await harness(t, false, directory, { initializeConversation: false });
  await second.bridge.flush();
  assert.equal(second.bridge.store.snapshot().conversations[first.key]!.selectedId, b);
  assert.deepEqual(second.bridge.store.snapshot().outbox.filter((item) => item.historyId), history);
  assert.ok(!visibleText(second.bridge.render(first.key)).includes("RETAINED_A"));
  assert.deepEqual(second.runtime.resumed, []);
  assert.deepEqual(second.runtime.received, []);
  assert.equal(second.runtime.live.size, 0);
});

test("a disconnected source with no retained dialogue remains unknown rather than claiming its original history is empty", async (t) => {
  const directory = await temporary(t);
  const first = await harness(t, false, directory);
  await createWorking(first);
  await first.bridge.close();
  const restored = await harness(t, false, directory, { initializeConversation: false });
  const reads = t.mock.method(restored.runtime, "history", async () => { throw new Error("Do not start runtime reads."); });
  await restored.text("!history");
  await restored.bridge.flush();
  const history = restored.bridge.store.snapshot().outbox.find((item) => item.historyId)!;
  assert.match(history.text, /does not prove.*no older conversation/);
  assert.equal(reads.mock.callCount(), 0);
  assert.deepEqual(restored.runtime.resumed, []);
});

test("read-only and stale side sources still provide explicit history without Send, notification inheritance or endpoint changes", async (t) => {
  const h = await harness(t);
  const parent = await createWorking(h);
  const side = await createWorking(h, "Side");
  h.runtime.live.get(side)!.events.push({ id: "side", type: "assistant.message", data: { messageId: "side", phase: "final", content: "OWN_SIDE_RESULT" } });
  await h.bridge.store.mutate((state) => {
    Object.assign(state.sessions[side]!, { sideChat: { parentId: parent }, kind: "peer", peerSource: "app",
      status: "offline", liveUntil: Date.now() - 1, access: { read: true, send: false } });
  });
  await h.text(`!use ${side}`);
  await h.bridge.flush();
  const card = h.bridge.render(h.key);
  assert.throws(() => findAction(card, "Send"), /not found/);
  assert.ok(!visibleText(card).includes("OWN_SIDE_RESULT"));
  assert.equal(notification(card, side).text, "Notifications: Not subscribed");
  assert.ok(h.bridge.store.snapshot().outbox.some((item) => item.historyId && item.sessionId === side && item.text.includes("OWN_SIDE_RESULT")));
  assert.equal(h.bridge.store.snapshot().sessions[side]!.access?.send, false);
});

test("two authorized Teams conversations read the same source with independent intent, body and recipient identities", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  h.runtime.live.get(id)!.events.push({ id: "first", type: "assistant.message", data: { messageId: "first", phase: "final", content: "FIRST_WINDOW" } });
  await h.text(`!use ${id}`);
  await h.bridge.flush();
  const first = h.bridge.store.snapshot().outbox.filter((item) => item.historyId);
  h.runtime.live.get(id)!.events.push({ id: "second", type: "assistant.message", data: { messageId: "second", phase: "final", content: "LATER_WINDOW" } });
  const envelope = mockEnvelope(`!use ${id}`);
  assert.ok(object(envelope.conversation));
  envelope.conversation.id = "second-authorized-conversation";
  const turn = authorizeActivity(envelope, { aud: mockIdentity.appId }, mockIdentity);
  await h.bridge.handle(turn.key, turn.reference, turn.activity.id!, turn.incoming);
  await h.bridge.flush();
  assert.deepEqual(h.bridge.store.snapshot().outbox.filter((item) => item.historyId && item.conversationKey === h.key), first);
  const second = h.bridge.store.snapshot().outbox.filter((item) => item.historyId && item.conversationKey === turn.key);
  assert.ok(second.some((item) => item.text.includes("LATER_WINDOW")));
  assert.notEqual(second[0]!.eventId, first[0]!.eventId);
});
