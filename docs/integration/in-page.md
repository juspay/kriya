# In-page TaskAgent

Use this placement for tasks that remain in one document. The complete
[in-page factory](../examples/in-page-task.ts) creates an engine, wraps it in an
AutomationTaskHost and injects a caller-supplied TaskDecider. Its cleanup disposes both host and engine.

## Keep the provider outside the page

Pass a typed RPC client implementing TaskDecider. Your authenticated backend validates the caller,
request size, goal and permitted session, then calls its decision service. Page observations are
untrusted data. Do not proxy an arbitrary URL or accept model-authored executable code.
Kriya does not ship this application-specific RPC server.

Do not put a TypeSafe or other provider key in a browser bundle. The built-in TypeSafe adapter
refuses normal browser-key use by default. `allowBrowserKey` is a test/trusted-extension escape
hatch, not a recommended website integration.

## Lifetime and permissions

Call `agent.run(request, signal?)` after the page is ready. Set explicit authorization origins and,
where appropriate, operations and narrowly scoped effect grants. Handle every result status in your UI.
The host advertises `persistsAcrossNavigation: false`; NAVIGATE/SUBMIT are withheld unless the caller
explicitly permits run loss. Do not enable `allowRunLoss` to emulate a persistent coordinator.
Use [Node/remote integration](node-playwright.md) for full navigation.

A page can change its own DOM and text. An in-page bridge is not a security sandbox against a
hostile page. An extension isolated world/controller can provide a stronger boundary, but capability
flags must describe the actual deployment rather than an aspirational isolation level.

## Observing your application

Host observer predicates can exclude elements, page readings or navigation choices. Use
`isSensitive` and `sensitiveSelectors` for application-specific private fields. `includeOffscreen`
is an observation request option; it changes which rendered controls are offered and does not
make hidden or disabled controls executable. Test collapsed sections, tabs and validation states.

See [lifecycle](lifecycle.md) for approval/resume UI and [security](security.md) for the distinction
between a correct local control value and a lasting saved change.
