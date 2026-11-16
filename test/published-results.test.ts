import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { LocalAppSessions } from "../src/app-sessions.js";
import { appJournalEvent } from "../src/journal-observer.js";
import { temporary } from "./helpers.js";
import { object } from "../src/safety.js";
import { conversationDialogue } from "../src/conversation-ui.js";
import { transcriptPages } from "../src/cards.js";
import type { TimelineEntry } from "../src/domain.js";

function publishedEvents(origin: string, message = "Synthetic published result.\r\n你好 🚀") {
  return [
    { id: "publish-request", type: "assistant.message", timestamp: "2026-11-16T04:00:00Z",
      data: { messageId: "request-id", originatingMessageId: origin, content: "", turnId: "publish-turn", interactionId: "scope",
        toolRequests: [{ toolCallId: "publish-call", name: "publish_chat_update", arguments: { message, attachments: [] } }] } },
    { id: "publish-start", parentId: "publish-request", type: "tool.execution_start",
      data: { toolCallId: "publish-call", toolName: "publish_chat_update", turnId: "publish-turn", arguments: { message, attachments: [] } } },
    { id: "publish-complete", type: "tool.execution_complete", timestamp: "2026-11-16T04:00:01Z",
      data: { toolCallId: "publish-call", turnId: "publish-turn", interactionId: "scope", success: true,
        result: { content: JSON.stringify({ kind: "chat_update", version: 1, message, attachments: [{ kind: "document", file: "PRIVATE_ATTACHMENT_PATH" }] }) } } },
    { id: "next-turn", type: "assistant.turn_start", data: { turnId: "final-turn", interactionId: "scope" } },
    { id: "empty-final", type: "assistant.message", timestamp: "2026-11-16T04:00:02Z",
      data: { messageId: "empty-id", originatingMessageId: origin, content: "", phase: "final_answer", turnId: "final-turn", interactionId: "scope" } },
    { id: "final-end", type: "assistant.turn_end", data: { turnId: "final-turn" } },
  ];
}

test("published root result plus empty final is visible with its own stable identity but publication alone does not confirm task completion", async (t) => {
  const root = await temporary(t);
  const id = randomUUID();
  const origin = randomUUID();
  const directory = join(root, "sessions", id);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "events.jsonl");
  await writeFile(path, JSON.stringify({ id: "start", type: "session.start", data: { sessionId: id } }) + "\n");
  const app = new LocalAppSessions({ timeoutMs: 1000, sessionStateDirectory: join(root, "sessions"), brokerDirectory: join(root, "absent") });
  await app.start();
  t.after(() => app.close());
  const baseline = await app.subscriptionBaseline(id);
  const rows = publishedEvents(origin);
  await appendFile(path, rows.slice(0, 3).map((row) => JSON.stringify(row)).join("\n") + "\n");
  const incomplete = await app.readSessionState(id, [origin]);
  assert.equal(incomplete.turns.length, 1, "an official published message is visible even if the following ordinary final is empty");
  assert.equal(incomplete.completions.length, 0, "publication is not task completion");
  const page = await app.subscriptionRead(id, baseline);
  assert.equal(page.events.length, 1);
  assert.deepEqual(page.events[0], appJournalEvent(id, incomplete.turns[0]!));
  await appendFile(path, rows.slice(3).map((row) => JSON.stringify(row)).join("\n") + "\n");
  const complete = await app.readSessionState(id, [origin]);
  assert.equal(complete.turns[0]!.assistantResponse, "Synthetic published result.\r\n你好 🚀");
  assert.equal(complete.turns[0]!.originatingMessageId, origin);
  assert.equal(complete.completions.length, 1);
  assert.ok(!JSON.stringify(complete).includes("PRIVATE_ATTACHMENT_PATH"));
  const history = await app.readSession(id);
  const preview = await app.readPreview(id);
  assert.deepEqual(history, complete.turns);
  assert.equal(preview.at(-1)?.assistantResponse, complete.turns[0]!.assistantResponse);
});

test("conversation presentation retains an actual trusted published reply and pasted code while hiding typed commentary without changing the source", async (t) => {
  const root = await temporary(t);
  const id = randomUUID();
  const origin = randomUUID();
  const directory = join(root, "sessions", id);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "events.jsonl");
  const input = "```ts\r\nthrow new Error('tool failure');\r\n```\n\n[Reference](https://example.test/a)";
  const message = "Published technical result.\r\nKeep the original error/tool explanation. 你好 🚀";
  const rows = [
    { id: "user", type: "user.message", timestamp: "2026-11-16T03:59:58Z", data: { messageId: origin, content: input } },
    { id: "commentary", type: "assistant.message", timestamp: "2026-11-16T03:59:59Z",
      data: { messageId: "comment", phase: "commentary", content: "COMMENTARY_PROGRESS_NOT_DIALOGUE", originatingMessageId: origin } },
    ...publishedEvents(origin, message),
  ];
  const original = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(path, original);
  const app = new LocalAppSessions({ timeoutMs: 1000, sessionStateDirectory: join(root, "sessions"), brokerDirectory: join(root, "absent") });
  await app.start();
  t.after(() => app.close());
  const turns = await app.readSession(id);
  const entries: TimelineEntry[] = turns.map((turn) => ({
    id: `entry:${turn.index}`, kind: turn.role === "user" ? "user" : "assistant",
    text: turn.assistantResponse, timestamp: turn.timestamp, ...(turn.role ? {} : { phase: turn.phase ?? "final" }),
  }));
  assert.deepEqual(transcriptPages(entries), [`**You**\n\n${input}\n\n**Copilot**\n\n${message}`]);
  assert.deepEqual(conversationDialogue(entries).map((entry) => entry.text), [input, message]);
  assert.ok(turns.some((turn) => turn.phase === "commentary"), "typed progress is preserved in the underlying read projection");
  assert.equal(await readFile(path, "utf8"), original);
  assert.ok(!JSON.stringify(transcriptPages(entries)).includes("PRIVATE_ATTACHMENT_PATH"));
});

test("published results fail closed for bad chains, child/other origin, tool, version and malformed output, while equal later finals deduplicate", async (t) => {
  const root = await temporary(t);
  const id = randomUUID();
  const origin = randomUUID();
  const directory = join(root, "sessions", id);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "events.jsonl");
  const app = new LocalAppSessions({ timeoutMs: 1000, sessionStateDirectory: join(root, "sessions"), brokerDirectory: join(root, "absent") });
  await app.start();
  t.after(() => app.close());
  const data = (rows: Record<string, unknown>[], index: number) => {
    const value = rows[index]!.data;
    assert.ok(object(value));
    return value;
  };
  const request = (rows: Record<string, unknown>[]) => {
    const requests = data(rows, 0).toolRequests;
    assert.ok(Array.isArray(requests) && object(requests[0]));
    return requests[0];
  };
  const result = (rows: Record<string, unknown>[]) => {
    const value = data(rows, 2).result;
    assert.ok(object(value));
    return value;
  };
  const variants: Array<[string, (rows: Record<string, unknown>[]) => void]> = [
    ["failed", (rows) => { data(rows, 2).success = false; }],
    ["missing request", (rows) => { rows.splice(0, 1); }],
    ["missing start", (rows) => { rows.splice(1, 1); }],
    ["wrong start parent", (rows) => { rows[1]!.parentId = "different-request"; }],
    ["unrelated tool", (rows) => { request(rows).name = "unrelated_tool"; data(rows, 1).toolName = "unrelated_tool"; }],
    ["child request", (rows) => { rows[0]!.agentId = "child"; }],
    ["child start", (rows) => { data(rows, 1).parentToolCallId = "child"; }],
    ["child completion", (rows) => { rows[2]!.agentId = "child"; }],
    ["other start origin", (rows) => { data(rows, 1).originatingMessageId = "other-origin"; }],
    ["other completion origin", (rows) => { data(rows, 2).originatingMessageId = "other-origin"; }],
    ["conflicting request origin", (rows) => { rows[0]!.originatingMessageId = "other-origin"; }],
    ["conflicting start origin", (rows) => { rows[1]!.originatingMessageId = origin; data(rows, 1).originatingMessageId = "other-origin"; }],
    ["conflicting completion origin", (rows) => { rows[2]!.originatingMessageId = origin; data(rows, 2).originatingMessageId = "other-origin"; }],
    ["malformed request origin", (rows) => { data(rows, 0).originatingMessageId = 123; }],
    ["wrong interaction", (rows) => { data(rows, 2).interactionId = "other-interaction"; }],
    ["wrong turn", (rows) => { data(rows, 2).turnId = "other-turn"; }],
    ["wrong tool call", (rows) => { data(rows, 2).toolCallId = "other-call"; }],
    ["malformed", (rows) => { result(rows).content = "not-json PRIVATE_RAW_OUTPUT"; }],
    ["unknown version", (rows) => { result(rows).content = JSON.stringify({ kind: "chat_update", version: 2, message: "Synthetic published result.\r\n你好 🚀", attachments: [] }); }],
    ["wrong kind", (rows) => { result(rows).content = JSON.stringify({ kind: "tool_output", version: 1, message: "Synthetic published result.\r\n你好 🚀", attachments: [] }); }],
    ["changed message", (rows) => { result(rows).content = JSON.stringify({ kind: "chat_update", version: 1, message: "Unrelated text", attachments: [] }); }],
    ["hidden request phase", (rows) => { data(rows, 0).phase = "analysis"; }],
  ];
  for (const [name, mutate] of variants) {
    const rows: Record<string, unknown>[] = structuredClone(publishedEvents(origin));
    mutate(rows);
    await writeFile(path, JSON.stringify({ id: "session", type: "session.start", data: { sessionId: id } }) + "\n");
    const baseline = await app.subscriptionBaseline(id);
    await appendFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    assert.equal((await app.readSessionState(id, [origin])).turns.length, 0, name);
    assert.equal((await app.subscriptionRead(id, baseline)).events.length, 0, name);
  }
  await writeFile(path, JSON.stringify({ id: "session", type: "session.start", data: { sessionId: id } }) + "\n");
  const baseline = await app.subscriptionBaseline(id);
  const rows: Record<string, unknown>[] = structuredClone(publishedEvents(origin));
  delete rows[1]!.parentId;
  data(rows, 4).content = "Synthetic published result.\r\n你好 🚀";
  await appendFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const visible = await app.readSessionState(id, [origin]);
  assert.equal(visible.turns.length, 1, "a supported root start without parentId still matches its exact tool call/turn/arguments");
  assert.equal((await app.subscriptionRead(id, baseline)).events.length, 1, "equal later final is the same result, not a second notification");
});
