import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { configuration, nativeConfiguration } from "../src/config.js";
import { nativeClientOptions } from "../src/native.js";
import { protectSecrets, safeText } from "../src/safety.js";
import { mockIdentity } from "../src/simulator.js";
import { temporary } from "./helpers.js";

test("production prerequisites fail closed and configuration-only validation does not start a mock or SDK", async (t) => {
  const directory = await temporary(t);
  await assert.rejects(() => configuration({}), /Missing prerequisite: BRIDGE_RELAY_CONFIG/);
  const environment: NodeJS.ProcessEnv = {
    BRIDGE_TRANSPORT: "webhook", COPILOT_AUTH: "token",
    TEAMS_APP_ID: mockIdentity.appId, TEAMS_TENANT_ID: mockIdentity.tenantId, TEAMS_OWNER_OBJECT_ID: mockIdentity.ownerId,
    TEAMS_APP_SECRET: "explicit-new-fixture-secret",
    BRIDGE_WORKSPACES: JSON.stringify([{ id: "local", name: "Local", path: directory }]),
    COPILOT_GITHUB_TOKEN: "explicit-fixture-only", COPILOT_DEFAULT_MODEL: "native-alpha",
  };
  const config = await configuration(environment, directory);
  assert.equal(config.native.home, join(directory, ".bridge", "bots", mockIdentity.appId, "native"));
  assert.equal(config.native.peers, false);
  assert.equal(config.native.token, "explicit-fixture-only");
  assert.equal(config.native.defaultModel, "native-alpha");
  await assert.rejects(() => configuration({ ...environment, TEAMS_OWNER_OBJECT_ID: "display-name" }, directory), /full GUIDs/);
  assert.equal((await configuration({ ...environment, COPILOT_DEFAULT_MODEL: "" }, directory)).native.defaultModel, "",
    "App-only startup must not require a private native model catalogue/configuration");
  await assert.rejects(() => configuration({ ...environment, BRIDGE_WORKSPACES: JSON.stringify([{ id: "local", name: "Local", path: join(directory, "missing") }]) }, directory), /does not exist/);
  await assert.rejects(() => configuration({ ...environment, COPILOT_ENABLE_PEERS: "maybe" }, directory), /true or false/);
  await assert.rejects(() => configuration({ ...environment, TEAMS_SERVICE_HOSTS: "*.example" }, directory), /exact trusted/);
});

test("explicit token catalogue alternative uses an isolated home and rejects invalid existing-runtime coordinates", () => {
  const directory = process.cwd();
  const config = nativeConfiguration({ COPILOT_AUTH: "token", COPILOT_GITHUB_TOKEN: "catalogue-only-fixture" }, directory, directory, true);
  assert.equal(config.defaultModel, "");
  assert.equal(config.peers, false);
  const options = nativeClientOptions(config);
  assert.equal(options.useLoggedInUser, false);
  assert.equal(options.gitHubToken, "catalogue-only-fixture");
  const { token: _token, ...runtime } = config;
  for (const uri of ["example.com:1234", "127.0.0.1:99999", "127.0.0.1:0", "http://user:token@127.0.0.1:42/path"]) {
    assert.throws(() => nativeClientOptions({ ...runtime, auth: "runtime", runtimeUri: uri, runtimeToken: "explicit" }));
  }
  assert.throws(() => nativeClientOptions({ ...runtime, auth: "runtime", runtimeUri: "127.0.0.1:1234" }), /explicit connection token/);
});

test("fixed App session operations default on independently of legacy coordinator settings; catalogue/login need no App directory", () => {
  const root = process.cwd();
  const config = nativeConfiguration({
    COPILOT_DEFAULT_MODEL: "native-alpha",
    COPILOT_APP_COORDINATOR_DIRECTORY: "ignored-legacy-queue",
    COPILOT_APP_COORDINATOR_SESSION_ID: "not-an-active-coordinator",
    COPILOT_APP_SESSION_STATE_DIRECTORY: join(root, "fixture-profile"),
    COPILOT_APP_BROKER_DIRECTORY: join(root, "fixture-broker"),
  }, root, root);
  assert.deepEqual(config.appSessions, {
    timeoutMs: 30_000, sessionStateDirectory: join(root, "fixture-profile"), brokerDirectory: join(root, "fixture-broker"),
  });
  assert.equal("appCoordinator" in config, false);
  assert.equal(nativeConfiguration({ COPILOT_APP_SESSIONS: "false" }, root, root, true).appSessions, undefined);
  assert.equal(nativeConfiguration({}, root, root, true).appSessions, undefined);
  assert.throws(() => nativeConfiguration({ COPILOT_APP_SESSIONS: "maybe" }, root, root, true), /true or false/);
  assert.throws(() => nativeConfiguration({ COPILOT_APP_ENDPOINT_TIMEOUT_MS: "60000" }, root, root, true), /100-30000/);
});
test("configured secret values are redacted even without recognizable token prefixes or field names", () => {
  const secret = "unstructured-configured-fixture-credential";
  protectSecrets([secret]);
  assert.equal(safeText(`Native visible output: ${secret}`), "Native visible output: [REDACTED]");
  const syntheticKey = ["-----BEGIN PRIVATE", "KEY-----\nfixture-key\n-----END PRIVATE", "KEY-----"].join(" ");
  assert.ok(!safeText(syntheticKey).includes("fixture-key"));
});
