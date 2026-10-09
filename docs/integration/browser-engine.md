# Browser execution engine

Import `createAutomationEngine` in your browser bundle and call `initialize()` after the DOM has
mounted. Dispose the engine when the view is removed. This path needs no model or provider key.
The complete [browser example](../examples/browser-engine.ts) fills an exact input inside a caller-owned root.

## Actions and targets

`executeAction(action, options?)` accepts a lowercase action type and string-valued parameters.
Supported engine actions include `click`, `fill`, `setChecked`, `select`, `press`, `scroll`,
`wait`, `navigate`, `fillForm`, `submitForm`, and `screenshot`.
TaskAgent exposes a narrower typed operation vocabulary; do not interchange the two command shapes.

For a known element, use `parameters.strict: 'true'` and pass `options.target`. Strict execution
refuses missing, detached, disabled, ambiguous or invalid targets rather than searching for a
similar one. An empty fill value is valid and clears an editable field. Use `setChecked` for
idempotent checkbox/radio state; a click toggles and is not equivalent. Native selects require a
unique enabled option. See the generated ActionCommand and ExecutionOptions API for parameter names.

Action failures fulfill with `success: false`; they are not Promise rejections for normal action
failures. Inspect `errorCode` and `effect`. A timeout or cancellation can occur after dispatch;
`effect: 'uncertain'` requires reconciliation before retrying a write. `executeActions` returns
individual results; it is not an atomic transaction or a durable workflow coordinator.

## Action parameter reference

All parameter values are strings, including booleans and numbers. In strict mode, supply an exact
options.target or a selector that resolves uniquely. Unknown keys and malformed values fail validation.

| Action                | Parameters to configure                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| fill                  | value (including empty string), optional clearFirst and triggerEvents                                |
| click                 | optional button left/right/middle and clickCount; strict clicks activate once                        |
| setChecked            | checked as true/false; requires strict targeting                                                     |
| select                | matchBy value/label/index together with option; optional triggerEvents; requires strict targeting    |
| press                 | key, optional implicitSubmit; Enter/Space activation can submit a form                               |
| scroll                | direction UP/DOWN/TOP/BOTTOM; optional target container; requires strict mode                        |
| wait                  | duration as a canonical integer from 1 to 60000 milliseconds                                         |
| navigate              | url, optional waitForLoad; direct engine navigation is caller-owned                                  |
| screenshot            | optional fullPage and quality from 0 to 1; protect resulting pixels                                  |
| fillForm / submitForm | Registered formId and form-specific inputs; see the form API and validate your framework integration |

For example, the engine checked-state command uses parameters checked: 'false'; the corresponding
TaskHost command uses operation SET_CHECKED and a boolean checked field. Only the coordinator's
policy path applies TaskAgent effect grants; direct engine calls are authorized by your application.

## Roots and application navigation

`AutomationConfig.root` can scope engine DOM queries to a `Document`, `ShadowRoot` or `Element`.
A `locationProvider` can supply `getHref`, optional `getTitle` and `navigate` for application-owned
navigation. The caller must provide a trustworthy implementation. A full navigation destroys an
in-page engine; use the remote task integration to preserve coordinator state.

TaskHost observation currently uses its own document observer; an engine root does not automatically
scope every TaskAgent observation. Use host observer predicates and origin authorization for that boundary.

## Forms and events

Call `registerForm(id, formElement)` for an explicit form, or use form detection through
`initialize(formLibrary?)`. Framework integration discovers compatible objects rather than importing
React or React Final Form. Their private internals can change, so exercise your exact framework/widget
version. Strict TaskAgent targeting does not promise support for every custom dropdown.

Use `addEventListener`/`removeEventListener` for execution events and `capturePageContext()` for
context capture. Raw legacy engine context can include form data. Supply a `redactor` when values
must be withheld; TaskAgent additionally scrubs its own observation and decision boundaries.
Screenshots contain pixels and need separate privacy controls. `html2canvas` is a runtime dependency
for this feature; UMD consumers must supply `globalThis.html2canvas` if they invoke screenshot capture.

## Bundles and server rendering

ESM and CommonJS are supported through the package root. The UMD build exposes `WebAutomata`.
Importing the package in Node is supported, but instantiate DOM services only in a browser lifecycle,
not during server rendering. Kriya does not provide a Playwright/CDP browser or polyfill a DOM.

See [migration](migration.md) for changed failure handling and removed bindings, and
[operations](operations.md) for the package consumer gate.
