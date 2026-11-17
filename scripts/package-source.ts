import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

export const sourceFiles = [
  ".env.example",
  ".gitattributes",
  ".gitignore",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/relay.md",
  "docs/design/interaction-v3.md",
  "extensions/teams-session-endpoint/README.md",
  "extensions/teams-session-endpoint/config.example.json",
  "extensions/teams-session-endpoint/extension.mjs",
  "package-lock.json",
  "package.json",
  "scripts/Run-Bridge.ps1",
  "scripts/Test-ManagedBridge.ps1",
  "scripts/native-smoke.ts",
  "scripts/package-source.ts",
  "src/actions.ts",
  "src/app-sessions.ts",
  "src/bridge.ts",
  "src/cards.ts",
  "src/commands.ts",
  "src/config.ts",
  "src/conversation-ui.ts",
  "src/domain.ts",
  "src/fake-runtime.ts",
  "src/journal-observer.ts",
  "src/interaction.ts",
  "src/login.ts",
  "src/main.ts",
  "src/models.ts",
  "src/native.ts",
  "src/preview.css",
  "src/preview.html",
  "src/preview.js",
  "src/projection.ts",
  "src/relay-auth.ts",
  "src/relay-config.ts",
  "src/relay.ts",
  "src/replies.ts",
  "src/safety.ts",
  "src/side-metadata.ts",
  "src/simulator.ts",
  "src/store.ts",
  "src/teams.ts",
  "src/transport-format.ts",
  "src/visible-publication.ts",
  "teams-package/New-TeamsPackage.ps1",
  "teams-package/README.md",
  "teams-package/Test-TeamsPackage.ps1",
  "teams-package/manifest.template.json",
  "teams-package/validate-manifest.py",
  "test/app-sessions.test.ts",
  "test/block-network.ts",
  "test/chat-v2.test.ts",
  "test/config.test.ts",
  "test/conversation-first.test.ts",
  "test/core.test.ts",
  "test/distribution.test.ts",
  "test/fixtures/managed-worker.cjs",
  "test/helpers.ts",
  "test/journal-observer.test.ts",
  "test/interaction-v3.test.ts",
  "test/native-chat-format.test.ts",
  "test/native-chat-races.test.ts",
  "test/native-chat.test.ts",
  "test/native.test.ts",
  "test/published-results.test.ts",
  "test/regressions.test.ts",
  "test/relay.test.ts",
  "test/sidechat-subscriptions.test.ts",
  "test/transport-format.test.ts",
  "test/transport.test.ts",
  "tsconfig.json",
] as const;

interface SourceFile {
  path: string;
  data: Buffer;
  sha256: string;
}

const maximumFileBytes = 2 * 1024 * 1024;
const maximumTotalBytes = 10 * 1024 * 1024;
const privateSegment = /^(?:\.git|\.bridge|\.copilot|\.twin|\.candidate.*|node_modules|dist|build|out|coverage|logs|profiles|journals|session-state|teams-session-broker|artifacts|evidence|screenshots)$/i;
const credentialPatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ["private-key marker", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ["JWT-shaped credential", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{15,}\b/],
  ["operator home path", /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+/i],
  ["private service reference", /\b(?:[a-z0-9-]+\.)*(?:pkgs\.visualstudio\.com|sharepoint\.com|enghub\.ms|eng\.ms)\b/i],
  ["personal App session link", /ghapp:\/\/[^\s"'<>]*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
];

function assertPublicPath(path: string): void {
  const parts = path.split("/");
  if (isAbsolute(path) || path.includes("\\") ||
    parts.some((part) => !part || part === "." || part === ".." || privateSegment.test(part)) ||
    (parts.some((part) => /^\.env/i.test(part)) && path !== ".env.example") ||
    /\.(?:zip|tgz|tar|gz|7z|pem|key|pfx|p12|cer|crt|log|jsonl|db|sqlite\d*)$/i.test(path) ||
    /(?:credentials|secrets|(?:relay|twin)-(?:config|bundle))[^/]*\.json$/i.test(path)) {
    throw new Error(`Not a public source path: ${path}`);
  }
}

function auditContent(path: string, data: Buffer): void {
  const text = data.toString("utf8");
  for (const [kind, pattern] of credentialPatterns) {
    if (pattern.test(text)) throw new Error(`${path}: possible ${kind}; content omitted. Review before packaging.`);
  }
  if (path === ".env.example") {
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*#?\s*(TEAMS_APP_SECRET|COPILOT_GITHUB_TOKEN|COPILOT_RUNTIME_TOKEN)\s*=\s*(.+)$/.exec(line);
      if (match && !/^REPLACE_[A-Z_]+$/.test(match[2]!)) {
        throw new Error(`${path}: credential settings must remain generic REPLACE_ placeholders.`);
      }
    }
  }
  if (path === "package-lock.json") {
    const lock: unknown = JSON.parse(text);
    if (!lock || typeof lock !== "object" || !("packages" in lock) ||
      !lock.packages || typeof lock.packages !== "object") throw new Error("Invalid source package lockfile.");
    for (const value of Object.values(lock.packages)) {
      if (!value || typeof value !== "object" || !("resolved" in value)) continue;
      if (typeof value.resolved !== "string") throw new Error("Invalid locked dependency URL.");
      const url = new URL(value.resolved);
      if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" ||
        url.username || url.password || url.port || url.search || url.hash) {
        throw new Error("package-lock.json: dependency URLs must use public npm without credentials.");
      }
    }
  }
}

export async function collectSource(root: string): Promise<SourceFile[]> {
  const base = await realpath(root);
  const result: SourceFile[] = [];
  const visited = new Set<string>();
  const names = new Set<string>();
  let total = 0;
  for (const name of [...sourceFiles].sort()) {
    assertPublicPath(name);
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate source path: ${name}`);
    names.add(name.toLowerCase());
    let path = base;
    for (const part of name.split("/")) {
      path = join(path, part);
      if (!visited.has(path)) {
        const info = await lstat(path);
        if (info.isSymbolicLink() || relative(path, await realpath(path)) !== "") {
          throw new Error(`${name}: symlinks, junctions and redirected paths are not distributable.`);
        }
        visited.add(path);
      }
    }
    const info = await lstat(path);
    if (!info.isFile() || info.size > maximumFileBytes) throw new Error(`${name}: invalid or oversized source file.`);
    const data = await readFile(path);
    total += data.length;
    if (data.length > maximumFileBytes || total > maximumTotalBytes) throw new Error("Source distribution size bound exceeded.");
    auditContent(name, data);
    result.push({ path: name, data, sha256: createHash("sha256").update(data).digest("hex") });
  }
  return result;
}

export function sourceInventory(files: readonly SourceFile[]) {
  return files.map(({ path, data, sha256 }) => ({ path, bytes: data.length, sha256 }));
}

export async function writeSourceArchive(root: string, outputPath: string) {
  const base = await realpath(root);
  const requested = resolve(outputPath);
  if (extname(requested).toLowerCase() !== ".zip") throw new Error("Source output must be a .zip file.");
  const output = join(await realpath(dirname(requested)), basename(requested));
  const destination = relative(base, output);
  if (!isAbsolute(destination) && destination !== ".." && !destination.startsWith(`..${sep}`)) {
    throw new Error("Write source archives outside the source tree, in an existing output directory.");
  }
  const files = await collectSource(base);
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false, extendedTimestamp: false, lastModDate: new Date(2000, 0, 1),
  });
  for (const file of files) await writer.add(file.path, new Uint8ArrayReader(file.data));
  const archive = await writer.close();
  await writeFile(output, archive, { flag: "wx", mode: 0o600 });
  return {
    archive: basename(output),
    bytes: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
    files: sourceInventory(files),
  };
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..", "..");
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--check") {
    console.log(JSON.stringify({ files: sourceInventory(await collectSource(root)) }, null, 2));
  } else if (args.length === 2 && args[0] === "--output" && args[1]) {
    console.log(JSON.stringify(await writeSourceArchive(root, args[1]), null, 2));
  } else {
    throw new Error("Usage: npm run check:source OR npm run pack:source -- --output <outside-source-tree.zip>");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Source packaging failed.");
    process.exitCode = 1;
  });
}
