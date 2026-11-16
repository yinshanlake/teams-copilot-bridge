# Third-party notices and service terms

The project's own source, documentation, and original generated Teams icons are
provided under the [MIT License](LICENSE). No Microsoft or GitHub logos are
included. Product names are used for identification only and do not imply
endorsement, affiliation, or trademark permission.

Dependencies are installed from their own packages and retain their copyright
notices, licenses, and any bundled notices. `package-lock.json` records exact
versions, integrity checks, and package license metadata. This source
distribution does **not** bundle `node_modules`, native SDK executables, or
compiled third-party code.

Direct runtime dependencies:

| Package | Upstream |
| --- | --- |
| `@github/copilot-sdk` | [GitHub Copilot SDK](https://github.com/github/copilot-sdk) |
| `@azure/identity` | [Azure SDK for JavaScript](https://github.com/Azure/azure-sdk-for-js) |
| `@microsoft/agents-activity`, `@microsoft/agents-hosting` | [Microsoft 365 Agents SDK](https://github.com/microsoft/Agents-for-js) |
| `@zip.js/zip.js` | [zip.js](https://github.com/gildas-lormeau/zip.js) |
| `express` | [Express](https://github.com/expressjs/express) |
| `socket.io-client` | [Socket.IO](https://github.com/socketio/socket.io) |

Development/test dependencies, their transitives, and the optional Python
`jsonschema` validator also retain their own licenses. If redistributing
installed dependencies or a binary build separately, review and retain all
relevant LICENSE/NOTICE files and comply with those terms; this project's MIT
license does not replace them.

Microsoft's Teams manifest schema is referenced, not vendored or relicensed.
Optional schema validation uses a local operator-supplied copy.

Use of GitHub Copilot, its CLI/App and model providers, Microsoft Teams, Entra,
Azure Bot Service, Azure CLI, or a tunnel/relay is subject to the applicable
product terms, organization policies, subscriptions, and permissions. Licensing
this bridge does not grant access to those products, preview APIs, hosted
services, accounts, or models.
