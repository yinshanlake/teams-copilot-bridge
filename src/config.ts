import { isAbsolute, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { Workspace } from "./domain.js";
import type { NativeOptions } from "./native.js";
import type { TeamsIdentity } from "./teams.js";
import { canonicalId, object, string, UserError } from "./safety.js";
import { readRelayBundle, type RelayBinding } from "./relay-config.js";

interface CommonConfig {
  identity: TeamsIdentity;
  stateDirectory: string;
  workspaces: Workspace[];
  host: string;
  port: number;
  native: NativeOptions;
}

export type Config = CommonConfig & (
  { transport: "relay"; relay: RelayBinding } |
  { transport: "webhook"; clientSecret: string }
);

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value || value.includes("REPLACE_")) throw new UserError(`Missing prerequisite: ${name}. See .env.example; production never falls back to mock.`);
  return value;
}

export async function configuration(environment: NodeJS.ProcessEnv, cwd = process.cwd()): Promise<Config> {
  const transport = environment.BRIDGE_TRANSPORT ?? "relay";
  if (transport !== "relay" && transport !== "webhook") throw new UserError("BRIDGE_TRANSPORT must explicitly select relay (default) or webhook. No fallback is performed.");
  const relay = transport === "relay" ? await readRelayBundle(resolve(cwd, required(environment, "BRIDGE_RELAY_CONFIG")), {
    botAppId: required(environment, "BRIDGE_BOT_APP_ID"),
    origin: required(environment, "BRIDGE_RELAY_ORIGIN"),
    forbiddenBotIds: (environment.BRIDGE_FORBIDDEN_BOT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
    ...(environment.TEAMS_OWNER_OBJECT_ID ? { ownerOid: environment.TEAMS_OWNER_OBJECT_ID } : {}),
    ...(environment.TEAMS_TENANT_ID ? { tenantId: environment.TEAMS_TENANT_ID } : {}),
  }) : undefined;
  const appId = relay?.botAppId ?? required(environment, "TEAMS_APP_ID").toLowerCase();
  const tenantId = relay?.aadTenantId ?? required(environment, "TEAMS_TENANT_ID").toLowerCase();
  const ownerId = relay?.ownerOid ?? required(environment, "TEAMS_OWNER_OBJECT_ID").toLowerCase();
  if (![appId, tenantId, ownerId].every(canonicalId)) throw new UserError("Teams app, tenant and owner IDs must be full GUIDs.");
  const stateDirectory = botStateDirectory(environment, appId, cwd);
  const port = Number(environment.PORT ?? "3978");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError("PORT must be 1-65535.");
  const serviceHosts = (environment.TEAMS_SERVICE_HOSTS ?? "smba.trafficmanager.net,smba.infra.teams.microsoft.com")
    .split(",").map((host) => host.trim().toLowerCase());
  if (!serviceHosts.length || serviceHosts.some((host) => !/^[a-z0-9.-]+$/.test(host) || host === "localhost" || /^\d/.test(host))) {
    throw new UserError("TEAMS_SERVICE_HOSTS requires exact trusted Teams HTTPS host names, not wildcards or IPs.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(required(environment, "BRIDGE_WORKSPACES")); } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError("BRIDGE_WORKSPACES must be a JSON array of {id,name,path}.");
  }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 20) throw new UserError("Configure 1-20 allowed workspaces.");
  const workspaces: Workspace[] = [];
  for (const workspace of parsed) {
    if (!object(workspace) || !string(workspace.id, 50) || !/^[\w-]+$/.test(workspace.id) ||
      !string(workspace.name, 100) || !string(workspace.path, 1024) || !isAbsolute(workspace.path) ||
      workspaces.some((item) => item.id === workspace.id)) throw new UserError("Invalid/duplicate workspace configuration; paths must be absolute.");
    let path: string;
    try {
      path = await realpath(workspace.path);
      if (!(await stat(path)).isDirectory()) throw new UserError(`Allowed workspace '${workspace.id}' is not a directory.`);
    } catch (error) {
      if (error instanceof UserError) throw error;
      if (object(error) && ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(String(error.code))) {
        throw new UserError(`Allowed workspace '${workspace.id}' does not exist or cannot be read.`);
      }
      throw error;
    }
    workspaces.push({ id: workspace.id, name: workspace.name, path });
  }
  const native = nativeConfiguration(environment, stateDirectory, cwd);
  const common = { identity: { appId, tenantId, ownerId, serviceHosts }, stateDirectory, workspaces, host: environment.BIND_HOST ?? "127.0.0.1", port, native };
  return relay ? { ...common, transport: "relay", relay } : { ...common, transport: "webhook", clientSecret: required(environment, "TEAMS_APP_SECRET") };
}

export function botStateDirectory(environment: NodeJS.ProcessEnv, botAppId: string, cwd: string): string {
  if (!canonicalId(botAppId)) throw new UserError("BRIDGE_BOT_APP_ID must explicitly confirm the new bot GUID.");
  return resolve(cwd, environment.BRIDGE_STATE_DIRECTORY ?? ".bridge", "bots", botAppId.toLowerCase());
}

export function nativeCliConfiguration(environment: NodeJS.ProcessEnv, cwd = process.cwd()): NativeOptions {
  const mode = environment.BRIDGE_TRANSPORT ?? "relay";
  if (mode !== "relay" && mode !== "webhook") throw new UserError("BRIDGE_TRANSPORT must be relay or webhook.");
  const appId = required(environment, mode === "webhook" ? "TEAMS_APP_ID" : "BRIDGE_BOT_APP_ID");
  return nativeConfiguration(environment, botStateDirectory(environment, appId, cwd), cwd, true);
}

export function nativeConfiguration(environment: NodeJS.ProcessEnv, stateDirectory: string, cwd: string, catalogueOnly = false): NativeOptions {
  const auth = environment.COPILOT_AUTH ?? "logged-in-user";
  if (auth !== "logged-in-user" && auth !== "token" && auth !== "runtime") throw new UserError("COPILOT_AUTH must be logged-in-user (default), token or runtime.");
  if ((auth !== "token" && environment.COPILOT_GITHUB_TOKEN) ||
    (auth !== "runtime" && (environment.COPILOT_RUNTIME_URI || environment.COPILOT_RUNTIME_TOKEN))) {
    throw new UserError("Native authentication alternatives require an explicit COPILOT_AUTH choice; no ambient token/URI fallback is allowed.");
  }
  const appSessions = environment.COPILOT_APP_SESSIONS ?? "true";
  if (!["true", "false"].includes(appSessions)) throw new UserError("COPILOT_APP_SESSIONS must be true or false.");
  const sessionStateDirectory = environment.COPILOT_APP_SESSION_STATE_DIRECTORY;
  const brokerDirectory = environment.COPILOT_APP_BROKER_DIRECTORY;
  const metadataDatabasePath = environment.COPILOT_APP_METADATA_DB;
  if (sessionStateDirectory && !isAbsolute(sessionStateDirectory)) {
    throw new UserError("COPILOT_APP_SESSION_STATE_DIRECTORY must be an explicit absolute path.");
  }
  if (brokerDirectory && !isAbsolute(brokerDirectory)) {
    throw new UserError("COPILOT_APP_BROKER_DIRECTORY must be an explicit absolute path.");
  }
  const endpointTimeout = Number(environment.COPILOT_APP_ENDPOINT_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(endpointTimeout) || endpointTimeout < 100 || endpointTimeout > 30_000) {
    throw new UserError("COPILOT_APP_ENDPOINT_TIMEOUT_MS must be 100-30000.");
  }
  const native: NativeOptions = {
    auth,
    home: resolve(stateDirectory, "native"),
    configDirectory: environment.COPILOT_PEER_CONFIG_DIRECTORY
      ? resolve(cwd, environment.COPILOT_PEER_CONFIG_DIRECTORY) : resolve(stateDirectory, "native"),
    defaultModel: catalogueOnly ? "" : environment.COPILOT_DEFAULT_MODEL ?? "",
    peers: environment.COPILOT_ENABLE_PEERS === "true",
    ...(!catalogueOnly && appSessions === "true" ? {
      appSessions: {
        timeoutMs: endpointTimeout,
        ...(sessionStateDirectory ? { sessionStateDirectory } : {}),
        ...(brokerDirectory ? { brokerDirectory } : {}),
        ...(metadataDatabasePath ? { metadataDatabasePath } : {}),
      },
    } : {}),
    ...(auth === "runtime" ? {
      runtimeUri: required(environment, "COPILOT_RUNTIME_URI"), runtimeToken: required(environment, "COPILOT_RUNTIME_TOKEN"),
    } : auth === "token" ? { token: required(environment, "COPILOT_GITHUB_TOKEN") } : {}),
    ...(environment.COPILOT_CLI_PATH ? { cliPath: environment.COPILOT_CLI_PATH } : {}),
  };
  if (environment.COPILOT_ENABLE_PEERS !== undefined && !["true", "false"].includes(environment.COPILOT_ENABLE_PEERS)) {
    throw new UserError("COPILOT_ENABLE_PEERS must be true or false.");
  }
  return native;
}
