import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { outboundActivity } from "../src/teams.js";
import { digest, object } from "../src/safety.js";
import { createWorking, eventually, findAction, harness, legacySend } from "./helpers.js";
import { Store } from "../src/store.js";
import type { ConversationPreview } from "../src/domain.js";

function visibleText(value: unknown): string {
  if (Array.isArray(value)) return value.map(visibleText).join("\n");
  if (!object(value) || value.type === "Action.ShowCard" || value.isVisible === false) return "";
  return [typeof value.text === "string" ? value.text : "", ...Object.entries(value)
    .filter(([key]) => key !== "data" && key !== "fallback").map(([, item]) => visibleText(item))].join("\n");
}

function excerpts(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(excerpts);
  if (!object(value)) return [];
  if (value.type === "TextBlock" && typeof value.id === "string" && value.id.startsWith("excerpt-") && typeof value.text === "string") {
    return [value.text];
  }
  return Object.entries(value).filter(([key]) => key !== "data" && key !== "fallback").flatMap(([, item]) => excerpts(item));
}

test("v2 Home and personal commands are deterministic entry points and ordinary selected text remains literal work", async (t) => {
  const h = await harness(t, false, undefined, { initializeConversation: false });
  const first = await h.text("Hello");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.view, "sessions");
  assert.equal(first.body[0]?.text, "Sessions");
  assert.ok(findAction(first, "Home"));
  assert.deepEqual(h.runtime.received, []);
  const id = await createWorking(h);
  for (const [command, view] of [["!home", "home"], ["!sessions", "sessions"], ["!working", "working"], ["!needs-reply", "needs-reply"]] as const) {
    await h.text(command);
    assert.equal(h.bridge.store.snapshot().conversations[h.key]!.view, view);
    assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, id);
    if (view !== "home") assert.ok(findAction(h.bridge.render(h.key), "Home"));
  }
  const prompt = " ordinary content while Home is open\r\n keep exactly 🚀 ";
  await h.text("!home");
  await h.text(prompt);
  assert.deepEqual(h.runtime.received, [{ sessionId: id, text: prompt }]);
  assert.equal(h.runtime.live.has(h.bridge.store.snapshot().controllerId!), false);
});

test("Teams manifest advertises only explicit ! personal-chat commands, never slash or ordinary business words", async () => {
  const manifest: unknown = JSON.parse(await readFile(join(import.meta.dirname, "..", "..", "teams-package", "manifest.template.json"), "utf8"));
  assert.ok(object(manifest) && Array.isArray(manifest.bots) && object(manifest.bots[0]));
  const bot = manifest.bots[0];
  assert.deepEqual(bot.scopes, ["personal"]);
  assert.ok(Array.isArray(bot.commandLists) && object(bot.commandLists[0]));
  assert.deepEqual(bot.commandLists[0].scopes, ["personal"]);
  assert.ok(Array.isArray(bot.commandLists[0].commands));
  assert.deepEqual(bot.commandLists[0].commands.map((command) => object(command) && command.title),
    ["!sessions", "!history", "!status", "!subscribe", "!unsubscribe", "!help", "!home"]);
});

test("v2 lists show three canonical selectable rows and the latest two actual dialogue entries without invented pairs or tool noise", async (t) => {
  const h = await harness(t);
  const ids = [];
  for (let index = 0; index < 5; index++) {
    const id = await createWorking(h, `Project ${index}`);
    ids.push(id);
    h.runtime.live.get(id)!.events.push(
      { id: randomUUID(), type: "user.message", timestamp: "2026-11-16T00:01:00Z", data: { content: `Older input ${index}` } },
      { id: randomUUID(), type: "assistant.message", timestamp: "2026-11-16T00:02:00Z", data: { content: `Output A ${index}`, phase: "commentary" } },
      { id: randomUUID(), type: "assistant.message", timestamp: "2026-11-16T00:03:00Z", data: { content: `Output B ${index}`, phase: "final" } },
      { id: randomUUID(), type: "assistant.message", agentId: "child", timestamp: "2026-11-16T00:04:00Z", data: { content: "CHILD-SECRET" } },
      { id: randomUUID(), type: "assistant.message", timestamp: "2026-11-16T00:05:00Z", data: { phase: "analysis", content: "HIDDEN-SECRET" } },
      { id: randomUUID(), type: "tool.execution_complete", data: { success: true, result: { content: "TOOL-SECRET" } } },
    );
    await h.bridge.store.mutate((state) => { state.sessions[id]!.lastConversationAt = `2026-11-16T00:03:0${index}Z`; });
  }
  const list = await h.text("!sessions");
  const rows = list.body.filter((entry) => entry.type === "ColumnSet");
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(object(row.selectAction) && object(row.selectAction.data));
    const claims = h.bridge.actions.verify(row.selectAction.data.token, h.bridge.store.snapshot().conversations[h.key]!);
    const index = ids.indexOf(claims.targetId!);
    assert.ok(index >= 0);
    const text = visibleText(row);
    assert.match(text, new RegExp(`Output A ${index}`));
    assert.match(text, new RegExp(`Output B ${index}`));
    assert.equal(text.split("Output · Copilot").length - 1, 2);
    assert.ok(!text.includes("Input · You"), "two assistant messages must not be relabelled as a question/answer pair");
    for (const secret of ["Older input", "CHILD-SECRET", "HIDDEN-SECRET", "TOOL-SECRET"]) assert.ok(!text.includes(secret));
    const open = findAction(row.columns, "Open");
    assert.equal(open.associatedInputs, "none");
    assert.ok(object(open.data));
    assert.equal(h.bridge.actions.verify(open.data.token, h.bridge.store.snapshot().conversations[h.key]!).targetId, claims.targetId);
  }
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, ids.at(-1));
  assert.deepEqual(h.runtime.received, []);
  assert.ok(Buffer.byteLength(JSON.stringify(list)) <= 27_000);
});

test("v2 operation cards do not repeat final bodies or routine delivery/legacy receipts", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h, "Readable result");
  await h.text("Explicit task for the visible result fixture");
  h.runtime.emit(id, "assistant.message", { messageId: "one-final", phase: "final", content: "ONE-VISIBLE-FINAL-BODY" });
  h.runtime.emit(id, "session.idle");
  await h.bridge.flush();
  await h.bridge.store.mutate((state) => {
    state.receipts["legacy"] = { id: "legacy", conversationKey: h.key, operation: "send", status: "uncertain", detail: "Older unknown send", at: 1 };
  });
  const rendered = h.bridge.render(h.key);
  const visible = visibleText(rendered);
  assert.ok(!visible.includes("ONE-VISIBLE-FINAL-BODY") && !visible.includes("Latest reply"));
  assert.ok(!visible.includes("Older send unconfirmed"));
  assert.ok(!rendered.body.some((entry) => entry.id === "message" || entry.id === "entry-context"));
  assert.deepEqual(rendered.actions?.map((action) => action.title), ["Sessions", "History", "More"]);
  assert.ok(findAction(rendered, "Home"));
  assert.equal(h.bridge.store.snapshot().outbox.filter((item) => item.eventId === "one-final").length, 1);
});

test("new replies conservatively format without reinterpreting legacy pending or uncertain outbox records", async (t) => {
  const h = await harness(t);
  const name = "A [title] **unsafe** <tag>";
  const id = await createWorking(h, name);
  await h.text("Explicit task for rich result formatting");
  const body = "Original body.\r\n\r\n- one\n- two\n\n```ts\nconst n = 1;\n```\n\n[Link](https://example.test/a) 🚀";
  await h.bridge.store.mutate((state) => {
    state.outbox.push(
      { id: "legacy-pending", conversationKey: h.key, sessionId: id, eventId: "legacy", text: "Old *plain* text", status: "pending" },
      { id: "legacy-uncertain", conversationKey: h.key, sessionId: id, eventId: "old-uncertain", text: "Never resend", status: "uncertain" },
    );
  });
  h.runtime.emit(id, "assistant.message", { messageId: "v2-result", phase: "final", content: body });
  await h.bridge.flush();
  const messages = [...h.transport.messages.values()].filter((item) => item.message.type === "text");
  const old = messages.find((item) => item.message.type === "text" && item.message.text === "Old *plain* text");
  const current = messages.find((item) => item.message.type === "text" && item.message.text.includes("Original body."));
  assert.ok(old && current);
  assert.equal(outboundActivity(old.message).textFormat, "plain");
  const activity = outboundActivity(current.message);
  assert.equal(activity.textFormat, "xml", "raw markup in a new source title uses the escaped basic-HTML fallback");
  assert.ok(current.message.type === "text" && current.message.text === body);
  assert.ok(typeof activity.text === "string" && activity.text.includes("<br><br>") && activity.text.endsWith("[Link](https://example.test/a) 🚀"));
  assert.ok(activity.text.startsWith("A [title] **unsafe** &lt;tag&gt;") && activity.text.includes(id.slice(0, 8)));
  assert.equal(h.bridge.store.snapshot().outbox.find((item) => item.eventId === "v2-result")?.id, digest(`${h.key}:${id}:v2-result:0`));
  assert.equal(h.bridge.store.snapshot().outbox.find((item) => item.id === "legacy-uncertain")?.status, "uncertain");
  h.runtime.emit(id, "assistant.message", { messageId: "v2-result", phase: "final", content: body });
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().outbox.filter((item) => item.eventId === "v2-result").length, 1);
  assert.equal([...h.transport.messages.values()].filter((item) => item.message.type === "text" && item.message.text.includes("Original body.")).length, 1);
  assert.ok(![...h.transport.messages.values()].some((item) => item.message.type === "text" && item.message.text === "Never resend"));
  const saved = h.bridge.store.snapshot().outbox;
  await h.bridge.close();
  const reopened = await Store.open(h.directory, "test-owner");
  assert.deepEqual(reopened.snapshot().outbox, saved, "new presentation metadata and every legacy status must persist without reinterpretation");
  await reopened.close();
});

test("v2 Needs reply uses actual live pending evidence and Working excludes stale, saved, historical and unverified waiting states", async (t) => {
  const h = await harness(t, true);
  const working = await createWorking(h, "Known working");
  h.runtime.emit(working, "assistant.turn_start");
  await h.bridge.flush();
  const unverified = await createWorking(h, "Waiting without request");
  await h.bridge.store.mutate((state) => {
    state.sessions[unverified]!.status = "awaiting";
    state.sessions[unverified]!.timeline.push({ id: "old-question", kind: "input", text: "Old resolved question", state: "waiting" });
  });
  const awaiting = await createWorking(h, "Known question");
  await h.text("ask");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[awaiting]!.pending.length));
  const request = h.bridge.store.snapshot().sessions[awaiting]!.pending[0]!;
  const expiredId = randomUUID();
  h.runtime.foreign.push({
    id: expiredId, name: "Expired App", kind: "peer", peerSource: "app", status: "busy", workspace: h.directory,
    capability: "Cached heartbeat", liveUntil: Date.now() - 1, access: { read: true, send: true },
  });
  await h.text("!home");
  assert.match(visibleText(h.bridge.render(h.key)), /Other hosts' pending requests are unknown/);
  const needs = await h.text("!needs-reply");
  const rows = needs.body.filter((entry) => entry.type === "ColumnSet");
  assert.equal(rows.length, 1);
  assert.match(visibleText(rows[0]), /Known question/);
  assert.match(visibleText(rows[0]), /▲ Needs reply/);
  const opened = await h.action(findAction(rows[0], "Open"));
  assert.ok(!JSON.stringify(opened).includes('"id":"message"'));
  const answer = findAction(opened, "Answer");
  assert.ok(object(answer.data));
  const claims = h.bridge.actions.verify(answer.data.token, h.bridge.store.snapshot().conversations[h.key]!);
  assert.equal(claims.requestId, request.id);
  assert.equal(claims.targetId, awaiting);
  const active = await h.text("!working");
  const activeRows = active.body.filter((entry) => entry.type === "ColumnSet");
  assert.equal(activeRows.length, 1);
  assert.match(visibleText(activeRows[0]), /Known working/);
  assert.ok(!visibleText(active).includes("Expired App") && !visibleText(active).includes("Waiting without request"));
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, awaiting);
  assert.deepEqual(h.runtime.received, [{ sessionId: awaiting, text: "ask" }]);
});

test("v2 a native SDK ACK keeps its busy guard but cannot become observed Working until a real root turn starts", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const send = t.mock.method(h.runtime, "send", async () => ({ id: "queued-native-id", peer: false }));
  const admitted = await h.text("queued task without a runtime start event");
  assert.equal(h.bridge.store.snapshot().sessions[id]!.status, "busy", "the existing concurrency guard must remain conservative");
  assert.equal(h.bridge.store.snapshot().sessions[id]!.executionObserved, false);
  assert.match(visibleText(admitted), /○ Queued · Execution not observed/);
  const queued = await h.text("!working");
  assert.equal(queued.body.filter((entry) => entry.type === "ColumnSet").length, 0);
  h.runtime.emit(id, "assistant.turn_start", { parentToolCallId: "child-only" });
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().sessions[id]!.executionObserved, false, "child activity is not a root execution signal");
  h.runtime.emit(id, "assistant.turn_start");
  await h.bridge.flush();
  const working = await h.text("!working");
  assert.equal(working.body.filter((entry) => entry.type === "ColumnSet").length, 1);
  assert.match(visibleText(working), /● Working/);
  assert.equal(send.mock.callCount(), 1);
  h.runtime.emit(id, "session.idle");
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().sessions[id]!.executionObserved, false);
});

test("round2 R1: root autopilot stop clears execution before the next ACK-only send, but child stops cannot clear root work", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  h.runtime.emit(id, "assistant.turn_start");
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().sessions[id]!.executionObserved, true);
  h.runtime.emit(id, "session.autopilot_stopped");
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().sessions[id]!.status, "idle");
  const send = t.mock.method(h.runtime, "send", async () => ({ id: "ack-after-autopilot", peer: false }));
  const admitted = await h.text("new queued instruction after autopilot stopped");
  assert.equal(h.bridge.store.snapshot().sessions[id]!.status, "busy", "the conservative busy/queue guard is unchanged");
  assert.equal(h.bridge.store.snapshot().sessions[id]!.executionObserved, false, "an older root execution must not survive terminal stop into a new ACK");
  assert.match(visibleText(admitted), /○ Queued · Execution not observed/);
  const home = await h.text("!home");
  assert.match(visibleText(home), /0 working/);
  const queued = await h.text("!working");
  assert.equal(queued.body.filter((entry) => entry.type === "ColumnSet").length, 0);
  h.runtime.emit(id, "assistant.turn_start");
  await h.bridge.flush();
  for (const [data, extra] of [
    [{}, { agentId: "child" }],
    [{ parentToolCallId: "child-tool" }, {}],
  ] as const) {
    h.runtime.emit(id, "session.autopilot_stopped", data, extra);
    await h.bridge.flush();
    assert.equal(h.bridge.store.snapshot().sessions[id]!.executionObserved, true, "child terminal activity must not clear current root evidence");
    assert.equal(h.bridge.store.snapshot().sessions[id]!.status, "busy");
  }
  const active = await h.text("!working");
  assert.equal(active.body.filter((entry) => entry.type === "ColumnSet").length, 1);
  h.runtime.emit(id, "session.autopilot_stopped");
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().sessions[id]!.executionObserved, false);
  assert.equal(send.mock.callCount(), 1);
  assert.equal(h.bridge.store.snapshot().outbox.length, 0);
});

test("round2 R2: populated Sessions excerpts follow live root input/output on redraw without navigation or additional preview reads", async (t) => {
  const h = await harness(t);
  for (let index = 0; index < 3; index++) await createWorking(h, `Other preview ${index}`);
  const id = await createWorking(h, "Live preview target");
  h.runtime.live.get(id)!.events.push(
    { id: randomUUID(), type: "user.message", timestamp: "2026-11-16T06:00:00Z", data: { messageId: "old-input", content: "Old visible input" } },
    { id: randomUUID(), type: "assistant.message", timestamp: "2026-11-16T06:01:00Z", data: { messageId: "old-output", phase: "commentary", content: "Old visible output" } },
  );
  await h.bridge.store.mutate((state) => { state.sessions[id]!.lastConversationAt = "2026-11-16T06:01:00Z"; });
  const reads = t.mock.method(h.runtime, "preview");
  const history = t.mock.method(h.runtime, "history");
  await h.text("!sessions");
  await eventually(() => /Session list refreshed/.test(h.bridge.store.snapshot().conversations[h.key]!.notice));
  await h.bridge.flush();
  assert.deepEqual(excerpts(h.bridge.render(h.key)), ["Old visible input", "Old visible output"]);
  const readCount = reads.mock.callCount();
  assert.equal(new Set(reads.mock.calls.map((call) => call.arguments[0])).size, 3, "the off-page fourth session stays unread");
  const before = h.bridge.store.snapshot().conversations[h.key]!;
  const input = "New root input\r\n  preserve whitespace 🚀";
  const output = "New root commentary\n\n[Reference](https://example.test/a)";
  h.runtime.emit(id, "user.message", { messageId: "new-input", content: input }, { timestamp: "2026-11-16T06:02:00Z" });
  h.runtime.emit(id, "assistant.message", { messageId: "new-output", phase: "commentary", content: output }, { timestamp: "2026-11-16T06:03:00Z" });
  h.runtime.emit(id, "assistant.message", { messageId: "hidden", phase: "analysis", content: "PRIVATE_NEW_ANALYSIS" });
  h.runtime.emit(id, "assistant.message", { messageId: "child", content: "PRIVATE_NEW_CHILD" }, { agentId: "child" });
  h.runtime.emit(id, "user.message", { messageId: "internal", source: "agent-fixture", content: "PRIVATE_NEW_INJECTION" });
  h.runtime.emit(id, "tool.execution_complete", { success: true, toolCallId: "noise", result: { content: "PRIVATE_TOOL_OUTPUT" } });
  h.runtime.emit(id, "user_input.requested", { requestId: "new-question", question: "Scoped follow-up", choices: ["Keep"], allowFreeform: false });
  await h.bridge.flush();
  const rendered = h.bridge.render(h.key);
  assert.deepEqual(excerpts(rendered), [input, output], "cached excerpts must not hide newer safe root dialogue");
  assert.equal(excerpts(rendered).filter((text) => text === input).length, 1);
  assert.equal(excerpts(rendered).filter((text) => text === output).length, 1);
  assert.match(visibleText(rendered), /▲ Needs reply/);
  assert.ok(!JSON.stringify(rendered).includes("PRIVATE_"));
  const current = h.bridge.store.snapshot().conversations[h.key]!;
  assert.equal(current.view, "sessions");
  assert.equal(current.selectedId, id);
  assert.equal(current.page, before.page);
  assert.equal(current.query, before.query);
  assert.equal(current.dashboardId, before.dashboardId, "the existing operation surface must be updated, not replaced");
  const delivered = h.transport.messages.get(current.dashboardId!);
  assert.ok(delivered?.message.type === "card");
  assert.deepEqual(excerpts(delivered.message.card), [input, output], "proactive redraw must carry the same fresh excerpts");
  assert.equal(reads.mock.callCount(), readCount, "live excerpt updates must not add preview I/O");
  assert.equal(history.mock.callCount(), 0);
  assert.equal(h.bridge.store.snapshot().sessions[id]!.lastConversationAt, "2026-11-16T06:03:00Z");
  assert.equal(h.bridge.store.snapshot().outbox.length, 0, "input/commentary updates are not new final deliveries");
  assert.deepEqual(h.runtime.received, []);
});

test("round2 R2: an older in-flight preview cannot overwrite a live correction with the same message ID and timestamp", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h, "In-flight preview target");
  h.runtime.live.get(id)!.events.push(
    { id: randomUUID(), type: "user.message", timestamp: "2026-11-16T07:00:00Z", data: { messageId: "read-input", content: "Visible original request" } },
    { id: randomUUID(), type: "assistant.message", timestamp: "2026-11-16T07:01:00Z",
      data: { messageId: "read-output", phase: "commentary", content: "Older cached wording" } },
  );
  await h.text("!sessions");
  await eventually(() => /Session list refreshed/.test(h.bridge.store.snapshot().conversations[h.key]!.notice));
  await h.bridge.flush();
  assert.deepEqual(excerpts(h.bridge.render(h.key)), ["Visible original request", "Older cached wording"]);
  const oldSnapshot = await h.runtime.preview(id);
  let release: ((value: ConversationPreview) => void) | undefined;
  const pending = new Promise<ConversationPreview>((resolve) => { release = resolve; });
  const reads = t.mock.method(h.runtime, "preview", () => pending);
  const navigation = h.action(findAction(h.bridge.render(h.key), "Search"), { query: "In-flight" });
  let during: string[] = [];
  let after: string[] = [];
  try {
    await eventually(() => reads.mock.callCount() === 1);
    h.runtime.emit(id, "assistant.message", {
      messageId: "read-output", phase: "commentary", content: "Newly observed corrected wording",
    }, { timestamp: "2026-11-16T07:01:00Z" });
    await h.bridge.flush();
    during = excerpts(h.bridge.render(h.key));
    release!(oldSnapshot);
    after = excerpts(await navigation);
  } finally { release?.(oldSnapshot); await navigation; }
  assert.deepEqual(during, ["Visible original request", "Newly observed corrected wording"]);
  assert.deepEqual(after, during, "finishing the old read must not undo newer live projection");
  assert.deepEqual(excerpts(h.bridge.render(h.key)), during);
  assert.equal(reads.mock.callCount(), 1);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, id);
  assert.equal(h.bridge.store.snapshot().outbox.length, 0);
  assert.deepEqual(h.runtime.received, []);
});

test("v2 fresh Home invalidates the previous operation surface while literal card work bypasses entry-point commands", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const old = legacySend(h.bridge, h.key);
  await h.text("!home");
  const oldCount = h.runtime.received.length;
  await h.action(old, { message: "do not execute an older card" });
  assert.equal(h.runtime.received.length, oldCount);
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /operation card was replaced/);
  await h.text("!status");
  for (const prompt of ["Home", "Sessions", "Working", "Needs reply", "Side chats", "Subscriptions", "control: list"]) {
    const form = legacySend(h.bridge, h.key);
    await h.action(form, { message: prompt });
    assert.deepEqual(h.runtime.received.at(-1), { sessionId: id, text: prompt });
  }
  assert.equal(h.runtime.live.has(h.bridge.store.snapshot().controllerId!), false);
});

test("v2 stalled list previews stay bounded and single-flight without off-page reads or work replay", async (t) => {
  const h = await harness(t);
  for (let index = 0; index < 7; index++) await createWorking(h, `Bounded ${index}`);
  let release: ((value: ConversationPreview) => void) | undefined;
  const pending = new Promise<ConversationPreview>((resolve) => { release = resolve; });
  const reads = t.mock.method(h.runtime, "preview", () => pending);
  try {
    const first = await h.text("!sessions");
    assert.equal(reads.mock.callCount(), 3, "catalogue refresh and main interaction must join the same three reads");
    assert.match(visibleText(first), /Conversation preview unavailable/);
    const next = await h.action(findAction(first, "Next"));
    assert.equal(reads.mock.callCount(), 3, "a timed-out underlying read must still occupy its bounded slot");
    assert.match(visibleText(next), /Conversation preview unavailable/);
    assert.equal(h.bridge.healthy, true, "an optional preview failure must not stop task/admission persistence");
    assert.deepEqual(h.runtime.received, []);
  } finally { release?.({ entries: [], complete: true }); await pending; }
});

test("v2 Unicode-heavy three-row pages retain both excerpts and canonical actions inside 27KB with at most four navigation controls", async (t) => {
  const h = await harness(t);
  for (let index = 0; index < 7; index++) {
    const id = await createWorking(h, `Budget ${index}`);
    h.runtime.live.get(id)!.events.push(
      { id: randomUUID(), type: "user.message", timestamp: "2026-11-16T00:00:00Z", data: { messageId: `q-${index}`, content: "🚀".repeat(700) } },
      { id: randomUUID(), type: "assistant.message", timestamp: "2026-11-16T00:01:00Z", data: { messageId: `a-${index}`, content: "漢🚀".repeat(700) } },
    );
    await h.bridge.store.mutate((state) => {
      state.sessions[id]!.name = "🚀".repeat(100);
      state.sessions[id]!.timeline = Array.from({ length: 8 }, (_, entry) => ({
        id: `progress-${entry}`, kind: "tool", text: "🚀".repeat(2000), state: "done",
      }));
    });
  }
  const first = await h.text("!sessions");
  await h.bridge.store.mutate((state) => { state.conversations[h.key]!.notice = "漢🚀".repeat(400); });
  const measuredSizes: number[] = [];
  const byteLength = Buffer.byteLength;
  const measurement = t.mock.method(Buffer, "byteLength", (...args: Parameters<typeof Buffer.byteLength>) => {
    const bytes = byteLength(...args);
    if (typeof args[0] === "string" && args[0].startsWith('{"type":"AdaptiveCard"')) measuredSizes.push(bytes);
    return bytes;
  });
  const rendered = h.bridge.render(h.key);
  measurement.mock.restore();
  assert.equal(rendered.body.filter((entry) => entry.type === "ColumnSet").length, 3,
    `optional diagnostics must not replace the list with a fallback navigation card; byte stages ${measuredSizes.join(", ")}`);
  assert.equal(visibleText(rendered).split("Input · You").length - 1, 3);
  assert.equal(visibleText(rendered).split("Output · Copilot").length - 1, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(rendered)) <= 27_000);
  const second = await h.action(findAction(first, "Next"));
  assert.equal(second.body.filter((entry) => entry.type === "ColumnSet").length, 3);
  assert.ok((second.actions?.length ?? 0) <= 4);
  for (const row of second.body.filter((entry) => entry.type === "ColumnSet")) {
    assert.ok(object(row.selectAction) && object(row.selectAction.data));
    const selected = h.bridge.actions.verify(row.selectAction.data.token, h.bridge.store.snapshot().conversations[h.key]!);
    const open = findAction(row.columns, "Open");
    assert.ok(object(open.data));
    assert.equal(h.bridge.actions.verify(open.data.token, h.bridge.store.snapshot().conversations[h.key]!).targetId, selected.targetId);
  }
  assert.deepEqual(h.runtime.received, []);
});

test("v2 long rich replies retain exact body chunks, one group and stable identities across repeat events", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h, "Long rich reply");
  await h.text("Explicit task for the long result fixture");
  const body = "中文段落 🚀\r\n[Reference](https://example.test/a)\n\n".repeat(900);
  h.runtime.emit(id, "assistant.message", { messageId: "long-v2", phase: "final", content: body });
  await h.bridge.flush();
  const chunks = h.bridge.store.snapshot().outbox.filter((item) => item.eventId === "long-v2");
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map((item) => item.text).join(""), body);
  for (const [index, item] of chunks.entries()) {
    assert.equal(item.id, digest(`${h.key}:${id}:long-v2:${index}`));
    assert.equal(item.presentation?.part, index + 1);
    assert.equal(item.presentation?.parts, chunks.length);
    assert.equal(item.presentation?.groupId, chunks[0]!.presentation?.groupId);
    const activity = outboundActivity({ type: "text", text: item.text, presentation: item.presentation! });
    assert.equal(activity.textFormat, "markdown");
    assert.ok(typeof activity.text === "string" && Buffer.byteLength(activity.text) <= 12_000);
    assert.ok(activity.text.endsWith(item.text));
  }
  h.runtime.emit(id, "assistant.message", { messageId: "long-v2", phase: "final", content: body });
  await h.bridge.flush();
  assert.deepEqual(h.bridge.store.snapshot().outbox.filter((item) => item.eventId === "long-v2"), chunks);
  await h.bridge.store.mutate((state) => state.outbox.push({
    id: digest(`${h.key}:${id}:legacy-duplicate:0`), conversationKey: h.key, sessionId: id,
    eventId: "legacy-duplicate", text: "Original legacy prefix and body", status: "uncertain",
  }));
  h.runtime.emit(id, "assistant.message", { messageId: "legacy-duplicate", phase: "final", content: body });
  await h.bridge.flush();
  const legacy = h.bridge.store.snapshot().outbox.filter((item) => item.eventId === "legacy-duplicate");
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0]!.presentation, undefined, "a known legacy group cannot acquire new rich chunks or be resent");
  assert.equal(legacy[0]!.status, "uncertain");
});
