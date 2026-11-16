// Extension: teams-session-endpoint
// Expose the current Copilot App session to the owner-only local Teams broker.

import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import {
    mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const root = join(homedir(), ".copilot", "teams-session-broker");
const configPath = join(root, "config.json");
const sessionsDirectory = join(root, "sessions");
const requestsRoot = join(root, "requests");
const processingRoot = join(root, "processing");
const responsesRoot = join(root, "responses");
const failedRoot = join(root, "failed");
const staging = join(root, "staging");
const maximumRequestBytes = 32 * 1024;
const maximumMessageBytes = 16 * 1024;

const boundedJson = async (path, maximumBytes = maximumRequestBytes) => {
    const file = await stat(path);
    if (!file.isFile() || file.size > maximumBytes) throw new Error("BROKER_JSON_BOUND");
    return JSON.parse(await readFile(path, "utf8"));
};

const config = await boundedJson(configPath);
if (config?.schema !== 1 || !Array.isArray(config.operations) ||
    !config.operations.includes("send_message")) {
    throw new Error("Session endpoint broker config is invalid.");
}
await realpath(root);

const session = await joinSession({ tools: [] });
if (!guid.test(session.sessionId)) throw new Error("Current session ID is invalid.");

const sessionId = session.sessionId.toLowerCase();
const instanceId = randomUUID();
const requestDirectory = join(requestsRoot, sessionId);
const processingDirectory = join(processingRoot, sessionId);
const responseDirectory = join(responsesRoot, sessionId);
const failedDirectory = join(failedRoot, sessionId);
const registrationPath = join(sessionsDirectory, `${sessionId}.json`);
for (const path of [
    sessionsDirectory, requestDirectory, processingDirectory, responseDirectory, failedDirectory, staging,
]) await mkdir(path, { recursive: true });

const yamlValue = (text, key) => {
    const match = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(text);
    if (!match) return "";
    const value = match[1].trim();
    if (value.startsWith("\"") && value.endsWith("\"")) {
        try { return JSON.parse(value); } catch { return value.slice(1, -1); }
    }
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
    return value;
};

const metadata = async () => {
    const workspacePath = join(homedir(), ".copilot", "session-state", sessionId, "workspace.yaml");
    try {
        const yaml = await readFile(workspacePath, "utf8");
        return {
            name: yamlValue(yaml, "name") || basename(process.cwd()) || sessionId,
            workspace: yamlValue(yaml, "cwd") || process.cwd(),
        };
    } catch {
        return { name: basename(process.cwd()) || sessionId, workspace: process.cwd() };
    }
};

let status = "idle";
let writeRegistration = Promise.resolve();
let registrationFailure = "";
const errorDetail = (error) =>
    `${error?.code ?? error?.name ?? "UnknownError"} (${error?.syscall ?? "registration"})`;
const logRegistration = async (message, level) => {
    try {
        await session.log(message, { level });
    } catch (error) {
        // A disconnected diagnostic channel must not poison future registration attempts.
        console.error("Teams session endpoint diagnostic failed:", errorDetail(error));
    }
};
const register = () => {
    writeRegistration = writeRegistration.then(async () => {
        const current = await metadata();
        const registration = {
            schema: 1,
            sessionId,
            instanceId,
            pid: process.pid,
            name: String(current.name).slice(0, 200),
            workspace: String(current.workspace).slice(0, 2048),
            status,
            heartbeatAt: new Date().toISOString(),
        };
        const temporary = join(staging, `${sessionId}.${instanceId}.${randomUUID()}.registration.tmp`);
        try {
            await writeFile(temporary, JSON.stringify(registration), { flag: "wx", mode: 0o600 });
            for (let attempt = 0; ; attempt++) {
                try {
                    await rename(temporary, registrationPath);
                    break;
                } catch (error) {
                    // Windows readers can briefly deny delete-sharing during atomic replacement.
                    if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= 4) throw error;
                    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
                }
            }
        } finally {
            await unlink(temporary).catch((error) => {
                if (error?.code !== "ENOENT") {
                    console.error("Teams session endpoint temporary cleanup failed:", errorDetail(error));
                }
            });
        }
        if (registrationFailure) {
            registrationFailure = "";
            await logRegistration("Teams session endpoint registration recovered.", "info");
        }
    }).catch(async (error) => {
        const detail = errorDetail(error);
        if (registrationFailure === detail) return;
        registrationFailure = detail;
        console.error("Teams session endpoint registration failed:", detail);
        await logRegistration(`Teams session endpoint registration failed: ${detail}; retrying on the next heartbeat.`, "error");
    });
    return writeRegistration;
};

session.on((event) => {
    let nextStatus = status;
    if (event.type === "assistant.turn_start" || event.type === "user.message") nextStatus = "busy";
    if (event.type === "session.idle" || event.type === "session.error" ||
        event.type === "session.shutdown") nextStatus = "idle";
    // Streaming and our own session.log events are not registration changes.
    if (nextStatus !== status) {
        status = nextStatus;
        void register();
    }
});

const writeResponse = async (id, value) => {
    const temporary = join(staging, `${sessionId}.${id}.${randomUUID()}.response.tmp`);
    const target = join(responseDirectory, `${id}.json`);
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
};

let processing = false;
let scheduled = false;
const processOne = async () => {
    scheduled = false;
    if (processing) return;
    processing = true;
    try {
        const files = (await readdir(requestDirectory))
            .filter((name) => guid.test(name.replace(/\.json$/i, "")) && name.endsWith(".json"))
            .sort();
        const file = files[0];
        if (!file) return;
        const pending = join(requestDirectory, file);
        const id = file.slice(0, -5).toLowerCase();
        const claimed = join(processingDirectory, file);
        await rename(pending, claimed);
        try {
            const request = await boundedJson(claimed);
            const expiresAt = Date.parse(String(request?.expiresAt ?? ""));
            const message = request?.payload?.message;
            if (request?.schema !== 1 || request?.id?.toLowerCase() !== id ||
                request?.sessionId?.toLowerCase() !== sessionId ||
                request?.operation !== "send_message" || !Number.isFinite(expiresAt) ||
                expiresAt <= Date.now() || typeof message !== "string" || !message.trim() ||
                Buffer.byteLength(message, "utf8") > maximumMessageBytes) {
                throw new Error("INVALID_REQUEST");
            }
            const messageId = await session.send({ prompt: message });
            await writeResponse(id, {
                schema: 1,
                id,
                completedAt: new Date().toISOString(),
                ok: true,
                result: { accepted: true, messageId, route: "session-extension" },
            });
        } catch (error) {
            await writeResponse(id, {
                schema: 1,
                id,
                completedAt: new Date().toISOString(),
                ok: false,
                error: {
                    code: error instanceof Error && error.message === "INVALID_REQUEST"
                        ? "INVALID_REQUEST" : "SESSION_SEND_FAILED",
                    message: "Session endpoint did not accept the request.",
                },
            });
        } finally {
            await unlink(claimed).catch(() => undefined);
        }
    } catch (error) {
        if (!(error && typeof error === "object" && error.code === "ENOENT")) {
            await session.log(`Teams session endpoint request failed: ${error instanceof Error ? error.name : "UnknownError"}`, {
                level: "error",
            });
        }
    } finally {
        processing = false;
    }
};

const schedule = (delay = 50) => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => void processOne(), delay);
};

await register();
const heartbeat = setInterval(() => void register(), 5000);
heartbeat.unref();
const scan = setInterval(() => schedule(), 1000);
scan.unref();
const watcher = watch(requestDirectory, { persistent: true }, () => schedule());
watcher.on("error", async (error) => {
    await session.log(`Teams session endpoint watcher failed: ${error.name}`, { level: "error" });
});
schedule();

await new Promise(() => {});
