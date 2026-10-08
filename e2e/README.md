# e2e: proof that general task execution works

Current pass counts and known limits are recorded in [the status page](../docs/task-agent-status.md) and the [acceptance evidence](acceptance/README.md). A failed live run remains evidence of a failed goal; assertion controls and labelled injection runs are separate proof classes.

This directory proves the compiled Kriya TaskAgent end to end. It is plain Node ESM (`.mjs`), is not part of the
package build, imports nothing from `src/` and adds no dependency. A run drives the real `dist/index.esm.js`
(Node side coordinator, remote host, TypeSafe decider) and injects the real `dist/index.umd.js` bridge into
every document of a real headless Chromium, against locally served controlled apps, with the live Jev model.

```text
e2e/
  run.mjs                CLI (this file's subject)
  apps/<family>.mjs      controlled apps: catalog, settings, shipping, checkout (3 variants each, fault switches)
  scenarios/<family>.mjs scenarios (goal + data + authorized scope + app options + assertions, never steps)
  scenarios/<family>.controls.mjs   scripted controls: expect() passes on a real end state, fails on wrong ones
  harness/               env, dist, browser, host (Playwright transport), jev (gate + recorder), faults,
                         evidence, sensitive, scenario, runner, selftest
  evidence/<run-id>/     output of runs (ignored by prettier and git)
```

## Prerequisites

| Need               | Detail                                                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node               | 20.8.1 or newer (the repository pins the same floor)                                                                                                                                                                                                                 |
| Playwright         | resolved from `BREEZE_GUIDE_TOOLS_DIR` (default `/tmp/amazon-guide`), exactly like `e2e/apps/*.check.mjs`                                                                                                                                                            |
| Chromium           | `executablePath` is mandatory (the Playwright revision in that directory is not installed). Lookup: `BREEZE_CHROME_PATH`, then `~/Library/Caches/ms-playwright/chromium-1234/...`, then the first installed `chromium-N`                                             |
| Built `dist/`      | `dist/index.esm.js` and `dist/index.umd.js`, newer than every file under `src/`, exporting `createTaskAgent`, `installTaskBridge`, `createRemoteTaskHost`, `createTypeSafeTaskDecider`, `redactEnvelope`. The harness never builds: build with `npm run build` first |
| `TYPESAFE_API_KEY` | only for live runs. Load it with `node --env-file=<file>`; the harness reads it in one place (`runner.mjs`, inside the credential callback it hands the decider) and never prints, logs or writes it                                                                 |

## Run

```sh
# the harness proves itself first (no browser, no model, no dist needed)
node e2e/harness/selftest.mjs

# what exists, and whether every scenario file is valid
node e2e/run.mjs --list
node e2e/run.mjs --validate

# live runs (needs dist and the key)
node --env-file=/path/to/.env e2e/run.mjs --family settings --variant B
node --env-file=/path/to/.env e2e/run.mjs --scenario settings-b-save-trap --scenario shipping-a-fill-review
node --env-file=/path/to/.env e2e/run.mjs --kind fault --jobs 2 --run-id fault-pass-1
```

### Flags

| Flag                                           | Meaning                                                                                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--scenario <id>...`                           | run these ids (repeatable; several ids may follow one flag)                                                                                                                        |
| `--family <f[,f]>`                             | `catalog`, `settings`, `shipping`, `checkout`                                                                                                                                      |
| `--variant <v[,v]>`                            | `A`, `B`, `C`                                                                                                                                                                      |
| `--kind live\|fault\|all`                      | default `all`                                                                                                                                                                      |
| `--jobs <n>`                                   | scenarios in parallel, default 1 (1 to 16). One browser, one context per scenario                                                                                                  |
| `--jev-concurrency <n>`                        | process-wide cap of in-flight Jev requests, default 3 (the cap is shared by every scenario and every `--jobs` lane)                                                                |
| `--run-id <id>`                                | evidence directory name under `e2e/evidence/`, default `run-<timestamp>-<hex>`. Evidence is never overwritten: an id that already holds evidence for a selected scenario is exit 2 |
| `--list`                                       | print id, family, variant, kind, title and exit                                                                                                                                    |
| `--validate`                                   | validate every scenario file and exit non-zero on any error (duplicate ids, import errors, an empty directory, unknown app options count)                                          |
| `--scenarios-dir`, `--evidence-root`, `--root` | overrides for tests and unusual layouts                                                                                                                                            |

### Exit codes

| Code | Meaning                                                                                                                                                                                                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | every selected scenario passed                                                                                                                                                                                                                                                                                   |
| 1    | a scenario failed (also: `--validate` found a problem)                                                                                                                                                                                                                                                           |
| 2    | preflight or usage: bad arguments (an empty `--scenario`, `--family` or `--variant` value included, because an empty list would select every scenario), unknown or duplicate scenario id, invalid scenario, reused run id, Playwright, Chromium, Node version, missing `TYPESAFE_API_KEY`, browser did not start |
| 3    | dist missing, stale (older than a source file it was built from) or missing a required export                                                                                                                                                                                                                    |
| 4    | the evidence scan found the API key or a sensitive test value in an artifact, or one was found in a request sent to Jev (wins over 1)                                                                                                                                                                            |

## What a scenario is

A scenario is data plus assertions. It carries a natural-language caller goal, optional `inputs` (a function of the
run-time generated sensitive values, so no secret is ever a literal), `inputDeclarations`, the authorized scope
(`authorization`, with `'$app'` standing for the origin of the app the runner started), app options (`initial`,
`faults`), `run` (budgets, `cancelAfterMs`, `allowRunLoss`), `resume` (data-only resolutions applied in order when the run
pauses), `inject` (kind `fault` only), `expectStatus` and `expect(app, result, page, ctx)`.

`validateScenario` rejects, on purpose: unknown keys, a goal or input holding a URL, a host, a file name, an absolute path, a CSS
selector, a click or tap instruction, a quoted button label used as an instruction, an expected phrase to find, a step list or a
count of steps. Names, addresses and query terms belong in `inputs` or as quoted literals inside a natural goal.

`ctx` given to `expect`: `calls` (recorded Jev exchanges), `trace` (events), `evidenceDir`, `sensitive` (the generated values),
`pauses` (the paused `TaskResult`s themselves), `pauseBackends` (backend snapshot at each pause), `results` (every result of the
run in order), `goal`, `runId`, `notes`.

These scenarios request state changes, so the runner supplies `expect: { answer: false }`. On resume it supplies the original private values for checkpoint `sensitivePaths`, unless the resolution replaces or explicitly omits them. Those values never become part of the approval decision or recorded checkpoint.

The optional `--action-confidence`, `--argument-confidence` and `--completion-confidence` flags set finite 0..1 runtime floors. `--observe-offscreen` includes rendered controls outside the viewport; hidden controls remain excluded. The recorded acceptance campaigns pass 0.2/0.3/0.4 (the example script uses 0.2/0.3/0.6) and each result records its profile. Commitment confidence and library defaults remain unchanged.

## What a run does (per scenario)

0. Create `e2e/evidence/<run-id>/<scenario-id>/`: it must be new or empty.
1. Start the app (`scenario.initial` and `faults`), write `backend-before.json`.
2. New context with the UMD bridge as init script, load the app, `step-00-initial.png`.
3. Build the Playwright transport, the remote host, the recording Jev http (process-wide gate) and the TypeSafe decider
   (credential callback only). For kind `fault`, `applyInjection` wraps decider and host.
4. Create the agent with the scenario authorization and budgets and an event recorder; run it, aborting through an `AbortSignal` when
   `run.cancelAfterMs` is set. While the result pauses (`needs_input`, `awaiting_approval`), apply the next `resume` entry with
   `agent.resume` (the approval id, nonce and digests are copied from the paused approval; the scenario never carries them).
5. Write `backend-after.json`, `result.json`, `final.png`; call `expect`; check `expectStatus`.
6. Assert on every recorded Jev request: every question's `instructions.goal` equals the scenario goal; no app route, host, CSS selector or
   scenario-forbidden phrase appears in library instruction text; every answered response model matches `/^jev-/`; a live scenario made at
   least one call (`no_jev_calls`) and at least one of them was answered by a `jev-*` model (`no_jev_answer`: a rejected key must not turn a
   refusal scenario into a pass).
7. Write `summary.json`, then scan the whole scenario directory for the API key and every generated or declared sensitive value (exact,
   JSON-escaped, URL-encoded as component and as form, HTML-escaped as text and as attribute, digit-grouped). Every leaf below a declared
   sensitive path counts, numbers included. A hit scrubs the file, fails the run and makes the CLI exit 4. `jev.mjs` masks known values before a
   request is written, so the runner also checks each raw request on its way to the model (body and headers, never the credential): a hit is
   `jev_request_secret` and exit 4. The directory is scanned again after the final `summary.json` write.
8. Always close page, context and app (and release the host). Each close step is abandoned after 15 s so one hung close cannot block the rest.
   A watchdog aborts a run that outlives 8 minutes; it covers the agent run only (`expect` has its own 2 minute limit), and its timers are
   cleared when the run ends. SIGINT and SIGTERM close the browser and exit 130.

## Evidence layout

`e2e/evidence/<run-id>/<scenario-id>/`

| File                                        | Content                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jev-calls.json`                            | every Jev exchange: request, response, resolved model, request id, latency, status, attempt; key and sensitive values replaced by `[REDACTED]`                                                                                                                                                                                                                                                              |
| `trace.json`                                | the agent events (decisions, compile, classification, policy, approvals, executions, gate), transport lines, fault notes, harness notes                                                                                                                                                                                                                                                                     |
| `observations.json`                         | per-observation summary (url, title, element count, fingerprint) and the final observation summary                                                                                                                                                                                                                                                                                                          |
| `backend-before.json`, `backend-after.json` | `app.state()` (backend truth) before and after                                                                                                                                                                                                                                                                                                                                                              |
| `pauses.json`, `result-pause-N.json`        | backend snapshot at each pause and the paused `TaskResult` (only when the run paused)                                                                                                                                                                                                                                                                                                                       |
| `result.json`                               | the `TaskResult` as returned                                                                                                                                                                                                                                                                                                                                                                                |
| `screenshots/`                              | `step-00-initial`, `step-NN-<event>`, `step-NN-paused-K-<status>`, `final`. In a scenario that declares sensitive values the page is probed before and after each capture: a shot is taken only when the visible page text and control values (password and hidden fields excepted) show none, an unreadable page counts as showing one, and a shot is removed again if a value appeared while it was taken |
| `injection.json`                            | kind `fault` only: the injection configuration, notes and whether each fault fired                                                                                                                                                                                                                                                                                                                          |
| `failure/`                                  | on failure: `failures.json`, `console.json`, `page.html`, `last-observation.json` (all redacted)                                                                                                                                                                                                                                                                                                            |
| `summary.json`                              | `{ id, family, variant, kind, label, passed, status, model, models, calls, steps, durationMs, sha256, failures, ... }` (`sha256` identifies the dist pair)                                                                                                                                                                                                                                                  |

`e2e/evidence/<run-id>/run-summary.json` lists every scenario of the run with the live and fault-injected totals.

## What counts as live-verified

| Label                            | Meaning                                                                                                                                                                                  | May be reported as                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| LIVE (`kind: 'live'`)            | real Jev through `api.typesafe.ai` (resolved model `jev-*` recorded), real Chromium, the real built bundles (sha256 in `summary.json`), a controlled app whose backend state is asserted | "verified with live Jev"                                                                             |
| FAULT-INJECTED (`kind: 'fault'`) | the same stack, but a labelled wrapper scripts one decider answer or one host call (`FAULT_INJECTION` in notes, `live: false` in `injection.json`)                                       | "fault-injection proof of the gate, the policy or the recovery path"; never "verified with live Jev" |
| selftest, controls               | fakes or scripted Playwright, no agent, no model                                                                                                                                         | proof that the harness and the assertions measure something; never a claim about the agent           |

The CLI prints the two totals separately. A live scenario that records no Jev call fails (`no_jev_calls`).

## Selftest

`node e2e/harness/selftest.mjs` runs with injected fakes only (no browser, no model, no dist): validators accept good and reject bad
scenarios (each bad goal must be caught by the rule that names it), the runner end to end with a fake agent (completed, needs_input then
resume, awaiting_approval then resume, cancelled, failed, expect throwing or never settling, a secret leaking into an artifact or into a
model request, per-request Jev assertion failures, a hung agent and a hung close), the CLI exit codes (including a real SIGTERM to a child
process), the evidence scan with positive and negative controls, dist and preflight checks, and source hygiene (no `src/` imports, `process.env`
only where the allow-list says, no card or password literals in any harness file). It prints `PASS`/`FAIL` per check and the real totals,
and exits non-zero on any failure; a check that hangs fails after 90 s. `faults.selftest.mjs` and `io.selftest.mjs` belong to the fault and
transport modules.

The scan cannot see pixels and does not look at values shorter than 6 characters (or all-digit values under 8 digits): those are listed by
label in `summary.json` (`secretsSkipped`), never by value.
