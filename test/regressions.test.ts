import assert from "node:assert/strict";
import { createHmac, randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import jwksRsa from "jwks-rsa";
import { clearJwksClients, type Request as AgentRequest, type WebResponse } from "@microsoft/agents-hosting";
import { Projector } from "../src/projection.js";
import { Actions } from "../src/actions.js";
import { inputSuffix, latestTranscriptPage, transcriptPages } from "../src/cards.js";
import { FakeRuntime } from "../src/fake-runtime.js";
import { appAdmissionNotice, type AppAdmission, type AppSessionLiveness, type BridgeState, type Card, type SessionRecord, type TimelineEntry } from "../src/domain.js";
import { authorizeActivity, createProductionApp, createTeamsAdapter, teamsAuthentication } from "../src/teams.js";
import { mockEnvelope, mockIdentity } from "../src/simulator.js";
import { digest, object, UserError } from "../src/safety.js";
import { withLoopback } from "./block-network.js";
import { createWorking, eventually, findAction, findAllActions, harness, temporary, legacySend } from "./helpers.js";

function visibleText(value: unknown): string {
  if (Array.isArray(value)) return value.map(visibleText).join("\n");
  if (!object(value) || value.isVisible === false || value.type === "Action.ShowCard") return "";
  const text = typeof value.text === "string" ? value.text : "";
  return [text, ...Object.entries(value).filter(([key]) => key !== "data" && key !== "fallback")
    .map(([, child]) => visibleText(child))].filter(Boolean).join("\n");
}

test("Teams nonbreaking spaces around explicit ! commands never become working-session tasks", async (t) => {
  const h = await harness(t);
  await createWorking(h);
  for (const command of ["!sessions\u00a0", "\u202f!sessions", "\u00a0!sessions\u00a0"]) {
    await h.text(command);
    assert.equal(h.bridge.store.snapshot().conversations[h.key]!.view, "sessions");
    assert.equal(h.runtime.received.length, 0);
    assert.equal(h.bridge.store.snapshot().outbox.length, 0);
  }
  const ordinary = "Explain list\u00a0sessions as literal text.\r\n  Preserve spacing.";
  await h.text(ordinary);
  assert.equal(h.runtime.received.at(-1)?.text, ordinary);
});

test("returning-user startup and local search do not wait for an unavailable App catalogue", async (t) => {
  const directory = await temporary(t);
  const first = await harness(t, false, directory);
  const id = await createWorking(first, "Retained project");
  await first.bridge.close();
  let release: () => void = () => { throw new Error("Catalogue fixture is not initialized."); };
  const pending = new Promise<Awaited<ReturnType<FakeRuntime["inventory"]>>>((resolve) => {
    release = () => resolve([]);
  });
  const inventory = t.mock.method(FakeRuntime.prototype, "inventory", () => pending);
  const second = await harness(t, false, directory, { initializeConversation: false, inventoryOnStart: false });
  assert.equal(inventory.mock.callCount(), 0);
  assert.equal(second.bridge.healthy, true);
  try {
    const list = await second.text("!sessions");
    const filtered = await second.action(findAction(list, "Search"), { query: "Retained" });
    assert.match(visibleText(filtered), /Retained project/);
    assert.equal(second.bridge.store.snapshot().conversations[second.key]!.selectedId, id);
    assert.equal(inventory.mock.callCount(), 1);
    const opened = await second.action(findAction(filtered, "Open"));
    await second.action(findAction(opened, "Check status"));
    await second.text(`!use ${id}`);
    assert.equal(inventory.mock.callCount(), 1);
    assert.deepEqual(second.runtime.received, []);
  } finally {
    release();
  }
});

test("a failed background catalogue leaves saved sessions usable and reports the failure", async (t) => {
  const h = await harness(t);
  await createWorking(h, "Saved work");
  t.mock.method(h.runtime, "inventory", async () => { throw new UserError("Host is unavailable."); });
  await h.text("!sessions");
  await eventually(() => /Host refresh is unavailable/.test(h.bridge.store.snapshot().conversations[h.key]!.notice));
  assert.match(visibleText(h.bridge.render(h.key)), /Saved work/);
  assert.equal(h.bridge.healthy, true);
  assert.deepEqual(h.runtime.received, []);
});

test("the mobile session list shows compact choices, a visible destination and no debug identifiers", async (t) => {
  const h = await harness(t);
  for (let index = 0; index < 6; index++) await createWorking(h, `Work ${index}`);
  const list = await h.text("!sessions");
  const text = visibleText(list);
  assert.match(text, /Current: Work 5/);
  assert.ok(text.length < 700, `Default list contains ${text.length} visible characters.`);
  for (const session of Object.values(h.bridge.store.snapshot().sessions)) {
    assert.ok(!text.includes(session.id));
    assert.ok(!text.includes(session.capability));
  }
  assert.equal(findAllActions(list).filter((action) => action.title === "Open").length, 3);
  assert.ok(findAction(list, "Search"));
  const dashboard = await h.text("!status");
  assert.equal(dashboard.body[0]?.text, "Work 5");
  assert.ok(JSON.stringify(dashboard).includes(h.bridge.store.snapshot().conversations[h.key]!.selectedId!));
  assert.ok(!visibleText(dashboard).includes("Native mode"));
});

test("long replies do not bury primary controls or turn the default card into a transcript", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.bridge.store.mutate((state) => {
    state.sessions[id]!.timeline.push({
      id: "long-preview", kind: "assistant", phase: "final", state: "done",
      text: "Read [the design](https://example.test/a-long-design-url).\n\n" + "A useful paragraph with details.\n\n".repeat(150),
    });
  });
  const card = h.bridge.render(h.key);
  assert.ok(visibleText(card).length < 750);
  assert.ok(!visibleText(card).includes("Read [the design]") && !visibleText(card).includes("Latest reply"),
    "working operations must not repeat a delivered reply body");
  assert.deepEqual(card.actions?.map((action) => action.title), ["Sessions", "History", "More"]);
  const primary = card.body.find((entry) => entry.id === "working-action");
  assert.equal(primary, undefined);
  assert.throws(() => findAction(card, "Send"), /not found/);
  assert.ok(!card.body.some((entry) => entry.id === "latest-reply-preview"));
  assert.ok(h.bridge.store.snapshot().sessions[id]!.timeline.at(-1)!.text.length > 4000);
});

test("key native session states retain full emphasis without changing ready, working, unknown or error meaning", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  for (const [status, text, color] of [
    ["idle", "● Ready", "Good"], ["busy", "● Working", "Accent"],
    ["awaiting", "▲ Needs reply", "Warning"], ["error", "! Session error", "Attention"],
    ["offline", "○ Not connected", "Default"],
  ] as const) {
    await h.bridge.store.mutate((state) => {
      state.sessions[id]!.status = status;
      state.sessions[id]!.executionObserved = status === "busy";
      state.sessions[id]!.pending = status === "awaiting"
        ? [{ id: "actual-pending", kind: "input", title: "Native question", choices: [], allowFreeform: true }] : [];
    });
    const header = h.bridge.render(h.key).body[1];
    assert.equal(header?.text, text);
    assert.notEqual(header.isSubtle, true, `${text} must not use a weakened host color`);
    assert.equal(header.color, color);
  }
  await h.bridge.store.mutate((state) => {
    Object.assign(state.sessions[id]!, { kind: "peer", peerSource: "app", status: "busy",
      liveUntil: Date.now() - 1, access: { read: true, send: true } });
  });
  const expired = h.bridge.render(h.key);
  assert.equal(expired.body[1]?.text, "? Status needs refresh");
  assert.notEqual(expired.body[1]?.isSubtle, true);
  assert.throws(() => findAction(expired, "Send"), /not found/);
  await h.bridge.store.mutate((state) => {
    delete state.sessions[id]!.liveUntil;
    state.sessions[id]!.access!.send = false;
    state.sessions[id]!.capability = "App live-status refresh failed; endpoint status is unknown.";
  });
  const unknown = h.bridge.render(h.key);
  assert.equal(unknown.body[1]?.text, "? Status unavailable");
  assert.notEqual(unknown.body[1]?.isSubtle, true);
  assert.equal(unknown.body[1]?.color, "Warning");
  assert.throws(() => findAction(unknown, "Send"), /not found/);
  assert.deepEqual(h.runtime.received, []);
});

test("status-only dashboard keeps navigation and scoped approval forms without any ordinary task input", async (t) => {
  const h = await harness(t, true);
  const id = await createWorking(h);
  const rendered = h.bridge.render(h.key);
  const inputIndex = rendered.body.findIndex((entry) => entry.type === "Input.Text" && entry.id === "message");
  assert.equal(inputIndex, -1);
  const send = legacySend(h.bridge, h.key);
  assert.equal(send.associatedInputs, "auto");
  assert.ok(object(send.data));
  const claims = h.bridge.actions.verify(send.data.token, h.bridge.store.snapshot().conversations[h.key]!);
  assert.equal(claims.op, "send");
  assert.equal(claims.targetId, id);
  assert.equal(claims.selected, id);
  assert.equal(claims.view, "dashboard");
  assert.deepEqual(rendered.actions?.map((action) => action.title), ["Sessions", "History", "More"]);
  assert.equal(rendered.actions?.length, 3);
  for (const action of rendered.actions ?? []) {
    if (action.type === "Action.ShowCard") continue;
    assert.equal(action.associatedInputs, "none", "navigation must not collect the task draft");
  }
  await h.bridge.store.mutate((state) => {
    Object.assign(state.sessions[id]!, { kind: "peer", peerSource: "app", status: "idle",
      liveUntil: Date.now() + 60_000, access: { read: true, send: false } });
  });
  const readOnly = h.bridge.render(h.key);
  assert.ok(!JSON.stringify(readOnly).includes('"id":"message"'));
  const checkGroup = readOnly.body.find((entry) => entry.id === "working-action");
  assert.equal(checkGroup?.type, "ActionSet");
  assert.ok(Array.isArray(checkGroup.actions) && checkGroup.actions.length === 1);
  const check = findAction(checkGroup, "Check status");
  assert.equal(check.associatedInputs, "none");
  assert.ok(object(check.data));
  const checkClaims = h.bridge.actions.verify(check.data.token, h.bridge.store.snapshot().conversations[h.key]!);
  assert.equal(checkClaims.op, "refresh");
  assert.equal(checkClaims.selected, id);
  assert.deepEqual(readOnly.actions?.map((action) => action.title), ["Sessions", "History", "More"]);
  assert.equal(findAllActions(readOnly).filter((action) => action.title === "Check status").length, 1);
  assert.throws(() => findAction(readOnly, "Send"), /not found/);
  await h.bridge.store.mutate((state) => { state.sessions[id]!.access!.read = false; });
  const unreadable = h.bridge.render(h.key);
  assert.deepEqual(unreadable.actions?.map((action) => action.title), ["Sessions", "More"]);
  assert.throws(() => findAction(unreadable, "History"), /not found/);
  await h.bridge.store.mutate((state) => {
    const session = state.sessions[id]!;
    session.kind = "owned";
    delete session.peerSource;
    delete session.access;
    delete session.liveUntil;
  });
  await h.text("ask");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[id]!.pending.length));
  const pending = h.bridge.store.snapshot().sessions[id]!.pending[0]!;
  const awaiting = h.bridge.render(h.key);
  assert.ok(!JSON.stringify(awaiting).includes('"id":"message"'));
  assert.ok(!awaiting.body.some((entry) => entry.id === "working-action"));
  const more = awaiting.actions?.find((action) => action.title === "More");
  assert.ok(more && object(more.card));
  assert.ok(!JSON.stringify(more.card).includes(`text_${inputSuffix(pending.id)}`));
  const answer = findAction(awaiting, "Answer");
  assert.ok(object(answer.data));
  const answerClaims = h.bridge.actions.verify(answer.data.token, h.bridge.store.snapshot().conversations[h.key]!);
  assert.equal(answerClaims.targetId, id);
  assert.equal(answerClaims.requestId, pending.id);
  await h.action(answer, { [`choice_${inputSuffix(pending.id)}`]: "0", [`text_${inputSuffix(pending.id)}`]: "" });
  assert.equal(h.runtime.answers.length, 1);
  assert.equal(h.runtime.answers[0]!.requestId, pending.id);
  assert.deepEqual(h.runtime.received, [{ sessionId: id, text: "ask" }]);
});

test("successful status checks keep Sessions in its fixed primary slot without treating ordinary not text as an error", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const refreshed = await h.action(findAction(h.bridge.render(h.key), "Check status"));
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /Idle is not a task-success signal/);
  assert.deepEqual(refreshed.actions?.map((action) => action.title), ["Sessions", "History", "More"]);
  assert.throws(() => findAction(refreshed, "Send"), /not found/);
  assert.ok(!visibleText(refreshed).includes("Status checked"));
  assert.ok(JSON.stringify(refreshed).includes("Refreshed native state"), "routine check evidence is retained in More");
  for (const text of [
    "Model capabilities loaded. Nothing has been changed in the working session yet.",
    "Stop request acknowledged. History and other sessions are preserved.",
    "This message is not a task-completion receipt.",
  ]) {
    await h.bridge.store.mutate((state) => { state.conversations[h.key]!.notice = text; });
    const rendered = h.bridge.render(h.key);
    assert.deepEqual(rendered.actions?.map((action) => action.title), ["Sessions", "History", "More"]);
    assert.throws(() => findAction(rendered, "Send"), /not found/);
    assert.notEqual(rendered.body.find((entry) => entry.text === text)?.color, "Attention");
  }
  await h.bridge.store.mutate((state) => {
    state.sessions[id]!.status = "error";
    state.conversations[h.key]!.notice = "Operation failed. Inspect details without retrying.";
  });
  const failed = h.bridge.render(h.key);
  assert.deepEqual(failed.actions?.map((action) => action.title), ["Sessions", "History", "More"]);
  assert.ok(findAction(failed.body.find((entry) => entry.id === "working-action"), "Check status"));
  assert.match(visibleText(failed), /Session error/);
  assert.equal(failed.body.find((entry) => typeof entry.text === "string" && entry.text.startsWith("Operation failed"))?.color, "Attention");
  await h.bridge.store.mutate((state) => {
    Object.assign(state.sessions[id]!, { kind: "peer", peerSource: "app", liveUntil: Date.now() - 1,
      access: { read: true, send: true } });
  });
  const expired = h.bridge.render(h.key);
  assert.deepEqual(expired.actions?.map((action) => action.title), ["Sessions", "History", "More"]);
  assert.ok(findAction(expired.body.find((entry) => entry.id === "working-action"), "Check status"));
  assert.throws(() => findAction(expired, "Send"), /not found/);
  assert.deepEqual(h.runtime.received, []);
});

test("native acceptance stays neutral before and after a final reply instead of asserting an untracked waiting state", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.text("an exact instruction");
  const notice = h.bridge.store.snapshot().conversations[h.key]!.notice;
  assert.match(notice, /^Native message /);
  const checkCard = () => {
    const rendered = h.bridge.render(h.key);
    assert.ok(!visibleText(rendered).includes("Message accepted"), "routine acceptance belongs in More");
    assert.ok(JSON.stringify(rendered).includes("Native message"), "the original admission notice stays accessible");
    assert.ok(!/Waiting for reply|Result confirmed|Reply delivered/u.test(visibleText(rendered)));
    assert.deepEqual(rendered.actions?.map((action) => action.title), ["Sessions", "History", "More"]);
    assert.throws(() => findAction(rendered, "Send"), /not found/);
  };
  checkCard();
  h.runtime.emit(id, "assistant.message", { messageId: "finished-native", phase: "final", content: "A complete visible answer." });
  h.runtime.emit(id, "session.idle");
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().sessions[id]!.status, "idle");
  checkCard();
  assert.ok(!visibleText(h.bridge.render(h.key)).includes("A complete visible answer"));
  await h.bridge.store.mutate((state) => {
    state.conversations[h.key]!.notice = "Peer owner accepted the exact message. Acceptance is not Teams delivery or task completion; supported result observation continues in the background. Approvals remain in its owner.";
  });
  assert.ok(!visibleText(h.bridge.render(h.key)).includes("Message accepted"));
  assert.ok(JSON.stringify(h.bridge.render(h.key)).includes("Peer owner accepted"));
  assert.ok(!visibleText(h.bridge.render(h.key)).includes("Waiting for reply"));
  assert.deepEqual(h.runtime.received, [{ sessionId: id, text: "an exact instruction" }]);
});

test("short settings and decline labels keep all native fields, canonical targets and exact request arguments", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const settings = await h.text("!settings");
  for (const [title, op] of [["Load options", "pick-model"], ["Apply", "settings"]] as const) {
    const action = findAction(settings, title);
    assert.ok(object(action.data));
    const claims = h.bridge.actions.verify(action.data.token, h.bridge.store.snapshot().conversations[h.key]!);
    assert.equal(claims.op, op);
    if (op === "settings") assert.equal(claims.targetId, id);
    assert.equal(action.associatedInputs, "auto");
  }
  for (const field of ["modelKey", "mode", "effort"]) {
    assert.ok(settings.body.some((entry) => entry.id === field));
  }
  for (const [kind, title] of [["permission", "Deny"], ["plan", "Request changes"]] as const) {
    const requestId = randomUUID();
    await h.bridge.store.mutate((state) => {
      state.conversations[h.key]!.view = "dashboard";
      state.sessions[id]!.status = "awaiting";
      state.sessions[id]!.pending = [{ id: requestId, kind, title: "Native approval", choices: [], allowFreeform: true }];
    });
    const rendered = h.bridge.render(h.key);
    const action = findAction(rendered, title);
    assert.ok(object(action.data));
    const claims = h.bridge.actions.verify(action.data.token, h.bridge.store.snapshot().conversations[h.key]!);
    assert.equal(claims.op, "answer");
    assert.equal(claims.targetId, id);
    assert.equal(claims.requestId, requestId);
    assert.equal(claims.argument, "decline");
    assert.equal(action.associatedInputs, "auto");
    assert.ok(JSON.stringify(rendered).includes(`text_${inputSuffix(requestId)}`));
    assert.ok(!JSON.stringify(rendered).includes('"id":"message"'));
  }
  assert.deepEqual(h.runtime.received, []);
  assert.deepEqual(h.runtime.answers, []);
});

test("the read-only status card keeps three navigation actions with unchanged signed management meanings", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h, "Readable working title");
  const rendered = h.bridge.render(h.key);
  assert.equal(rendered.body[0]?.text, "Readable working title");
  assert.deepEqual(rendered.actions?.map((action) => action.title), ["Sessions", "History", "More"]);
  assert.throws(() => findAction(rendered, "Send"), /not found/);
  const more = rendered.actions?.find((action) => action.title === "More");
  assert.ok(more?.type === "Action.ShowCard" && object(more.card));
  assert.ok(!JSON.stringify(more.card).includes('"type":"Action.ShowCard"'), "More must not contain nested disclosures");
  assert.ok(!JSON.stringify(more.card).includes('"type":"Input.'), "management shortcuts must not add another form to a task draft");
  const expected: Record<string, { op: string; argument?: string; targetId?: string }> = {
    Sessions: { op: "view", argument: "sessions" },
    History: { op: "view", argument: "transcript", targetId: id }, "Check status": { op: "refresh" },
    "New session": { op: "view", argument: "new" }, Settings: { op: "view", argument: "settings" },
    "Stop turn": { op: "stop", targetId: id }, Control: { op: "view", argument: "control" },
    Home: { op: "view", argument: "home" },
    Subscriptions: { op: "view", argument: "subscriptions" },
    Subscribe: { op: "subscribe", targetId: id },
    "Side chats": { op: "view", argument: "sides", targetId: id },
  };
  const actions = findAllActions(rendered);
  assert.equal(actions.length, Object.keys(expected).length);
  const conversation = h.bridge.store.snapshot().conversations[h.key]!;
  for (const action of actions) {
    assert.ok(typeof action.title === "string" && object(action.data));
    const scope = expected[action.title];
    assert.ok(scope, `unexpected control ${action.title}`);
    const claims = h.bridge.actions.verify(action.data.token, conversation);
    assert.deepEqual({ op: claims.op, argument: claims.argument, targetId: claims.targetId },
      { op: scope.op, argument: scope.argument, targetId: scope.targetId });
    assert.equal(claims.selected, id);
    assert.equal(action.associatedInputs, action.title === "Send" ? "auto" : "none");
  }
  assert.ok(visibleText(rendered).includes(id), "the status summary explicitly identifies the full current canonical source");
  assert.ok(!visibleText(rendered).includes("Native mode"));
  assert.ok(Buffer.byteLength(JSON.stringify(rendered)) < 27_000);
  assert.deepEqual(h.runtime.received, []);
});

test("compact instruction stages use admission and actual outbox facts once, with legacy uncertainty labelled as older", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h, "App destination");
  await h.bridge.flush();
  const messageId = randomUUID();
  const admissionId = digest(`${id}:${messageId}`);
  const eventId = randomUUID();
  const seed: AppAdmission = {
    id: admissionId, sessionId: id, messageId, conversationKey: h.key, receiptIds: ["ux-send"],
    baselineIndex: 0, acceptedAt: Date.now(), deadlineAt: Date.now() + 60_000, checkedAt: Date.now(),
    phase: "accepted", observation: "watching", resultIds: [],
  };
  const cases: Array<{
    phase: AppAdmission["phase"]; observation: AppAdmission["observation"]; label: string;
    delivery?: "pending" | "sent" | "uncertain" | "rejected"; activityId?: string; missingResult?: boolean;
  }> = [
    { phase: "accepted", observation: "watching", label: "Queued · Execution not yet observed" },
    { phase: "executing", observation: "watching", label: "Execution observed · Waiting for reply" },
    { phase: "accepted", observation: "timed_out", label: "Reply unconfirmed · Observation timed out" },
    { phase: "executing", observation: "interrupted", label: "Reply unconfirmed · Observation interrupted" },
    { phase: "accepted", observation: "failed", label: "Reply unconfirmed · Check failed" },
    { phase: "confirmed", observation: "settled", label: "Result confirmed · Delivery pending" },
    { phase: "confirmed", observation: "settled", delivery: "pending", label: "Result confirmed · Delivery pending" },
    { phase: "confirmed", observation: "settled", delivery: "sent", label: "Result confirmed · Delivery pending" },
    { phase: "confirmed", observation: "settled", delivery: "sent", activityId: "teams-activity", missingResult: true,
      label: "Result confirmed · Delivery pending" },
    { phase: "confirmed", observation: "settled", delivery: "uncertain", label: "Result confirmed · Delivery uncertain" },
    { phase: "confirmed", observation: "settled", delivery: "rejected", label: "Result confirmed · Delivery rejected" },
    { phase: "confirmed", observation: "settled", delivery: "sent", activityId: "teams-activity", label: "Reply delivered" },
  ];
  for (const item of cases) {
    await h.bridge.store.mutate((state) => {
      Object.assign(state.sessions[id]!, { kind: "peer", peerSource: "app", status: "busy",
        liveUntil: Date.now() + 60_000, access: { read: true, send: true } });
      const admission = { ...seed, phase: item.phase, observation: item.observation,
        resultIds: item.phase === "confirmed" ? [eventId, ...(item.missingResult ? ["missing-result"] : [])] : [] };
      state.admissions = { [admissionId]: admission };
      state.conversations[h.key]!.notice = appAdmissionNotice(admission);
      state.outbox = item.delivery ? [{
        id: "ux-outbox", conversationKey: h.key, sessionId: id, admissionId, eventId, text: "Result",
        status: item.delivery, ...(item.activityId ? { activityId: item.activityId } : {}),
      }] : [];
    });
    const rendered = h.bridge.render(h.key);
    const visible = visibleText(rendered);
    assert.equal(visible.split(item.label).length - 1, item.label === "Reply delivered" ? 0 : 1, item.label);
    if (item.label === "Reply delivered") assert.ok(JSON.stringify(rendered).includes("Reply delivered"));
    assert.notEqual(rendered.body.find((entry) => entry.text === item.label)?.isSubtle, true,
      "queued/result/uncertain stages must stay readable without changing their meaning");
    assert.ok(!visible.includes("App instruction") && !visible.includes("Native message") && !visible.includes("teams-activity"));
    assert.ok(!visible.includes(messageId) && !visible.includes(admissionId));
    assert.equal(JSON.stringify(rendered).split(appAdmissionNotice(h.bridge.store.snapshot().admissions[admissionId]!)).length - 1, 1,
      "the detailed admission must not be repeated as the last-operation notice");
    assert.equal(h.bridge.store.snapshot().sessions[id]!.status, "busy", "one admission's timeout cannot change the whole host status");
    assert.ok((rendered.actions?.length ?? 0) +
      findAllActions(rendered.body.filter((entry) => entry.id === "working-action")).length <= 4);
    assert.ok(Buffer.byteLength(JSON.stringify(rendered)) < 27_000);
  }
  await h.bridge.store.mutate((state) => {
    state.receipts["legacy-send"] = { id: "legacy-send", conversationKey: h.key, sessionId: id,
      operation: "send", status: "uncertain", detail: "Legacy host acknowledgement without native identity", at: 1 };
  });
  const legacy = h.bridge.render(h.key);
  assert.ok(!visibleText(legacy).includes("Reply delivered"));
  assert.ok(!visibleText(legacy).includes("Older send unconfirmed"));
  assert.ok(JSON.stringify(legacy).includes("Reply delivered") && JSON.stringify(legacy).includes("Older send unconfirmed"));
  assert.ok(!visibleText(legacy).includes("Execution/result remain unknown"));
  assert.ok(JSON.stringify(legacy).includes("this older request cannot be reconciled or replayed"));
  assert.deepEqual(h.runtime.received, []);
});

test("availability is never inferred from an expired busy lease, and pending approvals stay outside More and the task form", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.bridge.store.mutate((state) => {
    Object.assign(state.sessions[id]!, { kind: "peer", peerSource: "app", status: "busy",
      liveUntil: Date.now() - 1, access: { read: true, send: true } });
    state.conversations[h.key]!.notice = "";
  });
  const stale = h.bridge.render(h.key);
  assert.match(visibleText(stale), /Status needs refresh/);
  assert.ok(!/\bWorking\b|\bOffline\b|read-only/iu.test(visibleText(stale)));
  assert.throws(() => findAction(stale, "Send"), /not found/);
  assert.ok(findAction(stale, "Check status"));
  await h.bridge.store.mutate((state) => {
    state.sessions[id]!.liveUntil = Date.now() + 60_000;
    state.sessions[id]!.access!.send = false;
  });
  assert.match(visibleText(h.bridge.render(h.key)), /Read-only · History only/);
  assert.throws(() => findAction(h.bridge.render(h.key), "Send"), /not found/);
  await h.bridge.store.mutate((state) => { state.sessions[id]!.access!.read = false; });
  assert.match(visibleText(h.bridge.render(h.key)), /History unavailable · Sending disabled/);
  assert.throws(() => findAction(h.bridge.render(h.key), "History"), /not found/);
  const requestId = randomUUID();
  await h.bridge.store.mutate((state) => {
    const session = state.sessions[id]!;
    session.kind = "owned";
    delete session.peerSource;
    delete session.access;
    delete session.liveUntil;
    session.status = "error";
    session.timeline.push({ id: "visible-error", kind: "error", text: "Visible operation failure.", state: "failed" });
  });
  assert.match(visibleText(h.bridge.render(h.key)), /Session error/);
  assert.ok(JSON.stringify(h.bridge.render(h.key)).includes("Visible operation failure"));
  await h.bridge.store.mutate((state) => {
    state.sessions[id]!.status = "awaiting";
    state.sessions[id]!.pending = [{ id: requestId, kind: "permission", title: "Allow this exact action?",
      choices: [], allowFreeform: false }];
  });
  const pending = h.bridge.render(h.key);
  assert.match(visibleText(pending), /▲ Needs reply/);
  assert.match(visibleText(pending), /Approval: Allow this exact action/);
  assert.ok(!JSON.stringify(pending).includes('"id":"message"'));
  const more = pending.actions?.find((action) => action.title === "More");
  assert.ok(more && object(more.card));
  assert.ok(!JSON.stringify(more.card).includes(requestId));
  assert.ok(!JSON.stringify(more.card).includes('"type":"Action.ShowCard"'));
  const approval = findAction(pending, "Approve once");
  assert.ok(object(approval.data));
  const claims = h.bridge.actions.verify(approval.data.token, h.bridge.store.snapshot().conversations[h.key]!);
  assert.equal(claims.requestId, requestId);
  assert.equal(claims.targetId, id);
  assert.equal(approval.associatedInputs, "auto");
  assert.ok(!JSON.stringify(more.card).includes(`choice_${inputSuffix(requestId)}`));
});

test("history groups short dialogue, preserves every long Unicode/CRLF byte and opens the last answer rather than later status", () => {
  const long = "Line with Unicode 🚀 漢字\r\n[Reference](https://example.test/a)\n\n".repeat(300) + "FULL-ANSWER-END";
  const entries: TimelineEntry[] = [
    { id: "q1", kind: "user", text: "Question one\r\nwith a second line." },
    { id: "a1", kind: "assistant", phase: "final", state: "done", text: "Answer one.\n\nA second paragraph." },
    { id: "q2", kind: "user", text: "Question two." },
    { id: "a2", kind: "assistant", phase: "commentary", state: "running", text: "Working update." },
    { id: "long", kind: "assistant", phase: "final", state: "done", text: long },
    { id: "status", kind: "status", text: "Later native status." },
  ];
  const pages = transcriptPages(entries);
  assert.equal(pages[0], "**You**\n\nQuestion one\r\nwith a second line.\n\n**Copilot**\n\nAnswer one.\n\nA second paragraph.\n\n**You**\n\nQuestion two.");
  assert.equal(pages.slice(1).join(""), `**Copilot**\n\n${long}`);
  assert.ok(!pages.some((page) => page.includes("Working update.") || page.includes("Later native status.")),
    "typed progress/status remain stored but are not part of default conversation History");
  assert.ok(pages.every((page) => Buffer.byteLength(page) <= 7000 && !page.includes("\uFFFD")));
  assert.equal(latestTranscriptPage(entries), pages.length - 1);
  assert.ok(pages.every((page) => !/assistant\/final|commentary - running| - done/u.test(page)));
});

test("a full Unicode history page stays readable under 27KB even when optional progress and delivery diagnostics are large", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.bridge.flush();
  await h.bridge.store.mutate((state) => {
    const target = state.sessions[id]!;
    Object.assign(target, { kind: "peer", peerSource: "app", status: "busy", liveUntil: Date.now() + 60_000,
      access: { read: true, send: true } });
    target.timeline = Array.from({ length: 8 }, (_, index) => ({
      id: `large-visible-${index}`, kind: "assistant", phase: "final", state: "done",
      text: "🚀".repeat(2200) + ` visible message ${index}`,
    }));
    const conversation = state.conversations[h.key]!;
    conversation.view = "transcript";
    conversation.transcriptId = id;
    conversation.page = 0;
    conversation.notice = "";
    for (let index = 0; index < 3; index++) {
      const messageId = randomUUID();
      const admissionId = digest(`${id}:${messageId}`);
      const eventId = randomUUID();
      state.admissions[admissionId] = {
        id: admissionId, sessionId: id, messageId, conversationKey: h.key, receiptIds: [],
        baselineIndex: 0, acceptedAt: Date.now() + index, deadlineAt: Date.now() + 60_000, checkedAt: Date.now(),
        phase: "confirmed", observation: "settled", resultIds: [eventId],
      };
      for (let chunk = 0; chunk < 30; chunk++) state.outbox.push({
        id: digest(`${admissionId}:${chunk}`), conversationKey: h.key, sessionId: id, admissionId, eventId, text: "Long reply chunk",
        status: "sent", activityId: `179475000000000${String(chunk).padStart(4, "0")}`,
      });
    }
  });
  const rendered = h.bridge.render(h.key);
  assert.ok(rendered.body.some((entry) => entry.id === "transcript-page-text"),
    "optional diagnostics must not replace the current page with a History link back to itself");
  assert.equal(transcriptText(rendered), transcriptPages(h.bridge.store.snapshot().sessions[id]!.timeline)[0]);
  assert.ok(Buffer.byteLength(JSON.stringify(rendered)) <= 27_000);
  assert.deepEqual(rendered.actions?.map((action) => action.title), ["Newer", "Back", "More"]);
  const more = rendered.actions?.find((action) => action.title === "More");
  assert.ok(more && object(more.card));
  for (const admission of Object.values(h.bridge.store.snapshot().admissions)) {
    assert.ok(JSON.stringify(more.card).includes(admission.messageId), "receipt/native identity details must remain accessible");
  }
});

test("session search is local and old page links retain their signed search scope", async (t) => {
  const h = await harness(t);
  for (let index = 0; index < 6; index++) {
    const id = await createWorking(h, `Build ${index}`);
    await h.bridge.store.mutate((state) => {
      state.sessions[id]!.lastConversationAt = new Date(Date.UTC(2026, 10, 14, index)).toISOString();
    });
  }
  const notes = await createWorking(h, "Notes");
  const list = await h.text("!sessions");
  const inventory = t.mock.method(h.runtime, "inventory");
  const filtered = await h.action(findAction(list, "Search"), { query: " Build " });
  assert.equal(findAllActions(filtered).filter((action) => action.title === "Open").length, 3);
  const next = findAction(filtered, "Next");
  await h.action(findAction(filtered, "Search"), { query: "Notes" });
  const restored = await h.action(next);
  assert.match(visibleText(restored), /Build 0/);
  assert.equal(findAllActions(restored).filter((action) => action.title === "Open").length, 3);
  assert.equal(inventory.mock.callCount(), 0);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, notes);
  assert.deepEqual(h.runtime.received, []);
});

test("native Search clears an existing filter when the optional query is omitted, undefined, null or empty", async (t) => {
  const h = await harness(t);
  for (let index = 0; index < 6; index++) await createWorking(h, `PR 审查协议 ${index}`);
  const selectedId = await createWorking(h, "Selected work");
  await h.text("!sessions");
  await eventually(() => /Session list refreshed/.test(h.bridge.store.snapshot().conversations[h.key]!.notice));
  const runtimeCalls = [
    t.mock.method(h.runtime, "create"), t.mock.method(h.runtime, "resume"), t.mock.method(h.runtime, "send"),
    t.mock.method(h.runtime, "models"), t.mock.method(h.runtime, "settings"), t.mock.method(h.runtime, "inventory"),
  ];
  const outcomes = [];
  const cases: Array<{ name: string; fields: Record<string, unknown> }> = [
    { name: "omitted", fields: {} },
    { name: "undefined", fields: { query: undefined } },
    { name: "null", fields: { query: null } },
    { name: "empty", fields: { query: "" } },
    { name: "whitespace", fields: { query: " \t\r\n\u00a0" } },
  ];
  for (const { name, fields } of cases) {
    const filtered = await h.action(findAction(h.bridge.render(h.key), "Search"), { query: " PR 审查协议 " });
    await h.action(findAction(filtered, "Next"));
    const before = h.bridge.store.snapshot().conversations[h.key]!;
    assert.equal(before.query, "PR 审查协议");
    assert.equal(before.page, 1);
    const action = findAction(h.bridge.render(h.key), "Search");
    assert.ok(object(action.data));
    const data = { ...action.data, ...fields };
    if (name === "omitted") assert.deepEqual(Object.keys(data), ["token"], "native optional input may be absent entirely");
    const turn = authorizeActivity({
      ...mockEnvelope(""), value: data,
    }, { aud: mockIdentity.appId }, mockIdentity);
    const rendered = await h.bridge.handle(turn.key, turn.reference, turn.activity.id!, turn.incoming);
    const state = h.bridge.store.snapshot();
    const current = state.conversations[h.key]!;
    outcomes.push({
      name, query: current.query, page: current.page, view: current.view, selectedId: current.selectedId,
      status: state.receipts[digest(`${h.key}:${turn.activity.id}`)]?.status,
      input: rendered.body.find((entry) => entry.id === "query")?.value,
      choices: findAllActions(rendered).filter((entry) => entry.title === "Open").length,
    });
  }
  assert.deepEqual(outcomes, cases.map(({ name }) => ({
    name, query: "", page: 0, view: "sessions", selectedId, status: "accepted", input: "", choices: 3,
  })));
  for (const call of runtimeCalls) assert.equal(call.mock.callCount(), 0, "search must not create/send/resume or discover models");
  assert.deepEqual(h.runtime.received, []);
  assert.equal(h.runtime.live.has(h.bridge.store.snapshot().controllerId!), false);
  assert.equal(h.bridge.store.snapshot().outbox.length, 0);
});

test("optional Search clearing still rejects invalid types, over-limit text and extra fields without changing the target", async (t) => {
  const h = await harness(t);
  const selectedId = await createWorking(h, "Retained destination");
  const list = await h.text("!sessions");
  await eventually(() => /Session list refreshed/.test(h.bridge.store.snapshot().conversations[h.key]!.notice));
  const runtimeCalls = [
    t.mock.method(h.runtime, "create"), t.mock.method(h.runtime, "resume"), t.mock.method(h.runtime, "send"),
    t.mock.method(h.runtime, "models"), t.mock.method(h.runtime, "settings"), t.mock.method(h.runtime, "inventory"),
  ];
  await h.action(findAction(list, "Search"), { query: "x".repeat(100) });
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.query, "x".repeat(100));
  await h.action(findAction(h.bridge.render(h.key), "Search"), { query: " Retained " });
  await h.bridge.store.mutate((state) => { state.conversations[h.key]!.page = 1; });
  const invalid = [0, 123, true, false, [], ["Retained"], {}, { query: "Retained" }, "x".repeat(101), " ".repeat(101)];
  for (const query of invalid) {
    const activityId = randomUUID();
    await h.action(findAction(h.bridge.render(h.key), "Search"), { query }, activityId);
    const state = h.bridge.store.snapshot();
    const current = state.conversations[h.key]!;
    assert.equal(state.receipts[digest(`${h.key}:${activityId}`)]?.status, "failed");
    assert.match(current.notice, /Enter a session name of at most 100 characters/);
    assert.equal(current.query, "Retained");
    assert.equal(current.page, 1);
    assert.equal(current.view, "sessions");
    assert.equal(current.selectedId, selectedId);
  }
  const activityId = randomUUID();
  await h.action(findAction(h.bridge.render(h.key), "Search"), { query: null, targetId: selectedId }, activityId);
  const state = h.bridge.store.snapshot();
  const current = state.conversations[h.key]!;
  assert.equal(state.receipts[digest(`${h.key}:${activityId}`)]?.status, "failed");
  assert.match(current.notice, /unexpected field/);
  assert.equal(current.query, "Retained");
  assert.equal(current.page, 1);
  assert.equal(current.selectedId, selectedId);
  for (const call of runtimeCalls) assert.equal(call.mock.callCount(), 0, "invalid filters must not dispatch native work");
  assert.deepEqual(h.runtime.received, []);
  assert.equal(h.runtime.live.has(state.controllerId!), false);
});

test("lists, search and pagination share busy/online/offline ordering with stable dialogue-time ties, without changing the selected destination", async (t) => {
  const h = await harness(t);
  const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
  const row = (
    value: number, status: SessionRecord["status"], at?: string, kind: SessionRecord["kind"] = "peer",
  ): Awaited<ReturnType<FakeRuntime["inventory"]>>[number] => ({
    id: id(value), name: `Order ${value}`, kind, status, workspace: h.directory, capability: "Fixture",
    ...(at ? { lastConversationAt: at } : {}),
  });
  h.runtime.foreign.push(
    row(10, "offline"),
    row(9, "offline", "2026-11-14T07:00:00Z"),
    row(8, "offline", "2026-11-14T07:00:00Z"),
    { ...row(7, "busy", "2026-11-14T08:00:00Z"), peerSource: "app",
      access: { read: true, send: true }, liveUntil: Date.now() - 1 },
    row(6, "idle", "2026-11-14T10:00:00Z", "saved"),
    row(5, "idle", "2026-11-14T05:00:00Z"),
    row(4, "idle", "2026-11-14T06:00:00Z"),
    row(3, "busy"),
    row(2, "busy", "2026-11-14T04:00:00Z"),
    row(1, "busy", "2026-11-14T01:00:00Z"),
  );
  await h.text("!sessions");
  await eventually(() => /Session list refreshed/.test(h.bridge.store.snapshot().conversations[h.key]!.notice));
  await h.bridge.store.mutate((state) => {
    const conversation = state.conversations[h.key]!;
    conversation.selectedId = id(5);
    for (const [index, session] of Object.values(state.sessions).entries()) session.updatedAt = 999_999_999_999_999 - index;
  });
  const ids = (card: Card) => findAllActions(card).filter((action) => action.title === "Open").map((action) => {
    assert.ok(object(action.data));
    return h.bridge.actions.authenticate(action.data.token, h.bridge.store.snapshot().conversations[h.key]!).targetId;
  });
  const first = h.bridge.render(h.key);
  assert.deepEqual(ids(first), [2, 1, 3].map(id));
  assert.match(visibleText(first), /Current: Order 5/);
  const next = await h.action(findAction(first, "Next"));
  assert.deepEqual(ids(next), [4, 5, 6].map(id));
  const third = await h.action(findAction(next, "Next"));
  const fourth = await h.action(findAction(third, "Next"));
  assert.deepEqual([...ids(first), ...ids(next), ...ids(third), ...ids(fourth)], [2, 1, 3, 4, 5, 6, 7, 8, 9, 10].map(id));
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, id(5));
  const previous = await h.action(findAction(next, "Previous"));
  assert.deepEqual(ids(previous), ids(first));
  const search = await h.action(findAction(previous, "Search"), { query: "Order" });
  assert.deepEqual(ids(search), ids(first));
  const searchNext = await h.action(findAction(search, "Next"));
  assert.deepEqual(ids(searchNext), ids(next));
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, id(5));
  assert.deepEqual(h.runtime.received, []);
});

test("visible root conversations advance recency but tools, hidden phases, child messages and maintenance do not", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const projector = new Projector();
  await h.bridge.store.mutate((state) => {
    const session = state.sessions[id]!;
    projector.apply(session, {
      id: "root-user", type: "user.message", timestamp: "2026-11-14T06:00:00Z",
      data: { content: "Visible user", parentAgentTaskId: randomUUID(), isAutopilotContinuation: false },
    });
    assert.equal(session.lastConversationAt, "2026-11-14T06:00:00Z");
    for (const event of [
      { type: "assistant.message", data: { phase: "analysis", content: "hidden" } },
      { type: "assistant.message", agentId: "child", data: { content: "child" } },
      { type: "user.message", data: { source: "skill-internal", content: "injected" } },
      { type: "tool.execution_complete", data: { success: true, result: { content: "tool" } } },
      { type: "session.mode_changed", data: {} },
    ]) projector.apply(session, { ...event, id: randomUUID(), timestamp: "2026-11-14T10:00:00Z" });
    assert.equal(session.lastConversationAt, "2026-11-14T06:00:00Z");
    projector.apply(session, {
      id: "root-answer", type: "assistant.message", timestamp: "2026-11-14T06:00:02Z",
      data: { messageId: "root-answer", phase: "final", content: "Visible answer" },
    });
    assert.equal(session.lastConversationAt, "2026-11-14T06:00:02Z");
  });
});

test("App endpoint freshness owns active status even when a bot admission completes, and expired cached endpoints become read-only", async (t) => {
  const h = await harness(t);
  const id = randomUUID();
  await h.bridge.store.mutate((state) => {
    state.sessions[id] = {
      id, name: "Original App work", kind: "peer", peerSource: "app", status: "busy", workspace: h.directory,
      capability: "Live endpoint", access: { read: true, send: true }, liveUntil: Date.now() + 20_000,
      timeline: [], pending: [], seenEvents: [], sequence: 0, updatedAt: 0,
    };
    const conversation = state.conversations[h.key]!;
    conversation.selectedId = id;
    conversation.view = "dashboard";
    new Projector().apply(state.sessions[id], { id: "our-admission-finished", type: "session.idle", data: {} });
  });
  assert.equal(h.bridge.store.snapshot().sessions[id]?.status, "busy");
  assert.ok(legacySend(h.bridge, h.key));
  assert.match(visibleText(h.bridge.render(h.key)), /^● Working$/m);
  await h.bridge.store.mutate((state) => { state.sessions[id]!.liveUntil = Date.now() - 1; });
  const expired = visibleText(h.bridge.render(h.key));
  assert.match(expired, /Status needs refresh/);
  assert.ok(!/Working/m.test(expired), "a stale cached busy state cannot be presented as current liveness");
  assert.ok(!expired.includes("Offline") && !expired.includes("History only"), "read-only snapshot help is not an endpoint status");
  assert.throws(() => findAction(h.bridge.render(h.key), "Send"), /not found/);
});

test("concurrent navigation shares one liveness refresh and retains each conversation's page, query and destination", async (t) => {
  const h = await harness(t);
  const otherActivity = mockEnvelope();
  assert.ok(object(otherActivity.conversation));
  const other = authorizeActivity({
    ...otherActivity, conversation: { ...otherActivity.conversation, id: "a:another-private-conversation" },
  }, { aud: mockIdentity.appId }, mockIdentity);
  await h.bridge.handle(other.key, other.reference, randomUUID(), { kind: "text", text: "!status" });
  const ids = Array.from({ length: 7 }, () => randomUUID());
  await h.bridge.store.mutate((state) => {
    for (const [index, id] of ids.entries()) state.sessions[id] = {
      id, name: `Joined ${index}`, kind: "peer", peerSource: "app", status: "idle", workspace: h.directory,
      capability: "Cached endpoint", liveUntil: Date.now() - 1, access: { read: true, send: true },
      lastConversationAt: "2026-11-14T06:00:00Z", timeline: [], pending: [], seenEvents: [], sequence: 0, updatedAt: 0,
    };
    for (const key of [h.key, other.key]) {
      const conversation = state.conversations[key]!;
      conversation.view = "sessions";
      conversation.query = "Joined";
      conversation.page = 1;
      conversation.selectedId = ids[0]!;
    }
  });
  let release: ((value: AppSessionLiveness[]) => void) | undefined;
  const pending = new Promise<AppSessionLiveness[]>((resolve) => { release = resolve; });
  const refresh = t.mock.method(h.runtime, "appLiveness", () => pending);
  const inventory = t.mock.method(h.runtime, "inventory");
  const postPrevious = async (key: string, reference: typeof other.reference) => {
    const previous = findAction(h.bridge.render(key), "Previous");
    assert.ok(object(previous.data));
    return h.bridge.handle(key, reference, randomUUID(), { kind: "action", data: previous.data });
  };
  const initial = authorizeActivity(mockEnvelope(), { aud: mockIdentity.appId }, mockIdentity);
  const left = postPrevious(h.key, initial.reference);
  const right = postPrevious(other.key, other.reference);
  try {
    await eventually(() => refresh.mock.callCount() === 1);
    release!(ids.map((id) => ({ id, status: "idle", liveUntil: Date.now() + 20_000 })));
    await Promise.all([left, right]);
    for (const key of [h.key, other.key]) {
      const conversation = h.bridge.store.snapshot().conversations[key]!;
      assert.equal(conversation.query, "Joined");
      assert.equal(conversation.page, 0, "only the requested previous-page action may change the page");
      assert.equal(conversation.selectedId, ids[0]);
      assert.ok(!visibleText(h.bridge.render(key)).includes("History only"));
    }
    assert.equal(refresh.mock.callCount(), 1);
    assert.equal(inventory.mock.callCount(), 0);
    assert.deepEqual(h.runtime.received, []);
  } finally {
    release?.([]);
    await Promise.all([left, right]);
  }
});

test("failed or stalled liveness checks are bounded, visibly unknown and cannot apply a late success or start duplicate reads", async (t) => {
  for (const mode of ["failure", "timeout"] as const) {
    const h = await harness(t, false, undefined, { appLivenessTimeoutMs: 25 });
    const id = randomUUID();
    await h.bridge.store.mutate((state) => {
      state.sessions[id] = {
        id, name: "Original App", kind: "peer", peerSource: "app", status: "busy", workspace: h.directory,
        capability: "Cached live endpoint", liveUntil: Date.now() - 1, access: { read: true, send: true },
        lastConversationAt: "2026-11-14T06:00:00Z", timeline: [], pending: [], seenEvents: [], sequence: 0, updatedAt: 0,
      };
      state.conversations[h.key]!.selectedId = id;
    });
    let release: ((value: AppSessionLiveness[]) => void) | undefined;
    const pending = new Promise<AppSessionLiveness[]>((resolve) => { release = resolve; });
    const refresh = t.mock.method(h.runtime, "appLiveness", async () => {
      if (mode === "failure") throw new Error("PRIVATE_LIVENESS_DETAIL");
      return pending;
    });
    const card = await h.text("!status");
    assert.match(visibleText(card), /Couldn't refresh status/);
    assert.match(visibleText(card), /Status unavailable/);
    assert.ok(findAction(card, "Check status"));
    assert.throws(() => findAction(card, "Send"), /not found/);
    assert.ok(!JSON.stringify(card).includes("PRIVATE_LIVENESS_DETAIL"));
    assert.equal(h.bridge.store.snapshot().sessions[id]!.access?.send, false);
    assert.equal(h.bridge.store.snapshot().sessions[id]!.liveUntil, undefined);
    assert.equal(h.bridge.store.snapshot().sessions[id]!.lastConversationAt, "2026-11-14T06:00:00Z");
    await h.text("!status");
    assert.equal(refresh.mock.callCount(), 1, "failed/offline repeated navigation must not spin new registry reads");
    if (mode === "timeout") {
      await h.bridge.store.mutate((state) => { state.sessions[id]!.liveUntil = Date.now() - 1; });
      await h.text("!status");
      assert.equal(refresh.mock.callCount(), 1, "a real stalled read remains single-flight beyond the UI deadline");
      release!([{ id, status: "idle", liveUntil: Date.now() + 20_000 }]);
      await pending;
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(h.bridge.store.snapshot().sessions[id]!.access?.send, false, "late data must not silently restore writable state");
    }
    assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, id);
    assert.deepEqual(h.runtime.received, []);
  }
});
test("returning to an expired History link reads its signed session without sending to a newer selection", async (t) => {
  const h = await harness(t);
  const a = await createWorking(h, "Original work");
  h.runtime.live.get(a)!.events.push({
    id: "original-answer", type: "assistant.message",
    data: { messageId: "original-answer", phase: "final_answer", content: "Original retained answer." },
  });
  const state = h.bridge.store.snapshot();
  const legacyConversation = structuredClone(state.conversations[h.key]!);
  delete legacyConversation.surfaceId;
  const token = new Actions(state.actionKey, 10).issue(legacyConversation, {
    op: "view", argument: "transcript", targetId: a,
  }, Date.now() - 3 * 24 * 60 * 60_000);
  const b = await createWorking(h, "Another work");
  await h.action({ data: { token } });
  const conversation = h.bridge.store.snapshot().conversations[h.key]!;
  assert.equal(conversation.selectedId, a);
  assert.equal(conversation.historyRead?.sessionId, a);
  await h.bridge.flush();
  assert.ok(h.bridge.store.snapshot().outbox.some((item) => item.historyId && item.text.includes("Original retained answer")));
  assert.equal(h.runtime.received.length, 0);
  await h.text("Continue the displayed work.");
  assert.equal(h.runtime.received.at(-1)?.sessionId, a);
  assert.ok(!h.runtime.received.some((message) => message.sessionId === b));
});

test("History commits its visible target atomically when a controller selection finishes concurrently", async (t) => {
  const h = await harness(t);
  const a = await createWorking(h, "History target");
  h.runtime.live.get(a)!.events.push({
    id: "history-target-answer", type: "assistant.message",
    data: { messageId: "history-target-answer", phase: "final_answer", content: "History target content." },
  });
  const legacyConversation = structuredClone(h.bridge.store.snapshot().conversations[h.key]!);
  delete legacyConversation.surfaceId;
  const history = { data: { token: h.bridge.actions.issue(legacyConversation, { op: "view", argument: "transcript", targetId: a }) } };
  const b = await createWorking(h, "Controller selection");
  const controller = h.bridge.store.snapshot().controllerId!;
  await h.text("!control select a session");
  const handler = h.runtime.live.get(controller)!.tools.find((tool) => tool.name === "bridge_select")?.handler;
  assert.ok(handler);
  const original = h.bridge.store.mutate.bind(h.bridge.store);
  let interleaved = false;
  t.mock.method(h.bridge.store, "mutate", async <T>(change: (state: BridgeState) => T): Promise<T> => {
    const candidate = h.bridge.store.snapshot();
    change(candidate);
    if (!interleaved && candidate.conversations[h.key]?.historyRead?.sessionId === a) {
      interleaved = true;
      await handler({ sessionId: b }, {
        sessionId: controller, toolCallId: randomUUID(), toolName: "bridge_select", arguments: { sessionId: b },
      });
    }
    return original(change);
  });
  await h.action(history);
  assert.equal(interleaved, true);
  const conversation = h.bridge.store.snapshot().conversations[h.key]!;
  assert.equal(conversation.historyRead?.sessionId, a);
  assert.equal(conversation.selectedId, a);
  await h.text("Continue the displayed history.");
  assert.equal(h.runtime.received.at(-1)?.sessionId, a);
  assert.ok(!h.runtime.received.some((message) => message.sessionId === b));
});

test("a session-list command creates a visible refreshing card before a slow inventory read completes", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.bridge.flush();
  const oldDashboard = h.bridge.store.snapshot().conversations[h.key]!.dashboardId;
  let finishRefresh: () => void = () => { throw new Error("Inventory fixture was not initialized."); };
  const promise = new Promise<Awaited<ReturnType<typeof h.runtime.inventory>>>((resolve) => {
    finishRefresh = () => resolve([]);
  });
  const inventory = t.mock.method(h.runtime, "inventory", () => promise);
  const request = h.text("!sessions");
  try {
    await eventually(() => {
      const current = h.bridge.store.snapshot().conversations[h.key]!;
      return Boolean(current.dashboardId && current.dashboardId !== oldDashboard);
    });
    const current = h.bridge.store.snapshot().conversations[h.key]!;
    const sent = h.transport.messages.get(current.dashboardId!);
    assert.equal(sent?.message.type, "card");
    assert.match(JSON.stringify(sent?.message), /Refreshing sessions\.\.\./);
    assert.equal(inventory.mock.callCount(), 1);
    assert.equal(current.selectedId, id);
    assert.deepEqual(h.runtime.received, []);
  } finally {
    finishRefresh();
    await request;
  }
  await eventually(() => /Session list refreshed/.test(h.bridge.store.snapshot().conversations[h.key]!.notice));
  await h.bridge.flush();
  assert.match(visibleText(h.bridge.render(h.key)), /^Sessions$/m);
  assert.ok(!visibleText(h.bridge.render(h.key)).includes("Refreshing sessions"));
});

test("visible navigation survives queued clicks and remains reusable without executing session work", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.bridge.flush();
  const dashboardId = h.bridge.store.snapshot().conversations[h.key]!.dashboardId!;
  const delivered = h.transport.messages.get(dashboardId);
  assert.ok(delivered?.message.type === "card");
  const visible = delivered.message.card;
  const listForBack = await h.action(findAction(visible, "Sessions"));
  const back = findAction(await h.action(findAction(listForBack, "Home")), "Current session");
  for (const [title, view] of [
    ["Control", "control"], ["New session", "new"], ["Sessions", "sessions"],
    ["Back", "dashboard"], ["New session", "new"],
  ] as const) {
    await h.action(title === "Back" ? back : findAction(visible, title));
    assert.equal(h.bridge.store.snapshot().conversations[h.key]!.view, view);
  }
  const list = await h.text("!sessions");
  const home = await h.action(findAction(list, "Home"));
  await h.action(findAction(home, "Control"));
  await h.action(findAction(list, "Open"));
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, id);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.view, "dashboard");
  assert.equal(Object.values(h.bridge.store.snapshot().sessions).filter((item) => item.kind === "owned").length, 1);
  assert.deepEqual(h.runtime.received, []);
  assert.deepEqual(h.runtime.stopped, []);
  assert.deepEqual(h.runtime.answers, []);
});

test("old navigation can open a fresh form but expired, tampered and foreign mutations stay blocked", async (t) => {
  const h = await harness(t);
  await createWorking(h);
  const state = h.bridge.store.snapshot();
  const conversation = state.conversations[h.key]!;
  const actions = new Actions(state.actionKey, 10);
  const legacyConversation = structuredClone(conversation);
  delete legacyConversation.surfaceId;
  const oldNavigation = actions.issue(legacyConversation, { op: "view", argument: "new" }, Date.now() - 1000);
  await h.text("!control");
  await h.action({ data: { token: oldNavigation } });
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.view, "new");
  assert.ok(findAction(h.bridge.render(h.key), "Create"));

  const expiredCreate = actions.issue(
    h.bridge.store.snapshot().conversations[h.key]!, { op: "create" }, Date.now() - 1000,
  );
  await h.action({ data: { token: expiredCreate } }, { sessionName: "Must not create", workspace: "local" });
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /expired/);
  assert.equal(Object.values(h.bridge.store.snapshot().sessions).filter((item) => item.kind === "owned").length, 1);
  assert.throws(() => actions.verify(`${oldNavigation}x`, conversation), /signature/);
  assert.throws(() => actions.verify(oldNavigation, { ...conversation, key: "another-conversation" }), /conversation/);
  const staleStop = actions.issue(conversation, { op: "stop", targetId: conversation.selectedId! });
  await h.action({ data: { token: staleStop } });
  assert.deepEqual(h.runtime.stopped, []);
});

test("Sessions button switches to visible loading state before a slow host refresh completes", async (t) => {
  const h = await harness(t);
  await createWorking(h);
  await h.bridge.flush();
  const dashboardId = h.bridge.store.snapshot().conversations[h.key]!.dashboardId!;
  const delivered = h.transport.messages.get(dashboardId);
  assert.ok(delivered?.message.type === "card");
  let release: () => void = () => { throw new Error("Inventory fixture was not initialized."); };
  const inventory = new Promise<Awaited<ReturnType<typeof h.runtime.inventory>>>((resolve) => {
    release = () => resolve([]);
  });
  t.mock.method(h.runtime, "inventory", () => inventory);
  const request = h.action(findAction(delivered.message.card, "Sessions"));
  try {
    await eventually(() => h.bridge.store.snapshot().conversations[h.key]?.view === "sessions");
    await eventually(() => /Refreshing sessions\.\.\./.test(JSON.stringify(h.transport.messages.get(dashboardId))));
    assert.deepEqual(h.runtime.received, []);
  } finally {
    release();
    await request;
  }
  await eventually(() => /Session list refreshed/.test(h.bridge.store.snapshot().conversations[h.key]!.notice));
  await h.bridge.flush();
  const updated = h.transport.messages.get(dashboardId);
  assert.ok(updated?.message.type === "card");
  assert.match(visibleText(updated.message.card), /^Sessions$/m);
  assert.ok(!visibleText(updated.message.card).includes("Refreshing sessions"));
});

test("a delivered list remains pageable while its catalogue refresh is in flight", async (t) => {
  const h = await harness(t);
  for (let index = 0; index < 6; index++) await createWorking(h, `Session ${index}`);
  await h.text("!sessions");
  await h.bridge.flush();
  const dashboardId = h.bridge.store.snapshot().conversations[h.key]!.dashboardId!;
  const delivered = h.transport.messages.get(dashboardId);
  assert.ok(delivered?.message.type === "card");
  let release: () => void = () => { throw new Error("Inventory fixture was not initialized."); };
  const pending = new Promise<Awaited<ReturnType<typeof h.runtime.inventory>>>((resolve) => {
    release = () => resolve([]);
  });
  const inventory = t.mock.method(h.runtime, "inventory", () => pending);
  const resume = t.mock.method(h.runtime, "resume");
  const history = t.mock.method(h.runtime, "history");
  const refresh = h.action(findAction(delivered.message.card, "Refresh"));
  const next = h.action(findAction(delivered.message.card, "Next"));
  try {
    await eventually(() => inventory.mock.callCount() === 1);
  } finally {
    release();
    await Promise.all([refresh, next]);
  }
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.page, 1);
  assert.match(JSON.stringify(h.bridge.render(h.key)), /Page 2 of 2/);
  assert.equal(h.bridge.store.snapshot().outbox.length, 0);
  assert.equal(resume.mock.callCount(), 0);
  assert.equal(history.mock.callCount(), 0);
  assert.deepEqual(h.runtime.received, []);
});

test("duplicate catalogue submissions acknowledge the existing result without another host refresh or error reply", async (t) => {
  const h = await harness(t);
  await createWorking(h);
  const list = await h.text("!sessions");
  const inventory = t.mock.method(h.runtime, "inventory", async () => []);
  const refresh = findAction(list, "Refresh");
  await Promise.all([h.action(refresh), h.action(refresh)]);
  assert.equal(inventory.mock.callCount(), 1);
  assert.equal(h.bridge.store.snapshot().outbox.length, 0);
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /already used.*accepted/i);
  assert.deepEqual(h.runtime.received, []);
});

test("signed list pages retain their view intent across expiry and navigation without retargeting work", async (t) => {
  const h = await harness(t);
  for (let index = 0; index < 6; index++) await createWorking(h, `Session ${index}`);
  await h.text("!sessions");
  const state = h.bridge.store.snapshot();
  const conversation = state.conversations[h.key]!;
  const actions = new Actions(state.actionKey, 10);
  const legacyConversation = structuredClone(conversation);
  delete legacyConversation.surfaceId;
  const token = actions.issue(legacyConversation, { op: "page", argument: "1" }, Date.now() - 1000);
  await h.text("!control");
  await h.action({ data: { token } });
  await h.action({ data: { token } });
  const current = h.bridge.store.snapshot().conversations[h.key]!;
  assert.equal(current.view, "sessions");
  assert.equal(current.page, 1);
  assert.equal(current.selectedId, conversation.selectedId);
  assert.equal(h.bridge.store.snapshot().outbox.length, 0);
  assert.deepEqual(h.runtime.received, []);
  assert.deepEqual(h.runtime.stopped, []);
  assert.deepEqual(h.runtime.answers, []);
  assert.throws(() => actions.verify(`${token}x`, current), /signature/);
  assert.throws(() => actions.verify(token, { ...current, key: "another-conversation" }), /conversation/);
});

test("an authenticated duplicate mutation reports its recorded outcome without applying changed form fields", async (t) => {
  const h = await harness(t);
  const form = await h.text("!new");
  const create = findAction(form, "Create");
  await h.action(create, { sessionName: "Original", workspace: "local" });
  await h.text("!control");
  await h.action(create, { sessionName: "Must not create", workspace: "local" });
  const owned = Object.values(h.bridge.store.snapshot().sessions).filter((item) => item.kind === "owned");
  assert.deepEqual(owned.map((item) => item.name), ["Original"]);
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /already used.*accepted/i);
  assert.equal(h.bridge.store.snapshot().outbox.length, 0);
  assert.ok(object(create.data));
  await h.action({ data: { token: `${create.data.token}x` } });
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /signature/);
  assert.equal(h.bridge.store.snapshot().outbox.length, 1);
  assert.equal(Object.values(h.bridge.store.snapshot().sessions).filter((item) => item.kind === "owned").length, 1);
});

test("a duplicate failed action retains its failure and never retries the native operation", async (t) => {
  const h = await harness(t);
  await createWorking(h);
  const action = findAction(h.bridge.render(h.key), "Stop turn");
  const stop = t.mock.method(h.runtime, "stop", async () => { throw new UserError("Native stop was not accepted."); });
  await h.action(action);
  await h.text("!control");
  const activityId = randomUUID();
  await h.action(action, {}, activityId);
  assert.equal(stop.mock.callCount(), 1);
  const state = h.bridge.store.snapshot();
  assert.equal(state.receipts[digest(`${h.key}:${activityId}`)]?.status, "failed");
  assert.match(state.conversations[h.key]!.notice, /already used.*failed.*Native stop was not accepted/i);
  assert.equal(state.outbox.length, 1);
});

test("an interrupted card action remains uncertain after restart instead of being executed or reported accepted", async (t) => {
  const directory = await temporary(t);
  const first = await harness(t, false, directory);
  await createWorking(first);
  const action = findAction(first.bridge.render(first.key), "Stop turn");
  assert.ok(object(action.data));
  const claims = first.bridge.actions.authenticate(action.data.token, first.bridge.store.snapshot().conversations[first.key]!);
  await first.bridge.store.mutate((state) => {
    const id = `action:${claims.nonce}`;
    state.receipts[id] = {
      id, conversationKey: first.key, operation: "stop", status: "started",
      detail: "Native acknowledgement is unresolved.", at: Date.now(),
    };
  });
  await first.bridge.close();
  const second = await harness(t, false, directory, { initializeConversation: false });
  const activityId = randomUUID();
  await second.action(action, {}, activityId);
  assert.deepEqual(second.runtime.stopped, []);
  const state = second.bridge.store.snapshot();
  assert.equal(state.receipts[digest(`${second.key}:${activityId}`)]?.status, "uncertain");
  assert.match(state.conversations[second.key]!.notice, /already used.*uncertain.*restarted/i);
  assert.equal(state.outbox.length, 0);
});

test("an old unscoped list token refreshes visible controls without guessing its target or replaying an action", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.text("!sessions");
  const state = h.bridge.store.snapshot();
  const conversation = state.conversations[h.key]!;
  const token = h.bridge.actions.issue(conversation, { op: "page", argument: "1" });
  const legacy = h.bridge.actions.authenticate(token, conversation);
  delete legacy.view;
  const body = Buffer.from(JSON.stringify(legacy)).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(state.actionKey, "base64url")).update(body).digest("base64url");
  const action = { data: { token: `${body}.${signature}` } };
  await h.text("!control");
  await h.bridge.flush();
  const oldDashboard = h.bridge.store.snapshot().conversations[h.key]!.dashboardId;
  const inventory = t.mock.method(h.runtime, "inventory");
  const history = t.mock.method(h.runtime, "history");
  const activityId = randomUUID();
  await h.action(action, {}, activityId);
  await h.bridge.flush();
  const current = h.bridge.store.snapshot().conversations[h.key]!;
  assert.ok(current.dashboardId && current.dashboardId !== oldDashboard);
  assert.equal(current.view, "control");
  assert.equal(current.selectedId, id);
  assert.equal(inventory.mock.callCount(), 0);
  assert.equal(history.mock.callCount(), 0);
  assert.deepEqual(h.runtime.received, []);
  assert.match(h.bridge.store.snapshot().outbox.at(-1)!.text, /refreshed card/i);
  await h.action(action, {}, activityId);
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.dashboardId, current.dashboardId);
  assert.equal(h.bridge.store.snapshot().outbox.length, 1);
});

test("native final_answer streaming, final delivery and history retain the actual answer exactly once", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.text("Explicit task for the streaming result fixture");
  h.runtime.emit(id, "assistant.message_start", { messageId: "native-answer", phase: "final_answer" });
  h.runtime.emit(id, "assistant.message_delta", { messageId: "native-answer", deltaContent: "The result is 42." });
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().sessions[id]!.timeline.at(-1)?.text, "The result is 42.");
  assert.equal(h.bridge.store.snapshot().sessions[id]!.timeline.at(-1)?.state, "running");
  assert.equal(h.bridge.store.snapshot().outbox.length, 0);

  const answer = { messageId: "native-answer", phase: "final_answer", content: "The result is 42." };
  h.runtime.emit(id, "assistant.message", answer);
  h.runtime.emit(id, "assistant.message", answer);
  h.runtime.emit(id, "session.idle");
  await h.bridge.flush();
  const sent = [...h.transport.messages.values()].filter((item) => item.message.type === "text");
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0]), /The result is 42\./);
  assert.equal(h.bridge.store.snapshot().outbox[0]?.status, "sent");
  assert.match(JSON.stringify(await h.text("!read")), /The result is 42\./);
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().outbox.length, 1);

  const controller = h.bridge.store.snapshot().controllerId!;
  await h.text("!control list available sessions");
  h.runtime.emit(controller, "assistant.message", {
    messageId: "native-control-answer", phase: "final_answer", content: "One working session is available.",
  });
  h.runtime.emit(controller, "session.idle");
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().outbox.at(-1)!.presentation?.kind, "control");
  assert.equal(h.bridge.store.snapshot().outbox.at(-1)!.text, "One working session is available.");
});

test("Read transcript opens the newest answer rather than an old native status page", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const events = h.runtime.live.get(id)!.events;
  events.push(
    { id: "initial-status", type: "session.native_status", data: {} },
    { id: "old-answer", type: "assistant.message", data: { messageId: "old-answer", phase: "final_answer", content: "Earlier answer." } },
    { id: "latest-answer", type: "assistant.message", data: { messageId: "latest-answer", phase: "final_answer", content: "The current result is 391." } },
  );
  const latest = await h.text("!read");
  assert.match(transcriptText(latest), /The current result is 391\./);
  const earlier = transcriptText(latest).includes("Earlier answer") ? latest : await h.action(findAction(latest, "Older"));
  assert.match(transcriptText(earlier), /Earlier answer/);
  assert.equal(h.bridge.store.snapshot().outbox.length, 0);
});

test("legacy merged entries and later native status events do not hide the newest timestamped answer", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.bridge.store.mutate((state) => {
    state.sessions[id]!.timeline.push({
      id: "legacy-projection", kind: "assistant", phase: "final", text: "Old legacy answer.", state: "done",
    });
  });
  h.runtime.live.get(id)!.events.push(
    { id: "source-answer", type: "assistant.message", timestamp: "2026-11-12T05:30:00Z",
      data: { messageId: "source-answer", phase: "final_answer", content: "The newest source answer is 899." } },
    { id: "later-status", type: "session.usage_checkpoint", timestamp: "2026-11-12T05:30:01Z", data: {} },
  );
  const latest = await h.text("!read");
  assert.match(transcriptText(latest), /The newest source answer is 899/);
  const previous = transcriptText(latest).includes("Old legacy answer") ? latest : await h.action(findAction(latest, "Older"));
  assert.match(transcriptText(previous), /Old legacy answer/);
  assert.equal(h.bridge.store.snapshot().outbox.length, 0);
});

test("an offline owned session can be opened and read without resuming or replaying its work", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.bridge.store.mutate((state) => {
    state.sessions[id]!.status = "offline";
    state.sessions[id]!.timeline.push({
      id: "saved-answer", kind: "assistant", phase: "final", state: "done", text: "Saved work remains readable.",
    });
  });
  const history = t.mock.method(h.runtime, "history", async () => { throw new Error("Disconnected SDK history must not be required."); });
  const resume = t.mock.method(h.runtime, "resume", async () => { throw new UserError("Native resume is unavailable."); });
  await h.text(`!use ${id}`);
  const transcript = await h.text("!read");
  assert.match(transcriptText(transcript), /Saved work remains readable/);
  assert.equal(resume.mock.callCount(), 0);
  assert.equal(history.mock.callCount(), 0);
  await h.text("Do not replay this task if resume fails.");
  assert.equal(resume.mock.callCount(), 1);
  assert.deepEqual(h.runtime.received, []);
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /resume is unavailable/);
});

test("settings select the unique current Copilot model without guessing an ambiguous provider", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const current = await h.runtime.settings(id);
  assert.ok(current.modelId);
  const model = {
    key: "current-copilot", id: current.modelId, name: "Current Copilot model",
    providerId: "copilot", providerKind: "copilot", efforts: ["max"],
  };
  let choices = [model];
  t.mock.method(h.runtime, "models", async () => choices);
  assert.ok(findAction(await h.text("!settings"), "Apply"));
  choices = [model, { ...model, key: "another-provider", providerId: "other", providerKind: "loki" }];
  const ambiguous = await h.text("!settings");
  assert.throws(() => findAction(ambiguous, "Apply"), /not found/);
  assert.equal(h.runtime.settingsCalls.length, 0);
});

test("cold restart keeps native history disconnected until Settings is explicitly reopened", async (t) => {
  const directory = await temporary(t);
  const first = await harness(t, false, directory);
  await createWorking(first);
  assert.ok(findAction(await first.text("!settings"), "Apply"));
  await first.bridge.close();
  const second = await harness(t, false, directory, { initializeConversation: false });
  assert.equal(second.bridge.store.snapshot().conversations[first.key]?.view, "dashboard");
  assert.deepEqual(second.runtime.resumed, []);
  assert.match(JSON.stringify(second.bridge.render(first.key)), /reopen Settings/i);
  await second.text("!settings");
  assert.equal(second.runtime.resumed.length, 1);
  const restored = second.bridge.render(first.key);
  assert.ok(findAction(restored, "Apply"));
  assert.ok(!JSON.stringify(restored).includes("native catalogue is unavailable"));
});

test("operation failures and expired actions send one durable visible reply instead of only editing an old card", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.bridge.flush();
  const send = t.mock.method(h.runtime, "send", async () => {
    throw new UserError("Admission could not be confirmed.");
  });
  const activityId = randomUUID();
  await h.text("an ordinary owner task", activityId);
  await h.bridge.flush();
  const sent = () => [...h.transport.messages.values()].filter((item) => item.message.type === "text");
  assert.equal(sent().length, 1);
  assert.match(JSON.stringify(sent()[0]), /Admission could not be confirmed/);
  assert.equal(h.bridge.store.snapshot().outbox.at(-1)?.status, "sent");
  await h.text("an ordinary owner task", activityId);
  await h.bridge.flush();
  assert.equal(send.mock.callCount(), 1);
  assert.equal(sent().length, 1);

  const state = h.bridge.store.snapshot();
  const token = new Actions(state.actionKey, 10).issue(
    state.conversations[h.key]!, { op: "stop", targetId: id }, Date.now() - 1000,
  );
  const oldDashboard = state.conversations[h.key]!.dashboardId;
  await h.action({ type: "Action.Execute", data: { token } });
  await h.bridge.flush();
  assert.equal(sent().length, 2);
  assert.match(JSON.stringify(sent()[1]), /expired/);
  assert.match(JSON.stringify(sent()[1]), /refreshed card/i);
  const current = h.bridge.store.snapshot().conversations[h.key]!;
  assert.ok(current.dashboardId && current.dashboardId !== oldDashboard);
  assert.equal(current.selectedId, id);
  assert.ok(!JSON.stringify(sent()[1]).includes("Send \"list sessions\""));
  assert.ok(!JSON.stringify(sent()[1]).includes("/sessions"));
  assert.deepEqual(h.runtime.stopped, []);
});

test("official JWT middleware verifies a real RSA signature with normalized audience connections and mocked JWKS metadata only", async (t) => {
  const h = await harness(t);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: "jwk" });
  assert.ok(jwk.n && jwk.e);
  clearJwksClients();
  t.after(() => clearJwksClients());
  const keys = t.mock.method(jwksRsa.JwksClient.prototype, "getKeys", async () => [{
    kty: "RSA", kid: "local-rsa-fixture", use: "sig", alg: "RS256", n: jwk.n!, e: jwk.e!,
  }]);
  const auth = teamsAuthentication(mockIdentity, "explicit-test-secret");
  assert.ok(auth.connections?.size);
  const token = (overrides: Record<string, unknown> = {}) => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "local-rsa-fixture" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      aud: mockIdentity.appId, iss: "https://api.botframework.com", exp: Math.floor(Date.now() / 1000) + 600,
      serviceurl: "https://smba.trafficmanager.net/amer/", ...overrides,
    })).toString("base64url");
    const input = `${header}.${payload}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url")}`;
  };
  const adapter = createTeamsAdapter(mockIdentity, "explicit-test-secret");
  let adapterCalls = 0;
  t.mock.method(adapter, "process", async (_request: AgentRequest, response: WebResponse) => {
    adapterCalls++;
    response.status(200).send({ verified: true });
    response.end();
  });
  const app = createProductionApp(mockIdentity, "explicit-test-secret", adapter, h.bridge);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await withLoopback(address.port, async () => {
    const post = (authorization: string, body = mockEnvelope()) => fetch(`http://127.0.0.1:${address.port}/api/messages`, {
      method: "POST", headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal((await post(token())).status, 200);
    assert.equal(adapterCalls, 1);
    assert.equal((await post(token({ aud: randomUUID() }))).status, 401);
    assert.equal((await post(token({ exp: Math.floor(Date.now() / 1000) - 600 }))).status, 401);
    assert.equal((await post(token({ iss: "https://evil.example" }))).status, 401);
    const original = token();
    const segments = original.split(".");
    segments[2] = `${segments[2]!.startsWith("a") ? "b" : "a"}${segments[2]!.slice(1)}`;
    assert.equal((await post(segments.join("."))).status, 401);
    assert.equal((await post(token(), { ...mockEnvelope(), from: { id: "29:foreign", aadObjectId: randomUUID() } })).status, 403);
  });
  assert.equal(adapterCalls, 1);
  assert.ok(keys.mock.callCount() > 0);
  assert.equal(h.runtime.received.length, 0);
});

test("bounded controller tools are explicitly exempted only at their SDK declaration and still require an owner control turn and idempotent invocation", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const controller = h.bridge.store.snapshot().controllerId!;
  await h.text("!control initialize bounded tools");
  h.runtime.emit(controller, "session.idle");
  await h.bridge.flush();
  const tools = h.runtime.live.get(controller)!.tools;
  assert.ok(tools.every((tool) => tool.skipPermission === true && tool.defer === "never"));
  const send = tools.find((tool) => tool.name === "bridge_send");
  assert.ok(send?.handler);
  const invocation = { sessionId: controller, toolCallId: randomUUID(), toolName: "bridge_send", arguments: {} };
  await assert.rejects(async () => send.handler!({ sessionId: id, text: "must not run" }, invocation), /owner-authenticated/);
  await h.text("!control send the task");
  await send.handler({ sessionId: id, text: "one owner task" }, invocation);
  await assert.rejects(async () => send.handler!({ sessionId: id, text: "one owner task" }, invocation), /already received/);
  assert.equal(h.runtime.received.filter((entry) => entry.sessionId === id).length, 1);
  const mismatched = { ...invocation, sessionId: id, toolCallId: randomUUID() };
  await assert.rejects(async () => send.handler!({ sessionId: id, text: "foreign invocation" }, mismatched), /owner-authenticated/);
});

test("ephemeral streaming never evicts durable dedup IDs, and history reconstruction never replays old busy state", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const start = { id: "persisted-start", type: "assistant.turn_start", data: {} };
  const final = { id: "persisted-final", type: "assistant.message", data: { messageId: "final", phase: "final", content: "Done" } };
  const idle = { id: "persisted-idle", type: "session.idle", data: {} };
  h.runtime.live.get(id)!.events.push(start, final, idle);
  const projector = new Projector();
  await h.bridge.store.mutate((state) => {
    const session = state.sessions[id]!;
    projector.apply(session, start);
    projector.apply(session, final);
    projector.apply(session, idle);
    for (let index = 0; index < 4100; index++) projector.apply(session, {
      id: `delta-${index}`, type: "assistant.message_delta", ephemeral: true, data: { messageId: "stream", deltaContent: "x" },
    });
    assert.ok(session.seenEvents.includes("persisted-start"));
    assert.equal(session.status, "idle");
    // Also model a legacy/missed dedup entry: reconstruction must not replay it into live status.
    session.seenEvents = session.seenEvents.filter((value) => value !== "persisted-start");
  });
  await h.text("!read");
  assert.equal(h.bridge.store.snapshot().sessions[id]?.status, "idle");
  await h.text("!settings");
  assert.equal(h.bridge.store.snapshot().sessions[id]?.status, "idle");
});

test("definite deleted-dashboard 404 creates one replacement containing current progress and scoped pending requests", async (t) => {
  const h = await harness(t, true);
  const id = await createWorking(h);
  await h.bridge.flush();
  const old = h.bridge.store.snapshot().conversations[h.key]!.dashboardId!;
  h.transport.messages.delete(old);
  await h.text("ask");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[id]?.pending.length));
  await h.bridge.flush();
  const replacement = h.bridge.store.snapshot().conversations[h.key]!.dashboardId;
  assert.ok(replacement && replacement !== old);
  const message = h.transport.messages.get(replacement);
  assert.ok(message?.message.type === "card");
  assert.ok(findAction(message.message.card, "Answer"));
  assert.match(JSON.stringify(message.message.card), /Mock helper/);
  assert.equal(h.runtime.received.length, 1);
});

function transcriptText(card: Card): string {
  const block = card.body.find((item) => item.id === "transcript-page-text");
  assert.ok(block && typeof block.text === "string");
  return block.text;
}

test("safe transcript pages include old history beyond the progress window and every suffix of a long final answer", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const events = h.runtime.live.get(id)!.events;
  for (let index = 0; index < 162; index++) events.push({
    id: `history-${index}`, type: "assistant.message",
    data: { messageId: `history-${index}`, phase: "final", content: `History item ${index}` },
  });
  const long = "Full native answer \u{1f680} ".repeat(1200) + "EXACT-END-OF-LONG-ANSWER";
  events.push({ id: "long-history", type: "assistant.message", data: { messageId: "long-history", phase: "final", content: long } });
  const latest = await h.text("!read");
  assert.match(transcriptText(latest), /EXACT-END-OF-LONG-ANSWER/);
  const conversation = h.bridge.store.snapshot().conversations[h.key]!;
  const first = await h.action({ data: {
    token: h.bridge.actions.issue(conversation, { op: "page", argument: "0" }),
  } });
  assert.match(transcriptText(first), /History item 0/);
  const pages = [transcriptText(first)];
  let current = first;
  while (findAllActions(current).some((action) => action.title === "Newer")) {
    current = await h.action(findAction(current, "Newer"));
    assert.ok(Buffer.byteLength(JSON.stringify(current)) <= 27_000);
    assert.ok(Buffer.byteLength(transcriptText(current)) <= 7000);
    pages.push(transcriptText(current));
    assert.ok(pages.length < 60, "short dialogue entries should share pages instead of consuming 162 separate pages");
  }
  const text = pages.join("\n\n");
  for (let index = 0; index < 162; index++) {
    assert.equal([...text.matchAll(new RegExp(`\\*\\*Copilot\\*\\*\\n\\nHistory item ${index}(?!\\d)`, "gu"))].length, 1,
      `history item ${index} must be readable exactly once`);
  }
  const longStart = pages.findIndex((page) => page.startsWith("**Copilot**\n\nFull native answer"));
  assert.ok(longStart >= 0);
  assert.equal(pages.slice(longStart).join(""), `**Copilot**\n\n${long}`);
  assert.equal(h.bridge.store.snapshot().sessions[id]?.timeline.length, 160);
});

test("dormant Control views do not label a live selected App target offline and retain their signed history scope", async (t) => {
  const h = await harness(t);
  const working = await createWorking(h, "Same display name");
  await createWorking(h, "Same display name");
  const controller = h.bridge.store.snapshot().controllerId!;
  await h.bridge.store.mutate((state) => {
    const selected = state.sessions[working]!;
    selected.kind = "peer";
    selected.peerSource = "app";
    selected.status = "idle";
    selected.access = { read: true, send: true };
    selected.liveUntil = Date.now() + 60_000;
    state.sessions[controller]!.name = selected.name;
    state.sessions[controller]!.status = "offline";
    state.sessions[controller]!.timeline = [
      { id: "control-history-a", kind: "assistant", phase: "final", text: "Management history one.\n" + "History context ".repeat(600) },
      { id: "control-history-b", kind: "assistant", phase: "final", text: "Management history two." },
    ];
  });
  for (const view of ["control", "transcript"] as const) {
    await h.bridge.store.mutate((state) => {
      const conversation = state.conversations[h.key]!;
      conversation.selectedId = working;
      conversation.view = view;
      conversation.transcriptId = controller;
      conversation.page = 0;
      conversation.notice = "Control view/history does not change the message destination. Ordinary text goes to the selected working session; only control: <instruction> (or /control <instruction>) invokes optional management.";
    });
    const card = h.bridge.render(h.key);
    const visible = visibleText(card);
    assert.match(visible, /Tasks go to: Same display name/);
    assert.ok(!/^Offline$/m.test(visible), "dormant management is not the selected work target's availability");
    assert.ok(!visible.includes("This session is not ready for new work"));
    assert.match(visible, /Management history/);
    assert.match(visible, /Control.*on demand/i);
    assert.match(visible, /Teams chat box/);
    assert.ok(!visible.includes("Control view/history does not change the message destination"),
      "the routine Control notice must not repeat the card's concise management explanation");
    const conversation = h.bridge.store.snapshot().conversations[h.key]!;
    const claims = (title: string) => {
      const action = findAction(card, title);
      assert.ok(object(action.data));
      return h.bridge.actions.authenticate(action.data.token, conversation);
    };
    if (view === "transcript") {
      assert.equal(claims("Newer").targetId, controller);
      assert.match(transcriptText(card), /Management history one/);
    } else assert.equal(claims("History").targetId, controller);
    assert.equal(conversation.selectedId, working);
    assert.deepEqual(h.runtime.received, []);
    assert.equal(h.runtime.live.has(controller), false);
  }
  const prompt = " Exact working task while viewing management history\r\n ";
  await h.text(prompt);
  assert.deepEqual(h.runtime.received, [{ sessionId: working, text: prompt }]);
  assert.equal(h.runtime.live.has(controller), false);
});

test("Control history still clearly identifies a genuinely read-only or disconnected selected destination", async (t) => {
  const h = await harness(t);
  const working = await createWorking(h, "Read-only work");
  const controller = h.bridge.store.snapshot().controllerId!;
  await h.bridge.store.mutate((state) => {
    const selected = state.sessions[working]!;
    selected.kind = "peer";
    selected.peerSource = "app";
    selected.status = "offline";
    selected.access = { read: true, send: false };
    delete selected.liveUntil;
    state.conversations[h.key]!.selectedId = working;
    state.conversations[h.key]!.transcriptId = controller;
  });
  for (const view of ["control", "transcript"] as const) {
    await h.bridge.store.mutate((state) => { state.conversations[h.key]!.view = view; });
    const card = h.bridge.render(h.key);
    const visible = visibleText(card);
    assert.match(visible, /Tasks go to: Read-only work/);
    assert.match(visible, /selected working session.*read-only/i);
    assert.ok(!visible.includes("Teams chat box below"), "do not invite sending to a read-only destination");
    const destination = card.body.find((entry) => typeof entry.text === "string" && entry.text.startsWith("Tasks go to:"));
    assert.equal(destination?.color, "Attention");
  }
  await h.bridge.store.mutate((state) => {
    const selected = state.sessions[working]!;
    selected.kind = "owned";
    selected.name = "Disconnected native work";
    delete selected.peerSource;
    delete selected.access;
  });
  const disconnected = visibleText(h.bridge.render(h.key));
  assert.match(disconnected, /Tasks go to: Disconnected native work \(not connected\)/);
  assert.match(disconnected, /selected working session is not connected/);
  assert.match(disconnected, /explicitly reconnects it/);
});

test("Control errors and pending replies remain explicitly scoped to management rather than the selected work", async (t) => {
  const h = await harness(t);
  const working = await createWorking(h);
  const controller = h.bridge.store.snapshot().controllerId!;
  const requestId = randomUUID();
  await h.bridge.store.mutate((state) => {
    const conversation = state.conversations[h.key]!;
    conversation.view = "transcript";
    conversation.transcriptId = controller;
    conversation.selectedId = working;
    conversation.page = 0;
    const management = state.sessions[controller]!;
    management.status = "error";
    management.timeline = [{ id: "control-error", kind: "error", state: "failed", text: "Safe management failure." }];
  });
  const failed = h.bridge.render(h.key);
  assert.match(visibleText(failed), /Management history · ! Session error/);
  assert.ok(!transcriptText(failed).includes("Safe management failure"), "diagnostic error rows are not fabricated dialogue");
  assert.match(visibleText(failed), /Safe management failure/, "genuine current errors stay visible outside the conversation body");
  assert.ok(JSON.stringify(failed).includes("Progress"));
  await h.bridge.store.mutate((state) => {
    state.sessions[controller]!.status = "awaiting";
    state.sessions[controller]!.pending = [{
      id: requestId, kind: "input", title: "Bounded management question", choices: ["Keep"], allowFreeform: false,
    }];
  });
  const awaiting = h.bridge.render(h.key);
  assert.match(visibleText(awaiting), /Management history · ▲ Needs reply/);
  assert.ok(JSON.stringify(awaiting).includes("Bounded management question"));
  const answer = findAction(awaiting, "Answer");
  assert.ok(object(answer.data));
  const claims = h.bridge.actions.authenticate(answer.data.token, h.bridge.store.snapshot().conversations[h.key]!);
  assert.equal(claims.targetId, controller);
  assert.equal(claims.requestId, requestId);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, working);
});

test("ordinary work-session disconnected state and canonical navigation remain explicit in dashboard and history views", async (t) => {
  const h = await harness(t);
  const working = await createWorking(h);
  await h.bridge.store.mutate((state) => {
    state.sessions[working]!.status = "offline";
    state.conversations[h.key]!.transcriptId = working;
  });
  for (const view of ["dashboard", "transcript"] as const) {
    await h.bridge.store.mutate((state) => { state.conversations[h.key]!.view = view; });
    const card = h.bridge.render(h.key);
    assert.match(visibleText(card), /Not connected/);
    assert.match(visibleText(card), /Sending a new task or opening Settings reconnects this session/);
    assert.ok(!visibleText(card).includes("Management history"));
    if (view === "dashboard") {
      const history = findAction(card, "History");
      assert.ok(object(history.data));
      assert.equal(h.bridge.actions.authenticate(history.data.token, h.bridge.store.snapshot().conversations[h.key]!).targetId, working);
    } else {
      assert.ok(findAction(card, "Back"));
      assert.equal(h.bridge.store.snapshot().conversations[h.key]!.transcriptId, working);
    }
  }
});

test("Control transcript retains its canonical history target while ordinary text still goes to the selected working session", async (t) => {
  const h = await harness(t);
  const working = await createWorking(h);
  const controller = h.bridge.store.snapshot().controllerId!;
  await h.text("!control initialize history fixture");
  h.runtime.emit(controller, "session.idle");
  await h.bridge.flush();
  h.runtime.live.get(controller)!.events.push({
    id: "controller-history", type: "assistant.message", data: { messageId: "control-only", phase: "final", content: "CONTROL-HISTORY-ONLY" },
  });
  const control = await h.text("!control");
  const transcript = await h.action(findAction(control, "History"));
  const conversation = h.bridge.store.snapshot().conversations[h.key]!;
  assert.equal(conversation.transcriptId, controller);
  assert.equal(conversation.selectedId, working);
  assert.match(transcriptText(transcript), /CONTROL-HISTORY-ONLY/);
  assert.match(JSON.stringify(transcript), new RegExp(controller));
  const prompt = " ordinary instruction while viewing Control history\r\n ";
  await h.text(prompt);
  assert.deepEqual(h.runtime.received.at(-1), { sessionId: working, text: prompt });
  assert.equal(h.runtime.received.filter((entry) => entry.sessionId === controller).length, 1,
    "only the prior explicit /control instruction may invoke the controller");
});

test("unknown stored session fields never cause a foreign mode/effort to be invented", async (t) => {
  const h = await harness(t);
  const id = randomUUID();
  h.runtime.foreign.push({
    id, name: "Native peer", kind: "peer", status: "idle", workspace: h.directory,
    capability: "Native peer", modelId: "peer-only-model",
  });
  const list = await h.text("!sessions");
  const action = findAction(list, "Open");
  const card = await h.action(action);
  const record: SessionRecord | undefined = h.bridge.store.snapshot().sessions[id];
  assert.ok(record);
  assert.equal(record.settings, undefined);
  assert.equal(record.peerModelId, "peer-only-model");
  assert.ok(object(card));
  assert.match(JSON.stringify(card), /Not exposed by peer management API/);
});

test("stopping an awaiting question cancels its timeline row and stale action; all pending request kinds share cancellation semantics", async (t) => {
  const h = await harness(t, true);
  const id = await createWorking(h);
  await h.text("ask");
  await eventually(() => Boolean(h.bridge.store.snapshot().sessions[id]?.pending.length));
  const old = findAction(h.bridge.render(h.key), "Answer");
  await h.text("!stop");
  const session = h.bridge.store.snapshot().sessions[id]!;
  assert.equal(session.status, "idle");
  assert.equal(session.pending.length, 0);
  assert.equal(session.timeline.find((entry) => entry.kind === "input")?.state, "cancelled");
  await h.action(old);
  assert.equal(h.runtime.answers.length, 0);
  const projector = new Projector();
  for (const kind of ["input", "permission", "plan"] as const) {
    const pendingId = randomUUID();
    session.pending.push({ id: pendingId, kind, title: kind, choices: [], allowFreeform: false });
    session.timeline.push({ id: `request:${pendingId}`, kind, text: kind, state: "waiting" });
  }
  projector.apply(session, { id: randomUUID(), type: "session.shutdown", data: {} });
  assert.equal(session.pending.length, 0);
  assert.ok(session.timeline.filter((entry) => entry.id.startsWith("request:")).every((entry) => entry.state === "cancelled"));
});
