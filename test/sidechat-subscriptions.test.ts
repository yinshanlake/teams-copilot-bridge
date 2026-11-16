import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LocalAppSessions } from "../src/app-sessions.js";
import { completeAppSend, createWorking, eventually, findAction, harness, temporary } from "./helpers.js";
import { NativeRuntime } from "../src/native.js";
import { Bridge } from "../src/bridge.js";
import { Store } from "../src/store.js";
import { PreviewTransport, mockEnvelope, mockIdentity } from "../src/simulator.js";
import { authorizeActivity } from "../src/teams.js";
import { digest, object } from "../src/safety.js";
import { readSideMetadata } from "../src/side-metadata.js";
import type { FinalPage } from "../src/domain.js";

async function localFixture(t: TestContext) {
  const root = await temporary(t);
  const sessionStateDirectory = join(root, "sessions");
  await mkdir(sessionStateDirectory);
  const brokerDirectory = join(root, "absent-broker");
  const metadataDatabasePath = join(root, "metadata.db");
  const parent = randomUUID();
  const workspace = randomUUID();
  const side = randomUUID();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(metadataDatabasePath);
  db.exec(`
    CREATE TABLE workspaces(id TEXT, session_id TEXT, name TEXT, archived_at TEXT);
    CREATE TABLE sessions(id TEXT, title TEXT, session_type TEXT, is_running INTEGER, was_interrupted INTEGER,
      created_at TEXT, updated_at TEXT, archived_at TEXT);
    CREATE TABLE workspace_side_chats(workspace_id TEXT, session_id TEXT, created_at TEXT);
    CREATE TABLE session_side_chats(parent_session_id TEXT, session_id TEXT, created_at TEXT);
  `);
  db.prepare("INSERT INTO workspaces VALUES(?,?,?,NULL)").run(workspace, parent, "Synthetic parent");
  db.prepare("INSERT INTO sessions VALUES(?,NULL,'side_chat',1,0,?,?,NULL)").run(side, "2026-11-16", "2026-11-16");
  db.prepare("INSERT INTO workspace_side_chats VALUES(?,?,?)").run(workspace, side, "2026-11-16");
  db.close();
  for (const [id, name] of [[parent, "Synthetic parent"], [side, "New session"]]) {
    const directory = join(sessionStateDirectory, id!);
    await mkdir(directory);
    await writeFile(join(directory, "workspace.yaml"), `name: ${JSON.stringify(name)}\ncwd: ${JSON.stringify(root)}\n`);
    await writeFile(join(directory, "events.jsonl"), JSON.stringify({
      id: randomUUID(), type: "session.start", data: { sessionId: id },
    }) + "\n");
  }
  const options = { timeoutMs: 1000, sessionStateDirectory, brokerDirectory, metadataDatabasePath };
  const client = new LocalAppSessions(options);
  await client.start();
  t.after(() => client.close());
  return { root, parent, side, workspace, client, options, metadataDatabasePath, sessionStateDirectory };
}

test("side sources use the resolved parent session UUID and never the distinct workspace ID or generic New session title", async (t) => {
  const h = await localFixture(t);
  const before = await readFile(h.metadataDatabasePath);
  const sessions = await h.client.listSessions();
  const side = sessions.find((session) => session.id === h.side);
  assert.ok(side);
  assert.match(side.name, new RegExp(`Synthetic parent > Side chat ${h.side.slice(0, 8)}`), h.client.discoveryStatus());
  assert.equal(side.id, h.side);
  assert.ok(!side.name.includes(h.workspace));
  assert.equal(side.status, "offline", "persisted is_running is not verified liveness");
  assert.deepEqual(await readFile(h.metadataDatabasePath), before, "metadata access must not write or migrate the source DB");
  await writeFile(join(h.sessionStateDirectory, h.parent, "workspace.yaml"), `name: "${"Parent".repeat(30)}"\ncwd: ${JSON.stringify(h.root)}\n`);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(h.metadataDatabasePath);
  db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run("Long side title".repeat(50), h.side);
  db.close();
  const longName = (await h.client.listSessions()).find((session) => session.id === h.side)!.name;
  assert.ok([...longName].length <= 120 && longName.endsWith(`Side chat ${h.side.slice(0, 8)}`),
    "long parent/title text must not hide the child's source ID in a reply heading");
});

test("session notification eligibility is an explicit Subscribe action, not an ordinary History visit", async (t) => {
  const h = await harness(t);
  await createWorking(h);
  assert.ok(findAction(h.bridge.render(h.key), "Subscribe"));
  await h.text("!read");
  assert.ok(findAction(h.bridge.render(h.key), "Subscribe"));
});

async function subscribedFixture(t: TestContext) {
  const local = await localFixture(t);
  let sdkCalls = 0;
  const open = async (subscriptionReadTimeoutMs = 2000, subscriptionBaselineTimeoutMs = 30_000) => {
    const app = new LocalAppSessions(local.options);
    const runtime = new NativeRuntime({
      home: join(local.root, "native"), configDirectory: join(local.root, "native"), defaultModel: "", peers: false,
      appSessions: { ...local.options, outputPollIntervalMs: 60_000, outputWatchTimeoutMs: 60_000 },
    }, () => { sdkCalls++; throw new Error("SDK_MUST_NOT_START"); }, app);
    const store = await Store.open(join(local.root, "bridge"), "subscriptions-owner");
    const transport = new PreviewTransport();
    const bridge = new Bridge(store, runtime, transport, { owner: "subscriptions-owner",
      workspaces: [{ id: "local", name: "Synthetic only", path: local.root }],
      coalesceMs: 60_000, subscriptionPollMs: 60_000, subscriptionReadTimeoutMs, subscriptionBaselineTimeoutMs });
    await bridge.start();
    const initial = authorizeActivity(mockEnvelope("!home"), { aud: mockIdentity.appId }, mockIdentity);
    const text = async (value: string) => {
      const turn = authorizeActivity(mockEnvelope(value), { aud: mockIdentity.appId }, mockIdentity);
      const card = await bridge.handle(turn.key, turn.reference, turn.activity.id!, turn.incoming);
      if (value.startsWith("!use ")) await bridge.flush();
      return card;
    };
    const action = async (title: string, fields: Record<string, unknown> = {}) => {
      const button = findAction(bridge.render(initial.key), title);
      assert.ok(object(button.data));
      const turn = authorizeActivity({ ...mockEnvelope(""), value: { ...button.data, ...fields } }, { aud: mockIdentity.appId }, mockIdentity);
      return bridge.handle(turn.key, turn.reference, turn.activity.id!, turn.incoming);
    };
    if (!store.snapshot().conversations[initial.key]) await text("!home");
    return { app, runtime, store, transport, bridge, text, action, key: initial.key };
  };
  let sequence = 0;
  const append = async (id: string, content: string, origin = `native-origin-${sequence}`, published = false) => {
    const index = sequence++;
    const timestamp = new Date(Date.UTC(2026, 10, 16, 5, 0, index)).toISOString();
    const ordinary = [
      { id: `start-${index}`, type: "assistant.turn_start", data: { turnId: `turn-${index}`, interactionId: `interaction-${index}` } },
      { id: `result-${index}`, type: "assistant.message", timestamp,
        data: { originatingMessageId: origin, messageId: "reused-local-message-id", phase: "final_answer",
          turnId: `turn-${index}`, interactionId: `interaction-${index}`, content } },
      { id: `end-${index}`, type: "assistant.turn_end", data: { turnId: `turn-${index}` } },
    ];
    const publication = [
      { id: `pub-${index}`, type: "assistant.message", timestamp,
        data: { originatingMessageId: origin, content: "", turnId: `turn-${index}`, interactionId: `interaction-${index}`,
          toolRequests: [{ name: "publish_chat_update", toolCallId: `pub-call-${index}`, arguments: { message: content, attachments: [] } }] } },
      { id: `pub-start-${index}`, type: "tool.execution_start",
        data: { toolCallId: `pub-call-${index}`, toolName: "publish_chat_update", turnId: `turn-${index}`, arguments: { message: content, attachments: [] } } },
      { id: `pub-end-${index}`, type: "tool.execution_complete", timestamp,
        data: { toolCallId: `pub-call-${index}`, success: true, turnId: `turn-${index}`, interactionId: `interaction-${index}`,
          result: { content: JSON.stringify({ kind: "chat_update", version: 1, message: content, attachments: [{ file: "PRIVATE_ATTACHMENT_PATH" }] }) } } },
      { id: `next-${index}`, type: "assistant.turn_start", data: { turnId: `empty-${index}`, interactionId: `interaction-${index}` } },
      { id: `empty-${index}`, type: "assistant.message", timestamp,
        data: { originatingMessageId: origin, phase: "final_answer", content: "", turnId: `empty-${index}`, interactionId: `interaction-${index}` } },
      { id: `end-${index}`, type: "assistant.turn_end", data: { turnId: `empty-${index}` } },
    ];
    await appendFile(join(local.sessionStateDirectory, id, "events.jsonl"), (published ? publication : ordinary)
      .map((event) => JSON.stringify(event)).join("\n") + "\n");
  };
  const register = async (id: string) => {
    for (const directory of ["sessions", "requests", "processing", "responses", "failed", "staging"]) {
      await mkdir(join(local.options.brokerDirectory, directory), { recursive: true });
    }
    await writeFile(join(local.options.brokerDirectory, "config.json"), JSON.stringify({ schema: 1, registrationTtlMs: 20_000, operations: ["send_message"] }));
    await writeFile(join(local.options.brokerDirectory, "sessions", `${id}.json`), JSON.stringify({
      schema: 1, sessionId: id, instanceId: randomUUID(), pid: process.pid, name: "New session",
      workspace: local.root, status: "idle", heartbeatAt: new Date().toISOString(),
    }));
  };
  return { ...local, open, append, register, sdkCalls: () => sdkCalls };
}

test("side navigation keeps independent histories and explicit source subscriptions; a parent never implicitly subscribes its sides", async (t) => {
  const f = await subscribedFixture(t);
  await f.append(f.parent, "PARENT_ONLY");
  await f.append(f.side, "SIDE_ONLY");
  const h = await f.open();
  try {
    await h.text(`!use ${f.parent}`);
    await h.action("Subscribe");
    const sides = await h.action("Side chats");
    assert.match(JSON.stringify(sides), /Synthetic parent > Side chat/);
    await h.action("Open");
    assert.equal(h.store.snapshot().conversations[h.key]!.selectedId, f.side);
    const history = await h.text("!read");
    const body = history.body.find((entry) => entry.id === "transcript-page-text")?.text;
    assert.ok(typeof body === "string" && body.includes("SIDE_ONLY") && !body.includes("PARENT_ONLY"));
    assert.throws(() => findAction(history, "Stop turn"), /not found/);
    assert.throws(() => findAction(history, "Approve once"), /not found/);
    assert.ok(findAction(history, "Subscribe"), "parent subscription cannot turn the side's toggle into Unsubscribe");
    await f.append(f.side, "SIDE_NOT_SUBSCRIBED");
    await h.bridge.checkSubscriptions();
    assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).length, 0);
    await h.action("Subscribe");
    await f.append(f.side, "SIDE_NEW_NOTIFICATION");
    await f.append(f.parent, "PARENT_NEW_NOTIFICATION");
    for (let count = 0; count < 4; count++) await h.bridge.checkSubscriptions();
    await h.bridge.flush();
    assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).length, 2);
    assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).find((item) => item.text === "SIDE_NEW_NOTIFICATION")?.sessionId, f.side);
    assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).find((item) => item.text === "PARENT_NEW_NOTIFICATION")?.sessionId, f.parent);
    assert.ok(!JSON.stringify(h.store.snapshot().outbox.filter((item) => !item.historyId)).includes("SIDE_NOT_SUBSCRIBED"));
    await h.action("Parent");
    assert.equal(h.store.snapshot().conversations[h.key]!.selectedId, f.parent);
    assert.equal(f.sdkCalls(), 0);
  } finally { await h.bridge.close(); }
});

test("subscriptions cover more than the history tail and restart from the durable covered cursor without a backlog or SDK", async (t) => {
  const f = await subscribedFixture(t);
  await f.append(f.parent, "OLD_BACKLOG_MUST_NOT_SEND");
  const first = await f.open();
  try {
    await first.text(`!use ${f.parent}`);
    await first.action("Subscribe");
    assert.equal(first.store.snapshot().outbox.filter((item) => !item.historyId).length, 0);
    for (let index = 0; index < 70; index++) await f.append(f.parent, `NEW_RESULT_${index}`);
    await first.bridge.checkSubscriptions();
    assert.ok(first.store.snapshot().outbox.filter((item) => !item.historyId).length > 0 && first.store.snapshot().outbox.filter((item) => !item.historyId).length < 70, "each read is paginated");
  } finally { await first.bridge.close(); }
  const second = await f.open();
  try {
    for (let count = 0; count < 12; count++) await second.bridge.checkSubscriptions();
    await second.bridge.flush();
    const outbox = second.store.snapshot().outbox.filter((item) => !item.historyId);
    assert.equal(outbox.length, 70);
    for (let index = 0; index < 70; index++) assert.equal(outbox.filter((item) => item.text === `NEW_RESULT_${index}`).length, 1);
    assert.ok(outbox.every((item) => item.status === "sent"));
    assert.ok(!JSON.stringify(outbox).includes("OLD_BACKLOG"));
    for (let count = 0; count < 2; count++) await second.bridge.checkSubscriptions();
    assert.deepEqual(second.store.snapshot().outbox.filter((item) => !item.historyId), outbox);
    assert.equal(f.sdkCalls(), 0);
  } finally { await second.bridge.close(); }
});

test("unsubscribe fences in-flight pages and pending source-only notifications, while resubscribe/restart begins at a new baseline", async (t) => {
  const f = await subscribedFixture(t);
  const first = await f.open();
  try {
    await first.text(`!use ${f.parent}`);
    await first.action("Subscribe");
    await f.append(f.parent, "CANCEL_PENDING");
    await first.bridge.checkSubscriptions();
    assert.equal(first.store.snapshot().outbox.filter((item) => !item.historyId)[0]?.status, "pending");
    await first.action("Unsubscribe");
    assert.equal(first.store.snapshot().outbox.filter((item) => !item.historyId)[0]?.status, "cancelled");
    await first.bridge.flush();
    assert.ok(![...first.transport.messages.values()].some((item) => item.message.type === "text" && item.message.text === "CANCEL_PENDING"));
    await first.action("Subscribe");
    await f.append(f.parent, "OLD_IN_FLIGHT");
    const subscription = Object.values(first.store.snapshot().subscriptions)[0]!;
    const page = await first.runtime.subscriptionRead(f.parent, subscription.cursor);
    let release: ((value: typeof page) => void) | undefined;
    const pending = new Promise<typeof page>((resolve) => { release = resolve; });
    const reads = t.mock.method(first.runtime, "subscriptionRead", () => pending);
    const checking = first.bridge.checkSubscriptions();
    try {
      await eventually(() => reads.mock.callCount() === 1);
      await first.action("Unsubscribe");
      await first.action("Subscribe");
      release!(page);
      await checking;
    } finally { release?.(page); await checking; reads.mock.restore(); }
    assert.ok(!first.store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.text === "OLD_IN_FLIGHT"));
  } finally { await first.bridge.close(); }
  const second = await f.open();
  try {
    await f.append(f.parent, "AFTER_RESTART");
    await second.bridge.checkSubscriptions();
    await second.bridge.flush();
    assert.equal(second.store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text === "AFTER_RESTART" && item.status === "sent").length, 1);
    assert.ok(!second.store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.text === "OLD_IN_FLIGHT"));
    assert.equal(f.sdkCalls(), 0);
  } finally { await second.bridge.close(); }
});

test("subscription and direct App admission share one canonical result in both observer orders and unsubscribe cannot cancel direct replies", async (t) => {
  for (const order of ["subscription-first", "admission-first", "published-subscription-first", "published-admission-first"]) {
    const f = await subscribedFixture(t);
    await f.register(f.parent);
    const h = await f.open();
    try {
      await h.text(`!use ${f.parent}`);
      await h.action("Subscribe");
      const origin = randomUUID();
      const sending = h.text(`Synthetic direct request ${order}`);
      await completeAppSend(f.options.brokerDirectory, f.parent, { accepted: true, messageId: origin });
      await sending;
      await f.append(f.parent, `ONE_RESULT_${order}`, origin, order.startsWith("published"));
      if (order.includes("subscription-first")) await h.bridge.checkSubscriptions();
      else await h.text("!read");
      await h.action("Unsubscribe");
      await h.text("!read");
      await h.bridge.checkSubscriptions();
      await h.bridge.flush();
      const outbox = h.store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text === `ONE_RESULT_${order}`);
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0]!.status, "sent");
      assert.equal(outbox[0]!.direct, true);
      assert.equal(outbox[0]!.admissionId, digest(`${f.parent}:${origin}`));
      assert.equal(h.store.snapshot().admissions[digest(`${f.parent}:${origin}`)]?.phase, "confirmed");
      assert.ok(!JSON.stringify(h.store.snapshot().outbox.filter((item) => !item.historyId)).includes("PRIVATE_ATTACHMENT_PATH"));
      assert.equal(f.sdkCalls(), 0);
    } finally { await h.bridge.close(); }
  }
});

test("journal replacement/truncation pauses subscriptions instead of resetting into historical notifications", async (t) => {
  for (const mode of ["replacement", "truncation"]) {
    const f = await subscribedFixture(t);
    await f.append(f.parent, "OLD_RESULT");
    const h = await f.open();
    try {
      await h.text(`!use ${f.parent}`);
      await h.action("Subscribe");
      const path = join(f.sessionStateDirectory, f.parent, "events.jsonl");
      if (mode === "replacement") {
        const replacement = join(f.root, "replacement.jsonl");
        await writeFile(replacement, await readFile(path));
        await rename(replacement, path);
      } else await writeFile(path, JSON.stringify({ id: "new", type: "session.start", data: { sessionId: f.parent } }) + "\n");
      await h.bridge.checkSubscriptions();
      const subscription = Object.values(h.store.snapshot().subscriptions)[0]!;
      assert.equal(subscription.status, "paused", mode);
      assert.match(subscription.detail, /JOURNAL_CHANGED/);
      assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).length, 0);
      assert.ok((await stat(path)).size > 0);
    } finally { await h.bridge.close(); }
  }
});

test("metadata schema/missing database failures are visible and do not break ordinary safe history or guess parent links", async (t) => {
  const f = await localFixture(t);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(f.metadataDatabasePath);
  db.exec("DROP TABLE workspace_side_chats");
  db.close();
  const sessions = await f.client.listSessions();
  assert.equal(sessions.length, 2);
  assert.match(f.client.discoveryStatus(), /METADATA_SCHEMA/);
  assert.equal(sessions.find((item) => item.id === f.side)?.sideChat, undefined);
  assert.match(sessions.find((item) => item.id === f.side)?.name ?? "", /Context unknown/);
  const missing = new LocalAppSessions({ ...f.options, metadataDatabasePath: join(f.root, "missing.db") });
  await missing.start();
  try {
    assert.equal((await missing.listSessions()).length, 2);
    assert.match(missing.discoveryStatus(), /Side-chat discovery unavailable/);
    assert.deepEqual(await missing.readSession(f.parent), []);
  } finally { await missing.close(); }
  const unavailable = await readSideMetadata(f.metadataDatabasePath, async () => {
    throw Object.assign(new Error("Built-in SQLite unavailable in this synthetic supported runtime"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
  });
  assert.equal(unavailable.available, false);
  assert.match(unavailable.detail, /Node version with built-in read-only SQLite/);
  assert.deepEqual(unavailable.sides, []);
});

test("covered cursors preserve split EOF, Unicode/CRLF and strict publication context through restart without storing prompts", async (t) => {
  const f = await subscribedFixture(t);
  const h = await f.open();
  const prompt = "PROMPT_MUST_NOT_ENTER_SUBSCRIPTION_CURSOR";
  try {
    await h.text(`!use ${f.parent}`);
    await h.action("Subscribe");
    const path = join(f.sessionStateDirectory, f.parent, "events.jsonl");
    const origin = randomUUID();
    const content = "Published after a long tool tail\r\n你好 🚀";
    await appendFile(path, [
      { id: "request-user", type: "user.message", data: { messageId: origin, content: prompt } },
      { id: "published-request", type: "assistant.message", data: { turnId: "turn", interactionId: "interaction", originatingMessageId: origin,
        toolRequests: [{ name: "publish_chat_update", toolCallId: "pub", arguments: { message: content, attachments: [] } }] } },
      { id: "published-start", type: "tool.execution_start", data: { toolCallId: "pub", toolName: "publish_chat_update", turnId: "turn",
        arguments: { message: content, attachments: [] } } },
      ...Array.from({ length: 140 }, (_, index) => ({ id: `tool-${index}`, type: "tool.execution_complete", data: { success: true, result: { content: "PRIVATE_TOOL_OUTPUT" } } })),
    ].map((event) => JSON.stringify(event)).join("\r\n") + "\r\n");
    await h.bridge.checkSubscriptions();
    const cursor = Object.values(h.store.snapshot().subscriptions)[0]!.cursor;
    assert.ok(cursor.index > 100 && cursor.requests.length === 1);
    assert.ok(!JSON.stringify(cursor).includes(prompt) && !JSON.stringify(cursor).includes(content));
    assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).length, 0);
  } finally { await h.bridge.close(); }
  const resumed = await f.open();
  try {
    const path = join(f.sessionStateDirectory, f.parent, "events.jsonl");
    const cursor = Object.values(resumed.store.snapshot().subscriptions)[0]!.cursor;
    const origin = cursor.requests[0]!.origin!;
    const content = "Published after a long tool tail\r\n你好 🚀";
    const event = JSON.stringify({ id: "published-final", type: "tool.execution_complete", timestamp: "2026-11-16T08:00:00Z",
      data: { toolCallId: "pub", turnId: "turn", interactionId: "interaction", originatingMessageId: origin, success: true,
        result: { content: JSON.stringify({ kind: "chat_update", version: 1, message: content, attachments: [] }) } } });
    const buffer = Buffer.from(event);
    const split = buffer.indexOf(Buffer.from("🚀")) + 2;
    await appendFile(path, buffer.subarray(0, split));
    for (let count = 0; count < 3; count++) await resumed.bridge.checkSubscriptions();
    assert.equal(resumed.store.snapshot().outbox.filter((item) => !item.historyId).length, 0);
    const before = Object.values(resumed.store.snapshot().subscriptions)[0]!.cursor.index;
    await appendFile(path, buffer.subarray(split));
    await resumed.bridge.checkSubscriptions();
    await resumed.bridge.flush();
    assert.equal(resumed.store.snapshot().outbox.filter((item) => !item.historyId).filter((item) => item.text === content).length, 1, "valid completed EOF without newline is readable");
    await appendFile(path, "\r\n");
    await resumed.bridge.checkSubscriptions();
    assert.equal(Object.values(resumed.store.snapshot().subscriptions)[0]!.cursor.index, before + 1,
      "the appended separator does not invent an extra physical record");
    assert.equal(resumed.store.snapshot().outbox.filter((item) => !item.historyId).length, 1);
    assert.ok(!JSON.stringify(resumed.store.snapshot().subscriptions).includes(prompt));
  } finally { await resumed.bridge.close(); }
});

test("a history visit never creates notification eligibility, while an explicit native task preserves its recipient across restart", async (t) => {
  const directory = await temporary(t);
  const first = await harness(t, false, directory);
  const id = await createWorking(first);
  await first.text("!read");
  first.runtime.emit(id, "assistant.message", { messageId: "unsubscribed-background", phase: "final", content: "HISTORY_VISIT_NOT_A_SUBSCRIPTION" });
  await first.bridge.flush();
  assert.equal(first.bridge.store.snapshot().outbox.filter((item) => !item.historyId).length, 0);
  await first.text("A new explicit native task");
  const origin = Object.values(first.bridge.store.snapshot().directOrigins).find((item) => item.sessionId === id && item.status === "accepted")!;
  assert.ok(origin.messageId);
  await first.bridge.close();
  const second = await harness(t, false, directory, { initializeConversation: false });
  second.runtime.emit(id, "assistant.message", { messageId: "direct-after-restart", originatingMessageId: origin.messageId,
    phase: "final", content: "DIRECT_RECIPIENT_SURVIVES_RESTART" });
  await second.bridge.flush();
  const results = second.bridge.store.snapshot().outbox.filter((item) => !item.historyId);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.text, "DIRECT_RECIPIENT_SURVIVES_RESTART");
  assert.equal(results[0]!.conversationKey, first.key);
  assert.equal(results[0]!.direct, true);
  assert.deepEqual(second.runtime.resumed, []);
});

test("subscribe during work preserves bounded pre-baseline request/start evidence and delivers only the later proven result", async (t) => {
  for (const name of ["task_complete", "publish_chat_update"]) {
    const f = await subscribedFixture(t);
    await f.append(f.parent, "ALREADY_COMPLETED_BEFORE_SUBSCRIBE");
    const origin = randomUUID();
    const text = `GENUINE_LATE_${name}\r\n你好 🚀`;
    const args = name === "task_complete" ? { summary: text } : { message: text, attachments: [] };
    const path = join(f.sessionStateDirectory, f.parent, "events.jsonl");
    await appendFile(path, [
      { id: "older-user", type: "user.message", data: { messageId: origin, content: "OLD_PROMPT_NOT_STORED_IN_CURSOR" } },
      { id: "older-request", type: "assistant.message", data: { turnId: "late-turn", interactionId: "late-interaction", originatingMessageId: origin,
        toolRequests: [{ name, toolCallId: "late-call", arguments: args }] } },
      { id: "older-start", parentId: "older-request", type: "tool.execution_start",
        data: { toolCallId: "late-call", toolName: name, turnId: "late-turn", arguments: args } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    const h = await f.open();
    try {
      await h.text(`!use ${f.parent}`);
      await h.action("Subscribe");
      const cursor = Object.values(h.store.snapshot().subscriptions)[0]!.cursor;
      assert.equal(cursor.requests.length, 1);
      assert.deepEqual(cursor.starts, ["late-call"]);
      assert.ok(!JSON.stringify(cursor).includes(text) && !JSON.stringify(cursor).includes("OLD_PROMPT"));
      await h.bridge.checkSubscriptions();
      assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).length, 0);
      const content = name === "task_complete" ? text : JSON.stringify({ kind: "chat_update", version: 1, message: text, attachments: [] });
      await appendFile(path, JSON.stringify({ id: "late-completion", type: "tool.execution_complete", timestamp: "2026-11-16T09:00:00Z",
        data: { toolCallId: "late-call", success: true, turnId: "late-turn", interactionId: "late-interaction", result: { content } } }) + "\n");
      await h.bridge.checkSubscriptions();
      await h.bridge.flush();
      const outbox = h.store.snapshot().outbox.filter((item) => !item.historyId);
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0]!.text, text);
      assert.equal(outbox[0]!.status, "sent");
      assert.ok(!JSON.stringify(outbox).includes("ALREADY_COMPLETED"));
    } finally { await h.bridge.close(); }
  }
});

test("identical titles, cwd, message/origin IDs and result text across canonical parent/side roots retain two isolated result identities", async (t) => {
  const f = await subscribedFixture(t);
  for (const id of [f.parent, f.side]) {
    await writeFile(join(f.sessionStateDirectory, id, "workspace.yaml"), `name: "Same title"\ncwd: ${JSON.stringify(f.root)}\n`);
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(f.metadataDatabasePath);
  db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run("Same title", f.side);
  db.close();
  const h = await f.open();
  try {
    for (const id of [f.parent, f.side]) {
      await h.text(`!use ${id}`);
      await h.action("Subscribe");
      await appendFile(join(f.sessionStateDirectory, id, "events.jsonl"), JSON.stringify({
        id: "same-event-id", type: "assistant.message", timestamp: "2026-11-16T09:05:00Z",
        data: { messageId: "same-local-message-id", originatingMessageId: "same-local-origin", content: "IDENTICAL_RESULT", phase: "final_answer" },
      }) + "\n");
    }
    await h.bridge.checkSubscriptions();
    await h.bridge.flush();
    const results = h.store.snapshot().outbox.filter((item) => !item.historyId);
    assert.equal(results.length, 2);
    assert.deepEqual(new Set(results.map((item) => item.sessionId)), new Set([f.parent, f.side]));
    assert.equal(new Set(results.map((item) => item.eventId)).size, 2);
    assert.equal(new Set(results.map((item) => item.id)).size, 2);
    assert.equal(new Set(results.map((item) => item.sourceResultKey)).size, 2);
    assert.ok(results.every((item) => item.text === "IDENTICAL_RESULT" && item.status === "sent"));
    for (const id of [f.parent, f.side]) {
      await h.text(`!use ${id}`);
      const history = await h.text("!read");
      assert.equal(h.store.snapshot().conversations[h.key]!.transcriptId, id);
      const text = history.body.find((item) => item.id === "transcript-page-text")?.text;
      assert.ok(typeof text === "string" && text.split("IDENTICAL_RESULT").length - 1 === 1);
    }
  } finally { await h.bridge.close(); }
});

test("subscription source and form guards remain signed and bounded; no implicit read markers are migrated into opt-in state", async (t) => {
  const h = await harness(t);
  for (let index = 0; index < 8; index++) {
    await createWorking(h, `Subscribed ${index}`);
    await h.action(findAction(h.bridge.render(h.key), "Subscribe"));
  }
  const id = await createWorking(h, "Ninth source");
  const calls = t.mock.method(h.runtime, "subscriptionBaseline");
  await h.action(findAction(h.bridge.render(h.key), "Subscribe"));
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /eight subscriptions/);
  assert.equal(calls.mock.callCount(), 0, "the cap must reject before any journal baseline scan");
  assert.equal(Object.values(h.bridge.store.snapshot().subscriptions).filter((item) => item.enabled).length, 8);
  const count = Object.keys(h.bridge.store.snapshot().subscriptions).length;
  await h.action(findAction(h.bridge.render(h.key), "Subscribe"), { targetId: id });
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /unexpected field/);
  assert.equal(Object.keys(h.bridge.store.snapshot().subscriptions).length, count);
  assert.deepEqual(h.runtime.received, []);
});

test("unsubscribe does not retract a notification already claimed by transport and uncertain delivery never re-posts", async (t) => {
  const f = await subscribedFixture(t);
  const h = await f.open();
  try {
    await h.text(`!use ${f.parent}`);
    await h.action("Subscribe");
    await f.append(f.parent, "CLAIMED_BEFORE_UNSUBSCRIBE");
    await h.bridge.checkSubscriptions();
    const send = h.transport.send.bind(h.transport);
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    t.mock.method(h.transport, "send", async (...args: Parameters<typeof h.transport.send>) => {
      if (args[1].type === "text" && args[1].presentation?.kind !== "history") await wait;
      return send(...args);
    });
    const flush = h.bridge.flush();
    try {
      await eventually(() => h.store.snapshot().outbox.filter((item) => !item.historyId)[0]?.status === "sending");
      await h.action("Unsubscribe");
      assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId)[0]?.status, "sending");
      release!();
      await flush;
    } finally { release?.(); await flush; }
    assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId)[0]?.status, "sent");
    await h.action("Subscribe");
    await f.append(f.parent, "UNCERTAIN_ONCE");
    await h.bridge.checkSubscriptions();
    const uncertain = t.mock.method(h.transport, "send", async (...args: Parameters<typeof h.transport.send>) => {
      if (args[1].type === "text") throw new Error("Synthetic lost acknowledgement");
      return send(...args);
    });
    await h.bridge.flush();
    assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).find((item) => item.text === "UNCERTAIN_ONCE")?.status, "uncertain");
    await h.action("Unsubscribe");
    await h.action("Subscribe");
    await h.bridge.checkSubscriptions();
    await h.bridge.flush();
    assert.equal(uncertain.mock.calls.filter((call) => call.arguments[1].type === "text").length, 1);
    assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).find((item) => item.text === "UNCERTAIN_ONCE")?.status, "uncertain");
  } finally { await h.bridge.close(); }
});

test("a stalled subscription read pauses visibly, retains its durable cursor and cannot apply a late result or spawn duplicate reads", async (t) => {
  const f = await subscribedFixture(t);
  const h = await f.open(25);
  try {
    await h.text(`!use ${f.parent}`);
    await h.action("Subscribe");
    await f.append(f.parent, "LATE_UNCONFIRMED_READ");
    const subscription = Object.values(h.store.snapshot().subscriptions)[0]!;
    const page = await h.runtime.subscriptionRead(f.parent, subscription.cursor);
    let release: ((value: typeof page) => void) | undefined;
    const pending = new Promise<typeof page>((resolve) => { release = resolve; });
    const reads = t.mock.method(h.runtime, "subscriptionRead", () => pending);
    try {
      await h.bridge.checkSubscriptions();
      const current = Object.values(h.store.snapshot().subscriptions)[0]!;
      assert.equal(current.status, "paused");
      assert.match(current.detail, /READ_TIMEOUT/);
      assert.deepEqual(current.cursor, subscription.cursor);
      await h.bridge.checkSubscriptions();
      assert.equal(reads.mock.callCount(), 1);
      release!(page);
      await pending;
      assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).length, 0, "late completion cannot mutate paused observer state");
      assert.deepEqual(Object.values(h.store.snapshot().subscriptions)[0]!.cursor, subscription.cursor);
    } finally { release?.(page); await pending; }
  } finally { await h.bridge.close(); }
});

test("S2: a timed-out revision1 read cannot be adopted by a resubscribed revision3 cursor or pause/overwrite it on late settlement", async (t) => {
  for (const outcome of ["resolve", "reject"] as const) {
    const f = await subscribedFixture(t);
    const h = await f.open(25);
    let releaseOld: ((page: FinalPage) => void) | undefined;
    let rejectOld: ((error: Error) => void) | undefined;
    let releaseNew: ((page: FinalPage) => void) | undefined;
    let checking: Promise<void> | undefined;
    try {
      await h.text(`!use ${f.parent}`);
      const base = await h.runtime.subscriptionBaseline(f.parent);
      const cursor100 = { ...base, offset: 100, index: 100 };
      const cursor200 = { ...base, offset: 200, index: 200 };
      let captures = 0;
      t.mock.method(h.runtime, "subscriptionBaseline", async () => ++captures === 1 ? cursor100 : cursor200);
      await h.action("Subscribe");
      const oldPage: FinalPage = {
        cursor: { ...base, offset: 150, index: 150 }, hasMore: false,
        events: [{ id: "pre-resubscribe-result", type: "assistant.message", timestamp: "2026-11-16T10:00:00Z",
          data: { messageId: "stale-final", phase: "final", content: "OLD_REVISION_MUST_NOT_SEND" } }],
      };
      const oldRead = new Promise<FinalPage>((resolve, reject) => { releaseOld = resolve; rejectOld = reject; });
      const newRead = new Promise<FinalPage>((resolve) => { releaseNew = resolve; });
      let actualReads = 0;
      const reads = t.mock.method(h.runtime, "subscriptionRead", () =>
        ++actualReads === 1 ? oldRead : newRead);
      await h.bridge.checkSubscriptions();
      assert.equal(Object.values(h.store.snapshot().subscriptions)[0]!.status, "paused");
      await h.action("Unsubscribe");
      await h.action("Subscribe");
      const expected = Object.values(h.store.snapshot().subscriptions)[0]!;
      assert.equal(expected.revision, 3);
      assert.equal(expected.cursor.offset, 200);
      const notice = h.store.snapshot().conversations[h.key]!.notice;
      const timeline = h.store.snapshot().sessions[f.parent]!.timeline;
      checking = h.bridge.checkSubscriptions();
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (outcome === "resolve") releaseOld!(oldPage);
      else rejectOld!(new Error("OLD_READ_FAILURE_MUST_NOT_PAUSE_NEW_REVISION"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseNew!({ cursor: cursor200, events: [], hasMore: false });
      await checking;
      assert.equal(reads.mock.callCount(), 2, "the newer intent must read its own baseline/revision rather than reuse the old promise");
      assert.deepEqual(Object.values(h.store.snapshot().subscriptions)[0], expected, outcome);
      assert.equal(h.store.snapshot().conversations[h.key]!.notice, notice, "a stale failure cannot replace the new subscription notice");
      assert.deepEqual(h.store.snapshot().sessions[f.parent]!.timeline, timeline);
      assert.ok(!h.store.snapshot().outbox.filter((item) => !item.historyId).some((item) => item.text === "OLD_REVISION_MUST_NOT_SEND"));
      assert.equal(f.sdkCalls(), 0);
    } finally {
      const safe = Object.values(h.store.snapshot().subscriptions)[0]?.cursor ??
        await h.runtime.subscriptionBaseline(f.parent);
      releaseOld?.({ cursor: safe, events: [], hasMore: false });
      releaseNew?.({ cursor: safe, events: [], hasMore: false });
      await checking;
      await h.bridge.close();
    }
  }
});

test("S2 baseline: an explicit retry cannot reuse a timed-out from-now capture and must start fresh after its old read settles", async (t) => {
  const f = await subscribedFixture(t);
  const h = await f.open(25, 25);
  let release: ((value: Awaited<ReturnType<typeof h.runtime.subscriptionBaseline>>) => void) | undefined;
  let retry: ReturnType<typeof h.action> | undefined;
  try {
    await h.text(`!use ${f.parent}`);
    const base = await h.runtime.subscriptionBaseline(f.parent);
    const priorCutoff = { ...base, offset: 150, index: 150 };
    const freshCutoff = { ...base, offset: 200, index: 200 };
    let reused: (() => void) | undefined;
    const adoption = new Promise<void>((resolve) => { reused = resolve; });
    let waiters = 0;
    class ObservedCapture extends Promise<typeof base> {
      static override get [Symbol.species](): PromiseConstructor { return Promise; }
      override then<TResult1 = typeof base, TResult2 = never>(
        fulfilled?: ((value: typeof base) => TResult1 | PromiseLike<TResult1>) | null,
        rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): Promise<TResult1 | TResult2> {
        if (++waiters === 3) reused!();
        return super.then(fulfilled, rejected);
      }
    }
    const pending = new ObservedCapture((resolve) => { release = resolve; });
    let actualReads = 0;
    const reads = t.mock.method(h.runtime, "subscriptionBaseline", () =>
      ++actualReads === 1 ? pending : Promise.resolve(freshCutoff));
    await h.action("Subscribe");
    assert.match(h.store.snapshot().conversations[h.key]!.notice, /BASELINE_TIMEOUT/);
    assert.equal(Object.keys(h.store.snapshot().subscriptions).length, 0);
    retry = h.action("Subscribe");
    const result = await Promise.race([adoption.then(() => "reused"), retry.then(() => "finished")]);
    if (result === "reused") release!(priorCutoff);
    await retry;
    assert.equal(Object.keys(h.store.snapshot().subscriptions).length, 0,
      "the second intent must fail explicitly while an earlier actual baseline capture is still pending, not adopt offset150");
    assert.match(h.store.snapshot().conversations[h.key]!.notice, /BASELINE_IN_PROGRESS/);
    release!(priorCutoff);
    await pending;
    await h.action("Subscribe");
    const current = Object.values(h.store.snapshot().subscriptions)[0]!;
    assert.equal(current.cursor.offset, 200);
    assert.equal(current.enabled, true);
    assert.equal(reads.mock.callCount(), 2);
    assert.equal(f.sdkCalls(), 0);
  } finally {
    release?.({ generation: "synthetic-cleanup", offset: 0, index: 0, anchor: digest(""), eofRecord: false, requests: [], starts: [], outputs: [] });
    await retry;
    await h.bridge.close();
  }
});

test("S2: read completion and errors also fence the original starting cursor when the saved cursor advances within one revision", async (t) => {
  for (const outcome of ["resolve", "reject"] as const) {
    const f = await subscribedFixture(t);
    const h = await f.open();
    let release: ((page: FinalPage) => void) | undefined;
    let reject: ((error: Error) => void) | undefined;
    let checking: Promise<void> | undefined;
    try {
      await h.text(`!use ${f.parent}`);
      await h.action("Subscribe");
      const before = Object.values(h.store.snapshot().subscriptions)[0]!;
      const cursor200 = { ...before.cursor, offset: 200, index: 200 };
      const pending = new Promise<FinalPage>((resolve, fail) => { release = resolve; reject = fail; });
      const read = t.mock.method(h.runtime, "subscriptionRead", () => pending);
      checking = h.bridge.checkSubscriptions();
      await eventually(() => read.mock.callCount() === 1);
      await h.store.mutate((state) => { state.subscriptions[before.id]!.cursor = cursor200; });
      const notice = h.store.snapshot().conversations[h.key]!.notice;
      if (outcome === "reject") reject!(new Error("OLD_START_CURSOR_FAILURE"));
      else release!({ cursor: { ...before.cursor, offset: 150, index: 150 }, hasMore: false,
        events: [{ id: "old-cursor-result", type: "assistant.message", timestamp: "2026-11-16T10:00:00Z",
          data: { messageId: "old-cursor", phase: "final", content: "OLD_CURSOR_MUST_NOT_SEND" } }] });
      await checking;
      assert.deepEqual(h.store.snapshot().subscriptions[before.id], { ...before, cursor: cursor200 }, outcome);
      assert.equal(h.store.snapshot().conversations[h.key]!.notice, notice);
      assert.equal(h.store.snapshot().outbox.filter((item) => !item.historyId).length, 0);
    } finally {
      const cursor = Object.values(h.store.snapshot().subscriptions)[0]!.cursor;
      release?.({ cursor, events: [], hasMore: false });
      await checking;
      await h.bridge.close();
    }
  }
});

test("S4: signed Unsubscribe can disable unreadable sources and cancel only unclaimed source notifications without source I/O", async (t) => {
  const f = await subscribedFixture(t);
  const h = await f.open();
  try {
    await h.text(`!use ${f.parent}`);
    await h.action("Subscribe");
    await f.append(f.parent, "PENDING_SOURCE_ONLY");
    await h.bridge.checkSubscriptions();
    await h.store.mutate((state) => {
      state.sessions[f.parent]!.access = { read: false, send: false };
      const subscription = Object.values(state.subscriptions)[0]!;
      subscription.status = "paused";
      state.outbox.push(
        { id: "direct-s4", conversationKey: h.key, sessionId: f.parent, eventId: "direct-s4", text: "DIRECT_REPLY_SURVIVES", direct: true, status: "pending" },
        { id: "admission-s4", conversationKey: h.key, sessionId: f.parent, eventId: "admission-s4", text: "ADMISSION_REPLY_SURVIVES", admissionId: "persisted-admission", status: "pending" },
      );
    });
    const calls = [
      t.mock.method(h.runtime, "subscriptionBaseline"), t.mock.method(h.runtime, "subscriptionRead"),
      t.mock.method(h.runtime, "history"), t.mock.method(h.runtime, "preview"),
      t.mock.method(h.runtime, "inventory"), t.mock.method(h.runtime, "appLiveness"),
    ];
    await h.action("Unsubscribe", { targetId: f.side });
    assert.match(h.store.snapshot().conversations[h.key]!.notice, /unexpected field/);
    assert.equal(Object.values(h.store.snapshot().subscriptions)[0]!.enabled, true);
    await h.action("Unsubscribe");
    const state = h.store.snapshot();
    const current = Object.values(state.subscriptions)[0]!;
    assert.equal(current.enabled, false);
    assert.equal(current.status, "disabled");
    assert.equal(state.outbox.find((item) => item.text === "PENDING_SOURCE_ONLY")?.status, "cancelled");
    assert.equal(state.outbox.find((item) => item.id === "direct-s4")?.status, "pending");
    assert.equal(state.outbox.find((item) => item.id === "admission-s4")?.status, "pending");
    for (const call of calls) assert.equal(call.mock.callCount(), 0, "unsubscribe must not require source readiness or read history/baselines");
    assert.equal(f.sdkCalls(), 0);
  } finally { await h.bridge.close(); }
});

test("S4: Subscriptions retains a signed cancellation path for an absent source without selecting, recreating or reading it", async (t) => {
  const f = await subscribedFixture(t);
  const h = await f.open();
  try {
    await h.text(`!use ${f.parent}`);
    await h.action("Subscribe");
    await h.store.mutate((state) => {
      delete state.sessions[f.parent];
      state.conversations[h.key]!.selectedId = f.side;
      state.conversations[h.key]!.view = "subscriptions";
      state.conversations[h.key]!.revision++;
      Object.values(state.subscriptions)[0]!.status = "paused";
    });
    const card = h.bridge.render(h.key);
    const cancel = findAction(card, "Unsubscribe");
    assert.ok(object(cancel.data));
    assert.equal(cancel.associatedInputs, "none");
    const claims = h.bridge.actions.verify(cancel.data.token, h.store.snapshot().conversations[h.key]!);
    assert.equal(claims.targetId, f.parent);
    assert.equal(claims.selected, f.side);
    assert.equal(claims.view, "subscriptions");
    const calls = [
      t.mock.method(h.runtime, "subscriptionBaseline"), t.mock.method(h.runtime, "subscriptionRead"),
      t.mock.method(h.runtime, "history"), t.mock.method(h.runtime, "preview"),
      t.mock.method(h.runtime, "inventory"), t.mock.method(h.runtime, "appLiveness"),
    ];
    await h.action("Unsubscribe");
    assert.equal(Object.values(h.store.snapshot().subscriptions)[0]!.enabled, false);
    assert.equal(h.store.snapshot().sessions[f.parent], undefined, "a UI cancellation placeholder must not recreate a runtime source");
    assert.equal(h.store.snapshot().conversations[h.key]!.selectedId, f.side);
    for (const call of calls) assert.equal(call.mock.callCount(), 0);
    assert.equal(f.sdkCalls(), 0);
  } finally { await h.bridge.close(); }
});
