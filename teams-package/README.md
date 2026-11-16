# Personal Teams app package

This ZIP is **only the Teams client package**: a manifest and two icons.
It does not register an Entra application or Azure Bot, enable a Teams channel,
host a webhook, run the local bridge, install an extension, or contain credentials.
First complete the [independent webhook setup](../README.md#first-run-independent-authenticated-webhook).

Use the **bot registration's application/client ID**, matching `TEAMS_APP_ID`.
The Azure Bot must have the Microsoft Teams channel enabled and its messaging
endpoint set to your HTTPS **`/api/messages`** route. Keep the local process and
tunnel/reverse proxy running while using the bot.

## Build your ZIP

From the repository root in PowerShell 7 on **Windows**:

```powershell
.\teams-package\New-TeamsPackage.ps1 `
  -BotId "<your-bot-application-guid>" `
  -WebsiteUrl "https://example.test/support" `
  -PrivacyUrl "https://example.test/privacy" `
  -TermsUrl "https://example.test/terms" `
  -OutputPath "..\copilot-sessions.zip"
```

Replace the placeholders and example URLs with your own actual HTTPS pages for
an installation. Optional `-AppName`, `-DeveloperName`, and `-Version` customize
the display metadata. Increment `-Version` when distributing an app update.
Keep generated per-operator ZIPs outside public source.

The builder generates original 192x192 color and 32x32 outline PNG icons.
It refuses an existing output path, an empty bot ID, non-HTTPS metadata, embedded
URL credentials, and unresolved manifest placeholders. It makes no network
requests. The three files are at the ZIP root; do not wrap them in another folder.
Windows is required for PNG generation with `System.Drawing`.

The manifest is version 1.23 and **personal-only**. Its menu contains
`!sessions`, `!history`, `!status`, `!subscribe`, `!unsubscribe`, and `!help`.
Use `!use <name or ID>` in the chat to select a source. These are fixed bridge
commands, not native Teams slash commands or an AI command parser.
Old unprefixed titles such as `Home`, `Sessions`, and `Working` are literal work
messages now; they do not navigate the bridge. Updating source alone does not
update an already installed Teams app package.

## Upload and open the bot

1. In **Teams desktop or web**, sign in with the work/school owner account and
   tenant configured in the backend.
2. Open **Apps -> Manage your apps -> Upload an app -> Upload a custom app**.
   Labels can vary by client. Select your generated ZIP, then **Add** and **Open**
   for personal use.
3. Send **`!help`**, then **`!sessions`**. A lack of an automatic welcome card on
   installation/chat-open is not proof of failure; start with an explicit message.
4. On **Teams mobile**, use the same account and tenant and open the same installed
   app/bot chat. Keep the computer, original Copilot host, bridge process, and
   HTTPS route online. Mobile does not run this backend.

Custom app upload, bot access, and mobile availability are controlled by your
organization. If the upload option or app is unavailable, ask your Teams
administrator; do not bypass the tenant's policies. A personal Microsoft account
is not a substitute for the required work/school tenant.

Manifest scope does not authenticate users. The backend still checks the signed
channel request, exact bot, owner, tenant, and personal conversation. Never weaken
those gates or place a secret in the ZIP to make installation work.

Microsoft reference:
[Upload your custom app](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload).

## Local validation

```powershell
.\teams-package\Test-TeamsPackage.ps1
```

The tests use an explicit fake registration and `example.test` URLs, inspect the
ZIP/menu/personal scope and PNG dimensions, exercise rejection behavior, and
remove only their own temporary files. They do not install the app, register a
bot, or send Teams messages.

For optional official-schema validation, download Microsoft's
[Teams 1.23 schema](https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json)
to a local file. With Python 3 and `jsonschema` available, add
`-SchemaPath "<local-schema-file>"` to the builder or test command. If needed,
install that optional validator with `python -m pip install jsonschema`.
Validation uses Draft 4 and refuses external schema retrieval; no schema or
operator configuration is downloaded by the builder. A synthetic test schema
checks only fixture behavior and is not official Teams certification.

For upload errors, check ZIP root layout, GUID consistency, manifest version,
HTTPS legal/support URLs, and tenant app policy. For a bot that installs but does
not answer, check the running backend, tunnel, Azure Bot endpoint/channel, secret
expiry, and owner/tenant GUIDs. `/health` is local readiness, not end-to-end proof.
