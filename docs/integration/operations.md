# Deployment checks and troubleshooting

Before exposing Kriya to users, test the exact application, provider and permission profile you
intend to deploy. A passing scripted integration test establishes wiring and control behavior,
not model accuracy. Preserve failed runs and distinguish local, CI, live-provider and released proof.

## Deployment checklist

- Install the packed package in a clean consumer; check ESM, CommonJS and TypeScript imports.
- Mount and dispose browser services correctly; install the bridge before every full navigation.
- Exercise the authenticated user's permitted origins and refuse an origin change before secret delivery.
- Check exact target execution, already-correct no-ops, validation failures and DOM rerender races.
- Implement all result states, real approval UI, input collection, cancellation and uncertain-effect reconciliation.
- Verify checkpoint ownership, cross-process integrity and atomic approval consumption if used.
- Confirm saved-state verification against your backend; test failed writes and misleading success messages.
- Scan recorded text and separately review screenshots/video privacy; record only redacted envelopes.
- Test model/HTTP timeouts, malformed answers, retry accounting and cost ceilings.
- Run live acceptance on your chosen provider/defaults and publish the precise scope of the evidence.

## Common failures

| Symptom                                     | What to inspect                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| HOST_INCAPABLE                              | Required strict targets/redaction/location or navigation lifetime is unavailable; repair the host    |
| Bridge unavailable after navigation         | Init script registered too late, global conflict, wrong frame, bridge not ready                      |
| ORIGIN_LEFT_SCOPE / ORIGIN_UNVERIFIED       | Controller location disagrees with observation or falls outside the grant                            |
| needs_input despite known data              | Input path, sensitivity binding, selected candidate and request-size truncation                      |
| awaiting_approval on an ordinary click      | Structural/model commitment classification; missing classifier is fail-closed                        |
| FORM_INVALID                                | Native validity, authored required metadata or application error; the goal may ask to test rejection |
| COMPLETION_NOT_VERIFIED                     | Fresh evidence, unmet required controls, independent persistence read or cited evidence              |
| NO_PROGRESS / MODEL_UNCERTAIN               | Unsupported widget, missed controls, low confidence or repeated state; keep the failure visible      |
| UNCERTAIN_EFFECT                            | Reconcile actual backend state before resuming/retrying                                              |
| CHECKPOINT_INVALID / APPROVAL_MISMATCH      | Wrong agent/key, edited checkpoint, changed reviewed context or incorrect approval fields            |
| APPROVAL_EXPIRED / APPROVAL_CONSUMED        | Obtain new consent; never reset the stored consumption record                                        |
| Provider INVALID_REQUEST / INVALID_RESPONSE | Credential/config, byte ceiling, model prefix or response vocabulary                                 |

Do not resolve these by disabling origin checks, lowering floors until a demonstration passes,
auto-approving commitments or treating a success toast as persistence evidence.

## Repository verification

Run npm ci under the contributor Node version, install Chromium, then run validate, Jest, build,
verify:package and docs:verify. `docs:verify` type-checks the new documentation's TypeScript examples
and performs actual Chromium checks with a scripted provider: engine fill/blank/click, in-page
coordination, remote full navigation, completion evidence, approval binding and a forbidden origin.
No model credential or paid request is used by that gate.

Use KRIYA_CHROMIUM_EXECUTABLE only to select an existing compatible browser executable; otherwise
Playwright uses its installed Chromium. For the website, create a Python virtual environment,
install docs-requirements.txt, run docs:api, then docs:build. TypeDoc warnings are fatal. Literal
union backing constants intentionally remain internal; types used by public signatures are exported.

The consumer package gate rejects bindings, caches, media and environment files, verifies declared
entrypoints and imports the packed tarball in an isolated project. CI also retains the existing
markdownlint, strict MkDocs and link-validation gates. GitHub Pages deployment requires a repository
administrator to select GitHub Actions as its build source; see CONTRIBUTING.md for the setup.

## Development dependency audit

Production and development audits have different scopes. The current release-tool chain includes
an unpatched braces advisory and vulnerable dependencies bundled inside npm. npm audit fix does
not repair all of them. See [security policy](https://github.com/juspay/kriya/blob/main/SECURITY.md) for the tracked limitation.
Do not use audit --force to install an unrelated old release stack, silently suppress the audit,
or claim zero development findings. This code is excluded from the consumer tarball's runtime dependencies.
