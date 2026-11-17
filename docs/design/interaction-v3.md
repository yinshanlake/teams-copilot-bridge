# Teams interaction v3: Phase 0 design note

## Implementation record

The source analysis below is the historical Phase 0 baseline, not a claim that
later implementation leaves configuration unchanged.

Phase 1 now ships the non-preview Focus path: independently scoped Inbox, turn,
request and result cards; visible next-message target; read-only History/Show
full; automatic/explicit following and Mute; origin-bound direct results; and
passive-only digests. The main entry point and simulator enable it. Older direct
Bridge test harnesses deliberately retain the legacy UI path to exercise
compatibility; the new interaction tests exercise the production options.

Store writes schema 2 and accepts validated schema 1 for atomic migration.
Existing source/receipt/outbox populations are not subject to a new small UI
record limit. A synthetic populated migration fixture retains sent outbox
payloads, historical uncertain receipts, timed-out admissions and an
enabled-but-paused revision-1 subscription. No historical admission is converted
into a new running turn. State downgrade after accepting new work is not safe;
retain all new dedup/receipt facts and a schema-aware binary.

Result preview envelopes use an explicit `publication.version: 1` alongside
the retained full body; Show full generates a separate read-only v4 chunk group.
Existing unversioned/v2/v3/v4 outbox rows are not rewritten. Preview thread,
native quote/reaction, and App waiting-state gates remain as described below.
The source allowlist now includes this note and the shipped interaction module
and tests; no dependency or endpoint-source change is needed.

Phase 1 build/typecheck and all 278 offline tests passed. The Windows package
checks passed for ZIP/menu/icon shape and rejection cases. The source audit
passed with the explicit new files included. A typed mock and the intentional
`!home` menu expectation were corrected before these final gates.

Phase 2 implements the safe capability fallback, not an unverified preview
transport. Both webhook and relay explicitly report no thread-post, native-quote
or reaction capability; `auto` remains Focus and `off` disables those requests.
No new REST operation, endpoint operation, dependency or relay capability is
invented. Persistent session-thread bindings, MRU thread publication, native
reactions/quotes and the optional remembered-target UI remain withheld behind
the documented platform/transport evidence gates. This is an intentional
deviation from the preview wireframes, not an assertion that threading works.

Authenticated containing-chat metadata establishes checked aliases without
parsing opaque conversation IDs or rewriting old receipt/cursor namespaces.
Conflicting identities are not merged. An unbound/unknown thread reply is saved
as an unsent routing intent, with an explicit writable-source or allowed-workspace
create-and-send action, expiry, once-only receipts and no uncertain retry.
Original prompt bytes and the original authenticated prompt reference are retained.
At most 16 new unresolved drafts may wait; this does not limit legacy sessions,
receipts or outbox rows.

Schema 3 reads schema 1/2 and preserves their obligations. The version bump
prevents an older schema-2 reader from silently ignoring chat aliases/routing
semantics. The current Focus header is now an independent surface too: the UI-H1
regression (approve B from its independent card while Inbox stays selected) clears
the existing B header's pending controls on the same activity, without expiring
another request surface. Changing Focus freezes the previous header, not its work.

Phase 1 cold-review corrections are included in Phase 2: expiry rechecks the
current deadline inside Store serialization without revoking a valid renewal;
cross-focus read-only History failures visibly retain their own source/intent;
digests group canonical sources, page at three sources, and split bounded
64-publication batches fairly. Final signed Activity size is checked before
claiming members. A local size failure leaves members pending/unclaimed for
individual delivery, never uncertain. Regressions exercise the actual
four-source/64-publication case with both Submit and Execute, 66 distinct sources
with a two-source remainder, and injected final-payload oversize.
Phase 2 build/typecheck, all 290 offline tests, and the public-source audit passed.

Phase 3 adds owned controls without expanding existing-App authority. All pinned
permission kinds keep manual handling; the controller still denies execution.
True off returns user-not-available for permissions and declines plans, with
backend and UI guards. Permission/plan deadlines default to 15 minutes. Displayed
approval details are redacted; incomplete/unrenderable details cannot be allowed.
Session grants are restricted to explicit native command/write scopes; managed
one-shot/sandbox-escalation requests, foreign owning-host requests, and
permanent/location grants cannot use that path. Native request completion, not
an inferred answer or mere button click, dismisses pending state.

Stop now has a separate, durable owner confirmation for commands, cards and the
Control tool. The native API still aborts the currently processing message, not
an atomically addressed entire queue; ACK/uncertainty and remaining background
work are stated explicitly. Steer uses immediate only for an observed owned
root, retains its original recipient, and records a control receipt rather than
inventing an independently completed task. Normal sends explicitly enqueue.
Unknown send/stop ACK outcomes never become definite failure/retry permission.

Elicitation takes the documented unavailable fallback: no form handler is
registered, so this client neither advertises unsupported form capabilities nor
steals another client's first response. Authoritative owned SDK form events may
show a read-only needs-you notice; exact native completion clears it. No matching
by text/order, App callback enrollment, remote App answer, or endpoint change is
introduced. The default legacy question handler and exact plan actions remain.

Final control-state format is schema 4, accepting validated 1/2/3 data and
preserving all old source/cursor/receipt/outbox identities and payload bytes.
Older readers reject it rather than silently ignore Stop/approval state. Pending
controls are invalidated across restart, uncertain outcomes remain uncertain,
and no accepted task or decision is replayed. Backout after new acceptance must
retain the schema-aware state; an old database restore is not a safe downgrade.
The initial Phase 3 freeze passed build/typecheck and all 303 offline tests,
including the Phase 1 cold-review regressions. Its source audit and all four
Windows package checks passed. Runtime/tenant preview gates remain deliberately unverified;
these offline results do not authorize deployment or certify real Teams/SDK use.

Post-freeze cold-review corrections preserve the existing 512-character receipt
ID bound for result task references and both steering parent references. Genuine
`control-tool:<controller UUID>:<tool-call UUID>` receipts remain unchanged across
restart; no dedup ID is shortened or rehashed. Interaction transitions now share
the projector's canonical source/event dedup decision, including its separate
ephemeral cache, rather than treating a visible timeline change as event novelty.
Current headers refresh once per source event even when native completion,
timeout, abort or shutdown removes the final pending request. This updates the
same activity without invalidating another source's pending request surface.
The fixes do not change schema 4, dependencies, endpoint source or capability gates.
A schema-4 label alone is insufficient for backout: binaries with the former
64-character task/parent-reference checks cannot reopen Control-origin state.
The corrected candidate passed build/typecheck, all 311 offline tests (including
eight new regressions), and all four Windows package checks.

## Historical design evidence

Status: **proposal for owner review; no feature implementation**.
Evidence date: 2026-11-17.
Repository baseline: `dc81c718de8d3e8c0b18426af263b9d0909e3661`.

## 1. Scope and conclusions

This note maps the interaction-redesign brief onto the existing public
repository. Phase 0 changes only this document. It does not change configuration,
the manifest, dependencies, the endpoint, runtime behavior, or the source-package
allowlist. Phases 1-3 require review before implementation; Phase 4 is a written
proposal only. The product remains an owner-only personal Teams bot, not a tab
or a new web frontend.

The recommended direction is visible Focus-mode state first, then optional
thread addressing, then richer controls for bridge-created working sessions.
Reuse the current authorization, persistence, correlation, and publication
mechanisms rather than adding a second message dispatcher. In particular:

1. **Direct results are already independent of subscriptions.** Mute, follow
   expiry, a digest, and a newer thread must not cancel or redirect an explicit
   task's result/receipt.
2. **App sessions do not currently expose authoritative approval state through
   this bridge.** SDK event declarations do not establish what an App host
   writes to its journal, or what the current App projection forwards.
3. **Remote permission, question, and plan handling already exists for owned
   sessions.** The current permission policy is manual, not approve-all.
4. **Preview APIs are not present merely because a different Teams SDK documents
   them.** Agents 1.10.1 has message/update/delete primitives and preserves quote
   entities, but no dedicated reply-chain or reaction method.
5. **Current History navigation sometimes changes the selected source.** The
   brief's stricter read-only navigation invariant requires a deliberate future
   separation, not a claim that the current code already has it.

No live Teams, Bot, Copilot, original journal, profile, broker, or installation
was accessed for discovery. Repository tests construct synthetic local journals.
Installed package declarations and JavaScript were inspected without creating
a native runtime. Platform references below were separately checked by the
coordinating session; they are not tenant certification.

### Evidence labels

| Label | Meaning in this note |
| --- | --- |
| **verified** | Directly established by this repository or the exact installed package source/declarations; an explicitly identified offline probe may add serialization evidence. Not a real-service guarantee. |
| **fixture-only** | Demonstrated by existing sanitized/synthetic test data, not an actual App journal or Teams client. |
| **docs-only** | Documented by the linked public platform reference; not established for the pinned client or deployment. |
| **runtime-unknown** | Requires authoritative host data or separately authorized deployment/client verification. |
| **unsupported** | Not exposed by the current bridge/protocol, or unavailable on the named pinned surface. This does not mean the platform can never support it. |

Package-relative citations use these abbreviations:

- `SDK`: `@github/copilot-sdk@1.0.31`.
- `AH`: `@microsoft/agents-hosting@1.10.1`.
- `AA`: `@microsoft/agents-activity@1.10.1`.

These are installed from the existing lockfile, not inferred from latest online
SDK documentation. Repository citations refer to the baseline above.

## 2. Current architecture and protected behavior

### 2.1 Inbound, routing, and UI

| Area | Actual behavior and evidence |
| --- | --- |
| Startup | `src\main.ts:36-79` binds Store ownership to tenant, owner, bot, and transport fingerprint; constructs either webhook or relay; starts Bridge before enabling relay delivery. A controller record is allocated without starting its SDK (`src\bridge.ts:98-146`). |
| Webhook authentication | Official `authorizeJWT` finishes before owner validation, reference persistence, or adapter processing. Audience and optional signed service-URL claim are checked separately (`src\teams.ts:54-64,163-200`). `createTeamsAdapter` enables issuer/service-URL validation and the outbound host policy (`src\teams.ts:139-161`). |
| Owner boundary | Tenant, owner AAD object ID, Teams channel, personal conversation, non-group scope, bot recipient, non-bot sender, required IDs, and exact trusted HTTPS service hosts are checked (`src\teams.ts:22-31,69-88`). Manifest personal scope is not authorization. |
| Accepted activities | Webhook accepts text messages, signed `Action.Submit`, and a constrained manual `adaptiveCard/action` / `Action.Execute` invoke. Other activity types and arbitrary invokes fail closed. Relay accepts message/Submit only (`src\teams.ts:33-51,82`; `src\relay.ts:241`). No authenticated install-event welcome path exists. |
| Chat key | Currently `digest(tenant:owner:msteams:conversation.id)`, where the ID is opaque. `channelData.chat.id` and `replyChain.id` are not routing inputs. `Incoming` carries only text or action data (`src\teams.ts:83-88`; `src\bridge.ts:20`). |
| Literal composer | `parseCommand` recognizes only explicit valid `!` commands; malformed/unknown commands fail instead of becoming work. Ordinary text is forwarded unchanged to `selectedId`, regardless of a Control view (`src\commands.ts:3-31`; `src\bridge.ts:822-921,938-1020`). |
| Explicit selection | Full canonical IDs or unambiguous exact normalized names/UUID prefixes resolve sources, never shared workspace/title guesses. Failed `!use` retains the old source but sets `selectionBlocked`; later work is refused until a valid selection (`src\bridge.ts:228-235,830-847,923-936,953-967`; `test\native-chat.test.ts:45-98`). |
| Actions | A persistent random HMAC key signs self-contained claims: nonce, conversation, selected source, revision, expiry, view, optional target/request/surface/query. The secret is not a one-time per-button key. Mutations consume durable `action:<nonce>` receipts; authenticated duplicate actions report their existing outcome, ignoring changed form fields (`src\actions.ts:17-24,49-136`; `src\bridge.ts:182-218`). |
| Navigation exceptions | Some signed view-only navigation intentionally survives expiry/selection revision. Refresh, Select, history reads, and mutations still have nonce handling as appropriate; surface mismatch still rejects. Do not blanket-convert reusable navigation into mutation authority (`src\actions.ts:41-47,118-131`; `src\bridge.ts:191-215`). |
| Current surface | One conversation-wide `surfaceId`, `revision`, `dashboardId`, and mutable view. A fresh reply rotates the surface; normal updates replace that dashboard (`src\domain.ts:111-136`; `src\bridge.ts:482-506,549-576,1608-1649`). It is not yet a multi-card Inbox/turn/request model. |
| History coupling | `!history` reads the existing selection, but signed History links call `requestHistory(..., true)`; `setView("transcript")` also assigns a non-controller target to `selectedId`. Tests explicitly expect an old signed History link to select its source (`src\bridge.ts:558-563,668-673,1089-1137`; `test\regressions.test.ts:882-943`). |
| Cards | Adaptive Cards **1.5**, three-row session pages, text search, choice sets, ShowCard details, and a 27,000-byte fallback budget. Webhook Execute includes a Submit fallback; relay/simulator uses Submit (`src\cards.ts:10-42,155-177,345-429,567-598,644-674`). Availability and some destination visibility already exist; the UI is not wholly a black box. |

The redesign must distinguish **Open/Select** (explicit routing) from
**History/Show full** (read-only presentation). Do not silently repurpose an old
signed History token into a new mutation or remove the unresolved-selection
fence. The behavior change and related existing-test changes belong to a reviewed
future phase, not this document.

### 2.2 Store, source identity, observation, and delivery

| Area | Actual behavior and evidence |
| --- | --- |
| Store | Schema 1, exact owner binding, exclusive PID lock, validated bounded state, serialized cloned mutations, temporary file + fsync + atomic rename. Restart turns started receipts/sending outbox rows into uncertainty, clears pending approvals, and increments conversation revisions; it does not replay work (`src\store.ts:65-129,132-219,222-257`). |
| Canonical source | Root and side sessions have their own canonical session UUID. Optional explicitly configured read-only SQLite resolves workspace IDs to parent **session** UUIDs and rejects ambiguous/cyclic relations. Parent subscription never includes children (`src\side-metadata.ts:16-86`; `src\app-sessions.ts:212-279`; `test\sidechat-subscriptions.test.ts:54-74,155-189,455-491`). |
| App route | Discovery reads canonical root metadata/journal and fresh broker registrations. Sending needs both readable history and a live endpoint; no wake, SDK resume, coordinator queue, or takeover fallback (`src\app-sessions.ts:212-321,667-842`; `src\native.ts:467-535,571-618`). |
| App admission | Capture a baseline before send. Persist native message ID, baseline/deadline, original conversation, and receipt IDs before exposing acceptance or processing its results. Observe only matching native origins after that baseline (`src\bridge.ts:350-389`; `src\native.ts:571-615,814-946`). |
| App completion | `accepted`, `executing`, and `confirmed` are separate from observation failure/timeout and Teams delivery. A final plus correlated completion evidence is needed. A result from `publish_chat_update` alone is not task completion (`src\domain.ts:167-196`; `src\bridge.ts:1297-1394`; `test\published-results.test.ts:31-61`). |
| Owned direct origin | A durable direct-origin intent precedes send; ACK identity is committed before queued live events proceed. The original conversation receives correlated finals even after selection changes or restart (`src\bridge.ts:969-1019,1297-1380`; `test\sidechat-subscriptions.test.ts:392-414`). |
| Passive subscriptions | Explicit per-conversation/per-source subscriptions capture a from-now journal cursor. Current limits are eight enabled subscriptions, 64 retained source records, two physical reads, and revision/cursor fences. Mute/unsubscribe does not need source I/O (`src\bridge.ts:585-640,1423-1526`; `test\sidechat-subscriptions.test.ts:218-257,554-799`). |
| Journal cursor | File generation, covered byte offset, physical line index, header/anchor hashes, split-EOF/discard state, and bounded publication context survive restart. Replacement/truncation pauses rather than rebasing into history. Cursor and outbox advances commit together (`src\journal-observer.ts:21-38,85-213`; `src\bridge.ts:1489-1521`). |
| Result dedup | Canonical source, native origin, event/result identity and `sourceResultKey` reconcile live, admission, and subscription observations. A direct claim upgrades an existing passive row; unsubscribe cannot cancel direct/admission rows (`src\journal-observer.ts:8-19`; `src\bridge.ts:371-376,1396-1421,1504-1519,1560-1566`; `test\sidechat-subscriptions.test.ts:259-288`). |
| History namespace | Explicit read-only HISTORY groups have separate intent/outbox identities and source/supersession guards. Reading old results must not consume live final dedup or become subscription eligibility (`src\bridge.ts:1062-1242`; `test\native-chat-races.test.ts:97-147,176-264`; `test\native-chat.test.ts:347-362`). |
| Outbox | Persist `pending -> sending` before transport; record returned Teams activity ID only on ACK. Failures become rejected/uncertain without automatic reposting. Already sent/sending/uncertain rows are never retracted by unsubscribe (`src\bridge.ts:1543-1606`; `src\store.ts:178-197`). |
| Formatting | New groups use v4 Markdown or escaped basic HTML (`textFormat: "xml"`). Exact business-body slices are bounded by the serialized 12,000-byte Activity JSON, preserving Unicode and CRLF. Unversioned/v2/v3 persisted payloads retain their original bytes; v4 must also remain compatible (`src\replies.ts:10-92`; `src\transport-format.ts:1-50`; `test\native-chat-format.test.ts:148-197`). |
| Safety | `safeText` masks registered secrets/common credential shapes and removes control characters; `logError` deliberately logs only area/error kind. Unknown arguments, reasoning, and internal subagent text are not public notification content (`src\safety.ts:48-91`; `src\projection.ts:137-164,207-224,317-334`). |

There are **two recipient classes**, not one subscription gate:

- Direct/admission recipients are obligations created by explicit Teams work.
- Passive recipients are eligible only under an enabled source subscription.

Current code already preserves the first through unsubscribe. The brief's
"results only for subscribed/followed sessions" statement is incorrect when
applied to direct work. Its acceptance criterion must mean **passive**
notifications only.

### 2.3 Runtime, endpoint, relay, and simulator

`NativeRuntime.start()` installs the event listener and starts only the local App
reader. Private SDK construction/login/model validation happens lazily on an
explicit owned/Control operation. Inventory and previews do not start an SDK;
settings can explicitly reconnect an owned session. Owned workspaces come from
the validated allowlist. Cold resume refuses a foreign live owner/shared runtime
and does not continue pending work or recover transcripts automatically
(`src\native.ts:192-258,301-435,467-545,742-800`;
`src\config.ts:29-76`; `src\bridge.ts:148-160,1022-1043`).

Owned sends while busy currently call `session.send({ prompt })`, using the
pinned default queue mode. Pending scoped input/plan/permission blocks ordinary
text before asynchronous UI projection catches up. Settings reject busy/waiting
sessions. Stop currently calls `abort()` immediately; it has no two-step
confirmation. App/foreign peers cannot stop, change mode/model, or answer
permissions (`src\native.ts:554-570,620-704,706-740`;
`src\bridge.ts:738-820`; `test\native.test.ts:2231-2251`).

The endpoint is inert source in `extensions\teams-session-endpoint`, not an
auto-loaded `.github\extensions` installation. It calls
`joinSession({ tools: [] })` in the original host, registers only idle/busy
liveness every five seconds, atomically claims a bounded `send_message` file,
checks session/request/expiry, and returns the original `session.send` message ID.
There is no stop/answer/model/thread protocol. The reader validates registration
TTL, instance, PID and canonical paths; request text is limited to 16 KiB, the
request envelope to 32 KiB. Accepted-but-lost/malformed responses remain uncertain,
not replayable (`extensions\teams-session-endpoint\extension.mjs:31-50,93-146,155-230`;
`src\app-sessions.ts:706-842`). The installed App's extension API is independent
of this repository's npm SDK version.

Relay is a separately pinned, authenticated Socket.IO protocol, not the new
platform SignalR transport. It advertises `caps: []`, accepts only message/Submit,
and offers correlated send/update operations. Volatile emission, no Socket.IO
retry queue, and explicit uncertain timeouts preserve no-repost behavior
(`src\relay.ts:18-24,44-46,170-177,241-265,347-405`;
`docs\relay.md:64-82`). The bridge does not gain thread/delete/reaction support
by switching transports.

The simulator is existing loopback-only test infrastructure: synthetic identity,
FakeRuntime, PreviewTransport, fixed assets, same-origin/CSRF checks and SSE.
It is not a production authority or proof of Teams mobile rendering
(`src\simulator.ts:14-147`; `test\transport.test.ts:88-149,284-394`).
Future phases extend these fakes/renderers, not create a new product UI.

## 3. Pinned capability matrix

### 3.1 Copilot and App sources

| Capability | Evidence classification | Consequence |
| --- | --- | --- |
| Send enqueue/immediate and ACK ID | **verified**: `SDK dist\types.d.ts:3358-3444`, `dist\generated\rpc.d.ts:30600-30673`, `dist\session.js:545-580` | Omitted mode is enqueue by contract; send returns a native message ID, not completion. Current wrapper exposes neither mode nor queue count. |
| Abort current processing | **verified**: `SDK dist\session.js:2294-2318`; `src\native.ts:620-623` | ACK means abort requested, not proof of final state, empty queue, or stopped children. Only live bridge-owned sessions. |
| Permission decisions and completion | **verified**: SDK decision union/RPC and existing manual path; real host enforcement **runtime-unknown** | Revalidate exact pending request and actual RPC success. Never infer approval from a card click alone. |
| Input questions and exit-plan callback | **verified**: `SDK dist\types.d.ts:1219-1296`; existing `src\native.ts:321-356,706-729` | Already supported for owned sessions with matching runtime request ID; no guessed choice/actions. |
| Elicitation | Public declarations/dispatch **verified**; multi-client fan-out **docs-only** for runtime behavior (`SDK README.md:2215-2256`); bridge integration **unsupported** | Event/RPC IDs exist, but the public handler context omits request ID. Safe concurrent-card enrollment needs a separate evidence gate; see below. |
| Native event log/tail RPCs | **verified** declarations, not a bridge subscription implementation (`SDK dist\generated\rpc.d.ts:15832-15909`) | Opaque RPC cursors are not local `JournalCursor`s. Expired history snapshots and pruned ephemerals have explicit limitations. |
| Durable App following | Reader implementation **verified**, sanitized journal behavior **fixture-only** | From-now local journal subscriptions are supported, including readable offline App sources; live endpoint is not required merely to follow/read. |
| Durable owned/RPC-only following | **unsupported** in current `Runtime.subscriptionBaseline/Read` (`src\native.ts:541-548`) | Do not invent a cursor or wake/resume an SDK to follow. Offer explicitly limited live-only observation while already attached, or history/direct results, until a durable adapter is proven. |
| App turn/tool progress | Root journal shapes **fixture-only**; current general progress forwarding **unsupported** | Current App projection emits dialogue and admission evidence, not the raw SDK event stream. A future bounded progress projector needs supported sanitized host fixtures. |
| App waiting for approval/question/plan | **runtime-unknown**; current App approval projection **unsupported** | Show unknown/inspect original host, not "Waiting at your PC" inferred from busy, idle, tools, or an unfinished result. |
| App stop/remote approval/model/takeover | **unsupported** by authority and endpoint contract | No change in Phases 1-3; no App callback registration or remote answer as a fallback. |
| Native management peers | **verified** read-only policy (`src\native.ts:28,483-501,617-618`) | Missing originating message identity means no safe send; do not make a read-only peer writable because an SDK message method exists. |

### 3.2 Event shapes and persistence limits

The installed generated schema uses `ephemeral: true` for explicitly transient
events, and `ephemeral?: boolean` for the other events below. The latter is not a
promise that every host writes every event to disk.

| Event | Pinned data relevant to this design | Persistence/projection evidence |
| --- | --- | --- |
| `assistant.turn_start` / `assistant.turn_end` | `turnId`; start may include `interactionId`, mode/model, parent tool; end alone does not identify a user request | Optional ephemeral marker, `SDK dist\generated\session-events.d.ts:6511-6571,7831-7882`. App fixtures correlate start + interaction + unique origin, not a reused turn number (`test\app-sessions.test.ts:396-429`). |
| `assistant.intent` | `intent` | Explicitly ephemeral, SDK lines 6573-6624. Current Projector has no dedicated intent case; App journal persistence is not established. |
| `tool.execution_start` / `tool.execution_complete` | Tool-call ID, name/arguments at start; success, optional result/error/file edits, turn/interaction metadata at completion | Optional ephemeral marker, SDK lines 8692-8819,9049-9187. Native projection publishes names/states, not arbitrary arguments/results. App readers use selected tools only for strict visible-publication chains. |
| `permission.requested` / `permission.completed` | Request ID, discriminated permission request, optional prompt/managed/hook context; completion result and optional decision provenance | Optional ephemeral marker, SDK lines 11115-11211,12521-12584. No existing App-journal permission fixture demonstrates a live unresolved pair. Typed support is not App waiting-state evidence. |
| `user_input.requested` / completed | Exact request ID, question, choices, allowFreeform; answer/wasFreeform | Explicitly ephemeral, SDK lines 13290-13404. Existing owned callback tests are synthetic (`test\native.test.ts:2056-2096`). |
| `elicitation.requested` / completed | Request ID, optional schema/form-or-URL mode/source; action/content on completion | Explicitly ephemeral, SDK lines 13406-13550. Do not reconstruct from disk or match by question text/schema. |
| `exit_plan_mode.requested` / completed | Request ID, plan content/summary, offered/recommended actions; approved, selected action and optional feedback | Explicitly ephemeral, SDK lines 15407-15532. Existing owned callbacks are not an App approval API. |
| `session.idle` / `session.title_changed` | Idle may report aborted/mode; title event carries title | Explicitly ephemeral, SDK lines 2280-2425. Idle is not task success; use stored metadata for App titles, not an assumed durable title event. |
| `session.error` | Error type/message, optional native origin and remediation | Optional ephemeral marker, SDK lines 2181-2276. Current projection withholds raw error details; a source-wide error without origin cannot fail an arbitrary Teams turn. |
| `session.task_complete` | Optional `success`, `summary`, `outcome`, objective/blocker/reason | Optional ephemeral marker, SDK lines 4988-5052. Current projector records a task row, not a final outbox item (`src\projection.ts:266-271`). Prefer its summary only when completion and origin correlation are established. |
| `session.shutdown` | Shutdown type and cumulative `codeChanges.filesModified/linesAdded/linesRemoved` | Optional ephemeral marker, SDK lines 3675-3788,4140-4153. Session-wide totals are not per-turn change statistics; do not attribute them to the last Teams prompt. |
| `abort` | Finite reason code | Optional ephemeral marker, SDK lines 8592-8634. Current projector cancels pending requests and marks the turn stopped; no prompt replay. |

The sanitized App fixtures contain user/assistant dialogue, root turn
start/end, and correlated tool request/start/completion evidence for
`task_complete` and `publish_chat_update`. They also exercise malformed,
oversized, split-EOF, child, and mismatched-origin cases
(`test\app-sessions.test.ts:13-51,342-429,516-691`;
`test\journal-observer.test.ts:26-121`;
`test\published-results.test.ts:31-157`).

`LocalAppSessions.projectJournal` returns `AppSessionSnapshot` dialogue,
consumption, and completion fields; it does not return permissions, general
tools, intent, or pending questions. `appJournalEvent` deliberately synthesizes
user/assistant events. `journalPage` returns proven final publications only.
App `watchPeer` merely registers the App ID, unlike the distinct native-peer
journal watcher (`src\app-sessions.ts:34-54,405-654`;
`src\journal-observer.ts:8-19,137-192`; `src\native.ts:742-750,1032-1040`).
Therefore Phase 1 cannot promise App approval cards from today's projection.

### 3.3 Permission, question, and plan policy

Current owned working sessions request `permissionMode: "manual"`, verify the
effective mode twice, and enable required scoped prompts. With no
`onPermissionRequest`, the SDK surfaces requests as events and leaves them pending
for the permission RPC. The bridge offers **Approve once / Deny**, and approves
with `approvedInteractively: true` only after a scoped owner action. The controller
instead rejects permission callbacks and has custom-only management tools
(`src\native.ts:301-319,360-435,730-740`;
`SDK dist\types.d.ts:2576-2581`;
`test\native.test.ts:1718-1742,1903-1920,2080-2096`).

Proposed policy defaults must reproduce that behavior:

| Request kind | Existing owned-working default; proposed default | Display/decision constraint |
| --- | --- | --- |
| `shell` | Manual ask; manual ask | Full redacted command and intention; short progress preview separately. Respect `canOfferSessionApproval` and managed one-shot restrictions. |
| `write` | Manual ask; manual ask | File name, redacted bounded diff, optional file-edits preview; never expose complete file contents merely because the type supplies them. |
| `read` | Manual ask for surfaced requests; same | No blanket read auto-approval inferred from "read-only". |
| `url` | Manual ask; manual ask | Redact URL secrets; session-domain grant only when the authoritative prompt permits it. |
| `mcp` | Manual ask; manual ask | Bind actual server/tool identity, not display title or advisory recommendation. |
| `memory` | Manual ask; manual ask | No new automatic memory writes/reads policy. |
| `custom-tool` | Manual ask; manual ask | `skipPermission` on bounded controller tools is not authorization for arbitrary working-session tools. |
| `hook`, `extension-management`, `workflow`, `extension-permission-access`, `extension-env-access` | No bridge kind-based auto-approval; same | These additional pinned union variants are omitted by the brief. Current configuration disables relevant discovery/features where possible. If surfaced, retain manual handling or explicitly decline unsupported UI; never silently approve or enable them. |
| Controller, all kinds | Reject; reject | Do not expand the management agent's execution authority. |

This table describes how the bridge handles **surfaced permission requests**,
not a claim that native policy emits a prompt for every tool invocation.
The pinned union and request details are in
`SDK dist\generated\session-events.d.ts:1264,11213-11571,11573-11970`;
the bridge currently has no per-kind auto-approve table.

The pinned decision union includes `approve-once`, `approve-for-session`,
`approve-for-location`, `approve-permanently`, `reject`, `user-not-available`,
read-only/session variants and compatibility result variants. Session approval
can require typed command/tool approval details or a URL domain; permanent
approval is URL-specific. Only **Allow once / Allow for this session / Deny**
are proposed for Teams, with the session option omitted when the authoritative
request cannot offer it. Do not add location, permanent, read-only broad grants,
or compatibility decisions merely because the SDK accepts them
(`SDK dist\generated\rpc.d.ts:5340-5356,25387-25423,25610-25648,25835-25879`).

Every answer needs the current owned-session/request identity, current surface
revision, expiry, nonce, and pending-request readback. A `success: false` response
means stale/resolved, never "Allowed". Completion events dismiss all card copies.
New explicit approval timeouts default to 15 minutes and return
`user-not-available`; a card TTL expiring today is **not** an existing runtime
permission timeout. Restart/abort must cancel UI promises and invalidate old
decisions, not re-offer old permissions from history.

Questions retain exact choices and `allowFreeform`; no freeform reinterpretation
of a choice-only request. Plans retain the exact offered continuation actions,
require a selected action for approval, and reread actual mode after completion.
The callback result is `{ approved, selectedAction?, feedback? }`, not a generic
permission decision. `rpc.mode.get/set` and the existing owned settings path
already support plan mode; native confirmation/defer results are not success
(`src\native.ts:321-356,625-633,671-701,706-729`).

**Elicitation gate:** the pinned handler context includes `sessionId`, message,
schema, mode, source and URL, but **not `requestId`**
(`SDK dist\types.d.ts:928-978`). The SDK strips that ID from the public callback
context while retaining it internally; its response goes through
`rpc.ui.handlePendingElicitation({ requestId, result })`
(`SDK dist\session.js:1119-1134,1785-1813`;
`dist\generated\rpc.d.ts:37601-37611,45172-45178`).
The event includes the ID, and the RPC can report that another client already
resolved it. The packaged README documents fan-out/first response wins, not an
exclusive owner lock. Do not correlate simultaneous forms by matching text,
schema, callback order, or a guessed ID. Phase 3 must first prove a supported
event-ID/handler-enrollment lifecycle with concurrency and cancellation fixtures;
otherwise forms remain unavailable with an explanatory decline. Unsupported
schema constructs or URL mode are declined, not converted to browser navigation.
The initial supported form subset is bounded object fields: string/enum,
boolean, number/integer and required constraints, with server-side validation.

## 4. Teams transport and platform evidence

| Operation or surface | Pinned/current evidence | Fallback and remaining gate |
| --- | --- | --- |
| Send and update | **verified** on the bridge interface: `src\domain.ts:306-312`, `src\teams.ts:90-137`; correlated relay send/update at `src\relay.ts:367-405` | Retain validated proactive references and IDs. A deleted dashboard's definite 404 permits a replacement; unknown outcomes do not permit reposting. |
| Standard activity reply | **verified** in AH `dist\src\connector-client\connectorClient.d.ts:68-76`; implementation `connectorClient.js:161-182` uses `/activities/{id}` | Not the preview `/replyChains/{root}` endpoint and not proof of personal L2 placement. `replyToId` alone is not a quote. |
| Delete | **verified** in pinned AH `dist\src\turnContext.d.ts:147` and connector `connectorClient.js:267-285`; **unsupported** on current bridge/relay interface | Freeze old cards rather than require deletion. Any future delete stays behind an explicit transport capability and validated reference. |
| Preview thread post | **docs-only** [T1]; **unsupported** as a dedicated method in AH 1.10.1/current relay | Future webhook transport may use a bounded authenticated connector HTTP operation; not automatically available today. Focus mode until both adapter and chat capability are proven. |
| Authenticated raw connector request | **verified** public connector `httpClient` plus `HttpClient.request`; token is attached by the official connector (`AH dist\src\connector-client\connectorClient.js:37-84`; `dist\src\httpClient.d.ts:54-94`) | This is an implementation seam, not a Teams success claim. Obtain it inside the validated adapter continuation; do not extract/store/log tokens or accept arbitrary URLs. The generic HTTP client does not enforce the bridge's host policy: keep the operation transport-private, revalidate the reference, encode path IDs, and preserve the complete validated service-URL base. |
| Native quoted reply | Shape **docs-only** [T2]; entity/markup serialization **verified** offline in AA/AH; bridge envelope/relay server behavior **unsupported/runtime-unknown** | Use a safe source/turn reference until an explicitly versioned envelope and both transport paths are proven. No fabricated native author/timestamp/snippet. |
| Reaction add/remove | Preview **docs-only** [T3]; dedicated pinned methods/current transport **unsupported** | Capability-gated best effort only. Do not confuse `reactionsAdded/Removed` Activity fields with an outbound reaction API. L2 reaction conversation ID remains runtime-unknown. |
| Cards | 1.5 **verified** locally; Teams including mobile <=1.6 **docs-only** [T6] | Keep 1.5. Omit unsupported actions rather than use `Action.Submit.isEnabled`, which Teams does not support. Filtered/searchable choice UX and narrow/mobile behavior need manual verification; retain existing text-search/page fallback. |
| Manifest / prompt starters | Template 1.23 and six personal `!` commands **verified** (`teams-package\manifest.template.json:1-47`); exact 1.23 schema restrictions **docs-only** [T5] | 1.23 command items allow title/description, max ten; no `type`, `prompt`, or targeted-message triggers. Do not add newer prompt-starter fields or claim an app-version bump changes the schema. |
| Root deep link | Documented chat-message URL **docs-only** [T7] | Requires trusted containing chat ID and returned root message ID. Actual preview thread-pane opening on desktop/mobile is runtime-unknown; repost a header if not reliable. Never parse an opaque `a:` conversation ID or add Graph credentials to guess it. |

#### Public typed connector access and lifetime

Inside the real `TurnContext` callback supplied by the existing validated
`adapter.continueConversation(...)`, the public typed lookup is
`context.turnState.get<ConnectorClient | undefined>(context.adapter.ConnectorClientKey)`.
After checking that a connector exists, the public request entry is
`connector.httpClient.request(...)`. The key is an **adapter instance** property,
not a static property or a string guessed from SDK internals. `ConnectorClient`
is publicly exported. Evidence: `AH dist\src\index.d.ts:10`,
`dist\src\connector-client\index.d.ts:4`,
`dist\src\baseAdapter.d.ts:27-36`,
`dist\src\turnContext.d.ts:215,254`,
`dist\src\turnContextStateCollection.d.ts:4-16`,
`dist\src\connector-client\connectorClient.d.ts:20-29`.

The lifecycle and generic-request authentication are established by source,
not only by convenience-method names. `CloudAdapter.continueConversation`
creates the context, obtains the connector, stores it under that symbol, then
enters the callback. Connector creation validates the outbound service URL and
obtains the token from the configured provider. `createClientWithToken` sets
Authorization in the HTTP client's default headers; generic `request` merges
those defaults into the actual fetch headers too
(`AH dist\src\cloudAdapter.js:169-213,262-264,590-619`;
`dist\src\connector-client\connectorClient.js:69-84`;
`dist\src\httpClient.js:53-60,81-87`).

Use the connector only within that continuation and await the operation there;
do not retain revocable context/token state for later calls, override the
Authorization header, access protected creation methods, or read private fields.
The current bridge deliberately narrows `SendContext` to send/update
(`src\teams.ts:109-110`), so the future transport must explicitly expose the
needed public typed context members through that contract, not cast the narrow
type to a full context. Every call still needs bridge reference validation and a
fixed encoded operation path. This proves an authenticated client seam; actual
authorization/acceptance of preview reply-chain and reaction endpoints remains
**runtime-unknown**, and no such operation is implemented here.

### 4.1 Offline serializer result

An in-memory probe used only the installed Activity/connector modules and a
network function that throws. `Activity.fromObject` followed by the pinned
outgoing normalizer preserved:

- `entities: [{ type: "quotedReply", quotedReply: { messageId } }]`;
- the corresponding `<quoted messageId="..."/>` text marker;
- `channelData.chat.id`, `channelData.replyChain.id`, and `replyToId`.

It also confirmed connector prototype methods for send/reply/update/delete and
the generic HTTP client, with no named reply-chain/reaction method. No token,
native runtime, or service request was used. Source:
`AA dist\src\activity.js:36-76,115-119`,
`dist\src\entity\entity.d.ts:9-28`;
`AH dist\src\activityWireCompat.js:31-46`.

This proves serialization, **not server-stamped quote rendering**. The official
Teams SDK quote helper adds both the entity and marker [T2]. A new transport
envelope must add trusted markup *after* classifying/escaping the business body;
passing it through today's `newMessageFormat`/XML escaping would display the
marker literally. It must also budget that markup/entity in the complete wire
payload. Do not alter persisted v2/v3/v4 payloads to retrofit quotes.

Server-stamped snippets cannot be locally redacted. If redaction would change the
original prompt, use a safe source/turn reference instead of asking the server
to quote that prompt. Native ACK message IDs and Teams activity IDs are separate
identities; `OutboxItem.originatingMessageId` currently means the **native** ID.

### 4.2 Preview facts that affect the design

The current thread documentation [T1] says reply-chain data can appear on both
L1 and L2, and absence means no thread reply should be attempted. The storage key
is containing chat ID + root ID; `conversation.id` must remain opaque.
For inbound classification, message/update/delete use activity ID relative to
root; reaction, card-response messages with `channelData.source`, and ordinary
invokes use `replyToId`; message-action invokes use `value.messagePayload.id`.
Install/conversation-update events are not L2. Classification does not authorize
an otherwise unsupported activity type.

The explicit personal-chat thread route is
`POST {full serviceUrl}/v3/conversations/{chatId}/replyChains/{rootId}`.
Only the documented `400 BadArgument` / "Reply chains is not allowed in this
thread type" establishes that unsupported-thread fallback. Other 400/404 failures
can mean bad identity or deleted targets; network ambiguity cannot be converted
to a fresh top-level POST. The examples use Teams SDK 2.2+, not Agents 1.10.1.
The older quote/thread article's `;messageid=` parsing example conflicts with
the newer opaque-ID contract; do not adopt it.

Reactions use documented IDs `1f440_eyes`, `2705_whiteheavycheckmark`,
`274c_crossmark`, `270b_raisedhand`, from one future constants table [T3].
Replacement is remove + add, two operations. At most two operations/second
globally, respect Retry-After, and disable reactions for the process after a
non-429 unsupported/error outcome with one redacted diagnostic. They never block
receipts or authorize controls.

No Teams streaming is proposed: one open stream/conversation, ten-minute lifetime,
roughly one request/second, and no proactive streaming are poor fits for agent
turns [T4]. SDK event streaming is a different mechanism and may remain enabled.
Suggested actions are limited to three, only the latest are visible in personal
chat, and they cannot accompany attachments. Newer documentation also discusses
other scopes; that does not expand this bot beyond personal scope. Experimental
suggested-action invokes are not covered by the current card parser.

## 5. Proposed interaction and persistence design

Everything in this section is a proposal, not code added in Phase 0.

### 5.1 Explicit routing and stable addresses

Keep the owner's decisions: unrouted top-level messages require a target;
remote answers are limited to bridge-created working sessions; the App endpoint
is unchanged.

Introduce a normalized, **authenticated** inbound address containing the legacy
conversation key/reference, verified containing chat ID if present, root ID,
Teams activity ID, activity kind, and classification. Personal-only, owner,
tenant, audience, bot and trusted-service checks still precede all persistence,
including invokes and L2. A chat ID alone does not prove a personal chat. If a
real L2 envelope needs a different personal check, that change needs documented
payload evidence and negative fixtures; missing scope evidence fails closed.

| Address | Proposed routing |
| --- | --- |
| Known bound thread | Use its immutable canonical source, not a hidden Focus selection. Validate current capability and pending-request fences before sending. |
| Thread-mode L1 or unbound thread | Persist a bounded unrouted intent, show a Routing card, send nothing until explicit selection. |
| Remembered L1 target | Only an unexpired explicitly enabled remembered target; show target and remaining lifetime on each acknowledgement. Clear on Forget; do not inherit from a thread reply or History visit. |
| Focus mode | Preserve the explicit selected source and unresolved-selection blocking; make the target visible. No target means no send. |
| `!` command | Bridge command, never ordinary work. `!use` continues explicit Focus selection; it must not silently rebind an old thread. Explain the current thread target and offer Open for the new source. |

Bindings are `(verified chat identity, root ID) -> canonical source UUID`, with
an explicit owner action creating each binding. Several roots may bind the same
source. MRU means the latest **explicit Teams use of a bound thread**, not an
incoming background event, a card refresh, or a title timestamp.

If posting the initial Routing card proves threading unsupported, mark that
chat's capability accordingly and show the **same unsent intent's** target picker
in Focus mode. Do not silently send its text to the old Focus/remembered target.
Once a prompt is admitted or uncertain, no fallback may resend it. A known
thread-post rejection of an outbound result can choose a safe Focus destination
for that same origin-bound delivery; an uncertain result POST cannot.

Changing the acknowledgement's target means **the next message only** after
admission/uncertainty. It never retargets or resends the already accepted draft.
Unrouted-intent expiry must say nothing was sent. The existing card-action TTL
can bound this intent; no extra draft-duration configuration is necessary.

### 5.2 Separate addresses, surfaces, intents, and receipts

Extend the existing Store, not create a parallel database. Proposed future
records are bounded and strictly validated:

- Chat identity/legacy aliases and per-chat thread capability, including reason
  and evidence freshness. The transport's opaque conversation ID remains in its
  authenticated reference; it is not rewritten into a chat ID.
- Per-root bindings and session header activity IDs; immutable origin addresses
  on send intents (Teams activity, original reference, chat/root, canonical
  source), then native ACK/message ID on acceptance.
- Routing intents with exact unchanged prompt, deadline, chosen source and
  receipt linkage. Persist intent/claim before a native call; resume pending
  selection UI, never replay a started call on restart.
- Independent Inbox, header, turn, routing and needs-you surface identities,
  revisions and activity IDs. A turn-card update must not expire an unrelated
  pending approval. New signed claim versions bind the surface, canonical
  target, operation, request/intent ID, expiry and nonce.
- Following mode/expiry, passive-delivery destination and digest membership.
  Keep receipt, admission, original-native-message, source-result and outbox
  identities; presentation/thread location is not a new source identity.

Keep one durable inbound receipt namespace across authenticated L1/L2 aliases so
the same Teams activity cannot replay after a chat-key migration. An unknown
legacy token or mismatched surface/request remains fail-closed. Migration must
not reinterpret conversation-wide legacy tokens as multi-card authority.
Legacy view-navigation exceptions can only navigate, never answer a request or
send a saved prompt.

**Historical origin limitation:** today's conversation reference is overwritten
by later authenticated inbound activities. It cannot reconstruct an old prompt's
Teams activity/root. Existing receipts without the new origin snapshot retain
their legacy delivery route and source label; do not infer a quote/thread from
the latest reference.

### 5.3 Delivery and following policy

| Event class | Destination and mute/expiry rule |
| --- | --- |
| Direct result, failure, uncertainty or outstanding explicit task receipt | Original authenticated prompt address. Independent of following, Focus selection and session MRU. Never folded into a cross-session L1 digest. |
| Pending owned request needed to finish explicit Teams work | Keep its origin-bound turn/request card accessible even after mute; background attention notifications remain separately governed by following. Do not strand explicit work behind a passive toggle. |
| Passive followed result/needs-you event | Eligible source only; newest explicitly used bound thread, or Focus timeline. Snapshot destination before claiming delivery. |
| Unfollowed passive needs-you state | Inbox only, and only when authoritative state exists. |
| Progress | Coalesced card updates, not new notifications. |
| Three or more passive notifications for distinct sources within 60 seconds | One L1 digest with signed Open actions; direct results are excluded. |

Auto-follow starts/renews on an accepted explicit Teams send and expires after
24 hours without another Teams send. Explicit Follow/`!subscribe` has no expiry;
Mute/`!unsubscribe` cancels only unclaimed passive work. Existing enabled
subscriptions migrate to explicit non-expiring following with their exact cursor
and revision; existing paused ones stay visibly paused. Do not infer following
from selection, read markers, history, heartbeat, or recency.

Following the brief's default, a **new accepted Teams task overrides an earlier
Mute** for that source and starts a fresh automatic-follow period; the
acknowledgement makes that visible. An existing explicit non-expiring Follow
stays non-expiring. An unrouted, failed or uncertain send does not silently clear
Mute. These rules do not change outstanding direct-result obligations.

Follow intent and observation capability are separate. A readable local App
journal can retain durable following without an endpoint. An already attached
owned session can offer clearly labelled live-only observation; restart does not
silently resume it. A saved/RPC-only source without a supported adapter offers
direct receipts/history and an honest unavailable label, not a fabricated
durable subscription. Future RPC cursor work must handle its actual
`cursorStatus`, generation/snapshot semantics and ephemeral loss; mere API
presence does not satisfy this gate.

Retain existing observation budgets. If auto-follow cannot allocate a supported
observer or a subscription slot, the explicit send/result obligation still works;
report that passive following could not start rather than evict another source,
block an already accepted task, or silently expand limits.

For observer races, choose direct ownership before a passive item is claimed.
The existing live-event ACK gate and direct-claim promotion need to cover the
new thread-addressed subscription path as well. While native ACK correlation is
in flight, do not send a possibly direct result to an MRU thread and later repost
it to its origin. Unattributed output may satisfy passive eligibility but is not
proof that a particular uncertain prompt completed.

Dedup remains per canonical source and logical recipient across thread moves.
Do not add root ID to a key simply to bypass an existing sent/uncertain row.
Digest member identities and the composite send claim must commit atomically;
an acknowledged digest consumes only its passive members. Uncertain digest
delivery makes its attempted members uncertain too, not eligible for individual
reposting. HISTORY/Show full is an explicit separately labelled read, never a
second unsolicited completion.

### 5.4 Honest state and mobile cards

Use the existing projections and discovery cadence. Separate the axes:

- Native admission: not sent / accepted / may have been accepted.
- Execution: unobserved / observed / waiting with authoritative request.
- Result: unconfirmed / confirmed / failed / stopped.
- Teams delivery: pending / acknowledged / rejected / uncertain.

A busy heartbeat is session liveness, not execution of a particular prompt.
A published assistant reply is visible output, not necessarily task completion.
Idle, abort ACK and shutdown are not interchangeable with "Done".

The Inbox has one current instance. Reposting freezes the previous instance as
"Updated below" when editing is supported; logical invalidation is mandatory
even if that edit fails. Session headers distinguish Writable, Read-only and
Unknown with a reason; omit unsafe controls rather than rely on disabled UI.
Older headers can say activity continues in a newer thread, but their outstanding
origin-bound task results still belong there.

Turn cards exist only for accepted Teams prompts. Owned sessions can use native
events; App sessions initially use verified admission/result stages. Add App
tools/permissions only after the journal/projection gate is met. Use known
bounded local queue counts if proven; otherwise say queue state is unavailable,
not a count inferred from `status: busy`.

For an App "Waiting for approval at your PC" state, require a validated source,
supported journal shape, sufficiently complete coverage and an unresolved exact
request ID. Matching completion, cancellation, abort/shutdown, expiry, generation
change or loss of coverage must resolve/invalidate the claim. A stale bounded
tail containing only a request is not sufficient. Until this exists, retain
"Other hosts' pending requests are unknown" (`src\cards.ts:342-344`) and direct
the owner to the original host without claiming a particular pending request.
No remote-answer button is ever offered for that source.

Coalesce each card to at most one update per five-second interval, except
meaningful state transitions; serialize updates so older state cannot overwrite
a final card. Honor Retry-After with bounded scheduling, not aggressive polling.
Only operations known idempotent and definitely rate-limited may be retried;
never apply a blanket retry policy to uncertain native or Teams sends.

Results use a redacted first-line source/status summary and about 600 characters
of proven content. Show full reads the existing result/chunked publication,
without asking a model to summarize again. Prefer a correlated accepted
task-complete summary when present, otherwise the final assistant message.
Do not replace an already published result with an unrelated later summary.
Include durations/change totals only when scoped evidence supports them.
Keep at most roughly five primary actions, compact text/choice layouts, and
existing search/pagination fallback. Full permission commands require an
explicit detail surface if they exceed the card budget; they are not silently
truncated to the 120-character progress preview. Mask secrets and say so.

Welcome appears on the first authorized owner message or `!help`, not an
unauthorized install event. It must not consume/lose an unrouted work prompt.
Keep the existing `!` menu; prompt starters need a separate schema-compatibility
decision. Simulator rendering is an offline acceptance aid, not Teams mobile
certification.

### 5.5 Owned controls and remaining conflicts

Phase 3 adds two-step Stop and explicit Steer only to bridge-created working
sessions, preserving all current pending/busy gates. Plain work remains enqueue.
Steer uses immediate, but an immediate ACK does not imply a new independent
result: the pinned message documentation says steering can retain the active
request's origin (`SDK dist\types.d.ts:3433-3444`). Correlate steering to the
authoritative running request and preserve its original recipient; do not
overwrite that request's origin with the latest card/thread. If that relationship
cannot be proven, omit Steer rather than promise a misrouted result.

Two specification conflicts need explicit treatment before implementation:

1. **Remote approvals off:** the brief requires "off entirely" and also says off
   keeps today's behavior, but today's behavior already includes remote manual
   approve-once/deny. These statements cannot both hold. Default **on** can
   preserve existing manual behavior. A true **off** must disable remote
   permission approvals with an explicit fail-closed policy, never auto-approve,
   switch to allow-all, or retain an approval button under a misleading label.
   The exact native decline/unavailable response and handling of already-pending
   requests when disabling remain a Phase 3 review decision. Merely disabling
   new enhancements while keeping legacy approvals would need a differently
   named option; no such extra switch is proposed or implemented here.
2. **History does not route:** this is a desired stronger invariant, contradicted
   by current signed-History behavior and tests. Introduce a separate read
   target and explicit Open/Select controls in Phase 1; retain canonical read,
   supersession and nonce protections. Do not quietly change legacy signed
   mutation authority while doing the UI redesign.

## 6. Phase boundaries and module mapping

| Phase | Proposed changes after review | Gates / exclusions |
| --- | --- | --- |
| **0, this commit** | Discovery and this design note only | Run existing build/typecheck/offline tests. No feature scaffolding, configuration, manifest, endpoint, allowlist, push or PR. Stop for owner review. |
| **1, visible Focus state** | `cards.ts` Inbox/header/turn/result surfaces; `domain.ts` and `store.ts` bounded surface/origin/follow records; `actions.ts` surface claims; `bridge.ts` explicit view/read/routing separation, updates, passive digest/follow; `replies.ts`/transport envelope only if quote gate passes; `projection.ts` safe owned progress; existing simulator/fakes/tests | No thread dependency. App pending state stays unknown until authoritative fixtures/projector exist. No prompt-starter fields on manifest 1.23. Reactions are optional gated preview work, not a prerequisite for Focus release. Endpoint unchanged. |
| **2, optional session threads** | `teams.ts` normalized authenticated addresses and capability-gated thread operation; `domain.ts`/`store.ts` chat aliases/bindings/routing intents; `bridge.ts` binding-first resolver and origin-aware publication; `relay.ts` explicit supported-operation declaration; simulator/thread fixtures | No dependency upgrade, no opaque-ID parsing. Relay defaults to Focus unless its actual protocol gains reviewed capabilities. Unsupported-thread fallback never dispatches an unrouted prompt. Real desktop/mobile L2 verification is a release gate. Endpoint unchanged. |
| **3, owned interactive controls** | `native.ts` typed owned controls/policies, request lifecycle and event/RPC handling; `domain.ts`/`store.ts` durable decision/expiry UI fences; `cards.ts` redacted requests/forms/plan/Stop/Steer; bridge actions and offline fakes | Preserve manual per-kind defaults; no App authority expansion. Gate session grants by actual request. Elicitation concurrency/ID lifecycle and approval-off semantics must be resolved. No unverified global queue count. Endpoint unchanged. |
| **4, proposal only** | Record optional App ephemeral-state forwarding and remote-link findings in this note | No endpoint/broker changes, handler attachment, App answers, remote stop, new credentials or runtime calls. |

Current config accepts none of the new settings below. Future configuration must
use the existing strict validation pattern and update `.env.example` and related
tests only in the implementing phase.

| Proposed setting | Brief default | Design restriction |
| --- | --- | --- |
| `BRIDGE_THREADS=auto/off` | `auto` | Auto is not forced enablement. Effective mode remains Focus without a supported transport, validated chat/root data and successful capability evidence. |
| `BRIDGE_REACTIONS=auto/off` | `auto` | Effective off until a supported transport/target-ID contract exists; process-wide non-429 failure disablement. |
| `BRIDGE_ROUTING_REMEMBER_MINUTES=0..60` | `10` | Zero hides it; remembering is still owner opt-in, not enabled by this default. |
| `BRIDGE_STATUS_UPDATE_SECONDS>=2` | `5` | Per-card coalescing; state transitions exempt, Retry-After respected. Validate safe bounded timers. |
| `BRIDGE_FOLLOW_HOURS>=1` | `24` | Auto-follow only, never expires explicit subscriptions or direct receipts. |
| `BRIDGE_REMOTE_APPROVALS=on/off` | `on` | On preserves manual defaults. Off must genuinely disable remote permission approval with a reviewed fail-closed response/pending-request policy, not mean "legacy approvals still enabled". |
| `BRIDGE_APPROVAL_TIMEOUT_MINUTES>=1` | `15` | New permission timeout returns user-not-available; never transforms an expired UI into approval. |

Do not add speculative flags for every UI component. Code-level transport/source
capability checks are distinct from owner configuration. Do not introduce a
new endpoint capability or a new platform SDK to make the switches appear usable.

## 7. Migration, rollout, and rollback proposal

1. Use a future versioned Store migration, preferably schema 2 once route-aware
   records are persisted. Validate old owner binding before a single atomic
   conversion. An old binary must reject new route semantics rather than ignore
   fields and send into the wrong place. No migration runs in Phase 0.
2. Preserve every legacy receipt ID, direct origin, admission, native message ID,
   subscription revision/cursor, result key and outbox status. Unversioned/v2/v3/v4
   text, chunk boundaries and presentation stay byte-identical. New quote/digest
   envelopes need their own validated version; never rewrite attempted payloads.
3. Preserve selected source and `selectionBlocked`. Map existing enabled
   subscriptions to explicit non-expiring following, disabled ones to muted,
   paused ones to paused. Never generate from-now baselines during migration.
4. Establish stable chat aliases only from a new authenticated activity that
   provides both its legacy conversation identity and trusted containing chat ID.
   Keep old namespaces until that relation is proven. Do not merge state by
   owner/title/workspace alone; conflicting aliases fail closed. Outstanding
   legacy deliveries retain their original references, not an MRU rewrite.
5. Expire/invalidate old mutable surfaces; freeze visible predecessors when
   possible. Rebuild safe navigation from retained state. Do not turn old tokens
   into current request grants or replay persisted drafts/sends.
6. Release visible Focus behavior first. Add preview capability only to known
   compatible chats/transports with fallback; add richer controls last.
   Debug shape capture is opt-in and limited to field names/ID format classes,
   never raw IDs, prompt text, secrets or original journal dumps.
7. Rollback uses feature-off modes within a schema-aware binary and retains
   pending/direct obligations. Do not run an old binary against migrated state,
   restore a stale backup over accepted work, or rebaseline subscriptions to
   simulate rollback. Review any downgrade separately.

The source packer's fixed allowlist intentionally omits this new design document
(`scripts\package-source.ts:7-79`). This commit does **not** change that list.
`check:source` therefore does not audit/package this note; public-document review
must independently ensure it contains no operator paths, real chat/Bot IDs,
credentials or private runtime evidence. A later packaging decision is separate.

## 8. Verification and future acceptance

### Existing evidence to retain

| Invariant | Existing test evidence |
| --- | --- |
| JWT/owner/personal/URL validation before dispatch | `test\core.test.ts:13-51`; `test\transport.test.ts:45-67`; `test\regressions.test.ts:1391-1444` |
| Literal composer, unresolved selection, exact canonical target | `test\native-chat.test.ts:21-98`; `test\core.test.ts:88-247` |
| Authenticated action signature, nonce, revision, stale/duplicate outcomes | `test\core.test.ts:430-505`; `test\regressions.test.ts:979-1224`; `test\native-chat.test.ts:152-172` |
| Direct/admission results independent of passive following | `test\sidechat-subscriptions.test.ts:259-288,392-414`; `test\native-chat.test.ts:198-227,305-331` |
| Cursor/revision/generation/late-read fences and source isolation | `test\journal-observer.test.ts:35-121`; `test\sidechat-subscriptions.test.ts:191-257,290-312,455-491,554-726` |
| Origin publication chains and completion distinctions | `test\app-sessions.test.ts:342-429,624-691`; `test\published-results.test.ts:31-157` |
| Lazy SDK, manual policy, exact request answers, no foreign takeover | `test\native.test.ts:1718-1775,1903-1920,2056-2096,2231-2251` |
| Versioned bytes and history/live dedup races | `test\native-chat-format.test.ts:19-197`; `test\native-chat-races.test.ts:97-147,176-264` |
| Relay correlation, Submit semantics and no retry | `test\relay.test.ts:255-367,392-492` |

Future focused offline acceptance must additionally cover:

- Multi-card isolation: an Inbox refresh cannot stale a pending approval;
  foreign/replaced/expired surface and request IDs cannot act; double-submit
  consumes exactly one intent and reports the recorded outcome.
- Address routing: L1/unbound-thread input stays unsent until choice, including
  unsupported-thread fallback; bound replies ignore unrelated Focus state;
  invalid personal/tenant/bot/service metadata is rejected for every accepted
  activity shape. Explicit commands remain literal-command-only.
- Recipient races: two roots for one source, a later MRU/focus change,
  admission/subscription in both orders, mute/expiry after acceptance, restart,
  and digest formation all preserve a single origin-bound direct result.
- Stable-ID migration: authenticated old/new aliases, unknown/ambiguous aliases,
  identical parent/side names, unchanged existing outbox bytes, legacy references,
  and activity/action dedup across aliases.
- Card clocks/delivery: per-card five-second coalescing, transition exceptions,
  out-of-order updates, definite 404 replacement, 429 Retry-After and uncertain
  sends. Reactions share one two-operation/second limiter and cannot affect work.
- App evidence: pending permission only from a supported complete source shape;
  matching completion, hook resolution, expiry, abort, split/oversized gaps and
  generation replacement remove or downgrade the claim. Unsupported/ephemeral
  state remains unknown, never inferred.
- Owned controls: all current per-kind defaults, exact choices, allowed
  session-grant scopes, timeouts, resolved-elsewhere races, Stop confirmation,
  immediate/queued sends, steering-origin retention, and unsupported schema/URL
  form declines. Safe elicitation request-ID enrollment is a prerequisite.
- Quote envelope: exact server-defined entity/marker survives both adapters,
  sensitive prompts use the non-quote fallback, full serialized byte budgets,
  all legacy presentation versions unchanged.

Do not add these future-feature tests in Phase 0. Existing tests remain offline:
the test bootstrap blocks network and child processes except explicitly allowed
loopback fixtures (`test\block-network.ts:1-59`). No native smoke, login, model
catalogue, simulator service, or real Teams trial is required for this note.

### Phase 0 execution record

- Baseline and isolated branch were verified clean before editing; no tracked
  repository AGENTS/custom instruction files were found.
- Initial `npm run typecheck` failed because `tsc` was absent. Restored the exact
  lockfile with `npm ci --offline --ignore-scripts --no-audit --no-fund`: 172
  packages, no lifecycle scripts, no dependency/lockfile edits and no claimed
  fresh registry download or TLS-policy change.
- Installed pins were confirmed with `npm ls`: SDK 1.0.31, Agents hosting/activity
  1.10.1. Host tools for these checks: Node 26.13.0 and npm 11.20.0.
- Offline Activity serialization/connector inspection passed as described in
  section 4.1. No service/native runtime was instantiated.
- No required gate remained unavailable. Negative-test diagnostic lines in the
  test log are expected fixture outcomes, not failed tests. Logs are retained as
  private session artifacts, not added to the repository.
- The initial staged whitespace check flagged this new file's CRLF endings.
  The note was normalized to LF without weakening Git whitespace checks or
  changing repository configuration.
- An independent public-text scan of this document found no operator-home paths,
  private-service references, personal App links or credential-shaped content.
  This scan supplements review; it is not a guarantee against arbitrary secrets.

Final required gates and the existing public-source audit passed in the isolated
worktree:

| Command | Result |
| --- | --- |
| `npm run build` | Exit 0 |
| `npm run typecheck` | Exit 0 |
| `npm test` | Exit 0; 268 passed, 0 failed, 0 cancelled, 0 skipped; approximately 94 seconds |
| `npm run check:source` | Exit 0; existing allowlist only, intentionally excluding this new note |

Manual **future** release gates remain: real personal-chat L1/L2 payloads on
desktop/mobile, tenant thread support, quote rendering/privacy, reaction target
IDs/rate limits, mobile card/layout behavior, relay server capability evidence,
and sanitized supported App journal approval coverage. None is claimed verified
by a build, typecheck or offline suite. Windows/PowerShell Teams-package and
official-schema checks are relevant when a later phase changes that package;
Phase 0 makes no package change.

## 9. Phase 4 findings, proposal only

An optional future endpoint protocol could carry bounded ephemeral intent,
question/plan/permission status with canonical source, request ID, generation,
revision, freshness, cancellation and ownership provenance. It would need
loss/reconnect semantics distinct from durable journal cursors, and a supported
original-host API. It must not replay prompts, make passive following start an
SDK, or turn a heartbeat into authority. This task does not change that protocol.

Elicitation fan-out/first-response-wins is a race property, **not permission** to
answer an App-owned request remotely. Any remote App answer proposal requires
separate owner authorization, supported host API and native permission policy;
it remains outside this redesign's implementation scope. No inferred approvals,
handler replacement, stop, takeover, or model/mode change is proposed.

The SDK remote-sessions reference [C3] may describe links for compatible
GitHub-backed sessions. A future UI may show an authoritative host-returned link
only when actually available; repository membership or a session UUID alone
cannot manufacture a working remote link. No remote session is created,
attached, mirrored, or probed here.

## 10. Public references and freshness

Platform findings were checked on 2026-11-17; they are **docs-only** unless
separately marked verified against pinned source above.

- **T1, threads:** [Agent chat threads](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/agent-chat-threads),
  document date 2026-11-13; source commit
  `90b68d2308dda455636670bbe6684f26473596c9`.
- **T2, quotes:** [Quoted and threaded replies](https://microsoft.github.io/teams-sdk/blog/quoted-and-threaded-replies/)
  (older thread-ID parsing is not adopted);
  [official Teams SDK message helper](https://github.com/microsoft/teams.ts/blob/96ec9329e67adea20959660b7cb2180c88f15c99/packages/api/src/activities/message/message.ts),
  lines 343-364 and 723-740, for entity plus marker shape.
- **T3, reactions:** [Agent reactions](https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/agent-reactions),
  [reaction IDs](https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/teams-reactions-reference),
  [Python Teams SDK guide](https://microsoft.github.io/teams-sdk/python/in-depth-guides/message-reactions/).
- **T4, interaction limits:** [Streaming UX](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux)
  (2026-10-28), [suggested actions](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/suggested-actions).
- **T5, manifest:** [exact Teams 1.23 schema](https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json),
  [newer prompt-starter documentation](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/prompt-starters),
  [agent slash commands](https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/agent-slash-commands).
  Prefer the pinned schema over newer feature examples.
- **T6, cards:** [Teams card reference](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-reference)
  (2026-10-13, updated 2026-10-23);
  [agent experience checklist](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/teams-conversational-ai/agents-best-practices-features-checklist).
- **T7, links:** [Teams deep links](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-link-teams).
- **T8, authenticated wire protocol:** [Connect an agent without an SDK](https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/connect-agent-without-sdk)
  (2026-11-06, updated 2026-11-13). ACS is Agent Communication Service; its
  documented Bot Framework credential scope does not replace the current relay.
- **C1, latest SDK queueing:** [Steering and queueing](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/steering-and-queueing).
- **C2, latest SDK events:** [Streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
  and [latest Node README](https://raw.githubusercontent.com/github/copilot-sdk/main/nodejs/README.md).
  The pinned package, not these latest pages, is the API evidence in this note.
- **C3, future remote-session research:** [Remote sessions](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/remote-sessions).

**Stop point:** review this design note before any Phase 1 implementation.
