import http from "node:http";
import https from "node:https";
import net from "node:net";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const permitted = new Map<number, number>();
const realFetch = globalThis.fetch;
const realConnect = net.Socket.prototype.connect;

function isAllowed(host: unknown, port: unknown): boolean {
  return typeof host === "string" && ["127.0.0.1", "localhost", "::1"].includes(host) &&
    permitted.has(Number(port));
}

function reject(): never {
  throw new Error("Unmocked network/process access is blocked by the test bootstrap.");
}

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!isAllowed(url.hostname, url.port || (url.protocol === "https:" ? 443 : 80))) reject();
  return realFetch(input, init);
};

net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  let host: unknown = "localhost";
  let port: unknown;
  if (typeof first === "object" && first !== null) {
    if ("host" in first) host = first.host;
    if ("port" in first) port = first.port;
  } else {
    port = first;
    if (typeof args[1] === "string") host = args[1];
  }
  if (!isAllowed(host, port)) reject();
  return Reflect.apply(realConnect, this, args);
};

// Prevent even a mocked transport accidentally starting a real SDK/CLI child.
childProcess.spawn = reject;
childProcess.spawnSync = reject;
childProcess.exec = Object.assign(reject, { __promisify__: reject });
childProcess.execSync = reject;
childProcess.execFile = Object.assign(reject, { __promisify__: reject });
childProcess.execFileSync = reject;
childProcess.fork = reject;
// Keep native module references loaded by SDKs in sync with the guarded exports.
void http;
void https;
syncBuiltinESMExports();

export async function withLoopback<T>(port: number, run: () => Promise<T>): Promise<T> {
  permitted.set(port, (permitted.get(port) ?? 0) + 1);
  try { return await run(); } finally {
    const remaining = (permitted.get(port) ?? 1) - 1;
    if (remaining) permitted.set(port, remaining);
    else permitted.delete(port);
  }
}
