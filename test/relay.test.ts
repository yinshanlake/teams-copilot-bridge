import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ZipWriter, Uint8ArrayWriter, TextReader } from "@zip.js/zip.js";
import { Server, type Socket as ServerSocket } from "socket.io";
import { io } from "socket.io-client";
import type { AccessToken } from "@azure/identity";
import type { CopilotSession } from "@github/copilot-sdk";
import type { Card, Outbound } from "../src/domain.js";
import { configuration, nativeCliConfiguration, nativeConfiguration } from "../src/config.js";
import { validateRelayConfig, readRelayBundle, type RelayBinding } from "../src/relay-config.js";
import { AzureRelayTokenSource, MicrosoftSignInRequired, type RelayTokenSource } from "../src/relay-auth.js";
import { RelayConnection, relayActivityRejectionReasons, relayValidationErrorCode, type RelayOptions } from "../src/relay.js";
import { nativeClientOptions } from "../src/native.js";
import { nativeLoginFlow } from "../src/login.js";
import { DeliveryError, object, UserError } from "../src/safety.js";
import { mockEnvelope, mockIdentity } from "../src/simulator.js";
import { outboundActivity, validateTeamsOwnerActivity } from "../src/teams.js";
import { Bridge } from "../src/bridge.js";
import { FakeRuntime } from "../src/fake-runtime.js";
import { Store } from "../src/store.js";
import { inputSuffix } from "../src/cards.js";
import { interactionDefaults } from "../src/interaction.js";
import { findAction, eventually, temporary } from "./helpers.js";
import { withLoopback } from "./block-network.js";

const origin = "https://relay-fixture.example.test";
const audienceId = "44444444-4444-4444-a444-444444444444";
const source = {
  version: 1, botAppId: mockIdentity.appId, ownerOid: mockIdentity.ownerId, aadTenantId: mockIdentity.tenantId,
  relayUrl: origin, relayPublicBaseUrl: origin,
  aadAudience: audienceId, aadScope: `api://${audienceId}/twin.connect`,
};
const trust = { origin, botAppId: mockIdentity.appId };

function fixtureToken(binding: RelayBinding, claims: Record<string, unknown> = {}, serial = 1): AccessToken {
  const body = {
    oid: binding.ownerOid, tid: binding.aadTenantId, aud: audienceId, scp: "twin.connect",
    exp: Math.floor(Date.now() / 1000) + 3600, fixtureSerial: serial, ...claims,
  };
  return {
    token: `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(body)).toString("base64url")}.loopback-fixture-not-a-real-signature`,
    expiresOnTimestamp: Date.now() + 3600_000,
  };
}

async function zipConfig(path: string, name: string, config: unknown): Promise<void> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add(name, new TextReader(JSON.stringify(config)), { useWebWorkers: false });
  await writeFile(path, await writer.close());
}

test("operator-provided JSON and ZIP bundles normalize relay audience independently of the bot identity and never import credentials", async (t) => {
  const directory = await temporary(t);
  const json = join(directory, "new-bot-config.json");
  const zip = join(directory, "new-bot-bundle.zip");
  await writeFile(json, JSON.stringify({ ...source, ownerUpn: "not-needed", unrelatedSecret: "must-not-import" }));
  await zipConfig(zip, "twin-config.json", source);
  const a = await readRelayBundle(json, trust);
  const b = await readRelayBundle(zip, trust);
  assert.deepEqual(a, b);
  assert.equal(a.aadAudience, `api://${audienceId}`);
  assert.equal(a.credentialScope, `api://${audienceId}/.default`);
  assert.notEqual(a.aadAudience.slice(6), a.botAppId);
  assert.ok(!JSON.stringify(a).includes("must-not-import"));
  assert.equal(validateRelayConfig({ ...source, aadAudience: `api://${audienceId}` }, trust).fingerprint, a.fingerprint);
  await zipConfig(zip, "nested/twin-config.json", source);
  await assert.rejects(() => readRelayBundle(zip, trust), /root twin-config/);
  await writeFile(json, "x".repeat(32 * 1024 + 1));
  await assert.rejects(() => readRelayBundle(json, trust), /32 KiB/);
});

test("bundle validation rejects identity substitution, forbidden bots, untrusted TLS origins and scope/audience confusion", () => {
  for (const patch of [
    { version: 2 }, { botAppId: randomUUID() }, { ownerOid: "name-not-guid" }, { aadTenantId: "common" },
    { relayUrl: "https://evil.example" }, { relayPublicBaseUrl: "https://other.example" },
    { relayUrl: "http://relay-fixture.example.test" }, { relayUrl: `${origin}/path` },
    { relayUrl: "https://token@relay-fixture.example.test" }, { aadAudience: "https://evil.example" },
    { aadScope: `api://${randomUUID()}/twin.connect` }, { aadScope: `api://${audienceId}/different.scope` },
  ]) assert.throws(() => validateRelayConfig({ ...source, ...patch }, trust));
  assert.throws(() => validateRelayConfig(source, { ...trust, forbiddenBotIds: [source.botAppId] }), /forbidden/);
  assert.throws(() => validateRelayConfig(source, { ...trust, ownerOid: randomUUID() }), /owner\/tenant/);
  assert.throws(() => validateRelayConfig(source, { ...trust, tenantId: randomUUID() }), /owner\/tenant/);
  for (const bad of ["https://127.0.0.1", "https://localhost", "https://foo.local", `${origin}?token=x`]) {
    assert.throws(() => validateRelayConfig({ ...source, relayUrl: bad }, { ...trust, origin: bad }));
  }
});

test("sanitized native WSS relay URL plus GUID audience normalizes to the same HTTPS-pinned binding without relaxing other origins", async (t) => {
  const directory = await temporary(t);
  const path = join(directory, "new-bot-wss.json");
  const wire = { ...source, relayUrl: "wss://relay-fixture.example.test", aadAudience: audienceId };
  await writeFile(path, JSON.stringify(wire));
  const canonical = validateRelayConfig(source, trust);
  const native = await readRelayBundle(path, trust);
  assert.deepEqual(native, canonical);
  assert.equal(native.relayUrl, origin);
  assert.equal(native.fingerprint, canonical.fingerprint);
  for (const relayUrl of [
    "ws://relay-fixture.example.test", "wss://evil.example.test",
    "wss://relay-fixture.example.test/path", "wss://relay-fixture.example.test:444",
    "wss://relay-fixture.example.test?token=x", "wss://relay-fixture.example.test#fragment",
    "wss://user:secret@relay-fixture.example.test",
  ]) assert.throws(() => validateRelayConfig({ ...wire, relayUrl }, trust));
  assert.throws(() => validateRelayConfig(wire, { ...trust, origin: wire.relayUrl }), /HTTPS/);
  assert.throws(() => validateRelayConfig({ ...wire, relayPublicBaseUrl: wire.relayUrl }, trust), /HTTPS/);
});

test("relay and logged-in-user are defaults with bot-scoped homes; webhook/token/runtime are explicit choices with no fallback", async (t) => {
  const directory = await temporary(t);
  const path = join(directory, "new-bot.json");
  await writeFile(path, JSON.stringify(source));
  const environment: NodeJS.ProcessEnv = {
    BRIDGE_RELAY_CONFIG: path, BRIDGE_BOT_APP_ID: mockIdentity.appId, BRIDGE_RELAY_ORIGIN: origin,
    BRIDGE_WORKSPACES: JSON.stringify([{ id: "local", name: "Local", path: directory }]),
    COPILOT_DEFAULT_MODEL: "explicit-live-model",
  };
  const config = await configuration(environment, directory);
  assert.equal(config.transport, "relay");
  assert.ok(!("clientSecret" in config));
  assert.equal(config.native.auth, "logged-in-user");
  assert.equal(config.stateDirectory, join(directory, ".bridge", "bots", mockIdentity.appId));
  const client = nativeClientOptions(config.native);
  assert.equal(client.mode, "empty");
  assert.equal(client.useLoggedInUser, true);
  assert.equal(client.gitHubToken, undefined);
  assert.equal(config.native.token, undefined);
  const cli = nativeCliConfiguration({ BRIDGE_BOT_APP_ID: mockIdentity.appId }, directory);
  assert.equal(cli.home, config.native.home);
  assert.equal(cli.defaultModel, "");
  const another = nativeCliConfiguration({ BRIDGE_BOT_APP_ID: randomUUID() }, directory);
  assert.notEqual(another.home, cli.home);
  assert.throws(() => nativeConfiguration({ COPILOT_GITHUB_TOKEN: "ambient" }, directory, directory, true), /explicit COPILOT_AUTH/);
  assert.throws(() => nativeConfiguration({ COPILOT_RUNTIME_URI: "127.0.0.1:42" }, directory, directory, true), /explicit COPILOT_AUTH/);
  await assert.rejects(() => configuration({ ...environment, BRIDGE_TRANSPORT: "guess" }, directory), /No fallback/);
  await assert.rejects(() => configuration({ ...environment, BRIDGE_FORBIDDEN_BOT_IDS: mockIdentity.appId }, directory), /forbidden/);
});

test("official AzureCliCredential wiring uses tenant and resource/.default with delegated owner claims, not app credentials or config-supplied identity assertions", async () => {
  const binding = validateRelayConfig(source, trust);
  const scopes: unknown[] = [];
  let credentialOptions: unknown;
  const auth = new AzureRelayTokenSource(binding, (options) => {
    credentialOptions = options;
    return { async getToken(scope) { scopes.push(scope); return fixtureToken(binding); } };
  });
  assert.ok((await auth.getToken()).token);
  assert.deepEqual(credentialOptions, { tenantId: binding.aadTenantId, processTimeoutInMs: 20_000 });
  assert.deepEqual(scopes, [binding.credentialScope]);
  for (const claims of [
    { oid: randomUUID() }, { tid: randomUUID() }, { aud: randomUUID() }, { scp: "" },
    { scp: "twin.connect.attacker" }, { scp: undefined, roles: ["twin.connect"] }, { exp: 1 },
  ]) {
    const wrong = new AzureRelayTokenSource(binding, () => ({ getToken: async () => fixtureToken(binding, claims) }));
    await assert.rejects(() => wrong.getToken(), /does not match/);
  }
  const expired = new AzureRelayTokenSource(binding, () => ({
    getToken: async () => ({ ...fixtureToken(binding), expiresOnTimestamp: 1 }),
  }));
  await assert.rejects(() => expired.getToken(), MicrosoftSignInRequired);
  const unavailable = new AzureRelayTokenSource(binding, () => ({ getToken: async () => { throw new Error("az login required token=never-export"); } }));
  await assert.rejects(() => unavailable.getToken(), (error: unknown) =>
    error instanceof MicrosoftSignInRequired && error.message.includes("az login --tenant") && !error.message.includes("never-export"));
});

interface Loopback {
  relay: RelayConnection;
  binding: RelayBinding;
  server: Server;
  sockets: ServerSocket[];
  packets: Array<{ event: string; payload: Record<string, unknown> }>;
  handshakes: Record<string, unknown>[];
  tokenRequests: () => number;
}

async function loopback(t: TestContext, run: (test: Loopback) => Promise<void>, options: RelayOptions = {}, tokens?: RelayTokenSource): Promise<void> {
  void t;
  const http = createServer();
  const server = new Server(http, { transports: ["websocket"], serveClient: false });
  const scope = server.of("/twin");
  const sockets: ServerSocket[] = [];
  const packets: Loopback["packets"] = [];
  const handshakes: Loopback["handshakes"] = [];
  scope.on("connection", (socket) => {
    sockets.push(socket);
    handshakes.push(socket.handshake.auth);
    socket.on("sendActivity", (payload: Record<string, unknown>) => packets.push({ event: "sendActivity", payload }));
    socket.on("updateActivity", (payload: Record<string, unknown>) => packets.push({ event: "updateActivity", payload }));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const binding = validateRelayConfig(source, trust);
  let requests = 0;
  const tokenSource = tokens ?? new AzureRelayTokenSource(binding, () => ({
    getToken: async () => fixtureToken(binding, {}, ++requests),
  }));
  const relay = new RelayConnection(binding, mockIdentity, tokenSource, {
    acknowledgementMs: 80, connectTimeoutMs: 300, reconnectMs: 10, ...options,
  }, (url, configuration) => {
    assert.equal(url, `${origin}/twin`);
    assert.equal(configuration.reconnection, false);
    assert.equal(configuration.retries, 0);
    assert.equal(configuration.rejectUnauthorized, true);
    assert.deepEqual(configuration.transports, ["websocket"]);
    return io(`http://127.0.0.1:${address.port}/twin`, configuration);
  });
  try {
    await withLoopback(address.port, async () => {
      try { await run({ relay, binding, server, sockets, packets, handshakes, tokenRequests: () => requests }); }
      finally { await relay.close(); }
    });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function activityEnvelope(activity: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "activity", id: randomUUID(), receivedAt: Date.now(), activity, ...extra };
}

test("relay rejection diagnostics expose only bounded reason codes", () => {
  const message = "private message that must not appear";
  const owner = mockEnvelope(message);
  const invalid = {
    ...owner,
    from: { id: "foreign-user", aadObjectId: randomUUID() },
    recipient: { id: `28:${randomUUID()}` },
  };
  const reasons = relayActivityRejectionReasons(activityEnvelope(invalid), { botAppId: mockIdentity.appId }, mockIdentity);
  assert.deepEqual(reasons, ["OWNER_AAD", "RECIPIENT_BOT"]);
  const serialized = JSON.stringify(reasons);
  assert.ok(!serialized.includes(message));
  assert.ok(!serialized.includes(String(invalid.from.aadObjectId)));
  assert.ok(!serialized.includes(String(invalid.recipient.id)));
  assert.deepEqual(
    relayActivityRejectionReasons(activityEnvelope({ ...owner, channelId: undefined }), { botAppId: mockIdentity.appId }, mockIdentity),
    ["CHANNEL_MISSING"],
  );
  assert.deepEqual(
    relayActivityRejectionReasons(activityEnvelope({ ...owner, channelId: "MSTeams" }), { botAppId: mockIdentity.appId }, mockIdentity),
    ["CHANNEL_CASE"],
  );
  assert.deepEqual(
    relayActivityRejectionReasons(activityEnvelope({ ...owner, channelId: "relay" }), { botAppId: mockIdentity.appId }, mockIdentity),
    ["CHANNEL_VALUE"],
  );
  assert.deepEqual(
    relayActivityRejectionReasons(activityEnvelope({ ...owner, text: undefined }), { botAppId: mockIdentity.appId }, mockIdentity),
    ["TEXT_MISSING"],
  );
  assert.equal(relayValidationErrorCode(new UserError("A text message is required.")), "TEXT_MISSING");
  assert.equal(relayValidationErrorCode(new Error(message)), "UNEXPECTED");
});

test("real Socket.IO /twin handshake, activity provenance and send/update correlation obey the public relay wire without synthetic JWT claims", async (t) => {
  await loopback(t, async ({ relay, sockets, handshakes, packets }) => {
    const admitted: string[] = [];
    await relay.start(async (turn) => { admitted.push(turn.activity.text ?? "submit"); });
    assert.equal(relay.status, "connected");
    assert.equal(handshakes[0]?.botAppId, mockIdentity.appId);
    assert.deepEqual(handshakes[0]?.caps, []);
    assert.ok(typeof handshakes[0]?.token === "string");
    const owner = mockEnvelope("original text");
    const { channelId: _channelId, ...relayOwner } = owner;
    relayOwner.attachments = [{
      contentType: "application/vnd.microsoft.teams.file.download.info",
      content: { marker: "never-import-attachment" },
    }];
    // The thin Twin adapter synthesizes type discriminants; the raw socket event
    // name is authoritative. Older relay revisions can omit both the redundant
    // envelope type and activity channelId; authenticated relay provenance safely
    // supplies msteams without accepting an explicit non-Teams channel.
    const { type: _type, ...wire } = activityEnvelope(relayOwner, { attachmentToken: "never-import-this-connector-token" });
    sockets[0]!.emit("activity", wire);
    await eventually(() => admitted.length === 1);
    const invalid = [
      { ...owner, channelId: "emulator" },
      { ...owner, conversation: { id: "group", conversationType: "groupChat" } },
      { ...owner, from: { id: "foreign", aadObjectId: randomUUID() } },
      { ...owner, channelData: { tenant: { id: randomUUID() } } },
      { ...owner, recipient: { id: `28:${randomUUID()}` } },
      { ...owner, from: { id: `28:${mockIdentity.appId}`, aadObjectId: mockIdentity.ownerId, role: "bot" } },
      { ...owner, serviceUrl: "https://evil.example/" },
      { ...owner, type: "invoke", name: "adaptiveCard/action", value: { action: { type: "Action.Execute", verb: "bridge", data: {} } } },
    ];
    for (const body of invalid) sockets[0]!.emit("activity", activityEnvelope(body));
    sockets[0]!.emit("activity", activityEnvelope(owner, { botAppId: randomUUID() }));
    sockets[0]!.emit("activity", { activity: owner, verified: true, aud: mockIdentity.appId });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(admitted, ["original text"]);
    const turn = validateTeamsOwnerActivity(owner, mockIdentity, true);
    const send = relay.send(turn.reference, { type: "text", text: "loopback result" });
    await eventually(() => packets.length === 1);
    const packet = packets[0]!.payload;
    assert.equal(packet.type, "sendActivity");
    assert.equal(packet.conversationId, turn.reference.conversation.id);
    assert.equal(packet.tenantId, mockIdentity.tenantId);
    assert.equal(packet.serviceUrl, owner.serviceUrl);
    assert.ok(object(packet.activity));
    assert.equal(packet.activity.text, "loopback result");
    assert.ok(!JSON.stringify(packet).includes("never-import"));
    assert.throws(
      () => validateTeamsOwnerActivity({ ...owner, attachments: relayOwner.attachments }, mockIdentity, true),
      /not uploaded attachments/,
    );
    sockets[0]!.emit("sendResult", { type: "sendResult", requestId: "wrong-correlation", messageId: "ignored" });
    sockets[0]!.emit("sendResult", { requestId: packet.requestId, messageId: "teams-message-id" });
    assert.equal(await send, "teams-message-id");
    const update = relay.update(turn.reference, "teams-message-id", {
      type: "AdaptiveCard", version: "1.5", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", body: [],
    });
    await eventually(() => packets.length === 2);
    assert.equal(packets[1]?.event, "updateActivity");
    assert.equal(packets[1]?.payload.messageId, "teams-message-id");
    sockets[0]!.emit("sendResult", { type: "sendResult", requestId: packets[1]!.payload.requestId, messageId: "teams-message-id" });
    await update;
  });
});

test("relay timeout/disconnect are uncertain, offline sends are not emitted, and reconnect refreshes identity without replaying packets", async (t) => {
  await loopback(t, async ({ relay, sockets, packets, handshakes, tokenRequests }) => {
    await relay.start(async () => undefined);
    const reference = validateTeamsOwnerActivity(mockEnvelope(), mockIdentity, true).reference;
    const timeout = relay.send(reference, { type: "text", text: "timeout fixture" });
    await assert.rejects(() => timeout, (error: unknown) => error instanceof DeliveryError && error.outcome === "uncertain" && error.code === "TIMEOUT");
    assert.equal(packets.length, 1);
    const disconnected = relay.send(reference, { type: "text", text: "disconnect fixture" });
    const rejects = assert.rejects(() => disconnected, (error: unknown) => error instanceof DeliveryError && error.outcome === "uncertain");
    await eventually(() => packets.length === 2);
    sockets[0]!.conn.close();
    await rejects;
    await eventually(() => !relay.connected);
    await assert.rejects(() => relay.send(reference, { type: "text", text: "never-buffer" }),
      (error: unknown) => error instanceof DeliveryError && error.outcome === "not-sent");
    await eventually(() => handshakes.length >= 2 && relay.connected);
    assert.ok(tokenRequests() >= 2);
    assert.notEqual(handshakes[0]?.token, handshakes[1]?.token);
    assert.deepEqual(handshakes[1]?.caps, []);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(packets.length, 2);
    sockets.at(-1)!.emit("kick", { reason: "REPLACED" });
    await eventually(() => relay.status === "kicked");
    const count = handshakes.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(handshakes.length, count);
  });
});

test("relay summary cards emit one attachment-only Activity and settle normal send/update ACKs", async (t) => {
  await loopback(t, async ({ relay, sockets, packets }) => {
    await relay.start(async () => undefined);
    const reference = validateTeamsOwnerActivity(mockEnvelope(), mockIdentity, true).reference;
    let combinedFailures = 0;
    for (const event of ["sendActivity", "updateActivity"]) sockets[0]!.on(event, (payload: Record<string, unknown>) => {
      const activity = payload.activity;
      const combined = object(activity) && Array.isArray(activity.attachments) && activity.attachments.length > 0 &&
        (activity.text !== undefined || activity.textFormat !== undefined);
      if (combined) combinedFailures++;
      sockets[0]!.emit("sendResult", {
        type: "sendResult", requestId: payload.requestId,
        ...(combined ? { error: { code: "SEND_FAILED" } } : { messageId: payload.messageId ?? "card-only-message" }),
      });
    });
    const card: Card = {
      type: "AdaptiveCard", version: "1.5", $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      body: [{ type: "TextBlock", text: "Done - synthetic source", weight: "Bolder", wrap: true },
        { type: "TextBlock", text: "The result stays in this card.", wrap: true }],
      actions: [{ type: "Action.Submit", title: "Open", data: { token: "synthetic-scoped-token" } }],
    };
    const message: Outbound = { type: "card", card, summary: "Copilot reply - password=summary-fixture" };
    const unchanged = structuredClone(message);
    const webhook = JSON.stringify(outboundActivity(message));
    const id = await relay.send(reference, message);
    assert.equal(id, "card-only-message");
    assert.equal(packets.length, 1, "summary must not be emitted as another message");
    const activity = packets[0]!.payload.activity;
    assert.ok(object(activity) && Array.isArray(activity.attachments));
    assert.ok(!("text" in activity) && !("textFormat" in activity));
    assert.equal(activity.attachments.length, 1);
    const expected: Card = { ...card, body: [
      { ...card.body[0], text: "Copilot reply - password=[REDACTED]\n\nDone - synthetic source" },
      ...card.body.slice(1),
    ] };
    assert.deepEqual(activity.attachments[0], { contentType: "application/vnd.microsoft.card.adaptive", content: expected });
    assert.deepEqual(message, unchanged, "relay normalization must not mutate cards or signed action data");
    assert.equal(JSON.stringify(outboundActivity(message)), webhook, "webhook serialization stays unchanged");
    await relay.update(reference, id, expected);
    assert.equal(packets.length, 2);
    assert.equal(packets[1]!.event, "updateActivity");
    assert.equal(packets[1]!.payload.messageId, id);
    assert.deepEqual(packets[1]!.payload.activity, activity);
    assert.equal(combinedFailures, 0, "the legacy combined-payload failure must not be triggered");
  }, { acknowledgementMs: 300 });
});

test("relay card normalization preserves exact plain text and XML history Activity bytes", async (t) => {
  await loopback(t, async ({ relay, sockets, packets }) => {
    await relay.start(async () => undefined);
    const reference = validateTeamsOwnerActivity(mockEnvelope(), mockIdentity, true).reference;
    sockets[0]!.on("sendActivity", (payload: Record<string, unknown>) => {
      sockets[0]!.emit("sendResult", { type: "sendResult", requestId: payload.requestId, messageId: "text-message" });
    });
    const messages: Outbound[] = [
      { type: "text", text: "  unchanged plain\r\n**literal** <tag> & value  " },
      { type: "text", text: "History body\r\n\r\n<synthetic> & `code`", presentation: {
        version: 4, kind: "history", title: "Synthetic history", sourceId: randomUUID(),
        format: "xml", groupId: "synthetic-history", part: 1, parts: 1,
      } },
    ];
    for (const message of messages) {
      const expected = JSON.stringify(outboundActivity(message));
      assert.equal(await relay.send(reference, message), "text-message");
      assert.equal(JSON.stringify(packets.at(-1)!.payload.activity), expected);
    }
    assert.equal(packets.length, messages.length);
  }, { acknowledgementMs: 300 });
});

test("v3 relay normal ACKs settle new cards without reposting uncertain Inbox or result deliveries", async (t) => {
  const directory = await temporary(t);
  await loopback(t, async ({ relay, sockets, packets, binding }) => {
    const runtime = new FakeRuntime(2, false, true, interactionDefaults);
    const store = await Store.open(directory, `relay-fixture:${binding.fingerprint}`);
    const bridge = new Bridge(store, runtime, relay, {
      owner: store.snapshot().owner, workspaces: [{ id: "local", name: "Local", path: directory }],
      coalesceMs: 2, cardActions: "submit", deliveryInitiallyPaused: true, interaction: interactionDefaults,
    });
    let failCard: "inbox" | "result" | undefined = "inbox";
    let combinedFailures = 0;
    const failedRequests: string[] = [];
    try {
      await bridge.start();
      await relay.start(async (turn) => { await bridge.handle(turn.key, turn.reference, turn.activity.id!, turn.incoming); });
      for (const event of ["sendActivity", "updateActivity"]) sockets[0]!.on(event, (payload: Record<string, unknown>) => {
        const activity = payload.activity;
        const content = object(activity) && Array.isArray(activity.attachments) ? activity.attachments[0] : undefined;
        const combined = content && object(activity) && (activity.text !== undefined || activity.textFormat !== undefined);
        if (combined) combinedFailures++;
        const reject = event === "sendActivity" && Boolean(content) && Boolean(combined ||
          failCard === "inbox" && JSON.stringify(content).includes("Copilot Sessions - Inbox") ||
          failCard === "result" && JSON.stringify(content).includes("uncertain-result-body"));
        if (reject) {
          failedRequests.push(String(payload.requestId));
          if (!combined) failCard = undefined;
        }
        sockets[0]!.emit("sendResult", {
          type: "sendResult", requestId: payload.requestId,
          ...(reject ? { error: { code: "SEND_FAILED" } } : { messageId: payload.messageId ?? `acked:${payload.requestId}` }),
        });
      });
      bridge.enableDelivery();
      const handle = async (text: string, value?: unknown) => {
        const envelope = { ...mockEnvelope(text), ...(value === undefined ? {} : { value }) };
        const turn = validateTeamsOwnerActivity(envelope, mockIdentity, true);
        return bridge.handle(turn.key, turn.reference, turn.activity.id!, turn.incoming);
      };
      const key = validateTeamsOwnerActivity(mockEnvelope(), mockIdentity, true).key;
      await handle("!home");
      await bridge.flush();
      const oldInbox = Object.values(store.snapshot().interaction!.surfaces).find((surface) => surface.kind === "inbox" && !surface.frozen)!;
      assert.equal(oldInbox.delivery, "uncertain");
      const form = await handle("!new");
      const create = findAction(form, "Create");
      assert.ok(object(create.data));
      await handle("", { ...create.data, sessionName: "Relay summaries", workspace: "local" });
      const id = store.snapshot().conversations[key]!.selectedId!;
      await handle("first exact task");
      failCard = "result";
      runtime.emit(id, "assistant.message", { messageId: "uncertain-result", content: "uncertain-result-body", phase: "final" });
      runtime.emit(id, "session.task_complete", { success: true, summary: "Generic completion, not the actual answer" });
      runtime.emit(id, "session.idle");
      await bridge.flush();
      const oldResult = store.snapshot().outbox.find((item) => item.eventId === "uncertain-result")!;
      assert.equal(oldResult.status, "uncertain");
      const resultSurfaceId = oldResult.publication!.surfaceId;
      assert.equal(store.snapshot().interaction!.surfaces[resultSurfaceId]!.delivery, "uncertain");
      assert.equal(failedRequests.length, 2);
      await handle("second exact task");
      runtime.emit(id, "assistant.message", { messageId: "acked-result", content: "acked-result-body", phase: "final" });
      runtime.emit(id, "session.task_complete", { success: true, summary: "Generic completion, not the actual answer" });
      runtime.emit(id, "session.idle");
      await bridge.flush();
      await bridge.flush();
      const after = store.snapshot();
      assert.equal(after.outbox.find((item) => item.eventId === "acked-result")?.status, "sent");
      assert.match(after.outbox.find((item) => item.eventId === "acked-result")!.activityId!, /^acked:/);
      assert.deepEqual(after.outbox.find((item) => item.id === oldResult.id), oldResult);
      assert.equal(after.interaction!.surfaces[oldInbox.id]!.delivery, "uncertain");
      assert.equal(after.interaction!.surfaces[resultSurfaceId]!.delivery, "uncertain");
      assert.equal(failedRequests.length, 2, "uncertain sends must not be retried");
      const sends = packets.filter((packet) => packet.event === "sendActivity");
      assert.equal(sends.filter((packet) => JSON.stringify(packet.payload.activity).includes("Copilot Sessions - Inbox")).length, 1);
      assert.equal(sends.filter((packet) => JSON.stringify(packet.payload.activity).includes("uncertain-result-body")).length, 1);
      assert.equal(sends.filter((packet) => JSON.stringify(packet.payload.activity).includes("acked-result-body")).length, 1);
      const actual = sends.find((packet) => JSON.stringify(packet.payload.activity).includes("acked-result-body"))!.payload.activity;
      assert.ok(object(actual) && Array.isArray(actual.attachments));
      const attachment = actual.attachments[0];
      assert.ok(object(attachment) && object(attachment.content) && Array.isArray(attachment.content.body));
      assert.equal(attachment.content.body[0]?.text, "acked-result-body", "relay must put the actual answer first, without a generic summary prefix");
      assert.equal(actual.text, undefined);
      assert.equal(actual.textFormat, undefined);
      assert.equal(combinedFailures, 0);
    } finally { await bridge.close(); }
  }, { acknowledgementMs: 300 });
});

test("relay sendResult definite rejection versus unknown connector outcome are distinguished and missing edits retain a recoverable 404", async (t) => {
  await loopback(t, async ({ relay, sockets, packets }) => {
    await relay.start(async () => undefined);
    const reference = validateTeamsOwnerActivity(mockEnvelope(), mockIdentity, true).reference;
    for (const [code, outcome] of [["FORBIDDEN", "rejected"], ["SEND_FAILED", "uncertain"], ["MESSAGE_NOT_FOUND", "rejected"]] as const) {
      const request = relay.send(reference, { type: "text", text: code });
      const rejects = assert.rejects(() => request, (error: unknown) => error instanceof DeliveryError &&
        error.outcome === outcome && !error.message.includes("secret-fixture") &&
        (code !== "MESSAGE_NOT_FOUND" || error.status === 404));
      const count = packets.length;
      await eventually(() => packets.length > count);
      sockets[0]!.emit("sendResult", {
        type: "sendResult", requestId: packets.at(-1)!.payload.requestId,
        error: { code, message: "do not log secret-fixture" },
      });
      await rejects;
    }
  });
});

test("credential/owner failure prevents any Socket.IO connection and never falls back to another bot or webhook", async (t) => {
  await loopback(t, async ({ relay, handshakes }) => {
    await assert.rejects(() => relay.start(async () => undefined), /unavailable/);
    assert.equal(relay.status, "signin-required");
    assert.equal(handshakes.length, 0);
  }, {}, { getToken: async () => { throw new MicrosoftSignInRequired(validateRelayConfig(source, trust)); } });
});

test("native relay owner rejection stops reconnect and repeated token rejection refreshes at most once without bot fallback", async (t) => {
  for (const rejection of ["NOT_OWNER", "INVALID_TOKEN"]) {
    await loopback(t, async ({ relay, server, handshakes, tokenRequests }) => {
      server.of("/twin").use((_socket, next) => next(new Error(rejection)));
      await assert.rejects(() => relay.start(async () => undefined),
        rejection === "NOT_OWNER" ? /binding/ : MicrosoftSignInRequired);
      assert.equal(relay.status, rejection === "NOT_OWNER" ? "rejected" : "signin-required");
      assert.equal(tokenRequests(), rejection === "NOT_OWNER" ? 1 : 2);
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(handshakes.length, 0);
      assert.equal(tokenRequests(), rejection === "NOT_OWNER" ? 1 : 2);
    });
  }
});

test("Submit cards round-trip through real relay message envelopes to the actual bridge and stale actions/delivery receipts stay durable", async (t) => {
  const directory = await temporary(t);
  await loopback(t, async ({ relay, sockets, packets, binding }) => {
    const runtime = new FakeRuntime(2);
    const store = await Store.open(directory, `relay-fixture:${binding.fingerprint}`);
    const bridge = new Bridge(store, runtime, relay, {
      owner: store.snapshot().owner, workspaces: [{ id: "local", name: "Local", path: directory }], coalesceMs: 2,
      cardActions: "submit", deliveryInitiallyPaused: true,
    });
    try {
      await bridge.start();
      await relay.start(async (turn) => { await bridge.handle(turn.key, turn.reference, turn.activity.id!, turn.incoming); });
      bridge.enableDelivery();
      let rejectText = false;
      sockets[0]!.on("sendActivity", (payload: Record<string, unknown>) => {
        const activity = payload.activity;
        const rejected = rejectText && object(activity) && typeof activity.text === "string";
        sockets[0]!.emit("sendResult", {
          type: "sendResult", requestId: payload.requestId,
          ...(rejected ? { error: { code: "FORBIDDEN" } } : { messageId: randomUUID() }),
        });
      });
      sockets[0]!.on("updateActivity", (payload: Record<string, unknown>) => {
        sockets[0]!.emit("sendResult", { type: "sendResult", requestId: payload.requestId, messageId: payload.messageId });
      });
      const original = mockEnvelope("!new");
      const turn = validateTeamsOwnerActivity(original, mockIdentity, true);
      sockets[0]!.emit("activity", activityEnvelope(original));
      await eventually(() => store.snapshot().conversations[turn.key]?.view === "new");
      const create = findAction(bridge.render(turn.key), "Create");
      assert.equal(create.type, "Action.Submit");
      assert.ok(object(create.data));
      assert.ok(!JSON.stringify(create).includes("Action.Execute"));
      const submission = {
        ...mockEnvelope(""), value: { ...create.data, sessionName: "Relay work", workspace: "local" },
      };
      sockets[0]!.emit("activity", activityEnvelope(submission));
      await eventually(() => Boolean(store.snapshot().conversations[turn.key]?.selectedId));
      const id = store.snapshot().conversations[turn.key]!.selectedId!;
      const exact = "  relay exact\r\nprompt \u{1f680}  ";
      const prompt = mockEnvelope(exact);
      sockets[0]!.emit("activity", activityEnvelope(prompt));
      sockets[0]!.emit("activity", activityEnvelope(prompt)); // Different relay IDs, same Teams ID.
      await eventually(() => runtime.received.length === 1 && store.snapshot().sessions[id]?.status === "idle");
      assert.equal(runtime.received[0]?.text, exact);
      await bridge.flush();
      sockets[0]!.emit("activity", activityEnvelope({ ...submission, id: randomUUID() }));
      await eventually(() => /stale|already used/i.test(store.snapshot().conversations[turn.key]!.notice));
      assert.equal(Object.values(store.snapshot().sessions).filter((record) => record.kind === "owned").length, 1);
      sockets[0]!.emit("activity", activityEnvelope(mockEnvelope("ask")));
      await eventually(() => store.snapshot().sessions[id]?.pending[0]?.kind === "input");
      const request = store.snapshot().sessions[id]!.pending[0]!;
      const answer = findAction(bridge.render(turn.key), "Answer");
      assert.equal(answer.type, "Action.Submit");
      assert.ok(object(answer.data));
      const answerEnvelope = {
        ...mockEnvelope(""), value: { ...answer.data, [`choice_${inputSuffix(request.id)}`]: "0" },
      };
      sockets[0]!.emit("activity", activityEnvelope(answerEnvelope));
      await eventually(() => runtime.answers.length === 1 && store.snapshot().sessions[id]?.status === "idle");
      assert.equal(runtime.answers[0]?.requestId, request.id);
      assert.equal(runtime.answers[0]?.answer.choice, 0);
      sockets[0]!.emit("activity", activityEnvelope({ ...answerEnvelope, id: randomUUID() }));
      await bridge.flush();
      assert.equal(runtime.answers.length, 1);
      sockets[0]!.emit("activity", activityEnvelope(mockEnvelope("permission")));
      await eventually(() => store.snapshot().sessions[id]?.pending[0]?.kind === "permission");
      const permissionId = store.snapshot().sessions[id]!.pending[0]!.id;
      const approval = findAction(bridge.render(turn.key), "Approve once");
      assert.equal(approval.type, "Action.Submit");
      sockets[0]!.emit("activity", activityEnvelope({ ...mockEnvelope(""), value: approval.data }));
      await eventually(() => runtime.answers.length === 2 && store.snapshot().sessions[id]?.status === "idle");
      assert.deepEqual(runtime.answers[1], { id, requestId: permissionId, answer: { approve: true } });
      sockets[0]!.emit("activity", activityEnvelope(mockEnvelope("error fixture awaiting a corrected final")));
      await eventually(() => store.snapshot().sessions[id]?.status === "error");
      const layoutBody = "| File |\r\n| --- |\r\n| [`Local`](<Q:\\MOCK\\source.rs#L1>) |\r\n\r\n[App](ghapp://session/synthetic)\r\n    `PROTECTED_0` 中文 🚀";
      runtime.emit(id, "assistant.message", { messageId: "xml-layout", phase: "final", content: layoutBody });
      await bridge.flush();
      const layoutPackets = packets.filter((item) => object(item.payload.activity) && typeof item.payload.activity.text === "string" &&
        item.payload.activity.text.includes("PROTECTED_0"));
      assert.equal(layoutPackets.length, 1);
      const layout = layoutPackets[0]!.payload.activity;
      assert.ok(object(layout) && typeof layout.text === "string");
      assert.equal(layout.textFormat, "xml");
      assert.ok(layout.text.includes("<br><br>") && layout.text.includes("&lt;Q:") && !layout.text.includes("<a"));
      assert.ok(Buffer.byteLength(JSON.stringify(layout)) <= 12_000);
      assert.equal(store.snapshot().outbox.find((item) => item.eventId === "xml-layout")?.text, layoutBody);
      rejectText = true;
      runtime.emit(id, "assistant.message", { messageId: "definite-rejection", phase: "final", content: "Retained even when relay rejects" });
      await bridge.flush();
      assert.equal(store.snapshot().outbox.at(-1)?.status, "rejected");
      const expected = `**Relay work** · ${id.slice(0, 8)}\n\nRetained even when relay rejects`;
      const count = packets.filter((item) => object(item.payload.activity) && item.payload.activity.text === expected &&
        item.payload.activity.textFormat === "markdown").length;
      assert.equal(count, 1);
      await bridge.flush();
      assert.equal(packets.filter((item) => object(item.payload.activity) && item.payload.activity.text === expected &&
        item.payload.activity.textFormat === "markdown").length, count);
    } finally { await bridge.close(); }
  }, { acknowledgementMs: 300 });
});

test("official isolated Copilot login flow uses native account APIs and never consents to plaintext token persistence", async () => {
  type Api = CopilotSession["rpc"]["accounts"]["login"];
  const calls: unknown[] = [];
  const displayed: string[] = [];
  const api: Api = {
    begin: async (request) => {
      calls.push(request);
      return { flowId: "native-login-fixture", step: { kind: "device-code", verificationUri: "https://github.com/login/device", userCode: "LOCAL-FIXTURE", expiresIn: 600, interval: 5 } };
    },
    advance: async (request) => { calls.push(request); return { kind: "completed", result: { status: "completed" } }; },
    cancel: async () => { throw new Error("Completed login should not be cancelled"); },
  };
  await nativeLoginFlow(api, "githubDotCom", { display: (value) => displayed.push(value), choose: async () => 0 });
  assert.deepEqual(calls[0], { kind: "githubDotCom", mode: "selectAccount", method: "device-code" });
  assert.deepEqual(calls[1], { flowId: "native-login-fixture" });
  assert.ok(displayed.some((value) => value.includes("LOCAL-FIXTURE")));
  let cancelled = false;
  const rejected: Api = {
    ...api, begin: async () => ({ flowId: "refuse-plaintext", step: { kind: "completed", result: { status: "needs-plaintext-consent" } } }),
    cancel: async () => { cancelled = true; },
  };
  await assert.rejects(() => nativeLoginFlow(rejected, "entra", { display: () => undefined, choose: async () => 0 }), /did not consent/);
  assert.equal(cancelled, true);
});

test("valid device/MFA login can complete after more than forty pending responses without wall-clock sleeps", async () => {
  type Api = CopilotSession["rpc"]["accounts"]["login"];
  let elapsed = 0;
  let advances = 0;
  let cancellations = 0;
  const api: Api = {
    begin: async () => ({
      flowId: "long-valid-login", step: {
        kind: "device-code", verificationUri: "https://github.com/login/device", userCode: "LOCAL-FIXTURE",
        expiresIn: 600, interval: 5,
      },
    }),
    advance: async () => ++advances > 80 ? { kind: "completed", result: { status: "completed" } } : { kind: "awaiting" },
    cancel: async () => { cancellations++; },
  };
  await nativeLoginFlow(api, "githubDotCom", { display: () => undefined, choose: async () => 0 }, {
    now: () => elapsed, wait: async (milliseconds) => { elapsed += milliseconds; },
  });
  assert.equal(advances, 81);
  assert.equal(elapsed, 40_000);
  assert.equal(cancellations, 0);
});

test("the native device-code expiry or login deadline cancels pending work without advancing plaintext-storage consent", async () => {
  type Api = CopilotSession["rpc"]["accounts"]["login"];
  for (const deviceExpiry of [undefined, 1]) {
    let elapsed = 0;
    let cancellations = 0;
    const advances: unknown[] = [];
    const api: Api = {
      begin: async () => ({
        flowId: "deadline-login",
        step: deviceExpiry === undefined ? { kind: "needs-interaction" } : {
          kind: "device-code", verificationUri: "https://github.com/login/device", userCode: "LOCAL-FIXTURE",
          expiresIn: deviceExpiry, interval: 5,
        },
      }),
      advance: async (request) => { advances.push(request); return { kind: "awaiting" }; },
      cancel: async ({ flowId }) => { assert.equal(flowId, "deadline-login"); cancellations++; },
    };
    await assert.rejects(() => nativeLoginFlow(api, "entra", { display: () => undefined, choose: async () => 0 }, {
      timeoutMs: 2000, now: () => elapsed, wait: async (milliseconds) => { elapsed += milliseconds; },
    }), /deadline expired/);
    assert.equal(elapsed, deviceExpiry === undefined ? 2000 : 1000);
    assert.equal(cancellations, 1);
    assert.ok(advances.every((request) => object(request) && request.input === undefined));
  }
});

test("a genuinely stalled native login RPC is cancelled at its real deadline and user cancellation remains scoped", async () => {
  type Api = CopilotSession["rpc"]["accounts"]["login"];
  for (const byUser of [false, true]) {
    let cancellations = 0;
    let consentInputs = 0;
    const controller = new AbortController();
    const api: Api = {
      begin: async () => ({ flowId: "stalled-login", step: { kind: "needs-interaction" } }),
      advance: async (request) => {
        if (request.input) consentInputs++;
        if (byUser) queueMicrotask(() => controller.abort());
        return new Promise(() => undefined);
      },
      cancel: async ({ flowId }) => { assert.equal(flowId, "stalled-login"); cancellations++; },
    };
    await assert.rejects(() => nativeLoginFlow(api, "entra", { display: () => undefined, choose: async () => 0 }, {
      timeoutMs: 25, signal: controller.signal,
    }), byUser ? /cancelled by the user/ : /deadline expired/);
    assert.equal(cancellations, 1);
    assert.equal(consentInputs, 0);
  }
});
