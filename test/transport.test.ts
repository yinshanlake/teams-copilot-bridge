import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";
import type { Card } from "../src/domain.js";
import { createProductionApp, createTeamsAdapter, TeamsTransport, authorizeActivity, outboundActivity } from "../src/teams.js";
import { startSimulator, mockEnvelope, mockIdentity } from "../src/simulator.js";
import { createWorking, findAction, harness, temporary } from "./helpers.js";
import { withLoopback } from "./block-network.js";
import { object } from "../src/safety.js";

test("proactive Teams adapter sends real Activity attachments/text and propagates swallowed callback failures", async () => {
  const turn = authorizeActivity(mockEnvelope(), { aud: mockIdentity.appId }, mockIdentity);
  const sent: unknown[] = [];
  const card: Card = { type: "AdaptiveCard", version: "1.5", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", body: [] };
  const transport = new TeamsTransport(mockIdentity, async (_reference, logic) => {
    await logic({
      sendActivity: async (activity) => { sent.push(activity); return { id: "teams-activity" }; },
      updateActivity: async (activity) => { sent.push(activity); },
    });
  });
  assert.equal(await transport.send(turn.reference, { type: "card", card }), "teams-activity");
  await transport.send(turn.reference, { type: "text", text: "exact answer" });
  await transport.update(turn.reference, "teams-activity", card);
  assert.ok(object(sent[0]));
  assert.equal(sent[0].type, "message");
  assert.match(JSON.stringify(sent[0]), /application\/vnd.microsoft.card.adaptive/);
  assert.equal(outboundActivity({ type: "text", text: "hello" }).textFormat, "plain");
  const failed = new TeamsTransport(mockIdentity, async (_reference, logic) => {
    await logic({
      sendActivity: async () => { throw new Error("transport failed"); },
      updateActivity: async () => { throw new Error("update failed"); },
    });
    // Simulates CloudAdapter middleware swallowing errors outside the callback.
  });
  await assert.rejects(() => failed.send(turn.reference, { type: "text", text: "test" }), /transport failed/);
  await assert.rejects(() => failed.update(turn.reference, "id", card), /update failed/);
  await assert.rejects(() => transport.send({ ...turn.reference, serviceUrl: "https://evil.example/" }, { type: "text", text: "test" }), /reference/);
});

test("production route rejects missing/malformed bearer authentication before any SDK dispatch or proactive reference persistence", async (t) => {
  const h = await harness(t);
  const before = Object.keys(h.bridge.store.snapshot().conversations).length;
  const adapter = createTeamsAdapter(mockIdentity, "explicit-test-secret");
  const app = createProductionApp(mockIdentity, "explicit-test-secret", adapter, h.bridge);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await withLoopback(address.port, async () => {
    for (const header of ["", "Basic forged", "Bearer "]) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/messages`, {
        method: "POST", headers: { "content-type": "application/json", ...(header ? { authorization: header } : {}) },
        body: JSON.stringify(mockEnvelope("must not execute")),
      });
      assert.equal(response.status, 401);
    }
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/activity`, { method: "POST" })).status, 404);
  });
  assert.equal(h.runtime.received.length, 0);
  assert.equal(Object.keys(h.bridge.store.snapshot().conversations).length, before);
});

test("uncertain proactive delivery is durable and never automatically retried or re-executed", async (t) => {
  const h = await harness(t);
  const id = await createWorking(h);
  await h.text("Explicit task for the uncertain-delivery fixture");
  const original = h.transport.send.bind(h.transport);
  let sends = 0;
  h.transport.send = async (reference, outbound) => {
    if (outbound.type === "text") { sends++; throw new Error("lost acknowledgement"); }
    return original(reference, outbound);
  };
  h.runtime.emit(id, "assistant.message", { messageId: "uncertain-final", phase: "final", content: "Retained final text" });
  await h.bridge.flush();
  assert.equal(h.bridge.store.snapshot().outbox[0]?.status, "uncertain");
  await h.bridge.flush();
  assert.equal(sends, 1);
  assert.match(JSON.stringify(h.bridge.store.snapshot().sessions[id]?.timeline), /Retained final text/);
  assert.match(h.bridge.store.snapshot().conversations[h.key]!.notice, /uncertain/);
});

test("loopback mock HTTP uses actual Teams Submit envelopes/cards, rejects origin/CSRF/rebinding, and streams finals without polling", async (t) => {
  const directory = await temporary(t);
  const simulator = await startSimulator({ port: 0, stateDirectory: directory, workspace: directory, tickMs: 2 });
  // Explicit close before temporary cleanup, including SSE connections.
  try {
    await withLoopback(simulator.port, async () => {
      const root = `http://127.0.0.1:${simulator.port}`;
      const health = await (await fetch(`${root}/health`)).json();
      assert.deepEqual(health, { status: "ready", mock: true, realTeamsSends: 0, realModelCalls: 0 });
      const response = await fetch(`${root}/bootstrap`);
      const bootstrap: unknown = await response.json();
      assert.ok(object(bootstrap) && typeof bootstrap.token === "string" && Array.isArray(bootstrap.messages));
      const token = bootstrap.token;
      const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
      assert.match(await (await fetch(root)).text(), /LOCAL MOCK/);
      assert.equal((await fetch(`${root}/activity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(mockEnvelope("bad")) })).status, 403);
      assert.equal((await fetch(`${root}/health`, { headers: { origin: "https://evil.example" } })).status, 403);
      const rebound = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest({
          hostname: "127.0.0.1", port: simulator.port, path: "/health", headers: { host: `evil.example:${simulator.port}` },
        }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
        request.once("error", reject);
        request.end();
      });
      assert.equal(rebound, 403);
      const post = async (envelope: Record<string, unknown>) => {
        const result = await fetch(`${root}/activity`, {
          method: "POST", headers: { "content-type": "application/json", "x-simulator-token": token }, body: JSON.stringify(envelope),
        });
        assert.equal(result.status, 200);
        const parsed: unknown = await result.json();
        assert.ok(object(parsed) && object(parsed.body) && object(parsed.body.value));
        return parsed.body.value;
      };
      const newForm = await post(mockEnvelope("!new"));
      const create = findAction(newForm, "Create");
      assert.ok(object(create.data));
      const dashboard = await post({
        ...mockEnvelope(), id: randomUUID(), type: "message",
        value: { ...create.data, sessionName: "HTTP work", workspace: "local" },
      });
      assert.match(JSON.stringify(dashboard), /HTTP work/);
      const abort = new AbortController();
      try {
        const stream = await fetch(`${root}/events`, { headers: { cookie }, signal: abort.signal });
        assert.equal(stream.status, 200);
        assert.ok(stream.body);
        const reader = stream.body.getReader();
        await post(mockEnvelope("actual envelope, mock runtime"));
        let received = "";
        const end = Date.now() + 3000;
        while (!received.includes("MOCK response") && Date.now() < end) {
          const result = await reader.read();
          received += new TextDecoder().decode(result.value);
        }
        assert.match(received, /MOCK response/);
        assert.match(received, /actual envelope, mock runtime/);
        await reader.cancel();
      } finally { abort.abort(); }
    });
  } finally { await simulator.close(); }
});

test("actual simulator serves only its three fixed assets from a build beneath a dot-prefixed ancestor", async (t) => {
  const directory = await temporary(t);
  const sourceRoot = join(import.meta.dirname, "..", "..");
  const relocated = join(directory, ".isolated", "project");
  const assets = join(relocated, "src");
  await mkdir(assets, { recursive: true });
  await Promise.all([
    cp(join(import.meta.dirname, "..", "src"), join(relocated, "dist", "src"), { recursive: true }),
    copyFile(join(sourceRoot, "package.json"), join(relocated, "package.json")),
    symlink(join(sourceRoot, "node_modules"), join(relocated, "node_modules"), process.platform === "win32" ? "junction" : "dir"),
  ]);
  const publicAssets = [
    { route: "/", file: "preview.html", contentType: /^text\/html\b/ },
    { route: "/preview.js", file: "preview.js", contentType: /^(?:text|application)\/javascript\b/ },
    { route: "/preview.css", file: "preview.css", contentType: /^text\/css\b/ },
  ];
  await Promise.all(publicAssets.map(({ file }) => copyFile(join(sourceRoot, "src", file), join(assets, file))));
  const privateContent = "SYNTHETIC_NOT_A_PUBLIC_PREVIEW_ASSET";
  await Promise.all([
    writeFile(join(relocated, ".env"), privateContent),
    writeFile(join(assets, ".hidden"), privateContent),
    writeFile(join(assets, "private.txt"), privateContent),
  ]);
  // Load the relocated real module so its asset lookup uses the dot-prefixed ancestor.
  const isolated: typeof import("../src/simulator.js") = await import(pathToFileURL(join(relocated, "dist", "src", "simulator.js")).href);
  const simulator = await isolated.startSimulator({
    port: 0, stateDirectory: join(directory, "mock-state"), workspace: relocated, tickMs: 2,
  });
  try {
    await withLoopback(simulator.port, async () => {
      const root = `http://127.0.0.1:${simulator.port}`;
      for (const { route, file, contentType } of publicAssets) {
        const response = await fetch(`${root}${route}?file=.env`);
        assert.equal(response.status, 200, `${file} must load from the relocated real simulator`);
        assert.match(response.headers.get("content-type") ?? "", contentType);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        const body = await response.text();
        assert.equal(body, await readFile(join(assets, file), "utf8"));
        if (file === "preview.html") assert.match(body, /LOCAL MOCK/);
        assert.equal((await fetch(`${root}${route}`, { headers: { origin: "https://evil.example" } })).status, 403);
      }
      for (const path of ["/.env", "/%2eenv", "/.hidden", "/private.txt", "/src/private.txt", "/dist/src/simulator.js", "/..%2f.env"]) {
        const response = await fetch(`${root}${path}`);
        assert.equal(response.status, 404, `${path} is not a public asset route`);
        assert.ok(!(await response.text()).includes(privateContent));
      }
    });
  } finally { await simulator.close(); }
});

interface PreviewEvent {
  target: PreviewElement;
  key?: string;
  repeat?: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

class PreviewElement {
  id = "";
  className = "";
  textContent = "";
  name = "";
  value = "";
  tabIndex = -1;
  disabled = false;
  readonly style: Record<string, string> = {};
  parent?: PreviewElement;
  children: PreviewElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: PreviewEvent) => unknown>>();
  readonly classList = { add: (...names: string[]) => { this.className += ` ${names.join(" ")}`; } };
  constructor(readonly tag: string) {}
  append(...children: PreviewElement[]): void {
    for (const child of children) { child.parent = this; this.children.push(child); }
  }
  replaceChildren(): void { this.children = []; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(name: string, handler: (event: PreviewEvent) => unknown): void {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], handler]);
  }
  matches(selector: string): boolean {
    return selector.split(",").some((part) => part.startsWith(".")
      ? this.className.split(" ").includes(part.slice(1))
      : part === "[role='button']" ? this.attributes.get("role") === "button" : part === this.tag);
  }
  closest(selector: string): PreviewElement | undefined {
    return this.matches(selector) ? this : this.parent?.closest(selector);
  }
  querySelectorAll(selector: string): PreviewElement[] {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  find(id: string): PreviewElement | undefined {
    return this.id === id ? this : this.children.map((child) => child.find(id)).find(Boolean);
  }
  async fire(type: string, init: { key?: string; repeat?: boolean } = {}): Promise<PreviewEvent> {
    const event: PreviewEvent = { target: this, ...init, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; } };
    for (let node: PreviewElement | undefined = this; node; node = node.parent) {
      for (const listener of node.listeners.get(type) ?? []) await listener(event);
    }
    return event;
  }
}

async function renderPreview(
  cards: Card[], receive: (envelope: unknown) => Promise<void> = async () => { throw new Error("Unexpected preview submission."); },
): Promise<Map<string, PreviewElement>> {
  const roots = new Map(["messages", "error", "payload", "composer", "prompt", "payload-toggle", "scenarios", "connection"]
    .map((id) => { const element = new PreviewElement("div"); element.id = id; return [id, element]; }));
  const document = {
    createElement: (tag: string) => new PreviewElement(tag),
    querySelector: (selector: string) => roots.get(selector.slice(1)),
    getElementById: (id: string) => [...roots.values()].map((element) => element.find(id)).find(Boolean),
  };
  const source = await readFile(join(import.meta.dirname, "..", "..", "src", "preview.js"), "utf8");
  await runInNewContext(`(async () => { ${source}\n })()`, {
    document, crypto: { randomUUID }, EventSource: class { constructor(_url: string) {} },
    fetch: async (url: string, init?: { body?: string }) => {
      if (url === "/bootstrap") return { ok: true, json: async () => ({
        mock: true, token: "isolated-mock-token", template: mockEnvelope(),
        messages: cards.map((card, index) => ({ id: `fixture-card-${index}`, message: { type: "card", card } })),
      }) };
      assert.equal(url, "/activity");
      assert.ok(init?.body);
      await receive(JSON.parse(init.body));
      return { ok: true, json: async () => ({}) };
    },
  }, { timeout: 1000 });
  assert.equal(roots.get("error")!.textContent, "", "the actual preview script must initialize without errors");
  return roots;
}

test("the actual MOCK renderer selects signed rows by click, Enter or Space and nested Open never submits twice or inherits search inputs", async (t) => {
  const h = await harness(t);
  await createWorking(h, "Same name");
  await createWorking(h, "Same name");
  await createWorking(h, "Another project");
  const list = await h.text("!sessions");
  const conversation = h.bridge.store.snapshot().conversations[h.key]!;
  const entries = list.body.filter((entry) => entry.type === "ColumnSet");
  assert.equal(entries.length, 3);
  const ids = entries.map((entry) => {
    assert.ok(object(entry.selectAction) && object(entry.selectAction.data));
    const claims = h.bridge.actions.verify(entry.selectAction.data.token, conversation);
    assert.equal(claims.op, "select");
    assert.equal(entry.selectAction.associatedInputs, "none");
    const fallback = findAction(entry.columns, "Open");
    assert.ok(object(fallback.data));
    assert.equal(fallback.associatedInputs, "none");
    assert.equal(fallback.style, "default", "Open is a neutral fallback, not the primary Send emphasis");
    assert.equal(h.bridge.actions.verify(fallback.data.token, conversation).targetId, claims.targetId);
    return claims.targetId;
  });
  const posts: Record<string, unknown>[] = [];
  const roots = await renderPreview([list], async (envelope) => {
    const turn = authorizeActivity(envelope, { aud: mockIdentity.appId }, mockIdentity);
    assert.equal(turn.incoming.kind, "action");
    if (turn.incoming.kind === "action") {
      assert.deepEqual(Object.keys(turn.incoming.data), ["token"], "row/Open must not auto-submit the query field");
      posts.push(turn.incoming.data);
    }
    await h.bridge.handle(turn.key, turn.reference, turn.activity.id!, turn.incoming);
  });
  const rows = roots.get("messages")!.querySelectorAll(".card-columns");
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.tabIndex, 0);
    assert.equal(row.attributes.get("role"), "button");
    assert.match(row.attributes.get("aria-label") ?? "", /^Open (Same name|Another project)$/u);
  }
  await rows[0]!.children[0]!.children[0]!.fire("click");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, ids[0]);
  assert.equal(posts.length, 1);
  const enter = await rows[1]!.fire("keydown", { key: "Enter" });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, ids[1]);
  assert.equal(posts.length, 2);
  await rows[2]!.fire("keydown", { key: " ", repeat: true });
  assert.equal(posts.length, 2);
  const space = await rows[2]!.fire("keydown", { key: " " });
  assert.equal(space.defaultPrevented, true);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, ids[2]);
  const open = rows[0]!.querySelectorAll("button")[0]!;
  await open.fire("click");
  assert.equal(posts.length, 4, "nested fallback click must not bubble into a second row submission");
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.selectedId, ids[0]);
  await rows[1]!.fire("keydown", { key: "ArrowDown" });
  assert.equal(posts.length, 4);
  assert.equal(h.bridge.store.snapshot().conversations[h.key]!.query, undefined);
  assert.deepEqual(h.runtime.received, []);
  assert.deepEqual(h.runtime.stopped, []);
  assert.deepEqual(h.runtime.answers, []);
});

test("the actual MOCK renderer caps two-line list excerpts without adding a working reply body or clipping full History", async (t) => {
  for (const text of [
    "完整中文结果第一段，保留原来的换行和标点。\r\n\r\n".repeat(90) + "中文完整后缀 🚀",
    `[Read this reference](https://example.test/${"long-link-".repeat(35)})\n\n` + "A linked paragraph.\n\n".repeat(120),
  ]) {
    const h = await harness(t);
    const id = await createWorking(h);
    const messageId = randomUUID();
    await h.text("!status");
    await h.bridge.store.mutate((state) => {
      state.sessions[id]!.timeline = [{ id: `message:${messageId}`, kind: "assistant", phase: "final", text }];
    });
    h.runtime.live.get(id)!.events.splice(0, Infinity, {
      id: randomUUID(), type: "assistant.message", timestamp: "2026-11-16T00:00:00Z",
      data: { messageId, phase: "final", content: text },
    });
    const dashboard = h.bridge.render(h.key);
    assert.ok(!JSON.stringify(dashboard.body).includes("latest-reply-preview"));
    const list = await h.text("!sessions");
    const row = list.body.find((entry) => entry.type === "ColumnSet");
    assert.ok(row && Array.isArray(row.columns) && object(row.columns[0]) && Array.isArray(row.columns[0].items));
    const preview = row.columns[0].items.find((entry) => object(entry) && typeof entry.id === "string" && entry.id.startsWith("excerpt-"));
    assert.ok(object(preview) && typeof preview.id === "string" && typeof preview.text === "string" && typeof preview.maxLines === "number");
    assert.equal(preview.size, "Default", "reply text must use the native host's normal body size");
    assert.equal(preview.maxLines, 2);
    const history = await h.text("!read");
    const historyBlock = history.body.find((entry) => entry.id === "transcript-page-text");
    assert.equal(historyBlock?.text, `**Copilot**\n\n${text}`);
    assert.equal(historyBlock?.size, "Default", "full history must not be reduced to the auxiliary Small size");
    const roots = await renderPreview([list, history, dashboard]);
    const surface = roots.get("messages")!;
    const rendered = surface.find(`fixture-card-0:${preview.id}`);
    assert.ok(rendered);
    assert.ok(rendered.className.split(" ").includes("default") && !rendered.className.split(" ").includes("small"));
    assert.equal(rendered.textContent, preview.text, "the preview applies a real line cap rather than substituting a shorter mock string");
    assert.equal(rendered.style.webkitLineClamp, String(preview.maxLines));
    assert.equal(rendered.style.webkitBoxOrient, "vertical");
    assert.equal(rendered.style.display, "-webkit-box");
    assert.equal(rendered.style.overflow, "hidden");
    const historyText = surface.find("fixture-card-1:transcript-page-text");
    assert.ok(historyText);
    assert.ok(historyText.className.split(" ").includes("default") && !historyText.className.split(" ").includes("small"));
    assert.equal(historyText.textContent, `**Copilot**\n\n${text}`);
    assert.equal(historyText.style.webkitLineClamp, undefined, "History must not inherit the dashboard cap");
    assert.equal(surface.find("fixture-card-2")!.querySelectorAll("button")[0]!.textContent, "Sessions");
    assert.deepEqual(h.runtime.received, []);
  }
});

test("the actual MOCK subtle color has at least 4.5 to 1 contrast on white cards without claiming native host colors", async (t) => {
  const css = await readFile(join(import.meta.dirname, "..", "..", "src", "preview.css"), "utf8");
  const match = /(?:^|\})\s*\.subtle\s*\{[^}]*\bcolor:\s*#([0-9a-f]{6})\b[^}]*\}/iu.exec(css);
  assert.ok(match, "the real .subtle mapping must expose its foreground color");
  const color = match[1]!;
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  const ratio = 1.05 / (luminance + 0.05);
  t.diagnostic(`MOCK .subtle #${color} on #ffffff: ${ratio.toFixed(3)}:1; native Teams colors remain host-controlled.`);
  assert.ok(ratio >= 4.5, `MOCK auxiliary text has only ${ratio.toFixed(3)}:1 contrast on white`);
});
