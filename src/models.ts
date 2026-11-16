import { CopilotClient } from "@github/copilot-sdk";
import { mkdir } from "node:fs/promises";
import { nativeCliConfiguration } from "./config.js";
import { catalogue, nativeClientOptions } from "./native.js";
import { logError, protectSecrets, publicError, UserError } from "./safety.js";

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("npm run models\nReads the actual Copilot catalogue for this bot's isolated logged-in-user profile. Requires BRIDGE_BOT_APP_ID (or explicit webhook TEAMS_APP_ID), not a Bot secret or PAT. If not signed in, run npm run login:copilot.");
    return;
  }
  const options = nativeCliConfiguration(process.env);
  protectSecrets([options.token, options.runtimeToken]);
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  const client = new CopilotClient(nativeClientOptions(options));
  try {
    await client.start();
    if (!(await client.getAuthStatus()).isAuthenticated) throw new UserError("Copilot is not signed in for this bot profile. Run npm run login:copilot (or -- --provider entra); no PAT is required.");
    console.log(JSON.stringify(catalogue(await client.listModels()), null, 2));
  } finally {
    const errors = await client.stop();
    if (errors.length) throw new AggregateError(errors, "Catalogue client cleanup failed");
  }
}

main().catch((error: unknown) => { logError("model-catalogue", error); console.error(publicError(error)); process.exitCode = 1; });
