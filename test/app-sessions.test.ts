import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { appendFile, mkdir, readFile, readdir, rename, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LocalAppSessions } from "../src/app-sessions.js";
import { object } from "../src/safety.js";
import { completeAppSend, temporary } from "./helpers.js";

async function fixture(t: TestContext, timeoutMs = 1000) {
  const root = await temporary(t);
  const sessionStateDirectory = join(root, "session-state");
  const brokerDirectory = join(root, "broker");
  await mkdir(sessionStateDirectory, { recursive: true });
  for (const name of ["sessions", "requests", "processing", "responses", "failed", "staging"]) {
    await mkdir(join(brokerDirectory, name), { recursive: true });
  }
  await writeFile(join(brokerDirectory, "config.json"), JSON.stringify({
    schema: 1,
    registrationTtlMs: 20_000,
    operations: ["send_message"],
  }));
  const client = new LocalAppSessions({ timeoutMs, sessionStateDirectory, brokerDirectory });
  await client.start();
  t.after(() => client.close());
  return { root, sessionStateDirectory, brokerDirectory, client };
}

async function saved(
  h: Awaited<ReturnType<typeof fixture>>, id: string, name: string, history = true,
) {
  const directory = join(h.sessionStateDirectory, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "workspace.yaml"), `name: ${JSON.stringify(name)}\ncwd: 'C:\\fixture\\repo'\n`);
  if (history) await writeFile(join(directory, "events.jsonl"), [
    { id: "message-event", type: "assistant.message", timestamp: "2026-11-11T13:00:00.000Z",
      data: { messageId: "message", content: "existing response", turnId: "turn-1" } },
    { id: "turn-end", type: "assistant.turn_end", timestamp: "2026-11-11T13:00:01.000Z", data: { turnId: "turn-1" } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
}

async function register(
  h: Awaited<ReturnType<typeof fixture>>, sessionId: string, patch: Record<string, unknown> = {},
) {
  await writeFile(join(h.brokerDirectory, "sessions", `${sessionId}.json`), JSON.stringify({
    schema: 1, sessionId, instanceId: randomUUID(), pid: process.pid,
    name: "Live endpoint", workspace: "C:\\fixture\\live", status: "idle",
    heartbeatAt: new Date().toISOString(), ...patch,
  }));
}

test("fresh local discovery includes saved metadata-only and journal sessions, merges live endpoints, and never needs a coordinator or Bot cache", async (t) => {
  const h = await fixture(t);
  const history = randomUUID();
  const metadata = randomUUID();
  const live = randomUUID();
  const endpointOnly = randomUUID();
  const nested = randomUUID();
  await saved(h, history, "Saved history");
  await saved(h, metadata, "Saved metadata without a journal", false);
  await saved(h, live, "Old saved title");
  await register(h, history, { heartbeatAt: "2020-01-01T00:00:00Z" });
  await register(h, live, { status: "busy", name: "Current live title" });
  await register(h, endpointOnly);
  await mkdir(join(h.sessionStateDirectory, live, nested));
  await writeFile(join(h.sessionStateDirectory, live, nested, "workspace.yaml"), "name: Not a root session");
  const list = await h.client.listSessions();
  assert.equal(list.length, 4);
  assert.deepEqual(list.find((item) => item.id === history), {
    id: history, name: "Saved history", status: "offline", workspace: "C:\\fixture\\repo", readable: true, direct: false,
    lastConversationAt: "2026-11-11T13:00:00.000Z",
  });
  assert.deepEqual(list.find((item) => item.id === metadata), {
    id: metadata, name: "Saved metadata without a journal", status: "offline", workspace: "C:\\fixture\\repo", readable: false, direct: false,
  });
  assert.equal(list.find((item) => item.id === live)?.name, "Current live title");
  assert.equal(list.find((item) => item.id === live)?.direct, true);
  assert.equal(list.find((item) => item.id === endpointOnly)?.readable, false);
  assert.deepEqual(await h.client.listSessions(), list);
  assert.deepEqual(await h.client.readSession(history), [{
    index: 0, assistantResponse: "existing response", timestamp: "2026-11-11T13:00:00.000Z",
  }]);
  assert.equal((await h.client.readSessionState(history)).completedThrough, 1);
  await assert.rejects(() => h.client.readSession(metadata), /APP_HISTORY_UNAVAILABLE/);
  const later = randomUUID();
  await saved(h, later, "Created after initial discovery");
  assert.ok((await h.client.listSessions()).some((item) => item.id === later));
  assert.deepEqual((await readdir(h.root)).sort(), ["broker", "session-state"]);
  assert.deepEqual(await readdir(join(h.brokerDirectory, "requests")), []);
});

test("v2 App preview backtracks behind tool tails, caches unchanged files and publishes only two proven root dialogue excerpts", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  await saved(h, id, "Preview root");
  const path = join(h.sessionStateDirectory, id, "events.jsonl");
  const origin = randomUUID();
  const rows = [
    { id: "visible-user", type: "user.message", timestamp: "2026-11-16T00:00:00Z", data: { messageId: origin, content: "Visible original request 🚀" } },
    { id: "summary-request", type: "assistant.message", timestamp: "2026-11-16T00:00:01Z",
      data: { originatingMessageId: origin, turnId: "root", interactionId: "scope", toolRequests: [
        { name: "task_complete", toolCallId: "finish", arguments: { summary: "Strictly verified final output" } },
      ] } },
    { id: "summary-start", parentId: "summary-request", type: "tool.execution_start",
      data: { toolCallId: "finish", toolName: "task_complete", turnId: "root", arguments: { summary: "Strictly verified final output" } } },
    { id: "summary-complete", type: "tool.execution_complete", timestamp: "2026-11-16T00:00:02Z",
      data: { toolCallId: "finish", turnId: "root", interactionId: "scope", success: true, result: { content: "Strictly verified final output" } } },
    { id: "child", type: "assistant.message", agentId: "child", timestamp: "2026-11-16T00:00:03Z", data: { content: "PRIVATE_CHILD" } },
    { id: "hidden", type: "assistant.message", timestamp: "2026-11-16T00:00:04Z", data: { content: "PRIVATE_ANALYSIS", phase: "analysis" } },
    { id: "injected", type: "user.message", timestamp: "2026-11-16T00:00:05Z", data: { content: "PRIVATE_INJECTED", source: "agent-fixture" } },
  ];
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n" +
    JSON.stringify({ id: "large-tool", type: "tool.execution_complete", data: { result: { content: "x".repeat(2_600_000) } } }) + "\n");
  const reads = t.mock.method(fs, "createReadStream");
  syncBuiltinESMExports();
  t.after(() => { reads.mock.restore(); syncBuiltinESMExports(); });
  const preview = await h.client.readPreview(id);
  assert.deepEqual(preview.map((turn) => [turn.role ?? "assistant", turn.assistantResponse]), [
    ["user", "Visible original request 🚀"], ["assistant", "Strictly verified final output"],
  ]);
  const count = reads.mock.callCount();
  assert.ok(count > 1, "an arbitrary tail cutoff cannot erase the actual dialogue");
  assert.deepEqual(await h.client.readPreview(id), preview);
  assert.equal(reads.mock.callCount(), count, "unchanged previews must use the file identity cache");
  await appendFile(path, JSON.stringify({
    id: "new-commentary", type: "assistant.message", timestamp: "2026-11-16T00:01:00Z", data: { content: "New visible commentary", phase: "commentary" },
  }) + "\n");
  const updated = await h.client.readPreview(id);
  assert.deepEqual(updated.map((turn) => turn.assistantResponse), ["Strictly verified final output", "New visible commentary"]);
  assert.ok(reads.mock.callCount() > count);
  assert.ok(!JSON.stringify(updated).includes("PRIVATE_"));
});
test("conversation recency uses only visible root dialogue, caches unchanged journals and never uses heartbeat or metadata maintenance time", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  await saved(h, id, "Recent conversation");
  await register(h, id);
  const path = join(h.sessionStateDirectory, id, "events.jsonl");
  const lines = [
    { id: "real-user", type: "user.message", timestamp: "2026-11-14T06:00:00Z",
      data: { content: "Visible user instruction", parentAgentTaskId: randomUUID(), isAutopilotContinuation: false } },
    { id: "real-answer", type: "assistant.message", timestamp: "2026-11-14T06:00:03Z", data: { content: "Visible answer" } },
    { id: "hidden", type: "assistant.message", timestamp: "2026-11-14T09:00:00Z", data: { phase: "analysis", content: "Hidden" } },
    { id: "child", type: "assistant.message", agentId: "child", timestamp: "2026-11-14T10:00:00Z", data: { content: "Child" } },
    { id: "injected", type: "user.message", timestamp: "2026-11-14T11:00:00Z",
      data: { source: "agent-fixture", content: "Agent injection" } },
    { id: "maintenance", type: "session.resume", timestamp: "2026-11-14T12:00:00Z", data: {} },
  ];
  await writeFile(path, lines.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const reads = t.mock.method(fs, "createReadStream");
  syncBuiltinESMExports();
  t.after(() => { reads.mock.restore(); syncBuiltinESMExports(); });
  const first = (await h.client.listSessions())[0]!;
  assert.equal(first.lastConversationAt, "2026-11-14T06:00:03Z");
  assert.equal(reads.mock.callCount(), 1);
  await register(h, id, { heartbeatAt: new Date().toISOString(), status: "busy" });
  await writeFile(join(h.sessionStateDirectory, id, "workspace.yaml"),
    "name: Metadata touched\ncwd: C:\\fixture\nupdated_at: 2999-01-01T00:00:00Z\n");
  const second = (await h.client.listSessions())[0]!;
  assert.equal(second.status, "busy");
  assert.equal(second.lastConversationAt, first.lastConversationAt);
  assert.equal(reads.mock.callCount(), 1, "heartbeat/metadata changes must not scan the same journal again");
  await appendFile(path, JSON.stringify({
    id: "new-user", type: "user.message", timestamp: "2026-11-14T07:00:00Z", data: { content: "A newer user message" },
  }) + "\n");
  assert.equal((await h.client.listSessions())[0]?.lastConversationAt, "2026-11-14T07:00:00Z");
  assert.equal(reads.mock.callCount(), 2);
  await h.client.listSessions();
  assert.equal(reads.mock.callCount(), 2);
  const before = await stat(path);
  const replacement = join(h.sessionStateDirectory, id, "events-replacement.tmp");
  await writeFile(replacement, (await readFile(path, "utf8")).replace("2026-11-14T07:00:00Z", "2026-11-14T08:00:00Z"));
  await utimes(replacement, before.atime, before.mtime);
  await rename(replacement, path);
  assert.equal((await h.client.listSessions())[0]?.lastConversationAt, "2026-11-14T08:00:00Z");
  assert.equal(reads.mock.callCount(), 3, "replacing a same-size journal must invalidate its file-identity cache");
});

test("activity discovery finds real dialogue behind multiple tool-output windows and caches the result instead of inventing unknown recency", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  await saved(h, id, "Long maintenance tail");
  const path = join(h.sessionStateDirectory, id, "events.jsonl");
  await appendFile(path, JSON.stringify({
    id: "real-dialogue-before-tools", type: "assistant.message", timestamp: "2026-11-14T06:35:10.385Z",
    data: { messageId: "real-dialogue-before-tools", phase: "final_answer", content: "Visible root reply before large tool output." },
  }) + "\n");
  const maintenance = JSON.stringify({
    id: "tool-output", type: "tool.execution_progress", timestamp: "2026-11-14T09:00:00Z", data: { output: "x".repeat(2000) },
  }) + "\n";
  await appendFile(path, maintenance.repeat(1800));
  const reads = t.mock.method(fs, "createReadStream");
  syncBuiltinESMExports();
  t.after(() => { reads.mock.restore(); syncBuiltinESMExports(); });
  assert.equal((await h.client.listSessions())[0]?.lastConversationAt, "2026-11-14T06:35:10.385Z",
    "valid dialogue beyond the first tail window must remain discoverable");
  const scans = reads.mock.callCount();
  assert.ok(scans > 1, "discovery must backtrack rather than silently stop at its initial window");
  await h.client.listSessions();
  assert.equal(reads.mock.callCount(), scans, "unchanged deep journals must not be rescanned");
  await appendFile(path, JSON.stringify({
    id: "visible-tail", type: "assistant.message", timestamp: "2026-11-14T07:00:00Z", data: { content: "A real tail answer" },
  }) + "\n");
  assert.equal((await h.client.listSessions())[0]?.lastConversationAt, "2026-11-14T07:00:00Z");
  assert.equal(reads.mock.callCount(), scans + 1, "a recent visible tail should not require rescanning old history");
  assert.equal((await h.client.readSession(id))[0]?.index, 0, "backtracking discovery must not renumber full-history indices");
});

test("backtracking retains strict task_complete evidence even when its request and completion span separate windows", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  await saved(h, id, "Buried completion", false);
  const path = join(h.sessionStateDirectory, id, "events.jsonl");
  const summary = "Confirmed root summary before a large tool tail 🚀";
  const originatingMessageId = randomUUID();
  const progress = JSON.stringify({
    id: "progress", type: "tool.execution_progress", timestamp: "2026-11-14T09:00:00Z", data: { output: "x".repeat(2000) },
  }) + "\n";
  await writeFile(path, JSON.stringify({
    id: "root-request", type: "assistant.message", timestamp: "2026-11-14T06:35:00Z",
    data: { turnId: "root-turn", interactionId: "root-interaction", originatingMessageId,
      toolRequests: [{ name: "task_complete", toolCallId: "root-call", arguments: { summary } }] },
  }) + "\n" + progress.repeat(700) + [
    { id: "root-start", parentId: "root-request", type: "tool.execution_start",
      data: { toolCallId: "root-call", toolName: "task_complete", turnId: "root-turn", arguments: { summary } } },
    { id: "root-complete", type: "tool.execution_complete", timestamp: "2026-11-14T06:35:10.385Z",
      data: { toolCallId: "root-call", turnId: "root-turn", interactionId: "root-interaction", success: true,
        result: { content: summary } } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n" + progress.repeat(1800));
  assert.equal((await h.client.listSessions())[0]?.lastConversationAt, "2026-11-14T06:35:10.385Z");
  const snapshot = await h.client.readSessionState(id);
  assert.deepEqual(snapshot.turns, [{
    index: 702, assistantResponse: summary, timestamp: "2026-11-14T06:35:10.385Z", originatingMessageId,
  }]);
  assert.deepEqual(snapshot.completions, [{ index: 702, originatingMessageId }]);
});

test("a visible user in the first window cannot hide a newer task completion whose request is further back", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  await saved(h, id, "Newer correlated completion", false);
  const path = join(h.sessionStateDirectory, id, "events.jsonl");
  const summary = "A later verified summary";
  const progress = JSON.stringify({ type: "tool.execution_progress", data: { output: "x".repeat(2000) } }) + "\n";
  await writeFile(path, JSON.stringify({
    id: "request", type: "assistant.message", timestamp: "2026-11-14T06:35:00Z",
    data: { turnId: "turn", interactionId: "interaction", toolRequests: [
      { toolCallId: "call", name: "task_complete", arguments: { summary } },
    ] },
  }) + "\n" + progress.repeat(1400) + [
    { type: "tool.execution_start", parentId: "request",
      data: { toolCallId: "call", toolName: "task_complete", turnId: "turn", arguments: { summary } } },
    { type: "user.message", timestamp: "2026-11-14T06:35:05Z", data: { content: "Visible steering text" } },
    { type: "tool.execution_complete", timestamp: "2026-11-14T06:35:10.385Z",
      data: { toolCallId: "call", turnId: "turn", interactionId: "interaction", success: true, result: { content: summary } } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  assert.equal((await h.client.listSessions())[0]?.lastConversationAt, "2026-11-14T06:35:10.385Z");
});

test("unknown recency requires reaching the actual beginning without visible dialogue and is cached without filesystem-time fallback", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  await saved(h, id, "No visible dialogue", false);
  const path = join(h.sessionStateDirectory, id, "events.jsonl");
  const hidden = JSON.stringify({
    id: "hidden", type: "assistant.message", timestamp: "2026-11-14T09:00:00Z",
    data: { phase: "analysis", content: "x".repeat(2000) },
  }) + "\n";
  await writeFile(path, hidden.repeat(1800));
  const reads = t.mock.method(fs, "createReadStream");
  syncBuiltinESMExports();
  t.after(() => { reads.mock.restore(); syncBuiltinESMExports(); });
  assert.equal((await h.client.listSessions())[0]?.lastConversationAt, undefined);
  const calls = reads.mock.calls;
  assert.ok(calls.length > 1);
  assert.ok(calls.some((call) => object(call.arguments[1]) && call.arguments[1].start === 0),
    "unknown must mean that even the oldest segment has no trustworthy dialogue");
  await h.client.listSessions();
  assert.equal(reads.mock.callCount(), calls.length, "an unchanged no-dialogue journal should also use the cache");
});

test("oversized tool records and split Unicode do not hide earlier visible dialogue or renumber physical history", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  await saved(h, id, "Oversized maintenance");
  const path = join(h.sessionStateDirectory, id, "events.jsonl");
  await appendFile(path, JSON.stringify({
    id: "oversized-tool", type: "tool.execution_progress", timestamp: "2026-11-14T09:00:00Z",
    data: { output: "x".repeat(5 * 1024 * 1024) },
  }) + "\r\n");
  assert.equal((await h.client.listSessions())[0]?.lastConversationAt, "2026-11-11T13:00:00.000Z");
  const content = "A large visible Unicode reply 🚀 ".repeat(2500);
  await appendFile(path, JSON.stringify({
    id: "unicode-answer", type: "assistant.message", timestamp: "2026-11-14T06:35:10.385Z", data: { content },
  }));
  assert.equal((await h.client.listSessions())[0]?.lastConversationAt, "2026-11-14T06:35:10.385Z");
  const snapshot = await h.client.readSessionState(id);
  assert.equal(snapshot.turns.at(-1)?.index, 3);
  assert.ok(snapshot.turns.at(-1)?.assistantResponse.startsWith("A large visible Unicode reply 🚀 "));
});

test("round3 R4 coverage: unfinished EOF does not count, complete no-newline JSON does, and terminated damaged or oversized rows keep their indices", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  const messageId = randomUUID();
  await saved(h, id, "EOF record coverage", false);
  const path = join(h.sessionStateDirectory, id, "events.jsonl");
  const final = JSON.stringify({
    id: "complete-eof", type: "assistant.message", timestamp: "2026-11-15T09:00:01Z",
    data: { originatingMessageId: messageId, content: "A complete final without a newline 🚀" },
  });
  const split = Math.floor(final.length / 2);
  await writeFile(path, "damaged terminated JSON\r\n" + "x".repeat(4 * 1024 * 1024 + 64) + "\r\n" +
    JSON.stringify({
      id: "root-user", type: "user.message", timestamp: "2026-11-15T09:00:00Z",
      data: { messageId, content: "Visible root user" },
    }) + "\r\n" + final.slice(0, split));
  const partial = await h.client.readSessionState(id, [messageId]);
  assert.equal(partial.throughIndex, 2, "malformed unterminated EOF must remain available for the next append/poll");
  assert.deepEqual(partial.consumed, [{ index: 2, messageId }]);
  assert.deepEqual(partial.turns, []);
  await appendFile(path, final.slice(split));
  const complete = await h.client.readSessionState(id, [messageId]);
  assert.equal(complete.throughIndex, 3);
  assert.equal(complete.turns[0]?.index, 3);
  assert.equal(complete.turns[0]?.assistantResponse, "A complete final without a newline 🚀");
  await appendFile(path, "\r");
  assert.deepEqual(await h.client.readSessionState(id, [messageId]), complete,
    "a complete JSON record followed by the first CR of CRLF is already covered");
  await appendFile(path, "\n");
  assert.deepEqual(await h.client.readSessionState(id, [messageId]), complete,
    "finishing CRLF must not create an extra physical record");
  await appendFile(path, '{"unfinished":');
  assert.equal((await h.client.readSessionState(id, [messageId])).throughIndex, 3);
  await appendFile(path, "\r\n");
  assert.equal((await h.client.readSessionState(id, [messageId])).throughIndex, 4,
    "a damaged but terminated record can be skipped without hiding later indices");
});

test("local App history accepts only a correlated successful root task_complete summary", async (t) => {
  const h = await fixture(t);
  const existing = randomUUID();
  const originatingMessageId = randomUUID();
  const sessionDirectory = join(h.sessionStateDirectory, existing);
  await mkdir(sessionDirectory);
  await writeFile(join(sessionDirectory, "events.jsonl"), [
    JSON.stringify({
      id: "visible-final", type: "assistant.message", timestamp: "2026-11-11T12:59:59.000Z",
      data: {
        turnId: "turn-1", interactionId: "interaction-1", messageId: "visible-message", originatingMessageId,
        content: "Completed safely.",
      },
    }),
    JSON.stringify({
      id: "request-message", type: "assistant.message", timestamp: "2026-11-11T13:00:00.000Z",
      data: {
        turnId: "turn-1", interactionId: "interaction-1", content: "", originatingMessageId,
        toolRequests: [{
          name: "task_complete", toolCallId: "call-1", arguments: { summary: "Completed safely." },
        }],
      },
    }),
    JSON.stringify({
      id: "start", parentId: "request-message", type: "tool.execution_start",
      timestamp: "2026-11-11T13:00:01.000Z",
      data: {
        toolName: "task_complete", toolCallId: "call-1", turnId: "turn-1",
        arguments: { summary: "Completed safely." },
      },
    }),
    JSON.stringify({
      id: "complete", type: "tool.execution_complete", timestamp: "2026-11-11T13:00:02.000Z",
      data: {
        toolCallId: "call-1", turnId: "turn-1", interactionId: "interaction-1", success: true,
        result: { content: "Completed safely." },
      },
    }),
    JSON.stringify({
      id: "turn-end", type: "assistant.turn_end", timestamp: "2026-11-11T13:00:03.000Z",
      data: { turnId: "turn-1" },
    }),
  ].join("\n"));
  assert.deepEqual(await h.client.readSessionState(existing), {
    turns: [{
      index: 0, assistantResponse: "Completed safely.", timestamp: "2026-11-11T12:59:59.000Z", originatingMessageId,
    }],
    completedThrough: 4,
    completions: [{ index: 3, originatingMessageId }],
    consumed: [{ index: 0, messageId: originatingMessageId }],
    throughIndex: 4,
  });
});

test("ordinary turn completion requires its own start/interaction origin scope, never just a reused turn number", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  const oldOrigin = randomUUID();
  const currentOrigin = randomUUID();
  await saved(h, id, "Repeated turn number");
  await writeFile(join(h.sessionStateDirectory, id, "events.jsonl"), [
    { id: "old-start", type: "assistant.turn_start", data: { turnId: "0", interactionId: "old-interaction" } },
    { id: "old-answer", type: "assistant.message", timestamp: "2026-11-14T05:00:00Z",
      data: { turnId: "0", interactionId: "old-interaction", originatingMessageId: oldOrigin, content: "Old answer" } },
    { id: "old-end", type: "assistant.turn_end", data: { turnId: "0" } },
    { id: "unattributed-start", type: "assistant.turn_start", data: { turnId: "0", interactionId: "new-interaction" } },
    { id: "unattributed-answer", type: "assistant.message", timestamp: "2026-11-14T05:01:00Z",
      data: { turnId: "0", interactionId: "new-interaction", content: "Unattributed answer" } },
    { id: "unattributed-end", type: "assistant.turn_end", data: { turnId: "0" } },
    { id: "current-start", type: "assistant.turn_start", data: { turnId: "0", interactionId: "current-interaction" } },
    { id: "current-answer", type: "assistant.message", timestamp: "2026-11-14T05:02:00Z",
      data: { turnId: "0", interactionId: "current-interaction", originatingMessageId: currentOrigin, content: "Current answer" } },
    { id: "mismatched-end", type: "assistant.turn_end", data: { turnId: "0", interactionId: "old-interaction" } },
    { id: "confirmed-start", type: "assistant.turn_start", data: { turnId: "0", interactionId: "confirmed-interaction" } },
    { id: "confirmed-answer", type: "assistant.message", timestamp: "2026-11-14T05:03:00Z",
      data: { turnId: "0", interactionId: "confirmed-interaction", originatingMessageId: currentOrigin, content: "Confirmed answer" } },
    { id: "child-end", type: "assistant.turn_end", agentId: "child", data: { turnId: "0" } },
    { id: "confirmed-end", type: "assistant.turn_end", data: { turnId: "0" } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const snapshot = await h.client.readSessionState(id);
  assert.deepEqual(snapshot.completions, [
    { index: 2, originatingMessageId: oldOrigin },
    { index: 12, originatingMessageId: currentOrigin },
  ]);
  assert.deepEqual(snapshot.turns.map((turn) => turn.index), [1, 4, 7, 10]);
  assert.equal(snapshot.turns[1]?.originatingMessageId, undefined);
  assert.deepEqual(await h.client.readSessionState(id), snapshot);
});

test("live App endpoint sends unchanged text once and returns the original owner's message ID with no coordinator queue", async (t) => {
  const h = await fixture(t);
  const existing = randomUUID();
  await saved(h, existing, "Direct App work");
  await register(h, existing);
  const prompt = "  Exact\tmessage\u00a0\r\n🚀 <b>unchanged</b>  ";
  const send = h.client.sendMessage(existing, prompt);
  const request = await completeAppSend(h.brokerDirectory, existing, {
    accepted: true,
    messageId: "direct-message-id",
    route: "session-extension",
  });
  assert.equal(await send, "direct-message-id");
  assert.equal(request.operation, "send_message");
  assert.ok(object(request.payload));
  assert.equal(request.payload.message, prompt);
  assert.equal((await readdir(join(h.brokerDirectory, "processing", existing))).length, 1);
  assert.deepEqual(await readdir(join(h.brokerDirectory, "requests", existing)), []);
  assert.deepEqual((await readdir(h.root)).sort(), ["broker", "session-state"]);
});

test("missing local profile/broker is read-only and later saved sessions are discovered without restarting or creating directories", async (t) => {
  const root = await temporary(t);
  const profile = join(root, "not-installed");
  const broker = join(root, "no-endpoints");
  const client = new LocalAppSessions({ timeoutMs: 100, sessionStateDirectory: profile, brokerDirectory: broker });
  await client.start();
  try {
    assert.deepEqual(await client.listSessions(), []);
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(() => client.sendMessage(randomUUID(), "not routed"), /APP_ENDPOINT_UNAVAILABLE/);
    const id = randomUUID();
    await mkdir(join(profile, id), { recursive: true });
    await writeFile(join(profile, id, "workspace.yaml"), "name: 'Saved ''quoted'' title'\ncwd: C:\\repo\n");
    const list = await client.listSessions();
    assert.equal(list[0]?.name, "Saved 'quoted' title");
    assert.equal(list[0]?.direct, false);
    assert.equal(list[0]?.readable, false);
  } finally { await client.close(); }
});

test("stale, invalid, future-dated or dead-process endpoint registrations cannot make saved sessions writable or route a send", async (t) => {
  const h = await fixture(t);
  const patches = [
    { heartbeatAt: "2020-01-01T00:00:00Z" }, { heartbeatAt: "2999-01-01T00:00:00Z" },
    { sessionId: randomUUID() }, { pid: 0 }, { pid: 2_000_000_001 },
  ];
  const originalKill = process.kill;
  t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === 2_000_000_001) throw Object.assign(new Error("Fixture process exited"), { code: "ESRCH" });
    return originalKill(pid, signal);
  });
  for (const patch of patches) {
    const id = randomUUID();
    await saved(h, id, "Read only");
    await register(h, id, patch);
    assert.equal((await h.client.listSessions()).find((item) => item.id === id)?.direct, false);
    assert.equal((await h.client.liveness()).some((endpoint) => endpoint.id === id), false);
    await assert.rejects(() => h.client.sendMessage(id, "not admitted"), /APP_ENDPOINT_UNAVAILABLE/);
  }
  assert.deepEqual(await readdir(join(h.brokerDirectory, "requests")), []);
});

test("endpoint rejection, unconfirmed admission and timeout never replay through another endpoint or a coordinator", async (t) => {
  for (const mode of ["timeout", "wrong-id", "missing-id", "rejected", "send-failed"] as const) {
    const h = await fixture(t, 150);
    const id = randomUUID();
    await register(h, id);
    const expected = mode === "rejected" ? /APP_ENDPOINT_REJECTED/ : /APP_ADMISSION_UNCERTAIN/;
    const send = assert.rejects(() => h.client.sendMessage(id, "admit at most once"), expected);
    if (mode !== "timeout") {
      await completeAppSend(h.brokerDirectory, id, mode === "missing-id" ? { accepted: true }
        : { accepted: true, messageId: "original-message" }, {
        ...(mode === "wrong-id" ? { id: randomUUID() } : {}),
        ...(mode === "rejected" || mode === "send-failed" ? {
          ok: false, error: { code: mode === "rejected" ? "INVALID_REQUEST" : "SESSION_SEND_FAILED" },
        } : {}),
      });
    }
    await send;
    assert.deepEqual((await readdir(h.root)).sort(), ["broker", "session-state"]);
    assert.equal((await readdir(join(h.brokerDirectory, mode === "timeout" ? "requests" : "processing", id))).length, 1);
  }
});

test("local history preserves physical indices and timestamps, excludes hidden/child/failed tool content, and keeps a stable sliding window", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  await saved(h, id, "Safe history");
  const path = join(h.sessionStateDirectory, id, "events.jsonl");
  const events: unknown[] = [
    { type: "assistant.message", id: "request", timestamp: "2026-11-11T13:00:00Z",
      data: { turnId: "root", interactionId: "root-interaction", toolRequests: [
        { name: "task_complete", toolCallId: "root-call", arguments: { summary: "Confirmed root summary" } },
      ] } },
    { type: "tool.execution_start", id: "start", parentId: "request",
      data: { toolCallId: "root-call", toolName: "task_complete", turnId: "root", arguments: { summary: "Confirmed root summary" } } },
    { type: "tool.execution_complete", id: "complete", timestamp: "2026-11-11T13:00:03Z",
      data: { toolCallId: "root-call", turnId: "root", interactionId: "root-interaction", success: true,
        result: { content: "Confirmed root summary" } } },
    { type: "assistant.message", id: "hidden", timestamp: "2026-11-11T13:00:04Z", data: { phase: "analysis", content: "HIDDEN_REASONING" } },
    { type: "assistant.message", id: "child", agentId: "child-agent", timestamp: "2026-11-11T13:00:05Z",
      data: { content: "CHILD_TEXT" } },
    { type: "tool.execution_complete", id: "arbitrary", timestamp: "2026-11-11T13:00:06Z",
      data: { success: true, result: { content: "ARBITRARY_OUTPUT" } } },
    { type: "assistant.turn_end", id: "child-end", agentId: "child-agent", data: {} },
    { type: "assistant.message", id: "bad-request", data: { turnId: "bad", interactionId: "bad-interaction", toolRequests: [
      { name: "task_complete", toolCallId: "bad-call", arguments: { summary: "BAD_PARENT" } },
    ] } },
    { type: "tool.execution_start", id: "bad-start", parentId: "not-the-request",
      data: { toolCallId: "bad-call", toolName: "task_complete", turnId: "bad", arguments: { summary: "BAD_PARENT" } } },
    { type: "tool.execution_complete", id: "bad-complete", timestamp: "2026-11-11T13:00:07Z",
      data: { toolCallId: "bad-call", turnId: "bad", interactionId: "bad-interaction", success: true, result: { content: "BAD_PARENT" } } },
    { type: "assistant.message", id: "failed-request", data: { turnId: "failed", interactionId: "failed-interaction", toolRequests: [
      { name: "task_complete", toolCallId: "failed-call", arguments: { summary: "FAILED_ROOT" } },
    ] } },
    { type: "tool.execution_start", id: "failed-start", parentId: "failed-request",
      data: { toolCallId: "failed-call", toolName: "task_complete", turnId: "failed", arguments: { summary: "FAILED_ROOT" } } },
    { type: "tool.execution_complete", id: "failed-complete", timestamp: "2026-11-11T13:00:08Z",
      data: { toolCallId: "failed-call", turnId: "failed", interactionId: "failed-interaction", success: false, result: { content: "FAILED_ROOT" } } },
  ];
  await writeFile(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const initial = await h.client.readSessionState(id);
  assert.deepEqual(initial, {
    turns: [{ index: 2, assistantResponse: "Confirmed root summary", timestamp: "2026-11-11T13:00:03Z" }],
    completedThrough: 2,
    completions: [],
    consumed: [], throughIndex: events.length - 1,
  });
  assert.deepEqual(await h.client.readSessionState(id), initial);
  const additional = Array.from({ length: 55 }, (_, index) => ({
    id: `visible-${index}`, type: "assistant.message", timestamp: new Date(Date.UTC(2026, 10, 11, 14, 0, index)).toISOString(),
    data: { content: `Visible ${index}`, turnId: `turn-${index}`, interactionId: `interaction-${index}` },
  }));
  await appendFile(path, additional.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const window = await h.client.readSession(id);
  assert.equal(window.length, 50);
  assert.equal(window[0]?.index, events.length + 5);
  assert.deepEqual(await h.client.readSession(id), window);
  await appendFile(path, JSON.stringify({
    id: "later", type: "assistant.message", timestamp: "2026-11-11T15:00:00Z", data: { content: "One later row" },
  }) + "\n");
  assert.deepEqual((await h.client.readSession(id)).slice(0, -1), window.slice(1));
});

test("visible commentary never consumes a same-text final or completion summary", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  await saved(h, id, "Phases");
  await writeFile(join(h.sessionStateDirectory, id, "events.jsonl"), [
    { id: "progress", type: "assistant.message", timestamp: "2026-11-11T13:00:00Z",
      data: { turnId: "turn", interactionId: "interaction", phase: "commentary", content: "Same visible text" } },
    { id: "answer", type: "assistant.message", timestamp: "2026-11-11T13:00:01Z",
      data: { turnId: "turn", interactionId: "interaction", phase: "final_answer", content: "Same visible text" } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  assert.deepEqual(await h.client.readSession(id), [
    { index: 0, timestamp: "2026-11-11T13:00:00Z", assistantResponse: "Same visible text", phase: "commentary" },
    { index: 1, timestamp: "2026-11-11T13:00:01Z", assistantResponse: "Same visible text" },
  ]);
});

test("conversation loading retains root user messages with parent-task metadata while filtering actual injections", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  await saved(h, id, "Two-way history");
  await writeFile(join(h.sessionStateDirectory, id, "events.jsonl"), [
    { id: "human", type: "user.message", timestamp: "2026-11-11T13:00:00Z",
      data: { content: "Displayed user question", transformedContent: "INTERNAL_MODEL_PROMPT",
        parentAgentTaskId: randomUUID(), isAutopilotContinuation: false } },
    { id: "system", type: "system.message", data: { content: "SYSTEM_PROMPT" } },
    { id: "child-user", type: "user.message", agentId: "child", timestamp: "2026-11-11T13:00:01Z", data: { content: "CHILD_PROMPT" } },
    { id: "agent-injection", type: "user.message", timestamp: "2026-11-11T13:00:02Z",
      data: { source: "agent-fixture", content: "AGENT_INTERNAL" } },
    { id: "skill-injection", type: "user.message", timestamp: "2026-11-11T13:00:02Z",
      data: { source: "skill-fixture", content: "SKILL_INTERNAL" } },
    { id: "continuation", type: "user.message", timestamp: "2026-11-11T13:00:02Z",
      data: { isAutopilotContinuation: true, parentAgentTaskId: randomUUID(), content: "AUTOPILOT_INTERNAL" } },
    { id: "child-tool-user", type: "user.message", timestamp: "2026-11-11T13:00:02Z",
      data: { parentToolCallId: "child-tool", content: "CHILD_TOOL_INTERNAL" } },
    { id: "assistant", type: "assistant.message", timestamp: "2026-11-11T13:00:03Z", data: { content: "Visible assistant response" } },
    { id: "end", type: "assistant.turn_end", data: {} },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  assert.deepEqual(await h.client.readSessionState(id), {
    turns: [
      { index: 0, assistantResponse: "Displayed user question", timestamp: "2026-11-11T13:00:00Z", role: "user" },
      { index: 7, assistantResponse: "Visible assistant response", timestamp: "2026-11-11T13:00:03Z" },
    ],
    completedThrough: 8,
    completions: [],
    consumed: [], throughIndex: 8,
  });
});

test("admission reconciliation retains exact root consumption and originated results outside the ordinary recent-history window", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  const messageId = randomUUID();
  await saved(h, id, "Targeted read");
  const path = join(h.sessionStateDirectory, id, "events.jsonl");
  const interactionId = randomUUID();
  const rows = [
    { id: "target-user", type: "user.message", timestamp: "2026-11-15T09:00:00Z",
      data: { messageId, content: "Own root instruction", parentAgentTaskId: randomUUID(), isAutopilotContinuation: false } },
    { id: "target-start", type: "assistant.turn_start", data: { turnId: "0", interactionId } },
    { id: "target-answer", type: "assistant.message", timestamp: "2026-11-15T09:00:01Z",
      data: { turnId: "0", interactionId, originatingMessageId: messageId, content: "Own root answer" } },
    { id: "target-end", type: "assistant.turn_end", data: { turnId: "0" } },
    ...Array.from({ length: 60 }, (_, index) => ({
      id: `other-${index}`, type: "assistant.message", timestamp: "2026-11-15T10:00:00Z",
      data: { originatingMessageId: `other-message-${index}`, content: `Other answer ${index}` },
    })),
  ];
  await writeFile(path, rows.map((event) => JSON.stringify(event)).join("\n") + "\n");
  assert.ok(!(await h.client.readSession(id)).some((turn) => turn.assistantResponse === "Own root answer"));
  const snapshot = await h.client.readSessionState(id, [messageId]);
  assert.deepEqual(snapshot.consumed, [{ index: 0, messageId }]);
  assert.deepEqual(snapshot.turns, [{
    index: 2, assistantResponse: "Own root answer", timestamp: "2026-11-15T09:00:01Z", originatingMessageId: messageId,
  }]);
  assert.deepEqual(snapshot.completions, [{ index: 3, originatingMessageId: messageId }]);
  assert.equal(snapshot.throughIndex, 63);
});

for (const mode of ["rows", "bytes"] as const) {
  test(`round2 R2 ${mode}: another admission's commentary cannot evict a targeted final`, async (t) => {
    const h = await fixture(t);
    const id = randomUUID();
    const a = randomUUID();
    const b = randomUUID();
    await saved(h, id, "Isolated targeted budgets", false);
    const summary = "A verified final must survive B progress 🚀";
    const progress = mode === "rows" ? "Short commentary" : "测🚀".repeat(3500);
    const count = mode === "rows" ? 60 : 12;
    await writeFile(join(h.sessionStateDirectory, id, "events.jsonl"), [
      { id: "a-request", type: "assistant.message", timestamp: "2026-11-15T09:00:00Z",
        data: { originatingMessageId: a, turnId: "0", interactionId: "a-interaction", toolRequests: [
          { toolCallId: "a-call", name: "task_complete", arguments: { summary } },
        ] } },
      { id: "a-start", parentId: "a-request", type: "tool.execution_start",
        data: { toolCallId: "a-call", toolName: "task_complete", turnId: "0", arguments: { summary } } },
      { id: "a-complete", type: "tool.execution_complete", timestamp: "2026-11-15T09:00:01Z",
        data: { toolCallId: "a-call", turnId: "0", interactionId: "a-interaction", success: true, result: { content: summary } } },
      ...Array.from({ length: count }, (_, index) => ({
        id: `b-comment-${index}`, type: "assistant.message", timestamp: "2026-11-15T10:00:00Z",
        data: { originatingMessageId: b, phase: "commentary", turnId: String(index),
          interactionId: `b-interaction-${index}`, content: `${progress} ${index}` },
      })),
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    const targeted = await h.client.readSessionState(id, [a, b]);
    assert.ok(targeted.turns.some((turn) => turn.index === 2 && turn.originatingMessageId === a && turn.assistantResponse === summary),
      `${mode} pressure from B must not delete A's trusted final`);
    assert.deepEqual(targeted.completions, [{ index: 2, originatingMessageId: a }]);
    assert.ok(!targeted.turns.some((turn) => turn.originatingMessageId === b && turn.phase !== "commentary"));
    assert.ok(targeted.turns.length <= 50, "targeted results must remain explicitly row-bounded");
    assert.ok(Buffer.byteLength(JSON.stringify(targeted), "utf8") <= 120_000, "targeted results must remain byte-bounded");
    const history = await h.client.readSession(id);
    assert.ok(history.length <= 50, "ordinary history keeps its shared recent-history budget");
    assert.ok(!history.some((turn) => turn.assistantResponse === summary),
      "this fixture must also exercise the historical shared window eviction");
  });
}

test("round2 R2 bounds: a targeted read reserves all 32 bounded finals, drops competing progress and leaves ordinary history budget unchanged", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  const messageIds = Array.from({ length: 32 }, () => randomUUID());
  await saved(h, id, "Maximum targeted final slots", false);
  const final = "🚀".repeat(7990);
  const rows = [
    ...messageIds.map((originatingMessageId, index) => ({
      id: `final-${index}`, type: "assistant.message", timestamp: "2026-11-15T09:00:00Z",
      data: { originatingMessageId, messageId: `final-${index}`, content: `${final} ${index}` },
    })),
    ...Array.from({ length: 55 }, (_, index) => ({
      id: `progress-${index}`, type: "assistant.message", timestamp: "2026-11-15T09:00:01Z",
      data: { originatingMessageId: messageIds.at(-1)!, phase: "commentary", content: `${final} progress ${index}` },
    })),
  ];
  await writeFile(join(h.sessionStateDirectory, id, "events.jsonl"), rows.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const targeted = await h.client.readSessionState(id, messageIds);
  assert.equal(targeted.turns.length, 32);
  for (const [index, origin] of messageIds.entries()) {
    assert.ok(targeted.turns.some((turn) => turn.index === index &&
      turn.originatingMessageId === origin && turn.assistantResponse === `${final} ${index}`));
  }
  assert.ok(!targeted.turns.some((turn) => turn.phase === "commentary"));
  assert.ok(Buffer.byteLength(JSON.stringify(targeted), "utf8") <= 32 * (8000 * 4 + 4096));
  const history = await h.client.readSessionState(id);
  assert.ok(history.turns.length <= 50);
  assert.ok(Buffer.byteLength(JSON.stringify(history), "utf8") <= 120_000);
  await assert.rejects(() => h.client.readSessionState(id, [...messageIds, randomUUID()]), /at most 32/);
});

test("the selected UUID cannot redirect its root journal through a different session directory", async (t) => {
  const h = await fixture(t);
  const id = randomUUID();
  const alias = randomUUID();
  await saved(h, id, "Real session");
  await symlink(join(h.sessionStateDirectory, id), join(h.sessionStateDirectory, alias), "junction");
  assert.equal((await h.client.listSessions()).some((item) => item.id === alias), false);
  await assert.rejects(() => h.client.readSession(alias), /APP_PATH_IDENTITY_MISMATCH/);
});
