import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { Actions } from "../src/actions.js";
import { Cards, inputSuffix } from "../src/cards.js";
import { chunkText, digest, object, safeText } from "../src/safety.js";
import { Store } from "../src/store.js";
import { mockEnvelope, mockIdentity } from "../src/simulator.js";
import { authorizeActivity, outboundActivity } from "../src/teams.js";
import { createWorking, eventually, findAction, findAllActions, harness, temporary, legacySend } from "./helpers.js";

test("owner, tenant, private scope, verified audience and service URL are mandatory", () => {
  const valid = mockEnvelope("exact");
  assert.equal(authorizeActivity(valid, { aud: mockIdentity.appId }, mockIdentity).incoming.kind, "text");
  const cases: unknown[] = [
    { ...valid, channelId: "emulator" },
    { ...valid, from: { id: "29:someone", aadObjectId: randomUUID() } },
    { ...valid, from: { id: "29:mock-owner", name: "Mock owner" } },
    { ...valid, from: { id: `28:${mockIdentity.appId}`, aadObjectId: mockIdentity.ownerId, role: "bot" } },
    { ...valid, channelData: { tenant: { id: randomUUID() } } },
    { ...valid, conversation: { id: "group", conversationType: "groupChat" } },
    { ...valid, conversation: { id: "group", conversationType: "personal", isGroup: true } },
    { ...valid, recipient: { id: "28:wrong-bot" } },
    { ...valid, serviceUrl: "https://attacker.example/post" },
    { ...valid, serviceUrl: "http://smba.trafficmanager.net/" },
    { ...valid, serviceUrl: "https://smba.trafficmanager.net@evil.example/" },
    { ...valid, serviceUrl: "https://user:password@smba.trafficmanager.net/" },
  ];
  for (const input of cases) assert.throws(() => authorizeActivity(input, { aud: mockIdentity.appId }, mockIdentity));
  assert.throws(() => authorizeActivity(valid, undefined, mockIdentity));
  assert.throws(() => authorizeActivity(valid, { aud: randomUUID() }, mockIdentity));
  assert.throws(() => authorizeActivity(valid, { aud: mockIdentity.appId, serviceurl: "https://evil.example/" }, mockIdentity));
});

test("actual Execute and Submit envelopes are parsed, arbitrary invoke payloads fail closed", () => {
  const base = mockEnvelope();
  const execute = authorizeActivity({
    ...base, type: "invoke", name: "adaptiveCard/action",
    value: { action: { type: "Action.Execute", verb: "bridge", data: { token: "scoped-token" } }, trigger: "manual" },
  }, { aud: mockIdentity.appId }, mockIdentity);
  assert.deepEqual(execute.incoming, { kind: "action", data: { token: "scoped-token" } });
  assert.deepEqual(authorizeActivity({ ...base, value: { token: "submit-token", answer: "x" } },
    { aud: mockIdentity.appId }, mockIdentity).incoming,
  { kind: "action", data: { token: "submit-token", answer: "x" } });
  for (const value of [
    { action: { type: "Action.Execute", verb: "shell", data: { token: "x" } } },
    { action: { type: "Action.Execute", verb: "bridge", data: "not-an-object" } },
    { action: { type: "Action.Execute", verb: "bridge", data: {} }, trigger: "automatic" },
  ]) assert.throws(() => authorizeActivity({ ...base, type: "invoke", name: "adaptiveCard/action", value }, { aud: mockIdentity.appId }, mockIdentity));
});

test("the optional Control runtime is lazy and ordinary text without a target never falls back to a model", async (t) => {
  const h = await harness(t);
  const id = h.bridge.store.snapshot().controllerId!;
  assert.equal(h.runtime.live.has(id), false);
  await h.text("an instruction with no selected session");
  assert.deepEqual(h.runtime.received, []);
  assert.equal(h.runtime.live.has(id), false);
  await h.text("!control");
  await h.text("!read");
  assert.equal(h.runtime.live.has(id), false, "viewing an empty Control transcript is read-only");
  await h.text("ordinary text with no selected target in a Control transcript");
  assert.equal(h.runtime.live.has(id), false, "a Control view cannot turn ordinary text into a management instruction");
  assert.deepEqual(h.runtime.received, []);
  await h.text("!control list sessions");
  assert.equal(h.runtime.live.has(id), true);
  assert.deepEqual(h.runtime.received, [{ sessionId: id, text: "list sessions" }]);
});

test("only explicit !control invokes optional management while ordinary selected text never inherits the Control view", async (t) => {
  const h = await harness(t);
  const working = await createWorking(h);
  const controller = h.bridge.store.snapshot().controllerId!;
  const management = " list sessions\r\n  Preserve this explicit instruction.";
  await h.text(`!control ${management}`);
  assert.deepEqual(h.runtime.received.at(-1), { sessionId: controller, text: management });
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.view, "control");
  assert.match(JSON.stringify(h.bridge.render(h.key)), /!control <instruction>/);
  const ordinary = "Explain control: as literal text.\r\n  Preserve spacing.";
  await h.text(ordinary);
  assert.deepEqual(h.runtime.received.at(-1), { sessionId: working, text: ordinary });
  const received = h.runtime.received.length;
  await h.text("!control   ");
  assert.equal(h.runtime.received.length, received);
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /explicit management instruction/);
});
test("list/new/select are deterministic; ordinary selected-session text is forwarded byte-for-byte, not through controller", async (t) => {
  const h = await harness(t);
  const a = await createWorking(h, "A");
  const b = await createWorking(h, "B");
  const list = await h.text("!sessions");
  const actions = findAllActions(list).filter((action) => action.title === "Open");
  const openA = actions.find((action) => {
    assert.ok(object(action.data));
    return h.bridge.actions.verify(action.data.token, h.bridge.store.snapshot().conversations[h.key]!).targetId === a;
  });
  assert.ok(openA);
  await h.action(openA);
  const prompt = "  Keep <b>HTML</b> exactly.\r\nLine two \u{1f680}  ";
  await h.text(prompt);
  assert.deepEqual(h.runtime.received, [{ sessionId: a, text: prompt }]);
  assert.equal(h.bridge.store.snapshot().sessions[a]?.status, "busy");
  await eventually(() => Boolean(h.bridge.store.snapshot().conversations[h.key]?.dashboardId));
  const previousDashboard = h.bridge.store.snapshot().conversations[h.key]?.dashboardId;
  const listAgain = await h.text("!sessions");
  assert.deepEqual(h.runtime.received, [{ sessionId: a, text: prompt }]);
  await eventually(() => {
    const current = h.bridge.store.snapshot().conversations[h.key]?.dashboardId;
    return Boolean(current && current !== previousDashboard);
  });
  const openB = findAllActions(listAgain).find((action) => {
    if (action.title !== "Open" || !object(action.data)) return false;
    return h.bridge.actions.verify(action.data.token, h.bridge.store.snapshot().conversations[h.key]!).targetId === b;
  });
  assert.ok(openB);
  await h.action(openB);
  assert.deepEqual(h.runtime.stopped, []);
  assert.equal(h.bridge.store.snapshot().sessions[a]?.status, "busy");
  await h.text(`\u00a0!use ${a}\r\n `);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]?.selectedId, a);
  const transcript = await h.text("!read");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]?.view, "transcript");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]?.transcriptId, a);
  assert.match(JSON.stringify(transcript), new RegExp(a));
});

test("retained legacy signed sends still deliver exact text once, but new cards no longer offer a task composer", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h, "Card target");
  const controller = h.bridge.store.snapshot().controllerId!;
  const card = h.bridge.render(h.key);
  const input = card.body.find((entry) => entry.type === "Input.Text" && entry.id === "message");
  assert.equal(input, undefined);
  assert.throws(() => findAction(card, "Send"), /not found/);
  const send = legacySend(h.bridge, h.key);
  assert.ok(object(send.data));
  assert.equal(send.associatedInputs, "auto");
  const claims = h.bridge.actions.verify(send.data.token, h.bridge.store.snapshot().conversations[h.key]!);
  assert.equal(claims.op, "send");
  assert.equal(claims.targetId, id);
  for (const prompt of ["control: list sessions\r\n  Keep this literal 🚀  ", "list sessions", "/stop"]) {
    const action = legacySend(h.bridge, h.key);
    const result = await h.action(action, { message: prompt });
    assert.deepEqual(h.runtime.received.at(-1), { sessionId: id, text: prompt });
    assert.equal(h.bridge.store.snapshot().conversations[h.key]!.view, "dashboard");
    assert.match(JSON.stringify(result), /admitted/);
    await h.action(action, { message: "do not replay even with a changed draft" });
    assert.deepEqual(h.runtime.received.at(-1), { sessionId: id, text: prompt });
  }
  assert.equal(h.runtime.received.length, 3);
  assert.equal(h.runtime.live.has(controller), false);
  assert.deepEqual(h.runtime.stopped, []);
});

test("card send rejects malformed drafts, stale targets and expired signatures and never retries an uncertain admission", async (t) => {
  const h = await harness(t);
  const a = await createWorking(h, "Original target");
  const old = legacySend(h.bridge, h.key);
  const b = await createWorking(h, "New target");
  await h.action(old, { message: "do not send to either target" });
  assert.equal(h.runtime.received.length, 0);
  for (const message of [undefined, null, 123, {}, [], "", " \t\r\n\u00a0", "x".repeat(64_001)]) {
    await h.action(legacySend(h.bridge, h.key), { message });
    assert.equal(h.runtime.received.length, 0);
  }
  const state = h.bridge.store.snapshot();
  const conversation = state.conversations[h.key]!;
  const expired = new Actions(state.actionKey, 1).issue(conversation, { op: "send", targetId: b }, Date.now() - 1000);
  await h.action({ data: { token: expired } }, { message: "expired draft" });
  const wrongTarget = h.bridge.actions.issue(conversation, { op: "send", targetId: a });
  await h.action({ data: { token: wrongTarget } }, { message: "mismatched signed target" });
  await h.action(legacySend(h.bridge, h.key), { message: "attempt UI retarget", targetId: a });
  assert.equal(h.runtime.received.length, 0);
  const maximum = "x".repeat(64_000);
  await h.action(legacySend(h.bridge, h.key), { message: maximum });
  assert.deepEqual(h.runtime.received, [{ sessionId: b, text: maximum }]);
  const form = legacySend(h.bridge, h.key);
  const send = t.mock.method(h.runtime, "send", async () => { throw new Error("Uncertain admission fixture"); });
  await h.action(form, { message: "admit at most once" });
  await h.action(form, { message: "a replay with a different activity and draft" });
  assert.equal(send.mock.callCount(), 1);
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /Previous operation: failed/);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
});

test("peer card send enforces exact UTF-8 limits and read-only or expired endpoints never receive a draft", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.bridge.store.mutate((state) => {
    const target = state.sessions[id]!;
    target.kind = "peer";
    target.peerSource = "app";
    target.access = { read: true, send: true };
    target.liveUntil = Date.now() + 60_000;
  });
  const boundary = "🚀".repeat(4096);
  await h.action(legacySend(h.bridge, h.key), { message: boundary + "x" });
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /16 KiB of UTF-8/);
  assert.equal(h.runtime.received.length, 0);
  await h.action(legacySend(h.bridge, h.key), { message: boundary });
  assert.deepEqual(h.runtime.received, [{ sessionId: id, text: boundary }]);
  const revoked = legacySend(h.bridge, h.key);
  await h.bridge.store.mutate((state) => { state.sessions[id]!.access!.send = false; });
  assert.throws(() => findAction(h.bridge.render(h.key), "Send"), /not found/);
  await h.action(revoked, { message: "read-only draft" });
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /APP_SESSION_READ_ONLY/);
  await h.bridge.store.mutate((state) => { state.sessions[id]!.access!.send = true; });
  const expired = legacySend(h.bridge, h.key);
  await h.bridge.store.mutate((state) => { state.sessions[id]!.liveUntil = Date.now() - 1; });
  assert.throws(() => findAction(h.bridge.render(h.key), "Send"), /not found/);
  await h.action(expired, { message: "no live endpoint draft" });
  assert.equal(h.runtime.received.length, 1);
  assert.equal(h.bridge.store.snapshot().sessions[id]!.access?.send, false);
});

test("working message inputs are absent from Control, settings, history and pending-answer forms", async (t) => {
  const h = await harness(t, true);
  const id = await createWorking(h);
  const hasDraft = () => JSON.stringify(h.bridge.render(h.key)).includes('"id":"message"');
  assert.equal(hasDraft(), false, "new cards never collect ordinary chat text");
  await h.action(findAction(h.bridge.render(h.key), "Check status"));
  assert.equal(h.runtime.received.length, 0, "rendering and refreshing must never send a draft");
  for (const view of ["!control", "!settings", "!read"]) {
    await h.text(view);
    assert.equal(hasDraft(), false, `${view} must not inherit a working-message input`);
    assert.throws(() => findAction(h.bridge.render(h.key), "Send"), /not found/);
  }
  await h.text("!status");
  const staleSend = legacySend(h.bridge, h.key);
  await h.text("ask");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[id]!.pending.length));
  const pending = h.bridge.store.snapshot().sessions[id]!.pending[0]!;
  const form = h.bridge.render(h.key);
  assert.equal(JSON.stringify(form).includes('"id":"message"'), false,
    "answer auto-input collection must not include a working draft from an ancestor card");
  assert.ok(JSON.stringify(form).includes(`choice_${inputSuffix(pending.id)}`));
  assert.ok(JSON.stringify(form).includes(`text_${inputSuffix(pending.id)}`));
  await h.action(staleSend, { message: "a send form from before the question" });
  assert.equal(h.runtime.received.length, 1);
  await h.action(findAction(h.bridge.render(h.key), "Answer"), {
    [`choice_${inputSuffix(pending.id)}`]: "0", [`text_${inputSuffix(pending.id)}`]: "",
  });
  assert.equal(h.runtime.answers.length, 1);
  assert.equal(h.runtime.answers[0]!.requestId, pending.id);
  assert.equal(h.runtime.received.length, 1, "answering a native request must not submit any working task");
});

test("prefixed selection rejects unknown names and explicit advanced history keeps the selected canonical ID", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h, "Direct command");
  assert.match(JSON.stringify(await h.text("!use not-a-session")), /No known source matches/);
  assert.match(JSON.stringify(await h.text(`!use ${randomUUID()}`)), /No known source matches/);
  await h.text(`!use ${id}`);
  const transcript = await h.text("!read");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]?.selectedId, id);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]?.view, "transcript");
  assert.match(JSON.stringify(transcript), new RegExp(id));
});

test("peer transcript hydration reads bounded owner-provided history instead of stopping at the peer watcher", async (t) => {
  const h = await harness(t);
  const id = randomUUID();
  await h.runtime.create({ id, name: "App-like peer", workspace: h.directory, controller: false });
  h.runtime.emit(id, "assistant.message", {
    messageId: "peer-history",
    phase: "final",
    content: "Owner-provided peer transcript",
  });
  h.runtime.foreign.push({
    id, name: "App-like peer", workspace: h.directory, kind: "peer", status: "idle",
    capability: "message/transcript",
  });
  await h.text(`!use ${id}`);
  const transcript = await h.text("!read");
  assert.match(JSON.stringify(transcript), /Owner-provided peer transcript/);
  assert.match(JSON.stringify(h.bridge.store.snapshot().sessions[id]?.timeline), /Owner-provided peer transcript/);
});

test("paginated selection uses canonical IDs even with identical session names", async (t) => {
  const h = await harness(t);
  for (let index = 0; index < 7; index++) await createWorking(h, "Same name");
  const first = await h.text("!sessions");
  assert.equal(findAllActions(first).filter((action) => action.title === "Open").length, 3);
  const second = await h.action(findAction(first, "Next"));
  assert.equal(findAllActions(second).filter((action) => action.title === "Open").length, 3);
  const third = await h.action(findAction(second, "Next"));
  assert.equal(findAllActions(third).filter((action) => action.title === "Open").length, 1);
  assert.match(JSON.stringify(third), /Page 3 of 3/);
  for (const action of [first, second, third].flatMap(findAllActions).filter((item) => item.title === "Open")) {
    assert.ok(object(action.data));
    assert.match(h.bridge.actions.verify(action.data.token, h.bridge.store.snapshot().conversations[h.key]!).targetId ?? "", /^[0-9a-f-]{36}$/);
  }
});

test("event projection shows visible phases and grouped tool lifecycle, never reasoning, arguments, full results or unknown-phase text", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const emit = h.runtime.emit.bind(h.runtime, id);
  emit("assistant.message", { messageId: "thinking", phase: "analysis", content: "HIDDEN-THOUGHT", reasoningText: "MORE-HIDDEN" });
  emit("assistant.message", { messageId: "future", phase: "future-private", content: "FUTURE-SECRET" });
  emit("assistant.reasoning_delta", { deltaContent: "HIDDEN-DELTA" });
  emit("assistant.message", { messageId: "comment", phase: "commentary", content: "Visible progress" });
  emit("tool.execution_start", { toolCallId: "call", toolName: "read_file", arguments: { password: "TOOL-ARG-SECRET" } });
  emit("tool.execution_complete", { toolCallId: "call", success: true, result: { content: "TOOL-OUTPUT-SECRET" } });
  emit("assistant.message", { messageId: "answer", content: "Visible standard unphased answer. Bearer fake-credential" });
  emit("session.idle");
  await h.bridge.flush();
  const output = JSON.stringify(h.bridge.store.snapshot()) + JSON.stringify([...h.transport.messages.values()]);
  assert.match(output, /Visible progress/);
  assert.match(output, /Visible standard unphased answer/);
  for (const secret of ["HIDDEN-THOUGHT", "MORE-HIDDEN", "FUTURE-SECRET", "HIDDEN-DELTA", "TOOL-ARG-SECRET", "TOOL-OUTPUT-SECRET", "fake-credential"]) {
    assert.ok(!output.includes(secret), secret);
  }
  const target = h.bridge.store.snapshot().sessions[id]!;
  assert.equal(target.status, "idle");
  assert.ok(!target.timeline.some((entry) => entry.kind === "task" && entry.state === "done"));
  assert.equal(target.timeline.find((entry) => entry.kind === "tool")?.state, "done");
  assert.match(JSON.stringify(h.bridge.render(h.key)), /Tools: 1\/1 completed/);
  assert.ok(h.transport.messages.size > 0);
});

test("events proactively deliver chunked background finals and coalesce dashboard updates without polling", async (t) => {
  const h = await harness(t);
  const a = await createWorking(h, "Background A");
  await h.text("work independently");
  const b = await createWorking(h, "Current B");
  await h.bridge.flush();
  const before = h.transport.messages.size;
  for (let index = 0; index < 30; index++) h.runtime.emit(a, "tool.execution_start", { toolCallId: `tool-${index}`, toolName: "inspect" });
  const content = "Unicode \u{1f680}\u6d4b\u8bd5 ".repeat(3000);
  h.runtime.emit(a, "assistant.message", { messageId: "long-final", phase: "final", content });
  h.runtime.emit(a, "session.idle");
  await eventually(() => {
    const items = h.bridge.store.snapshot().outbox;
    return items.length > 1 && items.every((item) => item.status === "sent");
  });
  const sent = [...h.transport.messages.values()].filter((item) => item.message.type === "text");
  assert.ok(sent.length > 1);
  for (const item of sent) if (item.message.type === "text") assert.ok(Buffer.byteLength(item.message.text) <= 12_000);
  const joined = sent.map((item) => item.message.type === "text" ? item.message.text : "").join("");
  assert.equal(joined, content);
  assert.ok(sent.every((item) => item.message.type === "text" && item.message.presentation?.kind === "background" &&
    item.message.presentation.title === "Background A"));
  assert.equal(h.bridge.store.snapshot().conversations[h.key]?.selectedId, b);
  assert.ok(h.bridge.store.snapshot().sessions[a]!.sequence > h.bridge.store.snapshot().conversations[h.key]!.read[a]!);
  assert.ok(h.transport.messages.size <= before + sent.length + 1);
  assert.equal(h.runtime.received.length, 1);
});

test("compact new reply prefixes preserve exact business text, canonical outbox identities and once-only delivery for current/background/control results", async (t) => {
  const h = await harness(t);
  const a = await createWorking(h, "Same name");
  const b = await createWorking(h, "Same name");
  const body = "Original business result.\r\n\r\n[Reference](https://example.test/a)\n保留空格与段落 🚀  ";
  const emit = async (id: string, messageId: string, title: string, kind: "session" | "background" | "control") => {
    if (kind !== "control") {
      const selected = h.bridge.store.snapshot().conversations[h.key]!.selectedId!;
      await h.text(`!use ${id}`);
      await h.text(`Explicit task for ${messageId}`);
      if (selected !== id) await h.text(`!use ${selected}`);
    }
    await h.bridge.flush();
    const before = h.bridge.store.snapshot().outbox;
    const receipts = h.bridge.store.snapshot().receipts;
    const data = { messageId, phase: "final", content: body };
    h.runtime.emit(id, "assistant.message", data);
    await h.bridge.flush();
    const result = h.bridge.store.snapshot().outbox.find((item) => item.eventId === messageId);
    assert.ok(result);
    assert.equal(result.text, body);
    assert.equal(result.presentation?.title, title);
    assert.equal(result.presentation?.kind, kind);
    assert.equal(outboundActivity({ type: "text", text: result.text, presentation: result.presentation! }).textFormat, "markdown");
    assert.equal(result.sessionId, id);
    assert.equal(result.eventId, messageId);
    assert.equal(result.id, digest(`${h.key}:${id}:${messageId}:0`), "presentation must not enter the idempotency key");
    assert.equal(result.status, "sent");
    assert.ok(result.activityId);
    assert.ok(!result.text.includes(id), "new prefixes do not expose the full canonical UUID");
    assert.deepEqual(h.bridge.store.snapshot().receipts, receipts);
    for (const item of before) assert.deepEqual(h.bridge.store.snapshot().outbox.find((current) => current.id === item.id), item,
      "new prefix construction must not rewrite a previously persisted or delivered message");
    h.runtime.emit(id, "assistant.message", data);
    await h.bridge.flush();
    assert.deepEqual(h.bridge.store.snapshot().outbox.find((item) => item.id === result.id), result);
    assert.equal([...h.transport.messages.values()].filter((item) => item.message.type === "text" &&
      item.message.presentation?.groupId === result.presentation?.groupId).length, 1);
  };
  await emit(b, "selected-duplicate", "Same name", "session");
  await emit(a, "background-duplicate", "Same name", "background");
  await h.bridge.store.mutate((state) => {
    state.sessions[a]!.name = "Unique background";
    state.sessions[b]!.name = "Unique current";
  });
  await emit(b, "selected-unique", "Unique current", "session");
  await emit(a, "background-unique", "Unique background", "background");
  const controller = h.bridge.store.snapshot().controllerId!;
  await h.text("!control initialize attribution fixture");
  const name = safeText(h.bridge.store.snapshot().sessions[controller]!.name, 100);
  await emit(controller, "control-result", name, "control");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, b);
  assert.equal(h.bridge.store.snapshot().outbox.filter((item) => !item.historyId).length, 5);
  assert.equal(h.runtime.received.length, 5, "four explicit working tasks and the explicit Control instruction are the only executions");
});

test("model capabilities are loaded before apply; changes affect only the selected working session and busy changes reject", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const controller = h.bridge.store.snapshot().controllerId!;
  assert.equal(h.runtime.live.has(controller), false);
  let settings = await h.text("!settings");
  settings = await h.action(findAction(settings, "Load options"), { modelKey: "mock-fast", mode: "interactive", effort: "high" });
  assert.equal(h.runtime.settingsCalls.length, 0);
  await h.action(findAction(settings, "Apply"), { modelKey: "mock-fast", mode: "plan", effort: "high" });
  assert.equal(h.runtime.settingsCalls.length, 0);
  settings = await h.text("!settings");
  settings = await h.action(findAction(settings, "Load options"), { modelKey: "mock-deep", mode: "interactive", effort: "__default__" });
  await h.action(findAction(settings, "Apply"), { modelKey: "mock-deep", mode: "plan", effort: "max" });
  assert.deepEqual(await h.runtime.settings(id), { mode: "plan", modelId: "mock-deep", effort: "max" });
  assert.equal(h.runtime.live.has(controller), false, "working settings must not create an optional control runtime");
  assert.equal(h.bridge.store.snapshot().sessions[id]?.settingsReceipt?.status, "applied");
  await h.text("running");
  settings = await h.text("!settings");
  await h.action(findAction(settings, "Apply"), { modelKey: "mock-deep", mode: "autopilot", effort: "max" });
  assert.equal(h.runtime.settingsCalls.length, 1);
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /busy/i);
});

test("input, plan and permission cards answer exact native IDs; stale session actions and replay never reach runtime", async (t) => {
  const h = await harness(t, true);
  const a = await createWorking(h);
  await h.text("ask");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[a]?.pending.length));
  await h.bridge.flush();
  const pending = h.bridge.store.snapshot().sessions[a]!.pending[0]!;
  const answerAction = findAction(h.bridge.render(h.key), "Answer");
  await h.action(answerAction, { [`choice_${inputSuffix(pending.id)}`]: "0" });
  await h.action(answerAction, { [`choice_${inputSuffix(pending.id)}`]: "1" });
  assert.equal(h.runtime.answers.length, 1);
  assert.equal(h.runtime.answers[0]?.requestId, pending.id);
  assert.equal(h.runtime.answers[0]?.answer.choice, 0);
  await eventually(() => h.bridge.store.snapshot().sessions[a]?.status === "idle");
  await h.text("permission");
  await eventually(() => h.bridge.store.snapshot().sessions[a]?.pending[0]?.kind === "permission");
  const approval = findAction(h.bridge.render(h.key), "Approve once");
  const b = await createWorking(h, "Different session");
  await h.action(approval);
  assert.equal(h.runtime.answers.length, 1);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]?.selectedId, b);
  await h.text("plan");
  await eventually(() => h.bridge.store.snapshot().sessions[b]?.pending[0]?.kind === "plan");
  const plan = h.bridge.store.snapshot().sessions[b]!.pending[0]!;
  await h.action(findAction(h.bridge.render(h.key), "Approve plan"), { [`choice_${inputSuffix(plan.id)}`]: "1", [`text_${inputSuffix(plan.id)}`]: "" });
  assert.equal(h.runtime.answers.length, 2);
  assert.equal((await h.runtime.settings(b)).mode, "autopilot");
});

test("tampered, expired, cross-conversation, malformed and stale-revision action tokens are rejected", async (t) => {
  const h = await harness(t);
  await createWorking(h);
  const state = h.bridge.store.snapshot();
  const conversation = state.conversations[h.key]!;
  const tokens = new Actions(state.actionKey, 10);
  const token = tokens.issue(conversation, { op: "stop", targetId: conversation.selectedId! }, 100);
  assert.throws(() => tokens.verify(token, conversation, 111), /expired/);
  assert.throws(() => tokens.verify(`${token}a`, conversation, 101));
  assert.throws(() => tokens.verify(token, { ...conversation, key: "another" }, 101));
  assert.throws(() => tokens.verify(token, { ...conversation, revision: conversation.revision + 1 }, 101));
  const create = findAction(await h.text("!new"), "Create");
  await h.action(create, { sessionName: "Unsafe", workspace: "local", shell: "run" });
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /unexpected field/);
  assert.equal(Object.values(h.bridge.store.snapshot().sessions).filter((item) => item.kind === "owned").length, 1);
});

test("restart preserves selection/history/real settings and receipts; ambiguous operations and stale approvals are not replayed", async (t) => {
  const directory = await temporary(t);
  const first = await harness(t, false, directory);
  const id = await createWorking(first);
  const activityId = randomUUID();
  await first.text("one request only", activityId);
  first.runtime.emit(id, "assistant.message", { messageId: "historic-answer", phase: "final", content: "Persisted answer" });
  first.runtime.emit(id, "session.idle");
  await first.bridge.flush();
  const oldCard = first.bridge.render(first.key);
  await first.bridge.store.mutate((state) => {
    state.receipts["in-flight"] = { id: "in-flight", conversationKey: first.key, operation: "send", status: "started", detail: "", at: Date.now() };
  });
  const controllerId = first.bridge.store.snapshot().controllerId;
  await first.bridge.close();
  const second = await harness(t, false, directory);
  assert.equal(second.bridge.store.snapshot().controllerId, controllerId);
  assert.equal(second.bridge.store.snapshot().conversations[second.key]?.selectedId, id);
  assert.deepEqual(second.runtime.resumed, [], "restart must not implicitly connect an owned runtime");
  assert.equal(second.bridge.store.snapshot().sessions[id]!.status, "offline");
  assert.match(JSON.stringify(second.bridge.store.snapshot().sessions[id]!.timeline), /Persisted answer/);
  assert.equal(second.bridge.store.snapshot().receipts["in-flight"]?.status, "uncertain");
  await second.text("one request only", activityId);
  assert.deepEqual(second.runtime.received, []);
  await second.action(findAction(oldCard, "Stop turn"));
  assert.deepEqual(second.runtime.stopped, []);
  await second.text("a new explicit instruction after restart");
  assert.deepEqual(second.runtime.resumed, [id]);
  assert.deepEqual(second.runtime.received, [{ sessionId: id, text: "a new explicit instruction after restart" }]);
});

test("exclusive persistence lock and stored owner mismatch fail explicitly", async (t) => {
  const directory = await temporary(t);
  const store = await Store.open(directory, "owner-a");
  await assert.rejects(() => Store.open(directory, "owner-a"), /Another bridge process/);
  await store.close();
  await assert.rejects(() => Store.open(directory, "owner-b"), /owner mismatch/);
});

test("safe chunking is exact across Unicode; common credential formats are redacted; unmocked network and child processes are blocked", async () => {
  const source = "\u{1f680}\u6d4babc".repeat(500);
  const chunks = chunkText(source, 19);
  assert.equal(chunks.join(""), source);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 19 && !chunk.includes("\ufffd")));
  const redacted = safeText("Bearer abc123 github_pat_secret123 password=hello https://u:p@example.test/?sig=secrets");
  for (const secret of ["abc123", "github_pat_secret123", "hello", "u:p", "sig=secrets"]) assert.ok(!redacted.includes(secret));
  await assert.rejects(() => fetch("https://example.test/no-live-post", { method: "POST" }), /blocked/);
  assert.throws(() => spawn("copilot", ["-p", "should never run"]), /blocked/);
});

test("card budget remains below Teams limit with a long transcript and several pending requests", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.bridge.store.mutate((state) => {
    const session = state.sessions[id]!;
    session.timeline = Array.from({ length: 160 }, (_, index) => ({ id: String(index), kind: "assistant", phase: "final", text: "x".repeat(3000) }));
  });
  const state = h.bridge.store.snapshot();
  const card = new Cards(h.bridge.actions, h.bridge.options.workspaces).render(state, h.key);
  assert.ok(Buffer.byteLength(JSON.stringify(card)) <= 27_000);
});
