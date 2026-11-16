import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { newMessageFormat } from "../src/transport-format.js";
import { replyChunks } from "../src/replies.js";
import { outboundActivity } from "../src/teams.js";

test("new Markdown compatibility formatter keeps a synthetic local-angle table/code message lossless and inert using an explicit whole-group plain fallback", () => {
  const body = "| File | Result |\r\n| --- | --- |\r\n| [`Label`](<Q:\\MOCK\\source.rs#L1>) | `PROTECTED_17` |\r\n\r\n" +
    "```rust\r\nlet label = \"<Q:\\\\MOCK\\\\source.rs#L1>\";\r\nprintln!(\"{label}\");\r\n```\r\n中文 🚀";
  const copy = body;
  const format = newMessageFormat(body);
  assert.equal(format, "plain");
  const id = randomUUID();
  const chunks = replyChunks(body, { version: 3, kind: "history", title: "Synthetic only",
    sourceId: id, groupId: "synthetic", format });
  assert.equal(chunks.map((item) => item.text).join(""), body);
  const activity = outboundActivity({ type: "text", ...chunks[0]! });
  assert.equal(activity.textFormat, "plain");
  assert.ok(activity.text!.endsWith(body));
  assert.match(activity.text!, /Plain text/);
  assert.ok(!activity.text!.startsWith("**"), "plain mode must not add Markdown markers to generated headers");
  assert.equal(activity.text!.match(/PROTECTED_17/gu)?.length, 1, "genuine literals must not be repaired or decoded");
  assert.ok(!activity.text!.includes("</q:"), "the transport never reconstructs raw tags");
  assert.equal(body, copy);
});

test("new format selection is conservative for unsupported destinations and raw markup without rewriting labels, paths, code or Unicode", () => {
  for (const body of [
    "[Label](file:///Q:/MOCK/source.rs#L1)", "[`Label`](Q:\\MOCK\\source.rs#L1)",
    "[Label](javascript:alert(1))", "![Label](data:text/html;base64,AAAA)", "[Label](vscode://file/Q:/MOCK/a)",
    "[Label](../relative.rs)", "[Label](//example.test/path)", "[ref]: file:///MOCK\r\n[Label][ref]",
    "<script>fixture()</script>", "<Q:\\MOCK\\source.rs#L1>", "```html\r\n<b>literal</b>\r\n```",
    "[Label](https://user:password@example.test/a)", "[Incomplete](https://example.test/a",
  ]) {
    assert.equal(newMessageFormat(body), "plain", body);
    const output = replyChunks(body, { version: 3, kind: "session", title: "Source", sourceId: randomUUID(),
      groupId: "format-test", format: newMessageFormat(body) });
    assert.equal(output.map((chunk) => chunk.text).join(""), body);
    assert.equal(outboundActivity({ type: "text", ...output[0]! }).textFormat, "plain");
  }
  const rich = "**Bold** and `code` PROTECTED_0\r\n\r\n| A | B |\n| - | - |\n| 1 | 2 |\n\n" +
    "[Web label](https://example.test/a(b)#L1)\n\n```ts\r\nconst error = 'tool';\r\n```\n中文 🚀";
  assert.equal(newMessageFormat(rich), "markdown");
  assert.equal(outboundActivity({ type: "text", text: rich, presentation: {
    version: 2, kind: "session", title: "Old", groupId: "old", part: 1, parts: 1,
  } }).textFormat, "extendedmarkdown");
});

test("a long new fallback group preserves exact code/CRLF bytes across bounded activities and repeats provenance on every continuation", () => {
  const sourceId = randomUUID();
  const body = "[`Label`](<Q:\\MOCK\\source.rs#L1>)\r\n" + "```ts\r\nconst a = 'PROTECTED_0'; 🚀\r\n```\r\n".repeat(1000);
  const chunks = replyChunks(body, { version: 3, kind: "background", title: "Parent > Side chat",
    sourceId, groupId: "chunk-test", format: newMessageFormat(body) });
  assert.ok(chunks.length > 2);
  assert.equal(chunks.map((chunk) => chunk.text).join(""), body);
  for (const chunk of chunks) {
    const activity = outboundActivity({ type: "text", ...chunk });
    assert.ok(Buffer.byteLength(activity.text!) <= 12_000 && !activity.text!.includes("\uFFFD"));
    assert.ok(activity.text!.includes(sourceId) && activity.text!.includes("Background reply"));
    assert.equal(activity.textFormat, "plain");
  }
  assert.equal(chunks.map((chunk) => outboundActivity({ type: "text", ...chunk }).text).join("\n").split("Plain text").length - 1, 1);
});
