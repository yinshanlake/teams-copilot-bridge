import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { BridgeState } from "../src/domain.js";
import { DeliveryError, digest, object, UserError } from "../src/safety.js";
import { mockEnvelope, mockIdentity } from "../src/simulator.js";
import { authorizeActivity } from "../src/teams.js";
import { createWorking, eventually, harness, type Harness } from "./helpers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail; });
  return { promise, resolve, reject };
}

async function persistenceBoundary(
  t: TestContext, h: Harness, matches: (draft: BridgeState, committed: BridgeState) => boolean,
) {
  const probe = await open(join(h.directory, `sync-probe-${randomUUID()}`), "wx");
  const prototype: Pick<FileHandle, "sync"> = Object.getPrototypeOf(probe);
  const originalSync = prototype.sync;
  await probe.close();
  const reached = deferred<void>();
  const resume = deferred<void>();
  let held = false;
  let armed = false;
  const original = h.bridge.store.mutate.bind(h.bridge.store);
  const mutations = t.mock.method(h.bridge.store, "mutate", <T>(change: (state: BridgeState) => T) => original((draft) => {
    const result = change(draft);
    if (!held && matches(draft, h.bridge.store.snapshot())) { held = true; armed = true; }
    return result;
  }));
  // Pause real Store persistence after its queued callback, before rename/commit.
  const syncing = t.mock.method(prototype, "sync", async function (this: FileHandle) {
    await originalSync.call(this);
    if (!armed) return;
    armed = false;
    reached.resolve(undefined);
    await resume.promise;
  });
  return {
    reached: reached.promise, release: () => resume.resolve(undefined), mutations,
    fail: (error: unknown) => resume.reject(error),
    restore: () => { mutations.mock.restore(); syncing.mock.restore(); },
  };
}

test("N1: an obsolete history failure queued behind malformed !use persistence cannot poison health or overwrite the superseding outcome", async (t) => {
  const h = await harness(t, false, undefined, { deliveryInitiallyPaused: true });
  const id = await createWorking(h);
  const failed = deferred<unknown[]>();
  const history = t.mock.method(h.runtime, "history", () => failed.promise);
  const readActivity = randomUUID();
  await h.text("!history", readActivity);
  const intent = h.bridge.store.snapshot().conversations[h.key]!.historyRead!;
  const boundary = await persistenceBoundary(t, h, (draft, committed) =>
    committed.conversations[h.key]?.historyRead?.id === intent.id && !draft.conversations[h.key]?.historyRead);
  const badActivity = randomUUID();
  let invalid: Promise<unknown> | undefined;
  try {
    invalid = h.text("!use", badActivity);
    await boundary.reached;
    assert.equal(h.bridge.store.snapshot().conversations[h.key]!.historyRead?.id, intent.id,
      "the real Store snapshot must still show the previous committed intent while supersession is persisting");
    const calls = boundary.mutations.mock.callCount();
    failed.reject(new UserError("OBSOLETE_HISTORY_FAILURE"));
    await eventually(() => boundary.mutations.mock.callCount() > calls);
    boundary.release();
    await invalid;
    await h.bridge.flush();
    const state = h.bridge.store.snapshot();
    assert.equal(h.bridge.healthy, true);
    assert.equal(state.conversations[h.key]!.historyRead, undefined);
    assert.equal(state.conversations[h.key]!.selectedId, id);
    assert.equal(state.conversations[h.key]!.selectionBlocked, true);
    assert.match(state.receipts[digest(`${h.key}:${readActivity}`)]!.detail, /superseded/iu);
    assert.match(state.receipts[digest(`${h.key}:${badActivity}`)]!.detail, /Unknown|Malformed/iu);
    assert.ok(!JSON.stringify(state).includes("OBSOLETE_HISTORY_FAILURE"));
    assert.equal(state.outbox.filter((item) => item.eventId.startsWith("operation-error:")).length, 1);
    boundary.restore();
    history.mock.restore();
    await h.text(`!use ${id}`);
    await h.text("WORK_AFTER_OBSOLETE_FAILURE");
    assert.deepEqual(h.runtime.received, [{ sessionId: id, text: "WORK_AFTER_OBSOLETE_FAILURE" }]);
  } finally {
    failed.resolve([]);
    boundary.release();
    await invalid;
    await h.bridge.flush();
    boundary.restore();
  }
});

test("N2: a historical native final awaiting its send ACK still produces exactly one independent direct result", async (t) => {
  const h = await harness(t, false, undefined, { deliveryInitiallyPaused: true });
  const id = await createWorking(h);
  const history = deferred<unknown[]>();
  t.mock.method(h.runtime, "history", () => history.promise);
  await h.text("!history");
  const ack = deferred<void>();
  const entered = deferred<string>();
  const original = h.runtime.send.bind(h.runtime);
  const messageId = "ack-gated-native-final";
  const eventId = "ack-gated-native-event";
  const text = "VISIBLE_FINAL_AFTER_ACK\r\n中文 🚀";
  t.mock.method(h.runtime, "send", async (...args: Parameters<typeof h.runtime.send>) => {
    const result = await original(...args);
    h.runtime.emit(id, "assistant.message", { messageId, phase: "final", content: text }, { id: eventId });
    entered.resolve(result.id);
    await ack.promise;
    return result;
  });
  const sending = h.text("EXPLICIT_NATIVE_TASK");
  try {
    const originId = await entered.promise;
    history.resolve(structuredClone(h.runtime.live.get(id)!.events));
    await eventually(() => h.bridge.store.snapshot().conversations[h.key]!.historyRead?.status === "queued");
    assert.ok(h.bridge.store.snapshot().outbox.some((item) => item.historyId && item.text.includes(text)));
    assert.equal(h.bridge.store.snapshot().outbox.filter((item) => item.direct).length, 0,
      "history itself must not deliver a live reply before the authoritative send ACK");
    ack.resolve(undefined);
    await sending;
    h.bridge.enableDelivery();
    await h.bridge.flush();
    const state = h.bridge.store.snapshot();
    const direct = state.outbox.filter((item) => item.direct);
    assert.equal(direct.length, 1);
    assert.equal(direct[0]!.text, text);
    assert.equal(direct[0]!.status, "sent");
    assert.equal(direct[0]!.id, digest(`${h.key}:${id}:${messageId}:0`));
    assert.equal(Object.values(state.directOrigins).find((item) => item.messageId === originId)!.answered, true);
    assert.equal(state.sessions[id]!.timeline.filter((item) => item.id === `message:${messageId}`).length, 1);
    assert.ok(state.sessions[id]!.seenEvents.includes(eventId), "the actual live callback, not hydration, must consume live dedup");
    h.runtime.emit(id, "assistant.message", { messageId, phase: "final", content: text }, { id: eventId });
    await h.bridge.flush();
    assert.deepEqual(h.bridge.store.snapshot().outbox.filter((item) => item.direct), direct);
    assert.deepEqual(h.runtime.received, [{ sessionId: id, text: "EXPLICIT_NATIVE_TASK" }]);
  } finally {
    history.resolve([]);
    ack.resolve(undefined);
    await sending;
  }
});

test("N1: a genuine current failure-persistence error still marks the bridge unhealthy instead of being mistaken for supersession", async (t) => {
  const h = await harness(t, false, undefined, { deliveryInitiallyPaused: true });
  await createWorking(h);
  const read = deferred<unknown[]>();
  t.mock.method(h.runtime, "history", () => read.promise);
  await h.text("!history");
  const intent = h.bridge.store.snapshot().conversations[h.key]!.historyRead!;
  const boundary = await persistenceBoundary(t, h, (draft) =>
    draft.conversations[h.key]?.historyRead?.id === intent.id && draft.conversations[h.key]!.historyRead!.status === "failed");
  try {
    read.reject(new UserError("CURRENT_HISTORY_FAILURE"));
    await boundary.reached;
    boundary.fail(new Error("Synthetic failure persistence fsync failure"));
    await h.bridge.flush();
    assert.equal(h.bridge.healthy, false, "genuine persistence failures must not be swallowed by a stale-intent guard");
    const state = h.bridge.store.snapshot();
    assert.equal(state.conversations[h.key]!.historyRead?.status, "reading", "the failed disk write cannot claim a committed failed receipt");
    assert.equal(state.outbox.length, 0);
    await assert.rejects(() => h.text("WORK_MUST_NOT_BE_ACCEPTED"), /persistence is unhealthy/);
    assert.deepEqual(h.runtime.received, []);
  } finally {
    read.resolve([]);
    boundary.release();
    await h.bridge.flush();
    boundary.restore();
  }
});

test("N2: live-first history retains live dedup and timeline merging without promoting unrelated old history to notifications", async (t) => {
  const h = await harness(t, false, undefined, { deliveryInitiallyPaused: true });
  const id = await createWorking(h);
  await h.text("EXPLICIT_LIVE_FIRST_TASK");
  const content = "ALREADY_LIVE_RESULT";
  h.runtime.emit(id, "assistant.message", { messageId: "live-first", phase: "final", content }, { id: "live-first-event" });
  await h.bridge.flush();
  const before = h.bridge.store.snapshot();
  h.runtime.live.get(id)!.events.unshift({
    id: "unrelated-old-event", type: "assistant.message", timestamp: "2026-01-01T00:00:00Z",
    data: { messageId: "unrelated-old-message", originatingMessageId: "not-an-admitted-origin", phase: "final", content: "OLD_DIALOGUE_ONLY" },
  });
  await h.text("!history");
  await h.bridge.flush();
  const after = h.bridge.store.snapshot();
  assert.deepEqual(after.sessions[id]!.seenEvents, before.sessions[id]!.seenEvents,
    "history uses its own reconstruction dedup and cannot consume unrelated live event IDs");
  assert.ok(after.sessions[id]!.timeline.some((item) => item.text === "OLD_DIALOGUE_ONLY"));
  assert.equal(after.sessions[id]!.timeline.filter((item) => item.id === "message:live-first").length, 1);
  assert.deepEqual(after.outbox.filter((item) => item.direct), before.outbox.filter((item) => item.direct));
  assert.ok(!after.outbox.some((item) => !item.historyId && item.text === "OLD_DIALOGUE_ONLY"));
  h.runtime.emit(id, "assistant.message", { messageId: "live-first", phase: "final", content }, { id: "live-first-event" });
  h.bridge.enableDelivery();
  await h.bridge.flush();
  const direct = h.bridge.store.snapshot().outbox.filter((item) => item.direct);
  assert.equal(direct.length, 1);
  assert.equal(direct[0]!.status, "sent");
  assert.equal([...h.transport.messages.values()].filter((item) => item.message.type === "text" && item.message.text === content).length, 1);
});

for (const outcome of ["rejected", "uncertain"] as const) {
  for (const failPart of [1, 2]) {
    test(`N3: ${outcome} HISTORY part ${failPart} never strands or terminalizes an independent same-local-ID multi-part direct group`, async (t) => {
      const h = await harness(t, false, undefined, { deliveryInitiallyPaused: true });
      const id = await createWorking(h);
      h.runtime.live.get(id)!.events.push({
        id: "history-event", type: "assistant.message",
        data: { messageId: "history-message", phase: "final", content: "OLD_VISIBLE_HISTORY\r\n".repeat(1600) },
      });
      await h.text("!history");
      await h.bridge.flush();
      const pendingHistory = h.bridge.store.snapshot().outbox.filter((item) => item.historyId);
      assert.ok(pendingHistory.length > 2);
      await h.text("EXPLICIT_RESULT_TASK");
      const text = "INDEPENDENT_NATIVE_RESULT 🚀\r\n".repeat(1100);
      h.runtime.emit(id, "assistant.message", {
        messageId: pendingHistory[0]!.eventId, phase: "final", content: text,
      });
      await h.bridge.flush();
      const pendingDirect = h.bridge.store.snapshot().outbox.filter((item) => item.direct);
      assert.ok(pendingDirect.length > 2);
      assert.equal(pendingDirect[0]!.eventId, pendingHistory[0]!.eventId,
        "history and live namespaces may have identical source-local IDs");
      const send = h.transport.send.bind(h.transport);
      let historyAttempts = 0;
      const attempts: string[] = [];
      t.mock.method(h.transport, "send", async (...args: Parameters<typeof h.transport.send>) => {
        const message = args[1];
        if (message.type === "text") {
          attempts.push(message.presentation?.kind ?? "legacy");
          if (message.presentation?.kind === "history" && ++historyAttempts === failPart) {
            throw new DeliveryError(outcome, "SYNTHETIC_HISTORY_FAILURE");
          }
        }
        return send(...args);
      });
      h.bridge.enableDelivery();
      await h.bridge.flush();
      const state = h.bridge.store.snapshot();
      const history = state.outbox.filter((item) => item.historyId);
      const direct = state.outbox.filter((item) => item.direct);
      assert.equal(historyAttempts, failPart);
      assert.deepEqual(history.map((item) => item.status),
        pendingHistory.map((_item, index) => index < failPart - 1 ? "sent" : outcome));
      assert.ok(direct.every((item) => item.status === "sent" && item.activityId),
        "the first delivery pass must attempt untouched independent results without another event");
      assert.equal(direct.map((item) => item.text).join(""), text);
      assert.equal(attempts.filter((kind) => kind !== "history").length, direct.length);
      const completedAttempts = [...attempts];
      await h.bridge.flush();
      assert.deepEqual(attempts, completedAttempts, "neither attempted history nor sent direct parts may be reposted");
      await h.bridge.close();
      const restored = await harness(t, false, h.directory, { initializeConversation: false });
      await restored.bridge.flush();
      assert.deepEqual(restored.bridge.store.snapshot().outbox, state.outbox);
      assert.ok(![...restored.transport.messages.values()].some((item) => item.message.type === "text"));
    });
  }
}

test("N4: two authenticated conversation queues reserve the last physical history slot before persistence yields", async (t) => {
  const h = await harness(t, false, undefined, { deliveryInitiallyPaused: true });
  const id = await createWorking(h);
  const envelope = mockEnvelope("!status");
  assert.ok(object(envelope.conversation));
  envelope.conversation.id = "second-capacity-conversation";
  const other = authorizeActivity(envelope, { aud: mockIdentity.appId }, mockIdentity);
  const otherText = (text: string, activityId = randomUUID()) => h.bridge.handle(other.key, other.reference, activityId, { kind: "text", text });
  await otherText(`!use ${id}`);
  await h.bridge.flush();
  const pending = deferred<unknown[]>();
  const reads = t.mock.method(h.runtime, "history", () => pending.promise);
  await h.text("!history");
  const first = h.bridge.store.snapshot().conversations[h.key]!.historyRead!;
  const appId = randomUUID();
  await h.bridge.store.mutate((state) => {
    state.sessions[appId] = {
      ...structuredClone(state.sessions[id]!), id: appId, kind: "peer", peerSource: "app",
      liveUntil: Date.now() - 1, access: { read: true, send: true },
    };
  });
  const liveness = deferred<Awaited<ReturnType<typeof h.runtime.appLiveness>>>();
  t.mock.method(h.runtime, "appLiveness", () => liveness.promise);
  const boundary = await persistenceBoundary(t, h, (draft, committed) => [h.key, other.key].some((key) =>
    draft.conversations[key]?.historyRead?.status === "reading" &&
    draft.conversations[key]!.historyRead!.id !== committed.conversations[key]?.historyRead?.id));
  const leftId = randomUUID();
  const rightId = randomUUID();
  const left = h.text("!history", leftId);
  const right = otherText("!history", rightId);
  try {
    await eventually(() => [digest(`${h.key}:${leftId}`), digest(`${other.key}:${rightId}`)]
      .every((receiptId) => h.bridge.store.snapshot().receipts[receiptId]?.status === "started"));
    liveness.resolve([{ id: appId, status: "idle", liveUntil: Date.now() + 60_000 }]);
    await boundary.reached;
    boundary.release();
    await Promise.all([left, right]);
    assert.equal(reads.mock.callCount(), 2, "one outstanding read plus two contenders may start only one more actual read");
    const state = h.bridge.store.snapshot();
    const receipts = [state.receipts[digest(`${h.key}:${leftId}`)]!, state.receipts[digest(`${other.key}:${rightId}`)]!];
    assert.equal(receipts.filter((item) => item.status === "failed" && item.detail.includes("Two history reads")).length, 1);
    assert.ok(Object.values(state.conversations).some((item) => item.historyRead?.id !== first.id && item.historyRead?.status === "reading"));
  } finally {
    liveness.resolve([]);
    boundary.release();
    pending.resolve([]);
    await Promise.all([left, right]);
    await h.bridge.flush();
    boundary.restore();
  }
  await h.text("!history");
  await h.bridge.flush();
  assert.equal(reads.mock.callCount(), 3, "the settled read, not its supersession, releases physical capacity");
});

test("N4: failed pre-read intent persistence releases its reservation without releasing any already-started superseded read", async (t) => {
  const h = await harness(t, false, undefined, { deliveryInitiallyPaused: true });
  await createWorking(h);
  const pending = deferred<unknown[]>();
  const reads = t.mock.method(h.runtime, "history", () => pending.promise);
  const boundary = await persistenceBoundary(t, h, (draft, committed) =>
    draft.conversations[h.key]?.historyRead?.status === "reading" &&
    draft.conversations[h.key]!.historyRead!.id !== committed.conversations[h.key]?.historyRead?.id);
  const admitting = h.text("!history");
  try {
    await boundary.reached;
    assert.equal(reads.mock.callCount(), 0, "intent persistence must precede the actual runtime read");
    boundary.fail(new Error("Synthetic history-intent fsync failure"));
    await admitting;
    boundary.restore();
    assert.equal(h.bridge.store.snapshot().conversations[h.key]!.historyRead, undefined);
    await h.text("!history");
    await h.text("!history");
    assert.equal(reads.mock.callCount(), 2, "a pre-read persistence failure cannot leak the reserved slot");
    await h.text("!history");
    assert.equal(reads.mock.callCount(), 2, "superseded actual reads must still own both physical slots");
    assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /Two history reads/);
    assert.equal(h.bridge.healthy, true);
    assert.deepEqual(h.runtime.received, []);
  } finally {
    boundary.release();
    pending.resolve([]);
    await admitting;
    await h.bridge.flush();
    boundary.restore();
  }
  await h.text("!history");
  await h.bridge.flush();
  assert.equal(reads.mock.callCount(), 3);
});
