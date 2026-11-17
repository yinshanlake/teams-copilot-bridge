# Copilot Teams Client

A self-hosted, single-owner bridge between a **personal Microsoft Teams bot chat**
and your local Copilot sessions. Use Teams' normal message composer to talk to an
explicit, visible Focus target. An Inbox, independently scoped task/request cards,
and result previews keep control separate from work text.

This is an independent project, not an official Microsoft or GitHub product.
It is not a hosted service or a multi-user bot.

**A Teams app ZIP is only a client manifest and icons.** Uploading it does not
register an Azure Bot, run this backend, install Copilot, or keep your computer
online. Every operator supplies their own work/school tenant, bot registration,
owner identity, Copilot entitlement/sign-in, private `.env`, and local state.
No shared portal, existing installation, or another operator's credentials are
required for the direct-webhook route below.

## Prerequisites and compatibility

- A Windows computer that can remain running. The Teams ZIP builder requires
  Windows (`System.Drawing`); use PowerShell 7. The existing-session integration
  has Windows-oriented host/file-layout assumptions. Linux, macOS, containers,
  remote hosts, and unattended-service deployments are not validated here.
- Node.js 24 LTS or a newer supported release, and npm. The declared engine range
  also permits Node 22.12+, but current Node 24+ is recommended.
- Your own Microsoft 365 **work/school** account with Teams. The tenant must allow
  custom app uploads and use of the bot. A personal Microsoft account alone is
  not sufficient. Azure subscription/resource permissions and Entra application
  registration/secret permissions are needed to register the bot.
- An HTTPS reverse proxy or tunnel reachable by the Teams/Bot service, forwarding
  to your local backend. You supply and operate it; this repository provisions
  no cloud resources, DNS, TLS certificates, tunnels, services, or startup tasks.
  Azure, tunneling, and Copilot usage may incur charges.
- For **existing-session writes**, a compatible Copilot App/CLI preview host that
  supports extensions, `@github/copilot-sdk/extension` `joinSession()`,
  `session.send()`, and the local session journal format. Install the included
  [endpoint extension source](extensions/teams-session-endpoint/README.md)
  manually in the original host. These APIs and App metadata are not universal
  stable interfaces; the npm SDK alone does not provide App attachment.
- For optional **bot-created sessions**, a Copilot account with access to the
  pinned SDK's native runtime and a model it actually advertises. Dependencies
  are pinned, including `@github/copilot-sdk` 1.0.31; do not replace the SDK or
  host with an arbitrary version and assume compatibility.

Python 3 with `jsonschema` is needed only for optional local Teams-schema
validation. No Python package is needed to run the bridge or build the ZIP.

## First run: independent authenticated webhook

### 1. Get and build the source

Extract the source ZIP, or clone the repository URL supplied by its publisher.
Run these commands from that source directory:

```powershell
npm ci --registry=https://registry.npmjs.org
npm run build
Copy-Item .env.example .env
```

Edit **`.env`**, never `.env.example`, with your private values. The example
explicitly sets `BRIDGE_TRANSPORT=webhook`. Omitting that variable retains the
legacy relay default; it does not auto-detect a webhook or fall back to mock.

For a no-account UI preview instead, run `npm run simulate` and open
`http://127.0.0.1:3979`. It is explicitly **MOCK**, uses synthetic sessions and
loopback-only HTTP, and makes no real Teams sends or model calls. Stop it with
Ctrl+C. Do not expose the simulator through your tunnel; it is not the bot.

### 2. Register your own bot

In your own tenant, create an Entra application and an **Azure Bot** resource
using that application's ID. Choose **single-tenant** identity for this setup.
Configure a client secret for that application and record its **secret value**
privately, not its secret ID. Set the bot's Microsoft App ID and tenant to the
same registration. The direct adapter uses client-secret authentication; this
guide does not configure managed-identity authentication.

In the Azure Bot resource:

1. Enable the **Microsoft Teams** channel and complete any required channel
   configuration/terms for your tenant.
2. Set **Configuration -> Messaging endpoint** to your own public HTTPS URL,
   ending in **`/api/messages`**, for example
   `https://bot.example.test/api/messages` (illustrative, not a working service).
3. Keep the bot application's secret on the backend only. Never put it in the
   manifest, ZIP, support URL, browser, Teams message, or source repository.

See Microsoft's [bot registration guide](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration?view=azure-bot-service-4.0).
Registration connects the bot to channels; it does not deploy this Node process.

### 3. Configure the backend privately

The required `.env` settings are:

| Setting | Value |
| --- | --- |
| `BRIDGE_TRANSPORT` | `webhook` |
| `TEAMS_APP_ID` | The bot registration's application/client GUID, not an application object ID |
| `TEAMS_APP_SECRET` | That application's current client-secret **value** |
| `TEAMS_TENANT_ID` | Your work/school directory/tenant GUID |
| `TEAMS_OWNER_OBJECT_ID` | Your user object's Entra object GUID **in that tenant**, not an email or bot/service-principal ID |
| `BRIDGE_WORKSPACES` | JSON array of 1-20 allowed existing absolute local paths, with unique `id` and readable `name` |

Keep `BIND_HOST=127.0.0.1` and `PORT=3978` for a tunnel/reverse proxy on the same
computer. `BRIDGE_STATE_DIRECTORY=.bridge` keeps private bot state separate from
source. JSON paths in `.env` require doubled backslashes; follow `.env.example`.

The default `TEAMS_SERVICE_HOSTS` are exact trusted commercial Teams service
hosts. Do not replace them with your tunnel hostname, wildcards, or IP addresses:
they validate the Bot service's **outbound conversation service URL**, not your
inbound webhook URL. Other cloud environments require separate compatibility
work and are not advertised as supported.

The official Microsoft Agents JWT validator authenticates inbound requests
before the bridge accepts a reference. The bridge additionally checks the
audience, tenant, owner, personal-only conversation, bot recipient, and trusted
service URL. Do not remove those checks to work around setup errors. The
manifest's personal scope is **not** an authorization boundary.

### 4. Enable the session route you need

For existing local sessions, follow
[the endpoint manual-install and reload instructions](extensions/teams-session-endpoint/README.md).
Keep the **original** session open, with its endpoint loaded and root journal
readable by the same OS account running the bridge. Missing or stale endpoints
mean read-only history; the bridge does not wake or take over offline sessions.
App-owned mode, tools, permissions, and approvals remain with the original host.
No separate bot SDK sign-in or model is needed for these existing-session sends.

For bot-created sessions instead, set `COPILOT_APP_SESSIONS=false` if you do not
want local App discovery. With `COPILOT_AUTH=logged-in-user`, run:

```powershell
npm run login:copilot
npm run models
```

These are real account/runtime operations, not offline checks. Complete your own
official sign-in, then set `COPILOT_DEFAULT_MODEL` in `.env` to an exact model ID
from that catalogue. A compatible runtime may also offer
`npm run login:copilot -- --provider entra`; support depends on that runtime and
your entitlement. Never copy credentials from another App profile. Explicit
token/runtime alternatives are commented in `.env.example`, not auto-selected.

The private SDK starts lazily only for bot-owned operations or explicit
`!control <instruction>`. Browsing existing sessions does not start a management
agent. `BRIDGE_WORKSPACES` limits bot-created workspaces; it is not an OS sandbox
and does not replace an existing host's tool permissions.

### 5. Check configuration, then keep the backend and HTTPS route running

```powershell
npm start -- --check
npm start
```

`--check` validates local configuration without starting a Bot listener, SDK,
endpoint, login, or model call. It does **not** validate Azure credentials, Teams
channel configuration, tunnel reachability, or host extension compatibility.

Keep the second command running. In another terminal, start your chosen HTTPS
tunnel/reverse proxy targeting **`http://127.0.0.1:3978`**, preserving
`POST /api/messages`, its JSON body, and the Authorization header. The public
webhook must be reachable by the Bot service without an interactive browser
login/interstitial; the backend's JWT authentication must still remain enabled.
Expose only the intended backend routes, never repository files, the simulator,
Copilot endpoints, or local broker/state directories.

`http://127.0.0.1:3978/health` checks the local process. A healthy response does
not prove Teams delivery or Copilot sign-in. An unauthenticated request to
`/api/messages` should be rejected, not return a useful bot response.
If the public hostname changes, update the Azure Bot messaging endpoint.
Sleep, loss of network, a stopped tunnel, or a stopped backend prevents delivery.
Ctrl+C stops the foreground process; no automatic startup is installed.

### 6. Build and import your personal Teams app

Use the **same bot application ID** as `TEAMS_APP_ID`:

```powershell
.\teams-package\New-TeamsPackage.ps1 `
  -BotId "<your-bot-application-guid>" `
  -WebsiteUrl "https://example.test/support" `
  -PrivacyUrl "https://example.test/privacy" `
  -TermsUrl "https://example.test/terms" `
  -OutputPath "..\copilot-sessions.zip"
```

Replace the placeholders and `example.test` URLs with your own actual HTTPS
support/privacy/terms pages. The script creates only `manifest.json`, a 192x192
color icon, and a 32x32 outline icon using original generated artwork.

On **Teams desktop or web**, sign in as the configured owner in the configured
tenant: **Apps -> Manage your apps -> Upload an app -> Upload a custom app**,
select the ZIP, then **Add/Open** for personal use. Labels may vary by client.
If upload is unavailable, contact your Teams administrator; do not bypass policy.
See [the complete package guide](teams-package/README.md).

Send **`!help`**, then **`!sessions`**. After installation on desktop/web, open
the **same bot chat** in Teams mobile using the **same account and tenant**.
Mobile is a client for that installed bot, not a backend host or a replacement
for the computer/tunnel. Availability and card rendering depend on tenant policy
and the mobile client; no separate mobile sideload flow is promised.

## Everyday use

| Message | Effect |
| --- | --- |
| `!sessions` | Find a source |
| `!use <name or ID>` | Select that exact source; use its canonical ID if names are ambiguous |
| `!history` / `!history 20` | Read 10 messages by default, or an explicit count from 1 to 50 |
| `!status` | Show the selected source and notification state |
| `!subscribe` | Follow the exact selected source without expiry; observation is journal-backed or explicitly live-only |
| `!unsubscribe` | Mute passive notifications, not explicit task replies or outstanding receipts |
| `!home` | Open the Inbox without changing the next-message target |
| `!help` | Show commands and capabilities |

Type ordinary work in Teams' native composer. Without a selected source, nothing
is forwarded. Only explicit `!` commands manage the bridge. Plain `Home`,
`Sessions`, `history`, and `control:` are literal work, not old menu commands.
Unknown/malformed `!` commands fail rather than becoming an agent prompt.

Root sessions and side chats have independent canonical identities, history,
admissions, and subscriptions. A parent subscription never includes its children.
Reading history or changing a view does not subscribe, switch the selected send
target, or silently start another session. Optional `COPILOT_APP_METADATA_DB`
enables read-only side relationships from an explicitly selected compatible App
database; no database is auto-discovered, migrated, or written.

Host acceptance, observed execution, confirmed results, and Teams delivery are
different states. Uncertain admissions/deliveries are retained and **never
automatically resent**. Subscriptions start at the current local journal cursor,
not historical output. Restart reconciliation is read-only and does not replay
work. Native management peers without a correlatable message ID stay read-only.
The included core preserves durable history/outbox formats: new complex-text
messages use the v4 escaped basic-HTML/XML fallback, while already persisted
legacy payloads are not rewritten or reposted.

### Interaction v3

The Inbox shows observed needs-you/running/recent-result state. App approval and
question state remains **unknown** unless the original host exposes authoritative
evidence; a busy heartbeat is not a permission request. Native request cards have
their own signed surface, so changing focus or refreshing the Inbox does not
invalidate another pending request.

An accepted Teams task automatically follows that source for 24 hours, including
after an earlier Mute. Explicit `!subscribe` has no expiry. App following uses the
existing durable local cursor; owned SDK sessions are **live-only**, with no
automatic reconnect or invented catch-up cursor. Existing paused subscriptions
stay paused. Following capacity/failures are reported separately from the task's
direct result obligation.

Results first show a short preview and a **Show full** action. Full content is
published through the existing measured chunk formatter as read-only history;
it never resends work or changes the next-message target. A stable task-receipt
reference supplies context without pretending to be a native server-stamped
quote. Three or more passive source notifications within 60 seconds can form
one digest; direct task replies are never folded into it. Individual passive
notifications may wait for that collection window.

`BRIDGE_STATUS_UPDATE_SECONDS` defaults to 5 (minimum 2); state transitions can
update immediately. `BRIDGE_FOLLOW_HOURS` defaults to 24 (minimum 1). Values must
fit the validated timer range. Rendering cards and following do not start an SDK.

The Store now writes **schema 2**. Opening schema 1 validates the same owner and
atomically preserves its sources, receipts, admissions, subscription cursors and
all legacy outbox bytes/statuses. Old binaries reject schema 2. A controlled
upgrade must stop the single writer and retain a consistent private backup.
After any newly accepted work, restoring an older database is **not a safe
rollback**: it can lose deduplication and receipt facts. Retain the schema-aware
binary/state and review a forward fix or an explicit offline downgrade instead.
See the [design and implementation record](docs/design/interaction-v3.md).

## Private state and operational limits

Keep `.env`, bot secrets, SDK profiles, broker files, conversation journals,
generated personal ZIPs, and `.bridge` private. State lives under
`.bridge\bots\<bot-application-id>` and is bound to the bot/owner/tenant/transport.
It can contain message content, authenticated conversation references, and signed
action material; it is **not** sanitized public telemetry.

Use a dedicated trusted OS account and restrictive Windows ACLs. POSIX file mode
bits are not Windows access controls. Local broker access is a trust boundary:
another process with write access can submit work. This is single-owner,
single-process software, not hardened multi-tenant hosting.

Do not share state across operators or remove a lock while its recorded process
is alive. After a crash, verify the process is gone before manually removing only
this bridge's lock. Never delete Copilot's own locks or copy another user's
profile. No automatic retention or deletion job is installed.

The [optional trusted relay](docs/relay.md) is an alternative transport only.
It is not supplied or required for the webhook setup.

## Development and clean source distribution

```powershell
npm run typecheck
npm test
.\teams-package\Test-TeamsPackage.ps1
npm run check:source
npm run pack:source -- --output "..\copilot-teams-client-source.zip"
```

`npm test` builds and runs the network/child-process-blocked suite with synthetic
config and explicitly permitted loopback fixtures. It does not sign in, create
cloud resources, send Teams messages, or run a native model. Packaging tests use
a fake bot registration. These checks are not an end-to-end certification of
your real tenant or host. `smoke:native` is a separate developer diagnostic that
starts a native runtime; it is not part of setup or the default test suite.

The source packer uses an **explicit file allowlist**, not a recursive copy or
Git history. It rejects redirected source paths, common credential patterns, and
non-public npm lockfile URLs. It writes the ZIP outside the source tree and
prints a file/hash inventory for private release review. Unknown files, build
output, local settings, generated Teams packages, and task evidence are excluded.
Do not distribute an arbitrary checkout archive or run `Compress-Archive *`.
Review the exact inventory/content before publishing: a pattern scan is not a
guarantee that arbitrary text contains no private information.

Source licensing is [MIT](LICENSE); dependencies and hosted products retain their
own licenses and terms. See [third-party notices](THIRD_PARTY_NOTICES.md).
