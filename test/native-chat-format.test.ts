import assert from "node:assert/strict";
import { test } from "node:test";
import { outboundActivity } from "../src/teams.js";
import { digest } from "../src/safety.js";
import { replyChunks } from "../src/replies.js";
import type { OutboxItem } from "../src/domain.js";
import { createWorking, harness, temporary } from "./helpers.js";

function visibleXml(text: string): string {
  assert.ok(!text.replaceAll("<br>", "").includes("<"), "only fixed <br> tags may reach the basic-HTML fallback");
  return text.replaceAll("<br>", "\n").replace(/&(amp|lt|gt|quot|#39|#160);/gu, (_match, entity: string) =>
    ({ amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", "#160": " " })[entity]!);
}

function displayText(text: string): string {
  return text.replace(/\r\n|\r/gu, "\n").replaceAll("\t", "    ");
}

test("v4 fallback explicitly escapes source and title into basic HTML breaks without executing local links, tags or Markdown", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const name = "Synthetic <b>title</b> & \"quoted\"";
  await h.bridge.store.mutate((state) => { state.sessions[id]!.name = name; });
  const body = "| File | Result |\r\n| --- | --- |\r\n" +
    "| [`Label`](<Q:\\MOCK\\source.rs#L1>) | [Open](ghapp://session/synthetic) |\r\n\r\n" +
    "```rust\r\n    let quoted = \"<>&'\";\r\n\tprintln!(\"PROTECTED_17 🚀\");\r\n```\r\n\r\n" +
    "<script>fixture()</script> <img src='javascript:fixture()'>\r\n中文";
  await h.text("synthetic formatting fixture");
  h.runtime.emit(id, "assistant.message", { messageId: "format-v4", phase: "final", content: body });
  await h.bridge.flush();
  const item = h.bridge.store.snapshot().outbox.find((entry) => entry.eventId === "format-v4")!;
  assert.equal(item.presentation?.version, 4);
  assert.equal(item.text, body);
  const activity = outboundActivity({ type: "text", text: item.text, presentation: item.presentation! });
  assert.equal(activity.textFormat, "xml");
  assert.ok(activity.text!.includes("<br><br>"), "line layout cannot rely on literal whitespace inside HTML");
  assert.ok(!/[\r\n]/u.test(activity.text!), "all display line breaks must be explicit");
  const visible = visibleXml(activity.text!);
  assert.ok(visible.startsWith(name) && visible.endsWith(displayText(body)));
  assert.ok(visible.includes(id.slice(0, 8)));
  assert.equal(visible.match(/PROTECTED_17/gu)?.length, 1, "genuine literals must not be masked or reconstructed");
  assert.equal(item.id, digest(`${h.key}:${id}:format-v4:0`), "format selection must not enter the canonical result key");
  assert.ok(Buffer.byteLength(JSON.stringify(activity)) <= 12_000);
});

test("new fallback partitions exact source slices by the expanded actual Activity JSON including XML entities, spaces, CRLF and Unicode", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const body = "  <>&\"'\\\t 中文 🚀\r\n\r\n".repeat(1500) + "FINAL_EXACT_SUFFIX";
  await h.text("synthetic expanded-wire budget fixture");
  h.runtime.emit(id, "assistant.message", { messageId: "wire-expanded", phase: "final", content: body });
  await h.bridge.flush();
  const items = h.bridge.store.snapshot().outbox.filter((entry) => entry.eventId === "wire-expanded");
  assert.ok(items.length > 2);
  assert.equal(items.map((entry) => entry.text).join(""), body);
  for (const [index, item] of items.entries()) {
    const activity = outboundActivity({ type: "text", text: item.text, presentation: item.presentation! });
    assert.ok(Buffer.byteLength(JSON.stringify(activity)) <= 12_000,
      `actual activity ${index + 1} exceeds the 12000-byte JSON limit after formatting`);
    assert.equal(activity.textFormat, "xml");
    assert.ok(visibleXml(activity.text!).endsWith(displayText(item.text)));
    assert.ok(!activity.text!.includes("\uFFFD") && activity.text!.includes(id.slice(0, 8)));
    if (index + 1 < items.length) {
      assert.ok(!(item.text.endsWith("\r") && items[index + 1]!.text.startsWith("\n")), "a source CRLF pair cannot split between activities");
    }
  }
});

test("normal Markdown stays Markdown but new-message chunk budgets measure JSON escape growth, not raw string bytes alone", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  const body = "**Original rich syntax**\r\n[Web](https://example.test/fixture)\n\n```ts\n" +
    "const quoted = \"\\\\mock\\\\source\"; 中文 🚀\r\n".repeat(1500) + "```\nEXACT_RICH_END";
  await h.text("synthetic markdown wire budget fixture");
  h.runtime.emit(id, "assistant.message", { messageId: "markdown-wire", phase: "final", content: body });
  await h.bridge.flush();
  const items = h.bridge.store.snapshot().outbox.filter((entry) => entry.eventId === "markdown-wire");
  assert.equal(items.map((entry) => entry.text).join(""), body);
  assert.ok(items.length > 2);
  for (const item of items) {
    const activity = outboundActivity({ type: "text", text: item.text, presentation: item.presentation! });
    assert.ok(Buffer.byteLength(JSON.stringify(activity)) <= 12_000, "quotes, slashes, newlines and headers count toward the real JSON budget");
    assert.equal(activity.textFormat, "markdown");
    assert.ok(activity.text!.endsWith(item.text));
  }
});

test("v4 chat HISTORY uses exact source/roles with escaped layout and never changes the source events or treats fallback references as links", async (t) => {
  const h = await harness(t);
  const parent = await createWorking(h, "Parent");
  const id = await createWorking(h, "Synthetic side");
  await h.bridge.store.mutate((state) => { state.sessions[id]!.sideChat = { parentId: parent }; });
  const input = "Question PROTECTED_0\r\n  literal `code`\r\n";
  const body = "Table:\r\n| File | State |\r\n| --- | --- |\r\n" +
    "| [App](ghapp://session/synthetic) | [`File`](<Q:\\MOCK\\source.rs#L1>) |\r\n\r\n" +
    "```ts\r\n\tconst original = '&lt;not-decoded&gt;';\r\n    console.log(\"<>&'\");\r\n```\r\n中文 🚀";
  h.runtime.live.get(id)!.events.push(
    { id: "history-user", type: "user.message", data: { messageId: "history-user", content: input } },
    { id: "history-final", type: "assistant.message", data: { messageId: "history-final", phase: "final", content: body } },
  );
  const original = structuredClone(h.runtime.live.get(id)!.events);
  await h.text("!history 2");
  await h.bridge.flush();
  const items = h.bridge.store.snapshot().outbox.filter((entry) => entry.historyId);
  assert.equal(items.length, 1);
  assert.ok(items[0]!.text.includes(`You\n\n${input}`) && items[0]!.text.endsWith(`Copilot\n\n${body}`));
  const activity = outboundActivity({ type: "text", text: items[0]!.text, presentation: items[0]!.presentation! });
  assert.equal(activity.textFormat, "xml");
  assert.ok(visibleXml(activity.text!).includes("Parent > Side chat") && visibleXml(activity.text!).includes(id));
  assert.ok(visibleXml(activity.text!).endsWith(displayText(items[0]!.text)));
  assert.ok(activity.text!.includes("&amp;lt;not-decoded&amp;gt;"), "original entities are escaped once rather than interpreted as source markup");
  assert.ok(!/<a|<pre|<style|style=|<script|<img/iu.test(activity.text!));
  assert.match(activity.text!, /You<br><br>/);
  assert.match(activity.text!, /Copilot<br><br>/);
  assert.ok(!activity.text!.includes("**You**") && !activity.text!.includes("**Copilot**"));
  assert.equal(activity.text!.match(/Plain text/gu)?.length, 1);
  assert.deepEqual(h.runtime.live.get(id)!.events, original);
  assert.deepEqual(h.runtime.received, []);
});

test("v4 layout conversion has bounded safe JSON for extreme source headings and whitespace without splitting CRLF or Unicode", () => {
  const sourceId = "11111111-1111-4111-8111-111111111111";
  const body = " \t".repeat(12_000) + "\r\n\r\n" + "<>&\"'".repeat(5000) + "\r\n🚀\u2028中文_END";
  const chunks = replyChunks(body, {
    version: 4, title: "<&\"'".repeat(100), kind: "background", sourceId, groupId: "layout-boundaries", format: "xml",
  });
  assert.ok(chunks.length > 10);
  assert.equal(chunks.map((entry) => entry.text).join(""), body);
  for (const [index, chunk] of chunks.entries()) {
    const activity = outboundActivity({ type: "text", ...chunk });
    const serialized = JSON.stringify(activity);
    assert.ok(Buffer.byteLength(serialized) <= 12_000);
    assert.deepEqual(JSON.parse(serialized), { type: "message", text: activity.text, textFormat: "xml" },
      "the tested official Activity serialization must match the budgeted payload shape");
    const visible = visibleXml(activity.text!);
    assert.ok(visible.includes(sourceId) && visible.includes(`Group layout-b · ${index + 1}/${chunks.length}`));
    assert.ok(visible.endsWith(displayText(chunk.text)));
    assert.ok(!serialized.includes("\uFFFD"));
    if (index + 1 < chunks.length) assert.ok(!(chunk.text.endsWith("\r") && chunks[index + 1]!.text.startsWith("\n")));
  }
  assert.equal(chunks.map((entry) => outboundActivity({ type: "text", ...entry }).text!).join("").match(/Plain text/gu)?.length, 1);
  const rich = "**Rich** and `original_code`\r\n[Web](https://example.test/a)\n\n- item";
  const markdown = replyChunks(rich, { version: 4, title: "Known source", sourceId, kind: "session", groupId: "normal", format: "markdown" });
  assert.equal(markdown.length, 1);
  assert.equal(outboundActivity({ type: "text", ...markdown[0]! }).text, `**Known source** · ${sourceId.slice(0, 8)}\n\n${rich}`);
});

test("legacy absent/v2/v3 pending wire payloads stay byte-identical while sent/uncertain rows never repost and new v4 persists across restart", async (t) => {
  const directory = await temporary(t);
  const h = await harness(t, false, directory, { deliveryInitiallyPaused: true });
  const id = await createWorking(h);
  const legacy: OutboxItem[] = [
    { id: "absent-pending", conversationKey: h.key, sessionId: id, eventId: "absent-event", status: "pending", text: "Old plain\r\n<b>literal</b> PROTECTED_1" },
    { id: "v2-pending", conversationKey: h.key, sessionId: id, eventId: "v2-event", status: "pending", text: "Old `code`\r\n<legacy>",
      presentation: { version: 2, kind: "session", title: "Legacy [v2]", groupId: "legacy-v2", part: 1, parts: 1 } },
    { id: "v3-plain-pending", conversationKey: h.key, sessionId: id, eventId: "v3-plain-event", status: "pending", text: "Old\r\n[App](ghapp://legacy)\r\n<local> PROTECTED_2",
      presentation: { version: 3, format: "plain", kind: "history", title: "Old <source>", sourceId: id, groupId: "legacy-v3-plain", part: 1, parts: 1 } },
    { id: "v3-md-pending", conversationKey: h.key, sessionId: id, eventId: "v3-md-event", status: "pending", text: "Old **rich**\r\n`code`",
      presentation: { version: 3, format: "markdown", kind: "background", title: "Legacy source", sourceId: id, groupId: "legacy-v3-md", part: 1, parts: 1 } },
    { id: "v3-sent", conversationKey: h.key, sessionId: id, eventId: "v3-sent-event", status: "sent", activityId: "already-sent",
      text: "ALREADY_SENT\r\n<never-repost>", presentation: { version: 3, format: "plain", kind: "session", title: "Old", sourceId: id, groupId: "v3-sent", part: 1, parts: 1 } },
    { id: "v3-uncertain", conversationKey: h.key, sessionId: id, eventId: "v3-uncertain-event", status: "uncertain", text: "UNCERTAIN\r\n<never-repost>",
      presentation: { version: 3, format: "plain", kind: "session", title: "Old", sourceId: id, groupId: "v3-uncertain", part: 1, parts: 1 } },
  ];
  await h.bridge.store.mutate((state) => { state.outbox.push(...legacy); });
  const wireBefore = legacy.map((item) => JSON.stringify(outboundActivity({ type: "text", text: item.text,
    ...(item.presentation ? { presentation: item.presentation } : {}) })));
  assert.equal(JSON.parse(wireBefore[2]!).textFormat, "plain");
  assert.ok(JSON.parse(wireBefore[2]!).text.endsWith(legacy[2]!.text), "old v3 plain must not be retroactively escaped or line-converted");
  await h.text("new-only format fixture");
  h.runtime.emit(id, "assistant.message", { messageId: "new-v4", phase: "final", content: "NEW_RESULT\r\n<local> & `code` PROTECTED_3" });
  await h.bridge.flush();
  assert.deepEqual(h.bridge.store.snapshot().outbox.filter((item) => item.eventId !== "new-v4"), legacy);
  h.bridge.enableDelivery();
  await h.bridge.flush();
  for (const [index, item] of legacy.entries()) {
    const row = h.bridge.store.snapshot().outbox.find((entry) => entry.id === item.id)!;
    assert.equal(row.text, item.text);
    assert.deepEqual(row.presentation, item.presentation);
    assert.equal(JSON.stringify(outboundActivity({ type: "text", text: row.text, ...(row.presentation ? { presentation: row.presentation } : {}) })), wireBefore[index]);
    const sends = [...h.transport.messages.values()].filter((entry) => entry.message.type === "text" && entry.message.text === item.text);
    assert.equal(sends.length, item.status === "pending" ? 1 : 0);
    if (item.status !== "pending") assert.deepEqual(row, item);
  }
  const newItem = h.bridge.store.snapshot().outbox.find((item) => item.eventId === "new-v4")!;
  assert.equal(newItem.presentation?.version, 4);
  assert.equal(outboundActivity({ type: "text", text: newItem.text, presentation: newItem.presentation! }).textFormat, "xml");
  h.runtime.emit(id, "assistant.message", { messageId: "new-v4", phase: "final", content: newItem.text });
  await h.bridge.flush();
  const saved = h.bridge.store.snapshot().outbox;
  assert.equal(saved.filter((item) => item.eventId === "new-v4").length, 1);
  await h.bridge.close();
  const restored = await harness(t, false, directory, { initializeConversation: false });
  await restored.bridge.flush();
  assert.deepEqual(restored.bridge.store.snapshot().outbox, saved);
  assert.ok(![...restored.transport.messages.values()].some((item) => item.message.type === "text"));
});
