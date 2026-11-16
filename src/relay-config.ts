import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { isIP } from "node:net";
import { ZipReader, Uint8ArrayReader } from "@zip.js/zip.js";
import { canonicalId, digest, object, string, UserError } from "./safety.js";

export interface RelayBinding {
  version: 1;
  botAppId: string;
  ownerOid: string;
  aadTenantId: string;
  relayUrl: string;
  relayPublicBaseUrl?: string;
  aadAudience: string;
  aadScope: string;
  credentialScope: string;
  fingerprint: string;
}

export interface RelayTrust {
  botAppId: string;
  origin: string;
  forbiddenBotIds?: string[];
  ownerOid?: string;
  tenantId?: string;
}

export function relayOrigin(value: unknown): string {
  if (!string(value, 2048)) throw new UserError("Relay origin must be an explicitly trusted HTTPS origin.");
  let url: URL;
  try { url = new URL(value); } catch { throw new UserError("Relay origin is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    url.pathname !== "/" || (url.port && url.port !== "443") || isIP(url.hostname) ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z][a-z0-9-]+$/i.test(url.hostname) ||
    url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) {
    throw new UserError("Relay requires a trusted public DNS HTTPS origin without path, credentials or custom port.");
  }
  return url.origin;
}

function bundleRelayOrigin(value: unknown): string {
  if (!string(value, 2048)) return relayOrigin(value);
  let url: URL;
  try { url = new URL(value); } catch { throw new UserError("Relay origin is invalid."); }
  if (url.protocol === "wss:") url.protocol = "https:";
  return relayOrigin(url.href);
}

export function validateRelayConfig(value: unknown, trust: RelayTrust): RelayBinding {
  if (!canonicalId(trust.botAppId) || !Array.isArray(trust.forbiddenBotIds ?? []) ||
    (trust.forbiddenBotIds ?? []).some((id) => !canonicalId(id))) {
    throw new UserError("Confirm the NEW bot's full BRIDGE_BOT_APP_ID; forbidden IDs must also be full GUIDs.");
  }
  if (!object(value) || value.version !== 1 || !canonicalId(value.botAppId) ||
    !canonicalId(value.ownerOid) || !canonicalId(value.aadTenantId)) {
    throw new UserError("Relay config version 1 requires full botAppId, ownerOid and aadTenantId GUIDs.");
  }
  const botAppId = value.botAppId.toLowerCase();
  const ownerOid = value.ownerOid.toLowerCase();
  const aadTenantId = value.aadTenantId.toLowerCase();
  if (botAppId !== trust.botAppId.toLowerCase() || trust.forbiddenBotIds?.some((id) => id.toLowerCase() === botAppId)) {
    throw new UserError("Bundle bot identity is not the confirmed new bot or is explicitly forbidden. No relay connection was attempted.");
  }
  if ((trust.ownerOid && ownerOid !== trust.ownerOid.toLowerCase()) ||
    (trust.tenantId && aadTenantId !== trust.tenantId.toLowerCase())) {
    throw new UserError("Relay bundle owner/tenant does not match the operator's explicit binding.");
  }
  const origin = relayOrigin(trust.origin);
  if (bundleRelayOrigin(value.relayUrl) !== origin ||
    (value.relayPublicBaseUrl !== undefined && relayOrigin(value.relayPublicBaseUrl) !== origin)) {
    throw new UserError("Bundle relay URLs do not match BRIDGE_RELAY_ORIGIN; the bundle cannot choose its own token destination.");
  }
  const resourceId = typeof value.aadAudience === "string" && value.aadAudience.startsWith("api://")
    ? value.aadAudience.slice(6) : value.aadAudience;
  if (!canonicalId(resourceId)) {
    throw new UserError("Twin-compatible aadAudience must be a relay resource GUID or api://<relay-resource-GUID>.");
  }
  const aadAudience = `api://${resourceId.toLowerCase()}`;
  if (typeof value.aadScope !== "string" || !/^api:\/\/[0-9a-fA-F-]{36}\/(?:twin\.connect|\.default)$/.test(value.aadScope) ||
    ![`${aadAudience}/twin.connect`, `${aadAudience}/.default`].includes(value.aadScope.toLowerCase())) {
    throw new UserError("aadScope must be this relay audience's /twin.connect or /.default scope.");
  }
  const fields = {
    version: 1 as const, botAppId, ownerOid, aadTenantId, relayUrl: origin,
    ...(value.relayPublicBaseUrl === undefined ? {} : { relayPublicBaseUrl: origin }),
    aadAudience, aadScope: value.aadScope.toLowerCase(), credentialScope: `${aadAudience}/.default`,
  };
  return { ...fields, fingerprint: digest(JSON.stringify(fields)) };
}

export async function readRelayBundle(path: string, trust: RelayTrust): Promise<RelayBinding> {
  if (resolve(path).split(/[\\/]/).some((component) => component.toLowerCase() === ".twin")) {
    throw new UserError("Do not import the installed Twin's configuration. Provide a separate new-bot bundle/config.");
  }
  let absolute: string;
  try { absolute = await realpath(resolve(path)); } catch (error) {
    if (object(error) && ["ENOENT", "EACCES", "EPERM"].includes(String(error.code))) {
      throw new UserError("The explicit BRIDGE_RELAY_CONFIG new-bot bundle/config is missing or unreadable. No installed Twin configuration will be discovered.");
    }
    throw error;
  }
  if (absolute.split(/[\\/]/).some((component) => component.toLowerCase() === ".twin")) {
    throw new UserError("Do not import the installed Twin's configuration. Provide a separate new-bot bundle/config.");
  }
  if ((await stat(absolute)).size > 2 * 1024 * 1024) throw new UserError("Relay bundle exceeds the 2 MiB limit.");
  const data = await readFile(absolute);
  let json: string;
  if (extname(absolute).toLowerCase() === ".zip") {
    const reader = new ZipReader(new Uint8ArrayReader(data), { useWebWorkers: false });
    try {
      const entries = await reader.getEntries();
      const candidates = entries.filter((entry) => entry.filename === "twin-config.json" && !entry.directory);
      if (entries.length > 32 || candidates.length !== 1) throw new UserError("Bundle needs exactly one root twin-config.json and at most 32 entries.");
      const entry = candidates[0]!;
      if (entry.directory || !entry.getData || entry.encrypted || entry.uncompressedSize > 32 * 1024) {
        throw new UserError("Relay config must be unencrypted and at most 32 KiB.");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      await entry.getData(new WritableStream<Uint8Array>({
        write(chunk) {
          size += chunk.length;
          if (size > 32 * 1024) throw new UserError("Inflated relay config exceeds 32 KiB.");
          chunks.push(Buffer.from(chunk));
        },
      }), { checkSignature: true, useWebWorkers: false });
      json = Buffer.concat(chunks).toString("utf8");
    } finally { await reader.close(); }
  } else if (extname(absolute).toLowerCase() === ".json") {
    if (data.length > 32 * 1024) throw new UserError("Relay config exceeds the 32 KiB limit.");
    json = data.toString("utf8");
  } else throw new UserError("BRIDGE_RELAY_CONFIG must explicitly identify a new-bot .zip or .json file.");
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new UserError("Relay config is not valid JSON."); }
  return validateRelayConfig(parsed, trust);
}
