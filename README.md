# Kriya

**Turn a user's goal into browser actions—with permissions, exact targets and checked outcomes.**

Kriya is a TypeScript browser automation library for teams building assistants inside web
applications or controlling a browser from Node. Use its execution engine when you already know
what to do, or its TaskAgent when a typed decision provider should choose the next action.
Your application owns the browser session, user data, permissions and approval experience.

```text
User goal + caller inputs
           ↓
TaskAgent → observe → typed decision → policy → exact DOM action
    ↑                                           ↓
    └──────── fresh state + completion checks ───┘
```

## What you can build

| Capability                    | Integration                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| Search and filter workflows   | Read, fill, select, click and inspect resulting page evidence                       |
| Settings assistants           | Set checkboxes idempotently, preserve already-correct values and verify saved state |
| Multi-page forms              | Keep the coordinator in Node; reinstall the bridge in each new document             |
| Review and confirmation flows | Pause a commitment for approval bound to the exact command and reviewed context     |
| Research assistants           | Restrict the same coordinator to reading, navigation, scrolling and waiting         |
| Existing agent integrations   | Inject a typed decider and host, or call the execution engine directly              |

TaskAgent's built-in TypeSafe adapter uses **Choice judgments over offered operations, targets
and value references**. It does not generate arbitrary form text or run model-authored JavaScript.
Data comes from caller inputs, exact goal spans, observed choices or declared resolvers. A missing
value can return `needs_input`. A model's `DONE` proposal must pass the completion gate.

## Install

```sh
npm install @juspay/kriya
```

The package provides ESM, CommonJS, TypeScript declarations and a browser UMD bundle
(`dist/index.umd.js`, global `WebAutomata`). Browser actions require a mounted DOM. The coordinator
can run in Node without a DOM; it needs an injected host to reach a browser. Node consumers need
Node 20.8.1 or later. Contributor tooling uses Node 22.23.2 or a compatible newer version.

`html2canvas` supports screenshots. Kriya does not install React, a browser binary, an AI SDK,
a database or a server. Playwright is a separate controller choice and a development dependency
for integration verification. No provider key is needed for direct engine actions.

## First browser action

Run this in your browser application after an input with `id="name"` has mounted:

```typescript
import { createAutomationEngine } from '@juspay/kriya';

const engine = createAutomationEngine({ debugMode: false, screenshotOnError: false });
engine.initialize();
try {
  const target = document.querySelector<HTMLInputElement>('#name');
  if (target !== null) {
    const result = await engine.executeAction(
      { type: 'fill', parameters: { strict: 'true', value: 'Ada Lovelace' } },
      { target }
    );
    if (!result.success) {
      document.body.dataset.automationError = result.errorCode ?? 'unknown';
    }
  }
} finally {
  engine.dispose();
}
```

Strict execution uses the supplied element and refuses stale or invalid targets. Action failures
fulfill with an `ExecutionResult`; inspect `success`, `error` and `effect`. See the
[engine integration guide](docs/integration/browser-engine.md) for scoped roots, forms and events.

## Add goal-driven execution

The [Node and Playwright guide](docs/integration/node-playwright.md) provides a complete setup
and reusable transport. Keep the TaskAgent and TypeSafe credential in Node and inject only the
execution bridge into each browser document. The caller sets the initial URL and allowed origins;
the goal describes the desired outcome rather than routes, selectors or a scripted action list.

For a coordinator inside your own application, use the
[in-page integration guide](docs/integration/in-page.md) with a trusted backend decider client.
An in-page coordinator cannot retain a run across a full document navigation.

| Integrators need                                              | Documentation                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| Placement, prerequisites and integration choice               | [Start here](docs/integration/index.md)                          |
| Defaults, budgets, timeouts, observation and provider options | [Configuration reference](docs/integration/configuration.md)     |
| Inputs, origin scope, approvals, resume and cancellation      | [Application lifecycle](docs/integration/lifecycle.md)           |
| Privacy, transport responsibilities and durable verification  | [Security and verification](docs/integration/security.md)        |
| Custom providers, resolvers and research mode                 | [Extension seams](docs/integration/extensions.md)                |
| Error handling, deployment checks and common failures         | [Operations and troubleshooting](docs/integration/operations.md) |
| v2 migration, removal of bundled ReScript bindings            | [Migration](docs/integration/migration.md)                       |
| Exact public protocol and types                               | [TaskAgent contract](docs/task-agent-contract.md)                |

## Evidence and boundaries

Version 2.2.0 has a recorded controlled-app campaign covering catalog, settings, shipping and
simulated checkout: **43/43 ordinary scenarios and 8/8 labelled fault scenarios** on one frozen
build. Caller action/argument/commitment/completion floors were **0.2/0.3/0.5/0.4**;
these are different from the library defaults **0.5/0.6/0.5/0.75**. Earlier failed runs are retained.
These figures describe that campaign, not arbitrary-site accuracy or a default-settings benchmark.
See [verification status and limits](docs/task-agent-status.md) and the
[acceptance ledger](e2e/acceptance/README.md).

The current observer does not offer iframe, canvas, contenteditable, file upload or drag-and-drop
operations. A custom widget may need caller-provided observation/accessibility integration.
Page text and success toasts alone cannot prove a durable write. Provider confidence is not a
calibrated probability of task success. A new provider needs its own acceptance evaluation.

## Develop and verify

```sh
nvm use
npm ci
npx playwright install chromium
npm run validate
npm test -- --runInBand
npm run build
npm run verify:package
npm run docs:verify
```

Integration verification uses a scripted decider and local Chromium, with **no provider calls**.
It checks the documented examples, packed-package consumers, full document navigation and
negative controls. To build the documentation website, install `docs-requirements.txt` in a Python
virtual environment, then run `npm run docs:api` and `npm run docs:build`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for reproducible gates and release setup.

## License and support

[MIT](LICENSE) · [Releases](https://github.com/juspay/kriya/releases) ·
[Issues](https://github.com/juspay/kriya/issues) · [Security reporting](SECURITY.md)
