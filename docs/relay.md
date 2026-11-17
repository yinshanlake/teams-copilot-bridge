# Optional trusted relay transport

The independent [authenticated webhook setup](../README.md) is the public
onboarding route. This optional adapter is for an operator who **already has**
an authorized, compatible relay and its own bot binding. This repository does
not supply a hosted relay, registration portal, or relay provisioning scripts.
There is no internal service or organization membership prerequisite.

Keep your direct-webhook `.env` and state separate if trying another transport.
State is bound to bot, tenant, owner, and transport/binding. Changing transport
is not an in-place migration of an existing installation.

## Operator-provided configuration

The relay operator must provide a separate **version 1 JSON binding** (at most
32 KiB), not an installed application's profile or credentials. Required fields:

```json
{
  "version": 1,
  "botAppId": "REPLACE_WITH_BOT_APPLICATION_GUID",
  "ownerOid": "REPLACE_WITH_OWNER_OBJECT_GUID",
  "aadTenantId": "REPLACE_WITH_TENANT_GUID",
  "relayUrl": "https://relay.example.test",
  "aadAudience": "api://REPLACE_WITH_RELAY_RESOURCE_GUID",
  "aadScope": "api://REPLACE_WITH_RELAY_RESOURCE_GUID/.default"
}
```

These values are placeholders, not a working service or valid binding. The
audience identifies the relay's Entra resource, **not** the per-bot application.
An optional `relayPublicBaseUrl` must match the same pinned origin. A compatibility
ZIP may contain one root `twin-config.json`; do not export or reuse an installed
profile. Keep either config form private and outside the source distribution.

Set these in your private `.env` instead of the webhook transport:

```dotenv
BRIDGE_TRANSPORT=relay
BRIDGE_RELAY_CONFIG=C:\REPLACE_WITH_PRIVATE_RELAY_CONFIG.json
BRIDGE_BOT_APP_ID=REPLACE_WITH_BOT_APPLICATION_GUID
BRIDGE_RELAY_ORIGIN=https://relay.example.test
TEAMS_TENANT_ID=REPLACE_WITH_TENANT_GUID
TEAMS_OWNER_OBJECT_ID=REPLACE_WITH_OWNER_OBJECT_GUID
```

Keep the existing workspace, state, and Copilot/session settings. Remove the
unused `TEAMS_APP_SECRET` from this relay-only configuration. The independently
chosen bot ID, origin, and optional `BRIDGE_FORBIDDEN_BOT_IDS` are trust pins;
the bundle cannot choose where an access token is sent. Owner/tenant settings
must match the binding. No relay/webhook/token fallback occurs on failure.

Authentication uses `AzureCliCredential` and your own authorized Azure CLI
login, with the relay operator's delegation/consent requirements. If directed
by that operator, sign in explicitly:

```powershell
az login --tenant "<your-tenant-guid>" `
  --scope "api://<relay-resource-guid>/.default" --allow-no-subscriptions
```

Do not copy tokens or another user's login profile. Relay sign-in is separate
from any Copilot sign-in. `npm start -- --check` validates the local bundle and
pins without connecting; it cannot certify the relay or your authorization.

## Compatibility and limitations

The adapter expects its existing authenticated Socket.IO activity/send-result
protocol, including exact bot/tenant/owner binding and correlated send receipts.
An arbitrary WebSocket proxy is not a compatible relay. Review `src\relay.ts`,
`src\relay-auth.ts`, and `src\relay-config.ts` when implementing one; the webhook
route is simpler when no such service is available.

This adapter supports message/`Action.Submit` activities, not synchronous
`Action.Execute` invokes. A relay can intercept slash-prefixed text before this
client receives it; the bridge's management commands are explicit `!` commands.
No automatic welcome-on-install/chat-open behavior is promised.

Interaction v3 runs in Focus mode over this relay. Send/update remain the only
declared operations; thread posting, native quotes, reactions and deletes are
not inferred from a generic activity payload. Preview `auto` settings therefore
degrade without preventing startup. Thread-addressed work is retained for an
explicit Routing-card choice; it is not silently forwarded to an old selection.
The independent Inbox, current header, task/request cards and result previews use
ordinary authenticated send/update messages, not a new relay protocol.

An authenticated relay is trusted to represent the Bot service's inbound
activity. It is an additional trust boundary, not a reason to skip the bridge's
owner/tenant/personal-scope checks. Uncertain send outcomes are not automatically
retried. The relay backend, bot registration, local process, and original session
host still need to remain available. None is installed or altered by this guide.
