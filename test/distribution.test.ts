import assert from "node:assert/strict";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { test, type TestContext } from "node:test";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { collectSource, sourceFiles, writeSourceArchive } from "../scripts/package-source.js";
import { LocalAppSessions } from "../src/app-sessions.js";
import { configuration } from "../src/config.js";
import { mockIdentity } from "../src/simulator.js";
import { temporary } from "./helpers.js";

const sourceRoot = resolve(import.meta.dirname, "..", "..");

async function distributionFixture(t: TestContext) {
  const directory = await temporary(t);
  const root = join(directory, "source");
  const files = await collectSource(sourceRoot);
  for (const file of files) {
    const path = join(root, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.data);
  }
  return { directory, root, files };
}

test("source ZIP contains only exact allowlisted bytes, excludes operator files, and never overwrites output", async (t) => {
  const h = await distributionFixture(t);
  for (const name of [
    ".env", ".env.production", ".bridge/state.json", ".copilot/profile.json",
    ".candidate/compiled.js", ".git/config", "node_modules/private/package.json",
    "dist/src/main.js", "relay-config.json", "teams-package/personal.zip",
    "logs/bridge.log", "credentials.json", "src/unreviewed.ts", "evidence/report.md",
  ]) {
    const path = join(h.root, ...name.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "SYNTHETIC_OPERATOR_FILE_NOT_FOR_DISTRIBUTION");
  }
  const output = join(h.directory, "source.zip");
  const result = await writeSourceArchive(h.root, output);
  assert.deepEqual(result.files.map((file) => file.path), [...sourceFiles].sort());
  const reader = new ZipReader(new Uint8ArrayReader(await readFile(output)), { useWebWorkers: false });
  try {
    const entries = await reader.getEntries();
    assert.deepEqual(entries.map((entry) => entry.filename).sort(), [...sourceFiles].sort());
    for (const entry of entries) {
      assert.ok(!entry.directory);
      const expected = h.files.find((file) => file.path === entry.filename)!;
      assert.deepEqual(Buffer.from(await entry.getData(new Uint8ArrayWriter(), { checkSignature: true })), expected.data);
    }
  } finally { await reader.close(); }
  assert.equal((await writeSourceArchive(h.root, join(h.directory, "second.zip"))).sha256, result.sha256);
  const before = await readFile(output);
  await assert.rejects(() => writeSourceArchive(h.root, output), { code: "EEXIST" });
  assert.deepEqual(await readFile(output), before);
  await assert.rejects(() => writeSourceArchive(h.root, join(h.root, "inside.zip")), /outside the source tree/);
  await assert.rejects(() => readFile(join(h.root, "inside.zip")), { code: "ENOENT" });
});

test("source audit rejects credential-shaped content and private settings without echoing their value", async (t) => {
  const h = await distributionFixture(t);
  const readme = join(h.root, "README.md");
  const original = await readFile(readme);
  const samples = [
    ["ghp", "x".repeat(36)].join("_"),
    ["-----BEGIN PRIVATE", "KEY-----\nsynthetic-only\n-----END PRIVATE", "KEY-----"].join(" "),
    ["eyJ" + "a".repeat(24), "b".repeat(24), "c".repeat(24)].join("."),
    ["C:", "Users", "synthetic-account", "local.env"].join("\\"),
  ];
  for (const sample of samples) {
    await writeFile(readme, sample);
    await assert.rejects(() => collectSource(h.root), (error: unknown) => {
      assert.ok(error instanceof Error && error.message.includes("README.md: possible"));
      assert.ok(!error.message.includes(sample), "the diagnostic must omit matched material");
      return true;
    });
  }
  await writeFile(readme, original);
  const env = join(h.root, ".env.example");
  await writeFile(env, "TEAMS_APP_SECRET=synthetic-but-not-a-placeholder\n");
  await assert.rejects(() => collectSource(h.root), /credential settings must remain generic/);
  await writeFile(env, h.files.find((file) => file.path === ".env.example")!.data);
  const lockPath = join(h.root, "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.packages["node_modules/express"].resolved = "https://packages.example.test/private.tgz";
  await writeFile(lockPath, JSON.stringify(lock));
  await assert.rejects(() => collectSource(h.root), /dependency URLs must use public npm/);
});

test("source audit refuses a redirected source directory instead of traversing it", async (t) => {
  const h = await distributionFixture(t);
  const original = join(h.directory, "redirect-target");
  const link = join(h.root, "src");
  await rename(link, original);
  await symlink(original, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => collectSource(h.root), /symlinks, junctions and redirected paths/);
});

test("public examples configure direct webhook and an isolated empty endpoint broker without login or native startup", async (t) => {
  const directory = await temporary(t);
  const environment = parseEnv(await readFile(join(sourceRoot, ".env.example"), "utf8"));
  const config = await configuration({
    ...environment,
    TEAMS_APP_ID: mockIdentity.appId,
    TEAMS_TENANT_ID: mockIdentity.tenantId,
    TEAMS_OWNER_OBJECT_ID: mockIdentity.ownerId,
    TEAMS_APP_SECRET: "synthetic-registration-secret",
    BRIDGE_WORKSPACES: JSON.stringify([{ id: "fixture", name: "Synthetic workspace", path: directory }]),
  }, directory);
  assert.equal(config.transport, "webhook");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.native.auth, "logged-in-user");
  assert.equal(config.native.defaultModel, "");
  const brokerDirectory = join(directory, "broker");
  await mkdir(brokerDirectory);
  await writeFile(join(brokerDirectory, "config.json"),
    await readFile(join(sourceRoot, "extensions", "teams-session-endpoint", "config.example.json")));
  const client = new LocalAppSessions({
    brokerDirectory, sessionStateDirectory: join(directory, "absent-synthetic-sessions"), timeoutMs: 1000,
  });
  t.after(() => client.close());
  await client.start();
  assert.deepEqual(await client.listSessions(), []);
});
