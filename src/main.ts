import { Bridge } from "./bridge.js";
import { configuration } from "./config.js";
import { NativeRuntime, nativeClientOptions } from "./native.js";
import { Store } from "./store.js";
import { createProductionApp, createTeamsAdapter, TeamsTransport } from "./teams.js";
import { logError, protectSecrets, publicError } from "./safety.js";
import { AzureRelayTokenSource } from "./relay-auth.js";
import { RelayConnection } from "./relay.js";
import express from "express";
import { digest } from "./safety.js";

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("Copilot Teams client\nCopy .env.example and configure your own Bot, tenant, owner and workspace. The example explicitly selects the authenticated direct webhook; no shared relay is required.\nnpm start -- --check  (offline configuration validation; no Bot, SDK or endpoint startup)\nnpm start            (start the configured backend; webhook POST /api/messages)\nNative Teams compose text goes unchanged to the selected source. Management: !sessions, !use <name or ID>, !history [1..50], !status, !subscribe, !unsubscribe, !help.\nExisting-session writes require the endpoint extension loaded in the original compatible host; see extensions/teams-session-endpoint/README.md.\nThe private SDK starts only for explicit Bot-owned operations or advanced !control <instruction>; views never redirect ordinary text.\nnpm run login:copilot (official native login for this isolated bot profile)\nnpm run models       (live model catalogue, no inference or App discovery)\nBRIDGE_TRANSPORT=relay selects the optional trusted-relay integration. An unset transport retains the legacy relay default; use the explicit .env.example settings.\nnpm run simulate     (separate loopback-only MOCK with Submit cards; no cloud/Teams calls)");
    return;
  }
  const config = await configuration(process.env);
  const legacyCoordinatorIgnored = Boolean(process.env.COPILOT_APP_COORDINATOR_DIRECTORY || process.env.COPILOT_APP_COORDINATOR_SESSION_ID);
  if (legacyCoordinatorIgnored) console.error(JSON.stringify({
    area: "app-session-configuration", code: "LEGACY_COORDINATOR_IGNORED",
    detail: "Local directory and endpoint code replace the coordinator queue. No coordinator request will be written.",
  }));
  protectSecrets([config.transport === "webhook" ? config.clientSecret : undefined, config.native.token, config.native.runtimeToken]);
  nativeClientOptions(config.native);
  if (process.argv.includes("--check")) {
    console.log(JSON.stringify({
      configuration: "valid", mock: false, transport: config.transport, botAppId: config.identity.appId,
      stateDirectory: config.stateDirectory, host: config.host, port: config.port,
      nativeAuth: config.native.auth, allowedWorkspaces: config.workspaces.length, nativePeers: config.native.peers,
      nativeStartup: "lazy", nativeModelConfigured: Boolean(config.native.defaultModel),
      stateSchema: 5, interactionMode: "focus",
      remoteApprovals: config.interaction.remoteApprovals, approvalTimeoutMs: config.interaction.approvalTimeoutMs,
      appSessions: Boolean(config.native.appSessions), legacyCoordinatorIgnored,
      ...(config.transport === "relay" ? { relayOrigin: config.relay.relayUrl, relayBinding: config.relay.fingerprint, connected: false } : {}),
    }));
    return;
  }
  const binding = config.transport === "relay" ? config.relay.fingerprint : digest(`webhook:${config.identity.appId}`);
  const owner = `${config.identity.tenantId}:${config.identity.ownerId}:${config.identity.appId}:${binding}`;
  const store = await Store.open(config.stateDirectory, owner);
  let relay: RelayConnection | undefined;
  let bridge: Bridge;
  let app: express.Express;
  if (config.transport === "relay") {
    relay = new RelayConnection(config.relay, config.identity, new AzureRelayTokenSource(config.relay), {
      onStatus: (status) => console.log(JSON.stringify({ transport: "relay", status })),
    });
    bridge = new Bridge(store, new NativeRuntime(config.native), relay, {
      owner, workspaces: config.workspaces, coalesceMs: 1200, cardActions: "submit", deliveryInitiallyPaused: true,
      interaction: config.interaction,
    });
    app = express();
    app.disable("x-powered-by");
    app.get("/health", (_request, response) => response.status(bridge.healthy && relay?.connected ? 200 : 503).json({
      status: bridge.healthy && relay?.connected ? "ready" : "not-ready", transport: "relay", relay: relay?.status, mock: false,
    }));
  } else {
    const adapter = createTeamsAdapter(config.identity, config.clientSecret);
    const transport = new TeamsTransport(config.identity, (reference, logic) =>
      adapter.continueConversation(config.identity.appId, reference, logic));
    bridge = new Bridge(store, new NativeRuntime(config.native), transport, {
      owner, workspaces: config.workspaces, coalesceMs: 1200, cardActions: "execute",
      interaction: config.interaction,
    });
    app = createProductionApp(config.identity, config.clientSecret, adapter, bridge);
  }
  try {
    await bridge.start();
    if (relay) {
      await relay.start(async (turn) => {
        // Dedup uses the original Teams activity ID, not the relay envelope ID,
        // so a relay redelivery with a new envelope cannot replay work.
        await bridge.handle(turn.key, turn.reference, turn.activity.id!, turn.incoming);
      });
      bridge.enableDelivery();
    }
  } catch (error) {
    await relay?.close();
    await bridge.close();
    throw error;
  }
  const server = app.listen(config.port, config.host, () => console.log(
    config.transport === "relay"
      ? `New-bot relay connected. Local health: http://${config.host}:${config.port}/health. No public webhook or tunnel is required.`
      : `Explicit direct-webhook mode listening on ${config.host}:${config.port}. No simulator routes.`));
  let stopping = false;
  const shutdown = (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      Promise.resolve().then(() => relay?.close()).then(() => bridge.close()).then(() => { process.exitCode = exitCode; }).catch((error: unknown) => {
        logError("shutdown", error); process.exitCode = 1;
      });
    });
  };
  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
  server.once("error", (error) => {
    logError("listen", error);
    shutdown(1);
  });
}

main().catch((error: unknown) => {
  logError("startup", error);
  console.error(publicError(error));
  process.exitCode = 1;
});
