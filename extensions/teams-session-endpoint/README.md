# Existing-session endpoint extension

`extension.mjs` is the source for the local endpoint used by the bridge to send
to an **already open, original Copilot session** without taking over its runtime.
It registers a heartbeat and uses that session's own `session.send({ prompt })`.
Its native message ID lets the bridge correlate accepted work and visible output.
There is no coordinating agent, workbench, cloud broker, or fallback queue.

This directory is deliberately **not** `.github/extensions`: cloning/building
the repository must not automatically load an endpoint or modify your host.
Nothing in the bridge installs or reloads this extension for you.

## Required host capability

The original App/CLI must support the preview extension entry point
`@github/copilot-sdk/extension`, `joinSession({ tools: [] })`, `session.sessionId`,
`session.send()`, `session.on()`, and `session.log()`. It must expose the
compatible local `workspace.yaml` / root `events.jsonl` session layout.
The extension import is resolved **by that host**; installing this repository's
npm dependencies does not upgrade or add that API to the desktop App/CLI.

There is no universal App version compatibility guarantee or verified automatic
offline-wake API. If your host lacks these interfaces or returns no correlated
message ID, existing-session writes are unsupported. Use the original host
directly, or the bridge's separate bot-created sessions. Do not remove locks,
resume an App session through another SDK, or replace its handlers as a workaround.

The bridge and host must run under the same trusted OS identity with access to
the same local files and process IDs. A remote/sandbox host whose files and PID
are not local is not supported by this endpoint protocol.

## Manual installation on Windows

Run the following yourself from the source repository **only when both target
directories are new**. If an endpoint or broker already exists, stop and review
that installation instead of overwriting it.
Use only one loaded endpoint instance per original session. Do not install a
second project-scoped copy alongside the user-scoped copy; project extensions
can shadow user extensions with the same name.

```powershell
$endpoint = Join-Path $HOME '.copilot\extensions\teams-session-endpoint'
$broker = Join-Path $HOME '.copilot\teams-session-broker'
if ((Test-Path -LiteralPath $endpoint) -or (Test-Path -LiteralPath $broker)) {
    throw 'Existing endpoint/broker detected. Review it manually; do not overwrite.'
}
New-Item -ItemType Directory -Path $endpoint, $broker | Out-Null
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $broker /inheritance:r /grant:r "${account}:(OI)(CI)F"
if ($LASTEXITCODE -ne 0) { throw 'Broker ACL setup failed. Stop before loading the extension.' }
Copy-Item .\extensions\teams-session-endpoint\config.example.json `
  (Join-Path $broker 'config.json')
Copy-Item .\extensions\teams-session-endpoint\extension.mjs `
  (Join-Path $endpoint 'extension.mjs')
```

These are **manual operator commands**, not part of `npm ci`, build, tests, or
bridge startup. Review the ACL against your organization's requirements.
Broker files contain prompts and response/admission metadata: local processes
able to write them can submit work. JSON configuration is not authentication.
Do not put this directory on a shared drive or grant other users write access.

The example configuration enables only `send_message` and sets a 20-second
registration TTL. The bridge accepts TTLs from 5 to 120 seconds; the endpoint
renews its heartbeat every 5 seconds. Do not lengthen TTL merely to present
an offline session as writable.

## Load in the original host, then verify availability

Open the intended original session through its normal App/CLI UI. In **that
session**, use the host's extension reload action, or ask its agent to call
`extensions_reload` if that tool is available. Inspect `teams-session-endpoint`
through the host's extension list/inspect tools and check for load errors.
Only a host implementing the extension API can perform this reload.
Copying the file, restarting this bridge, or reloading some other session is not
sufficient to make the intended source writable.

With `COPILOT_APP_SESSIONS=true`, refresh `!sessions` in Teams. The intended source
must have both readable local root history and a fresh live endpoint before a
write is allowed. Check its exact session identity; a matching title or workspace
is not enough. Keep the original host session open. Host permissions and
approvals are still enforced there; installing this extension does not grant
remote stop, model/mode changes, approval, or takeover authority.

The supplied source uses these portable home-relative defaults:

| Purpose | Location |
| --- | --- |
| Endpoint source | `<home>\.copilot\extensions\teams-session-endpoint\extension.mjs` |
| Broker configuration | `<home>\.copilot\teams-session-broker\config.json` |
| Broker registrations/queues | Subdirectories of that same broker root |
| Session metadata and history | `<home>\.copilot\session-state\<session-id>` |

Bridge overrides `COPILOT_APP_BROKER_DIRECTORY` and
`COPILOT_APP_SESSION_STATE_DIRECTORY` change **only its reader**; this source
continues using the defaults. Leave them unset for this installation. A custom
host profile needs an explicitly reviewed matching integration, not one-sided
path overrides. `COPILOT_APP_METADATA_DB` is optional read-only side-relationship
metadata and is not needed to install the endpoint.

No endpoint or expired heartbeat means read-only. If a send times out or returns
an invalid/uncertain response, inspect the original host: the work may already
have been admitted. The bridge must not automatically resend it. Restoring the
endpoint is not authorization to replay old requests.

To disable this route, first stop the bridge or set `COPILOT_APP_SESSIONS=false`
and restart it, then unload/remove the extension through the original host's
normal mechanism. Do not delete active broker queues, profiles, or Copilot locks.
