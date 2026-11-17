import express, { type ErrorRequestHandler } from "express";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import type { ConversationReference } from "@microsoft/agents-activity";
import { Bridge } from "./bridge.js";
import type { Card, Outbound, Transport } from "./domain.js";
import { FakeRuntime } from "./fake-runtime.js";
import { Store } from "./store.js";
import { validateTeamsOwnerActivity, type TeamsIdentity } from "./teams.js";
import { logError, publicError, UserError } from "./safety.js";
import { interactionDefaults } from "./interaction.js";

export const mockIdentity: TeamsIdentity = {
  tenantId: "11111111-1111-4111-a111-111111111111",
  ownerId: "22222222-2222-4222-a222-222222222222",
  appId: "33333333-3333-4333-a333-333333333333",
  serviceHosts: ["smba.trafficmanager.net"],
};

export function mockEnvelope(text = "!sessions"): Record<string, unknown> {
  return {
    type: "message", id: randomUUID(), timestamp: new Date().toISOString(), channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    from: { id: "29:mock-owner", aadObjectId: mockIdentity.ownerId, name: "Mock owner", role: "user" },
    recipient: { id: `28:${mockIdentity.appId}`, name: "MOCK Copilot bridge", role: "bot" },
    conversation: { id: "a:mock-private-conversation", conversationType: "personal", isGroup: false, tenantId: mockIdentity.tenantId },
    channelData: { tenant: { id: mockIdentity.tenantId } }, text,
  };
}

export interface PreviewMessage {
  id: string;
  message: Outbound;
}

export class PreviewTransport implements Transport {
  readonly connected = true;
  readonly messages = new Map<string, PreviewMessage>();
  readonly listeners = new Set<(message: PreviewMessage) => void>();

  async send(_reference: ConversationReference, message: Outbound): Promise<string> {
    const id = randomUUID();
    this.publish({ id, message });
    return id;
  }

  async update(_reference: ConversationReference, id: string, card: Card): Promise<void> {
    if (!this.messages.has(id)) throw new UserError("Mock dashboard activity no longer exists.", 404);
    this.publish({ id, message: { type: "card", card } });
  }

  private publish(message: PreviewMessage): void {
    this.messages.set(message.id, message);
    if (this.messages.size > 100) this.messages.delete(this.messages.keys().next().value!);
    for (const listener of this.listeners) listener(message);
  }
}

export interface Simulator {
  server: Server;
  bridge: Bridge;
  transport: PreviewTransport;
  port: number;
  token: string;
  close(): Promise<void>;
}

export async function startSimulator(options: { port: number; stateDirectory: string; workspace: string; tickMs?: number; interaction?: boolean }): Promise<Simulator> {
  const token = randomBytes(32).toString("base64url");
  const store = await Store.open(options.stateDirectory, `mock:${mockIdentity.tenantId}:${mockIdentity.ownerId}`);
  const transport = new PreviewTransport();
  const bridge = new Bridge(store, new FakeRuntime(options.tickMs, true, options.interaction !== false), transport, {
    owner: store.snapshot().owner,
    workspaces: [{ id: "local", name: "MOCK local workspace (no tools execute)", path: options.workspace }],
    coalesceMs: 200, cardActions: "submit",
    ...(options.interaction === false ? {} : { interaction: interactionDefaults }),
  });
  try { await bridge.start(); } catch (error) {
    await bridge.close();
    throw error;
  }
  const app = express();
  app.disable("x-powered-by");
  let actualPort = options.port;
  app.use((request, response, next) => {
    const host = request.headers.host;
    const allowed = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
    if (!host || !allowed.has(host) || !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) {
      response.status(403).json({ error: "MOCK simulator is loopback-only; host rebinding is rejected." });
      return;
    }
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) {
      response.status(403).json({ error: "Cross-origin mock requests are forbidden." });
      return;
    }
    response.set({
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    });
    next();
  });
  const assetRoot = resolve(import.meta.dirname, "..", "..", "src");
  app.get("/", (_request, response) => response.sendFile("preview.html", { root: assetRoot }));
  app.get("/preview.js", (_request, response) => response.sendFile("preview.js", { root: assetRoot }));
  app.get("/preview.css", (_request, response) => response.sendFile("preview.css", { root: assetRoot }));
  app.get("/health", (_request, response) => response.json({ status: "ready", mock: true, realTeamsSends: 0, realModelCalls: 0 }));
  app.get("/bootstrap", async (_request, response) => {
    const envelope = mockEnvelope("!home");
    const turn = validateTeamsOwnerActivity(envelope, mockIdentity, true);
    await bridge.handle(turn.key, turn.reference, randomUUID(), { kind: "text", text: "!home" });
    await bridge.flush();
    response.cookie("mockToken", token, { httpOnly: true, sameSite: "strict", path: "/" });
    response.json({ mock: true, token, template: mockEnvelope(""), messages: [...transport.messages.values()] });
  });
  const validToken = (value: unknown) => typeof value === "string" && value.length === token.length &&
    timingSafeEqual(Buffer.from(value), Buffer.from(token));
  app.get("/events", (request, response) => {
    const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("mockToken="))?.slice("mockToken=".length);
    if (!validToken(cookie)) { response.status(403).end(); return; }
    response.set({ "Content-Type": "text/event-stream", Connection: "keep-alive" });
    response.flushHeaders();
    const listener = (message: PreviewMessage) => response.write(`data: ${JSON.stringify(message)}\n\n`);
    transport.listeners.add(listener);
    request.once("close", () => transport.listeners.delete(listener));
  });
  app.post("/activity", express.json({ limit: "128kb" }), async (request, response) => {
    if (!validToken(request.headers["x-simulator-token"])) throw new UserError("Missing simulator CSRF token.", 403);
    const turn = validateTeamsOwnerActivity(request.body, mockIdentity, true);
    const card = await bridge.handle(turn.key, turn.reference, turn.activity.id!, turn.incoming);
    await bridge.flush();
    response.json({
      mock: true, status: 200,
      body: { statusCode: 200, type: "application/vnd.microsoft.card.adaptive", value: card },
    });
  });
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    logError("simulator-http", error);
    if (!response.headersSent) response.status(error instanceof UserError ? error.status : 500).json({ error: publicError(error), mock: true });
  };
  app.use(errors);
  const server = await new Promise<Server>((fulfill, reject) => {
    const server = app.listen(options.port, "127.0.0.1", () => fulfill(server));
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Simulator did not bind TCP");
  actualPort = address.port;
  return {
    server, bridge, transport, port: actualPort, token,
    async close() {
      transport.listeners.clear();
      server.closeAllConnections();
      await new Promise<void>((fulfill, reject) => server.close((error) => error ? reject(error) : fulfill()));
      await bridge.close();
    },
  };
}

async function main(): Promise<void> {
  const port = Number(process.env.SIMULATOR_PORT ?? "3979");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError("SIMULATOR_PORT must be 1-65535.");
  const simulator = await startSimulator({
    port, stateDirectory: resolve(process.env.SIMULATOR_STATE_DIRECTORY ?? ".bridge\\simulator"), workspace: process.cwd(),
  });
  console.log(`MOCK ONLY - no real Copilot model calls or Teams sends.\nPreview: http://127.0.0.1:${simulator.port}\nScenarios: ordinary text, ask, permission, plan, background, long, error. Commands: !sessions, !use <name or ID>, !history, !status, !subscribe, !unsubscribe, !help.`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    simulator.close().catch((error: unknown) => { logError("simulator-close", error); process.exitCode = 1; });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { logError("simulator-start", error); console.error(publicError(error)); process.exitCode = 1; });
}
