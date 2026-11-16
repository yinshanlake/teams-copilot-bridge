import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection, type CopilotSession, type SessionConfig, type SessionEvent } from "@github/copilot-sdk";
import { childEnvironment } from "../src/native.js";
import { Projector } from "../src/projection.js";
import type { SessionRecord } from "../src/domain.js";
import { object } from "../src/safety.js";

// This entrypoint intentionally uses one isolated native runtime, never the App
// runtime, ambient login, real Teams, or an external inference endpoint.
async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "copilot-teams-native-smoke-"));
  const model = "gpt-4o";
  let requests = 0;
  let blockedNetwork = 0;
  let invalidRequests = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions" ||
      !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) {
      invalidRequests++;
      response.writeHead(403).end();
      return;
    }
    let bytes = 0;
    request.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2_000_000) request.destroy(); });
    request.on("end", () => {
      requests++;
      const callId = `local-${requests}`;
      const toolRequest = requests === 1 || requests === 3;
      const delta = toolRequest ? {
        role: "assistant", tool_calls: [{
          index: 0, id: "local-ask", type: "function",
          function: requests === 1
            ? { name: "ask_user", arguments: JSON.stringify({ question: "Offline native smoke: continue?", choices: ["Proceed", "Stop"] }) }
            : { name: "bridge_list", arguments: "{}" },
        }],
      } : { role: "assistant", content: "Offline native smoke finished." };
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      response.write(`data: ${JSON.stringify({
        id: callId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: callId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: {}, finish_reason: toolRequest ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })}\n\ndata: [DONE]\n\n`);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const reservedAddress = reservation.address();
  assert.ok(reservedAddress && typeof reservedAddress !== "string");
  const runtimePort = reservedAddress.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const connectionToken = randomUUID();
  const client = new CopilotClient({
    mode: "empty", baseDirectory: home, useLoggedInUser: false, env: childEnvironment(process.env),
    logLevel: "error",
    connection: RuntimeConnection.forTcp({ port: runtimePort, connectionToken }),
    onListModels: () => [{
      id: model, name: "Local scripted smoke fixture",
      capabilities: {
        supports: { vision: false, reasoningEffort: true },
        limits: { max_context_window_tokens: 128_000 },
      }, supportedReasoningEfforts: ["low", "high"],
    }],
    network: {
      scope: "runtime",
      resolveProxy: () => {
        blockedNetwork++;
        throw new Error("Non-loopback networking is forbidden in native smoke.");
      },
    },
  });
  const id = randomUUID();
  const events: SessionEvent[] = [];
  const callbackIds: string[] = [];
  const projector = new Projector();
  const projection: SessionRecord = {
    id, name: "Native offline smoke", kind: "owned", status: "idle", workspace: home,
    capability: "Offline smoke", timeline: [], pending: [], seenEvents: [], sequence: 0, updatedAt: 0,
  };
  const config: SessionConfig = {
    sessionId: id, name: "Teams native offline smoke", workingDirectory: home, configDirectory: home,
    model, provider: { type: "openai", wireApi: "completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-scripted-not-a-real-key" },
    availableTools: ["builtin:ask_user"], permissionMode: "manual", enableConfigDiscovery: false,
    enableSessionTelemetry: false, enableExperimentalMode: false, reasoningSummary: "none", streaming: true,
    onPermissionRequest: () => ({ kind: "reject", feedback: "Offline smoke never authorizes tools." }),
    onUserInputRequest: (request, invocation) => {
      assert.equal(invocation.sessionId, id);
      assert.ok(request.requestId);
      assert.equal(request.choices?.[0], "Proceed");
      callbackIds.push(request.requestId);
      return { answer: "Proceed", wasFreeform: false };
    },
    onEvent: (event) => {
      events.push(event);
      projector.apply(projection, event);
    },
  };
  let session: CopilotSession | undefined;
  let resumed: CopilotSession | undefined;
  let attached: CopilotClient | undefined;
  let controller: CopilotSession | undefined;
  try {
    await client.start();
    const status = await client.getStatus();
    session = await client.createSession(config);
    assert.equal(session.sessionId, id);
    attached = new CopilotClient({
      mode: "empty", baseDirectory: home, logLevel: "error",
      connection: RuntimeConnection.forUri(`127.0.0.1:${runtimePort}`, { connectionToken }),
    });
    await attached.start();
    assert.equal((await attached.ping("existing-runtime")).message, "pong: existing-runtime");
    const freshId = randomUUID();
    const fresh = await attached.createSession({
      sessionId: freshId, name: "Teams explicit URI fresh-session smoke", model,
      provider: config.provider!, configDirectory: home, workingDirectory: home,
      availableTools: [], permissionMode: "manual", enableSessionTelemetry: false, enableConfigDiscovery: false,
      onPermissionRequest: () => ({ kind: "reject", feedback: "Offline smoke denies execution." }),
    });
    assert.equal(fresh.sessionId, freshId);
    assert.equal((await fresh.rpc.model.getCurrent()).modelId, model);
    await fresh.disconnect();
    assert.deepEqual(await attached.stop(), []);
    attached = undefined;
    assert.equal((await session.rpc.permissions.getMode()).mode, "manual");
    const required = await session.rpc.permissions.setRequired({ required: true, providerId: "teams-native-smoke" });
    assert.equal(required.success, true);
    assert.equal(await session.rpc.mode.get(), "interactive");
    await session.rpc.mode.set({ mode: "plan" });
    assert.equal(await session.rpc.mode.get(), "plan");
    await session.rpc.mode.set({ mode: "interactive" });
    await session.setModel(model, { reasoningEffort: "high" });
    const current = await session.rpc.model.getCurrent();
    assert.equal(current.modelId, model);
    assert.equal(current.reasoningEffort, "high");
    await session.sendAndWait({ prompt: "Run the local scripted ask_user smoke, then report the fixture result." }, 45_000);
    assert.equal(requests, 2);
    assert.equal(callbackIds.length, 1);
    assert.ok(events.some((event) => event.type === "tool.execution_start"));
    assert.ok(events.some((event) => event.type === "user_input.requested"));
    assert.ok(events.some((event) => event.type === "user_input.completed"));
    assert.ok(events.some((event) => event.type === "tool.execution_complete"));
    assert.ok(projection.timeline.some((entry) => entry.kind === "assistant" && entry.text.includes("Offline native smoke finished.")));
    const stale = await session.rpc.ui.handlePendingUserInput({
      requestId: callbackIds[0]!, response: { answer: "Stop", wasFreeform: false },
    });
    assert.equal(stale.success, false);
    let controlToolCalls = 0;
    let controllerPermissionRequests = 0;
    controller = await client.createSession({
      sessionId: randomUUID(), name: "Teams bounded controller smoke", model, provider: config.provider!,
      workingDirectory: home, configDirectory: home, permissionMode: "manual", enableSessionTelemetry: false,
      streaming: true,
      availableTools: ["custom:bridge_list"], excludedTools: ["builtin:*", "mcp:*"], includedBuiltinAgents: [],
      tools: [{
        name: "bridge_list", description: "List bounded fixture metadata", skipPermission: true, defer: "never",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: () => { controlToolCalls++; return { sessions: [], mock: true }; },
      }],
      onPermissionRequest: () => {
        controllerPermissionRequests++;
        return { kind: "reject", feedback: "Controller execution is forbidden." };
      },
    });
    await controller.sendAndWait({ prompt: "Call the bounded bridge_list fixture tool, then finish." }, 45_000);
    assert.equal(controlToolCalls, 1);
    assert.equal(controllerPermissionRequests, 0);
    assert.equal(requests, 4);
    await controller.disconnect();
    controller = undefined;
    await session.abort();
    await session.disconnect();
    session = undefined;
    const locks = await client.rpc.sessions.checkInUse({ sessionIds: [id] });
    assert.deepEqual(locks.inUse, []);
    const { sessionId: _sessionId, name: _name, ...resumeConfig } = config;
    resumed = await client.resumeSession(id, { ...resumeConfig, continuePendingWork: false, allowTranscriptRecovery: false });
    const history = await resumed.getEvents();
    assert.ok(history.some((event) => event.type === "assistant.message" && event.data.content.includes("Offline native smoke finished.")));
    assert.equal(invalidRequests, 0);
    console.log(JSON.stringify({
      sdk: "1.0.31", runtime: status.version, protocol: status.protocolVersion,
      localScriptedModelCalls: requests, realCloudModelCalls: 0, realTeamsSends: 0,
      rejectedNonLoopbackAttempts: blockedNetwork,
      nativeInputIds: callbackIds.length, staleAnswerRejected: true, modeReadback: "interactive",
      modelReadback: current.modelId, effortReadback: current.reasoningEffort,
      historyPreservedOnResume: true, projectedNativeEvents: projection.sequence,
      existingRuntimeUriConnected: true, foreignSessionReattachments: 0,
      boundedControllerToolCalls: controlToolCalls, controllerExecutionPermissionRequests: controllerPermissionRequests,
    }, null, 2));
  } finally {
    if (session) await session.disconnect();
    if (resumed) await resumed.disconnect();
    if (controller) await controller.disconnect();
    if (attached) await attached.stop();
    const errors = await client.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "Native runtime cleanup failed");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Native smoke failed");
  if (object(error) && "code" in error) console.error(`Code: ${String(error.code)}`);
  process.exitCode = 1;
});
