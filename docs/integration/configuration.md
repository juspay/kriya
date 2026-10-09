# Configuration reference

Kriya accepts configuration through constructors and typed requests. It has no automatic
NODE_ENV configuration merge, database connection or environment-file discovery. See the public
TypeScript declarations for the complete option shapes.

## Runtime versus development requirements

| Component             | Required setup                                                                 |
| --------------------- | ------------------------------------------------------------------------------ |
| Browser engine/bridge | Modern ES2020-capable browser with a mounted DOM                               |
| Node coordinator      | Node 20.8.1 or later; injected TaskHost and TaskDecider                        |
| TypeSafe adapter      | Node-side credential callback; HTTPS endpoint and permitted model prefix       |
| Playwright template   | Caller-installed Playwright/Chromium, dedicated authenticated context          |
| Repository tooling    | Node 22.23.2 or a compatible newer release; npm; Python for MkDocs             |
| Production package    | html2canvas for screenshot implementation; no React/ReScript peer installation |

## Coordinator and request

`createTaskAgent({ host, decider, policy?, options? })` injects the boundaries. `options.run`
sets application defaults; `run(request)` can supply request-specific options. Resume only tightens
saved limits. Use `options.verifier`, `resolvers`, `onEvent`, `beforeExecute`, `checkpointKey` and
`consumeApproval` for application integrations. The beforeExecute hook receives a redacted command;
it is not an authorization substitute.

| Setting                                                           | Library default        | Meaning                                                                 |
| ----------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| Confidence action / argument / commitment / completion            | 0.5 / 0.6 / 0.5 / 0.75 | Independent stage floors; not calibrated task accuracy                  |
| maxSteps / maxModelCalls / maxWallTimeMs                          | 25 / 150 / 300000      | Work and accumulated active-time budgets                                |
| maxStaleRetries / maxNoProgress                                   | 3 / 4                  | Bounded recovery; no blind mutation retry                               |
| maxUncertainEffects / maxPrematureDone                            | 1 / 2                  | Uncertain commitments block immediately regardless of the general limit |
| maxInvalidDecisions / maxRejectedCommands                         | 3 / 3                  | Unusable choices versus valid commands refused by the host              |
| maxDeciderFailures / maxHostFailures                              | 2 / 2                  | Consecutive boundary failures                                           |
| executionTimeoutMs / observeTimeoutMs                             | 8000 / 10000           | Coordinator action/observation bounds                                   |
| approvalTtlMs                                                     | 900000                 | Expiry of the concrete approval request                                 |
| settle quietMs / maxMs                                            | 150 / 2000             | DOM quiet wait with a hard ceiling, not a persistence proof             |
| includePageText / inputPreviews                                   | true / true            | Non-sensitive context projection; declarations can restrict exposure    |
| captureTrace / captureExchanges / captureProgressDiagnostics      | false / false / false  | Optional redacted diagnostics; can contain personal data                |
| allowRunLoss / allowUnverifiedLocation / allowUncertainCompletion | false / false / false  | Explicit escape hatches, not deployment fixes                           |
| requireGroundedCompletion                                         | false                  | When true, refuses a model-only completion basis                        |

Work budgets are checked before starting work; occurrence budgets block when their allowed count
is exceeded. Wall time accumulates across resume. Confidence/profile precedence is described in
the contract; resume never lowers stored floors. Run results expose effective floors when an
explicit confidence profile is configured.

## TypeSafe adapter

| Setting                                          | Default                                               |
| ------------------------------------------------ | ----------------------------------------------------- |
| endpoint / model                                 | `https://api.typesafe.ai/v1/systemone` / `jev-latest` |
| timeoutMs                                        | 20000 per HTTP attempt, joined to the caller signal   |
| maxRequestBytes / maxOptions / evidenceQuestions | 30000 / 60 / 2                                        |
| allowedModelPrefixes                             | `['jev-']`                                            |
| maxRetries / baseDelayMs / maxDelayMs            | 2 / 500 / 5000                                        |
| jitter / maxRetryAfterMs                         | 0.25 / 60000                                          |
| confirmCommitment / rotateOptions                | true / true                                           |
| captureProbabilities                             | false                                                 |

Use `apiKey: () => process.env.TYPESAFE_API_KEY ?? ''` in Node. A custom `http` implementation is
trusted code: the request carries a credential callback, not an Authorization header. The default
sender attaches Authorization; adapter validation/redaction also consults the reader. Serializing
the request omits the callback, but executing it reveals the credential to that trusted code.
Never record response bodies or raw errors without your own privacy boundary.

Retries cover 408, 429, 5xx, network failures and attempt timeouts. Other 4xx, invalid responses
and caller cancellation are not retryable. One model-call counter is not one physical HTTP send:
confirmation and the bounded coordinator classifier retry can add sends. The conservative default
classifier composition is at most 12 physical attempts before cancellation/deadlines shorten it.
Use physical-send instrumentation for provider cost accounting.

## Observation and host options

Task observations default to at most 250 elements and 6000 page-text characters. TypeSafe model
projection is smaller and capped by request size. The goal itself is limited to 1500 UTF-8 bytes.
Observer predicates and sensitivity hooks belong to host/bridge construction. `includeOffscreen`
belongs to observe requests; wrap the host's observe method to set it application-wide if needed.
A larger observation does not guarantee every candidate reaches the model.

RemoteTaskHost offers callTimeoutMs, navigationTimeoutMs, cancelGraceMs and pollIntervalMs.
Its capability flags depend on the supplied transport; do not advertise authoritative location,
concurrent cancellation or fresh-state reads unless their implementations satisfy the contract.
