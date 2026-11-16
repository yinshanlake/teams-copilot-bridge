import { CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { nativeCliConfiguration } from "./config.js";
import { nativeClientOptions } from "./native.js";
import { logError, publicError, safeText, UserError } from "./safety.js";

type LoginApi = CopilotSession["rpc"]["accounts"]["login"];
export interface LoginUi {
  display(message: string): void;
  choose(message: string, choices: string[]): Promise<number>;
}

export interface LoginTiming {
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function nativeLoginFlow(api: LoginApi, provider: "githubDotCom" | "entra", ui: LoginUi, timing: LoginTiming = {}): Promise<void> {
  const now = timing.now ?? (() => performance.now());
  const wait = timing.wait ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = timing.timeoutMs ?? 15 * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_000_000_000) throw new UserError("Native login deadline must be a positive, bounded duration.");
  if (timing.signal?.aborted) throw new UserError("Native login cancelled by the user.");
  const started = await api.begin({
    kind: provider, mode: "selectAccount", ...(provider === "githubDotCom" ? { method: "device-code" } : {}),
  });
  let step = started.step;
  let completed = false;
  let deadline = now() + timeoutMs;
  const remaining = () => {
    if (timing.signal?.aborted) throw new UserError("Native login cancelled by the user.");
    const duration = deadline - now();
    if (duration <= 0) throw new UserError("Native login deadline expired; the pending official login was cancelled.");
    return duration;
  };
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    const duration = remaining();
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new UserError("Native login deadline expired; the pending official login was cancelled.")), duration);
          onAbort = () => reject(new UserError("Native login cancelled by the user."));
          timing.signal?.addEventListener("abort", onAbort, { once: true });
        }),
        operation(),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) timing.signal?.removeEventListener("abort", onAbort);
    }
  };
  try {
    while (true) {
      remaining();
      let input: string | undefined;
      if (step.kind === "completed") {
        if (step.result.status === "completed") {
          completed = true;
          ui.display("Official Copilot login completed for this isolated bot profile.");
          return;
        }
        if (step.result.status === "needs-account-selection" && step.result.accounts?.length) {
          const accounts = step.result.accounts;
          const index = await bounded(() => ui.choose("Choose the account for this bot profile", accounts.map((account) => `${account.login} (${account.host})`)));
          const account = accounts[index];
          if (!account) throw new UserError("Invalid native account selection.");
          input = account.selectionId;
        } else if (step.result.status === "needs-plaintext-consent") {
          throw new UserError("The native runtime requested plaintext credential persistence. This client did not consent; configure the official OS credential store and retry login. No PAT fallback was requested.");
        } else throw new UserError("Native sign-in was declined or did not complete.");
      } else if (step.kind === "device-code") {
        if (!Number.isFinite(step.expiresIn) || step.expiresIn <= 0) throw new UserError("Native login returned an expired device code.");
        deadline = Math.min(deadline, now() + step.expiresIn * 1000);
        const url = new URL(step.verificationUri);
        if (url.protocol !== "https:" || url.username || url.password) throw new UserError("Native login returned an invalid verification URL.");
        ui.display(`Open ${url.href} and enter the one-time code: ${step.userCode}\nThe native runtime owns authorization polling; no token is printed or copied.`);
      } else if (step.kind === "open-url") {
        const url = new URL(step.url);
        if (url.protocol !== "https:" || url.username || url.password) throw new UserError("Native login returned an invalid authorization URL.");
        ui.display(`Complete official sign-in in your browser: ${url.href}`);
      } else if (step.kind === "needs-interaction") {
        ui.display("Complete the official Microsoft account/broker sign-in opened by the native runtime.");
      } else if (step.kind === "error") {
        throw new UserError(`Official native sign-in failed: ${safeText(step.message, 500)}`);
      } else if (step.kind === "input-required") {
        throw new UserError("This login provider requires additional host input; use its official interactive Copilot login. No credential was collected by this client.");
      }
      step = await bounded(() => api.advance({ flowId: started.flowId, ...(input ? { input } : {}) }));
      if (step.kind === "awaiting") await bounded(() => wait(Math.min(500, remaining())));
    }
  } finally {
    if (!completed) await api.cancel({ flowId: started.flowId });
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("npm run login:copilot [-- --provider entra]\nUses the official SDK account-login API in this bot's isolated profile. No copied App/Twin credentials, PAT or plaintext-storage consent.");
    return;
  }
  const providerIndex = process.argv.indexOf("--provider");
  const requested = providerIndex < 0 ? "github" : process.argv[providerIndex + 1];
  if (requested !== "github" && requested !== "entra") throw new UserError("--provider must be github (default) or entra.");
  const options = nativeCliConfiguration(process.env);
  if (options.auth !== "logged-in-user") throw new UserError("login:copilot is for COPILOT_AUTH=logged-in-user, not explicit token/runtime mode.");
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  const client = new CopilotClient(nativeClientOptions(options));
  let session: CopilotSession | undefined;
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once("SIGINT", cancel);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  terminal.once("SIGINT", cancel);
  try {
    await client.start();
    session = await client.createSession({
      clientName: "copilot-teams-login", configDirectory: options.configDirectory, workingDirectory: options.home,
      availableTools: [], tools: [], includedBuiltinAgents: [], enableConfigDiscovery: false, enableFileHooks: false,
      enableSkills: false, skipCustomInstructions: true, permissionMode: "manual", enableSessionTelemetry: false,
      onPermissionRequest: () => ({ kind: "reject", feedback: "A login session cannot execute tools." }),
    });
    await nativeLoginFlow(session.rpc.accounts.login, requested === "entra" ? "entra" : "githubDotCom", {
      display: (message) => console.log(message),
      async choose(message, choices) {
        if (!process.stdin.isTTY) throw new UserError("Account selection requires an interactive terminal.");
        console.log(message);
        choices.forEach((choice, index) => console.log(`${index + 1}. ${safeText(choice, 200)}`));
        const answer = await terminal.question("Account number: ");
        return /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
      },
    }, { signal: cancellation.signal });
  } finally {
    process.removeListener("SIGINT", cancel);
    terminal.removeListener("SIGINT", cancel);
    terminal.close();
    if (session) await session.disconnect();
    const errors = await client.stop();
    if (errors.length) throw new AggregateError(errors, "Login runtime did not stop cleanly");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { logError("native-login", error); console.error(publicError(error)); process.exitCode = 1; });
}
