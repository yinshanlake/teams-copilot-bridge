import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { type ReadStream } from "node:fs";
import { appendFile, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appJournalEvent, journalBaseline, journalPage } from "../src/journal-observer.js";
import { digest, object } from "../src/safety.js";
import { Store } from "../src/store.js";
import { temporary } from "./helpers.js";

function boundedReads(t: TestContext): ReadStream[] {
  const streams: ReadStream[] = [];
  const create = fs.createReadStream;
  const mock = t.mock.method(fs, "createReadStream", (...args: Parameters<typeof create>) => {
    const stream = create(...args);
    streams.push(stream);
    return stream;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  return streams;
}

function start(id: string): string {
  return JSON.stringify({ id: "session", type: "session.start", data: { sessionId: id } }) + "\r\n";
}

function final(content: string): string {
  return JSON.stringify({ id: "root-final", type: "assistant.message", timestamp: "2026-11-16T10:00:00Z",
    data: { originatingMessageId: "root-origin", phase: "final_answer", content } });
}

test("S1: a terminated ignored record larger than 8MiB cannot block baseline or the next physical final", async (t) => {
  const root = await temporary(t);
  const id = randomUUID();
  const path = join(root, "events.jsonl");
  await writeFile(path, start(id) + JSON.stringify({
    id: "historical-model", type: "model.model_call_success", data: { internal: "x".repeat(9 * 1024 * 1024) },
  }) + "\r\n" + final("EARLIER_COMPLETED_RESULT") + "\n");
  const reads = boundedReads(t);
  const baseline = await journalBaseline(id, path);
  assert.equal(baseline.index, 3, "one oversized terminated line still occupies exactly one physical record");
  assert.equal(baseline.offset, (await stat(path)).size);
  assert.ok(reads.length >= 2 && reads.every((stream) => stream.bytesRead <= 8 * 1024 * 1024),
    "baseline must carry discard progress instead of increasing actual per-read I/O");
  await appendFile(path, final("NEW_VISIBLE_FINAL\r\n你好 🚀") + "\n");
  const page = await journalPage(id, path, baseline);
  assert.deepEqual(page.events, [appJournalEvent(id, {
    index: 3, timestamp: "2026-11-16T10:00:00Z", originatingMessageId: "root-origin",
    assistantResponse: "NEW_VISIBLE_FINAL\r\n你好 🚀",
  })]);
  assert.equal(page.cursor.index, 4);
  assert.equal(page.hasMore, false);
  assert.ok(JSON.stringify(page).length < 5000 && !JSON.stringify(page).includes("historical-model"));
});

test("S1: oversized discard progress survives page/EOF boundaries without covering the unfinished line or losing appended Unicode finals", async (t) => {
  const root = await temporary(t);
  const id = randomUUID();
  const path = join(root, "events.jsonl");
  const prefix = start(id);
  await writeFile(path, prefix);
  const baseline = await journalBaseline(id, path);
  await appendFile(path, '{"id":"large-snapshot","type":"model.messages_snapshot","data":{"internal":"' + "x".repeat(9 * 1024 * 1024));
  const reads = boundedReads(t);
  const first = await journalPage(id, path, baseline);
  assert.equal(first.cursor.index, 1);
  assert.equal(first.cursor.offset, Buffer.byteLength(prefix), "discard scan offset is not completed physical-record coverage");
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.events, []);
  const atEof = await journalPage(id, path, JSON.parse(JSON.stringify(first.cursor)));
  assert.equal(atEof.cursor.index, 1);
  assert.equal(atEof.cursor.offset, baseline.offset);
  assert.equal(atEof.hasMore, false);
  assert.deepEqual(atEof.events, []);
  assert.ok(atEof.cursor.discard && atEof.cursor.discard.offset > atEof.cursor.offset);
  assert.ok(reads.every((stream) => stream.bytesRead <= 8 * 1024 * 1024));
  const streamCount = reads.length;
  assert.deepEqual(await journalPage(id, path, atEof.cursor), atEof,
    "unchanged EOF preserves discard progress without claiming an ignored line is complete");
  assert.equal(reads.length, streamCount, "discarded EOF is not rescanned");
  const stateDirectory = join(root, "cursor-state");
  const store = await Store.open(stateDirectory, "oversized-fixture");
  const subscriptionId = digest(`fixture:${id}`);
  await store.mutate((state) => {
    state.subscriptions[subscriptionId] = {
      id: subscriptionId, sessionId: id, conversationKey: "fixture", revision: 1, enabled: true,
      status: "watching", cursor: atEof.cursor, detail: "Synthetic discard cursor only",
    };
  });
  await store.close();
  const reopened = await Store.open(stateDirectory, "oversized-fixture");
  const persisted = reopened.snapshot().subscriptions[subscriptionId]!.cursor;
  assert.deepEqual(persisted, atEof.cursor, "restart must retain discard progress, not reset to the 9MiB record start");
  await reopened.close();
  const next = final("APPENDED_AFTER_LARGE_RECORD\r\n你好 🚀");
  const bytes = Buffer.from(next);
  const split = bytes.indexOf(Buffer.from("🚀")) + 2;
  await appendFile(path, '"}}\r\n');
  await appendFile(path, bytes.subarray(0, split));
  let incomplete = await journalPage(id, path, persisted);
  for (let page = 0; page < 3 && incomplete.hasMore; page++) incomplete = await journalPage(id, path, incomplete.cursor);
  assert.equal(incomplete.cursor.index, 2, "only the newly terminated ignored line is now covered");
  assert.deepEqual(incomplete.events, []);
  assert.equal(incomplete.hasMore, false);
  await appendFile(path, bytes.subarray(split));
  const completed = await journalPage(id, path, incomplete.cursor);
  assert.equal(completed.cursor.index, 3);
  assert.equal(completed.cursor.eofRecord, true, "valid completed JSON without newline remains supported");
  assert.equal(completed.events.length, 1);
  const event = completed.events[0];
  assert.ok(object(event) && object(event.data));
  assert.equal(event.data.content, "APPENDED_AFTER_LARGE_RECORD\r\n你好 🚀");
  await appendFile(path, "\r\n");
  const separated = await journalPage(id, path, completed.cursor);
  assert.equal(separated.cursor.index, 3, "the later CRLF separator is not another physical record");
  assert.deepEqual(separated.events, []);
  assert.ok(reads.every((stream) => stream.bytesRead <= 8 * 1024 * 1024));
});
