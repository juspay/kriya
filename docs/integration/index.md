# Integrating Kriya

Kriya supplies execution and task coordination. Your application supplies the authenticated
browser, the goal and data, a typed decision provider, authorization and the user interface.
There is no built-in web server, environment-file loader, browser launcher or approval dialog.

## Choose a placement

| Placement                         | Use when                                                                      | Configure                                                                                 | Lifetime            |
| --------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------- |
| Browser execution engine          | Your code or existing agent already selects actions                           | DOM root, action parameters, exact target, event redactor                                 | Current document    |
| In-page TaskAgent                 | Your own application needs a same-document assistant                          | Engine, host, trusted decider RPC, permissions and approval UI                            | Current document    |
| Node TaskAgent and RemoteTaskHost | Tasks cross full navigations or credentials must stay outside the page        | Controller transport, per-document bridge, authoritative location, provider, origin scope | Controller lifetime |
| Custom host/decider               | An extension, CDP controller or compatible decision service owns the boundary | Public TaskHost/TaskDecider contract and capability assertions                            | Defined by the host |

1. Start with [one engine action](browser-engine.md).
2. Select [Node/Playwright](node-playwright.md) or [in-page coordination](in-page.md).
3. Configure [budgets and timeouts](configuration.md).
4. Implement [result handling and approval/resume](lifecycle.md).
5. Add [privacy and authoritative saved-state verification](security.md).
6. Run the [deployment checks](operations.md) against your own application.

## What to prepare

- An authenticated session owned by the correct user; Kriya does not log in automatically.
- An explicit starting URL and list of origins the task may use.
- A literal desired outcome and caller inputs; do not put credentials in the goal.
- A trusted decision endpoint or custom typed decider. The TypeSafe adapter keeps its key in Node.
- A decision about which commitment effects can run under existing consent and which need approval.
- A way to independently read saved application state after lasting changes.
- A UI/storage layer for paused results and checkpoints, plus redacted diagnostics and cancellation.

Selectors used by direct engine code are application integration details. TaskAgent goals should
describe outcomes; the coordinator chooses among current observed controls rather than accepting
a route/selector/action plan from the model. Observation is capped, so pages with many controls
need application-specific acceptance tests.

## Runnable integration files

The repository and npm package include the same small examples under `docs/examples/`:
`browser-engine.ts`, `in-page-task.ts`, `approval.ts`, `task-agent-node.mjs` and
`playwright-transport.mjs`. TypeScript examples import the public package, not private source.
The Node factory accepts an injected decider, so it can be exercised without a paid model call.
`npm run docs:verify` type-checks and executes these examples in Chromium.

The [configuration reference](configuration.md) distinguishes consumer runtime requirements,
contributor tooling and optional provider/browser-controller setup. No configuration JSON or
`.env` file is automatically discovered by Kriya.
