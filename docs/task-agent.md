# General task execution

TaskAgent connects one caller goal to an injected decision provider and execution host. It observes the page, asks the provider to choose from current operations and value references, checks policy, executes through Kriya, and observes the resulting state. `DONE` proposes completion; a fresh observation, action postconditions and an independent completion decision must pass the completion gate.

Local control values cannot prove a lasting write. When changed controls remain in the document that performed a commitment, the gate requires an independent saved-state observation or caller verifier; a success message is insufficient. A remote transport can opt into `refresh({ url, allowedOrigins }, call)` to GET its current authorized view without resubmitting a POST. The remote host advertises `freshStateObservations` only alongside authoritative location support, validates the latest observation scope, and checks that the bridge really reports a new document at the same URL. The coordinator uses this capability only with NAVIGATE authorization. Applications whose current view cannot safely be read this way should use an authoritative verifier. Freshly loaded controls still have to satisfy their postconditions and the completion decision.

```ts
import { createTaskAgent, createRemoteTaskHost, createTypeSafeTaskDecider } from '@juspay/kriya';

const host = createRemoteTaskHost({ transport });
const agent = createTaskAgent({
  host,
  decider: createTypeSafeTaskDecider({ apiKey: () => process.env.TYPESAFE_API_KEY ?? '' }),
});
const result = await agent.run({
  goal: 'Fill my shipping details and open the order review.',
  expect: { answer: false },
  inputs: { profile },
  authorization: { origins: [testApplicationOrigin], effects: ['form_submit'] },
});
```

Inputs supply data. The caller supplies no route, selector or action sequence. Jev selects among offered choices and cannot generate missing text. Missing data returns `needs_input`; `completed`, `blocked`, `awaiting_approval`, `failed` and `cancelled` are distinct outcomes. Use `expect.answer: false` for a state-change goal, `true` for a question, or omit it to permit an inferred answer. An informational task may complete with a `NO` answer.

The TypeSafe decider advertises `supportsRequirements`. Before execution, the coordinator assesses which observed fields and form activations the goal requires. Once a control is assessed required, its requirement is independent of the executed action ledger; skipping its execution cannot remove that completion check. Applicability remains a model judgment and can be wrong. Required unavailable data can remain pending while known fields and dependent controls advance; an unrelated field is withheld. `KEEP_CURRENT` preserves an observed value, and `REQUIRED_UNAVAILABLE` identifies a needed value absent from the offered candidates. Low-confidence assessments are retried within the existing budgets. Custom deciders can opt into the same contract; without it, their existing behavior is preserved.

Native radio groups are assessed once as a mutually exclusive choice. The model chooses an observed member or a fixed sentinel; code derives the sibling expectations without issuing unsupported radio-uncheck commands. Actual control identities preserve distinct controls even when labels or values repeat. Accessible fieldset and ARIA group context accompany field judgments.

A selected requirement argument and its confidence can be reused when that exact reference is still offered for the same operation. The coordinator rebuilds the candidate pool and repeats compilation, binding, policy and strict execution checks; it does not ask the model to guess the same value again. Once a lasting write has satisfied the observed requirements, the coordinator may attempt the independent saved-state gate before asking for another action. Completion still requires the model verifier and every local gate.

For action tasks, completion sentences and comma-separated clauses are judged separately in one Jev request, with the full original goal retained as context. Every operational clause must be SATISFIED. A real `CALLER_CONTEXT_ONLY` Choice can establish that a clause gives only a personal reason or relationship, with no website action, quantity, state or constraint; that decision keeps its actual confidence. Confidence is the minimum across all clause decisions. Overflow clauses are combined rather than dropped. Code separately checks field requirements, postconditions, persistence, uncertainty and evidence grounding. Read-only questions retain their whole-goal judgment. No route or application-specific success text is built into these checks. For deciders that support requirement assessment, a rejected completion proposal temporarily withholds DONE for the same document, fingerprint and collected evidence. Another supported action must provide observable progress before the identical proposal is offered again.

Completion receives current goal controls and resulting record text before historical context. A matched supplied-input fill followed by actual same-form submission can carry `preparationBasis: 'matched_supplied_input_submission'`. This records checked preparation and dispatch without exposing private data; it does not prove the resulting data was saved. Observed checked controls in the pre-execution submission snapshot likewise preserve requested consent context. `submittedControls.preservedValue` can carry an exact, non-sensitive, untruncated original field value under a matching KEEP_CURRENT requirement. These are observed preparation facts, not proof of the serialized payload or persistence; final record evidence remains required.

The completion projection also exposes typed `verifiedPreparationFacts` and `preservedOriginalValueFacts`. These restate checked source matching, redaction, submission attempts and pre-submission preservation in direct terms for the decision model. They do not assert payment capture, payload contents or persistence. A requested test purchase expects simulated payment, while an ordinary purchase still needs its requested resulting state. Cached peripheral assessments can be reconsidered after a later main-form submission; reassessment uses the current evidence and a real decision.

Completion-only `verifiedCurrentGoalStates` makes satisfied checked-state requirements explicit alongside the current observed value and independent-read flag. These are individual condition matches, not a whole-task verdict; all clauses, evidence grounding and persistence gates still apply. Negative and unchanged constraints remain relevant requirements. Actual native option-group labels are available as context, and a verified parent SELECT change can re-assess unavailable public SELECT siblings in the same form without clearing missing text data.

Submission context can also retain a required KEEP_CURRENT checked state and the observed enabled choices of a required public select. Choice inventories carry truncation information and do not claim to enumerate every website alternative. These observations support preservation and comparison judgments alongside a matching resulting record.

The browser endpoint is installed once per document with `installTaskBridge()`. A Node or extension transport reinjects it at document creation and keeps the coordinator outside the page realm. `createAutomationTaskHost({ executor })` supports an existing engine in the current document; its capability flags describe that document's lifetime. `createRemoteTaskHost({ transport })` survives full navigation and checks the controller's authoritative location before execution. The TypeSafe credential remains in Node; the page receives only the command it is authorized to execute.

Routine actions run within the caller's origin and operation scope. External commitments use an explicit effect grant or return a concrete `awaiting_approval` result. Resume echoes that approval's id, nonce, command digest and context digest. The agent reobserves and compares the reviewed context, then consumes the approval before dispatch. A changed document, target, argument or review context requires a new decision or approval. Enter and other equivalent submission effects follow the same policy.

Commitment classification sees the actual target, its form relationships, submit controls and nearby value-free passages. Forward/reverse judgments that identify two different concrete commitment classes require grants covering both effects. An uncertain NONE or unknown commitment still fails closed. A preparation action and a later form submission are classified separately.

Strong agreement on NONE keeps its minimum confidence at the configured commitment floor. A separate binary Choice supplies a fallback for diffuse agreement below that floor. A possible effect in the applicable fallback remains `other_commitment`; a concrete class from either class judgment cannot be overridden. The commitment floor is unchanged.

A transient commitment-classifier failure gets at most one additional read-only decision attempt, within the existing cancellation, wall, model-call and failure budgets. Only retryable network/timeouts, 408, 429 and 5xx are eligible. Invalid answers and authorization failures are not retried; an execution is never retried by this mechanism. If independent completion verification is unavailable, `done_gate` reports `DECIDER_UNAVAILABLE` without counting a semantic premature-DONE judgment.

The default TypeSafe transport permits two retries, or three physical HTTP attempts per send.
The conservative default composition is two coordinator invocations × up to two adapter sends
(including weak-presence confirmation) × three HTTP attempts: at most twelve physical sends
for that classification path. A coordinator timeout can interrupt confirmation and start its
additional invocation; this is why the returned-transient-error path alone understates the bound.
This is code-derived, not a live measurement, and cancellation/deadlines can shorten it.
The coordinator model-call budget counts decider invocations. The HTTP recorder is authoritative
for complete physical-send accounting; a returned exchange can retain the first result when
confirmation fails. Other configured retry limits need their own bound. Execution is not retried.

Empty requirement, validation and group candidate lists retain `KEEP_CURRENT`, `REQUIRED_UNAVAILABLE` and `NONE_APPROPRIATE`. Byte fitting retains at least one real candidate when supplied candidates exist; an oversized minimal question fails before HTTP rather than presenting supplied data as absent. Ordinary empty argument requests retain their refusal behavior.

When a caller uses an argument floor below 0.5, a weak judgment that rewrites an existing value
requires an additional actual agreeing sample. An earlier deferred low-confidence sample cannot
consume that confirmation; an unavailable confirmation leaves the requirement uncertain. Calls
remain within the normal budgets. Two agreeing wrong judgments remain possible, so this protects
the confirmation boundary rather than proving semantic correctness.

Optional diagnostics do not change decisions or gates:

```ts
const decider = createTypeSafeTaskDecider({
  apiKey: () => process.env.TYPESAFE_API_KEY ?? '',
  captureProbabilities: true,
  confidenceProfile: {
    kind: 'vendor_reported',
    calibrated: false,
  },
});
const agent = createTaskAgent({ host, decider });
const result = await agent.run({
  goal,
  options: { captureProgressDiagnostics: true },
});
```

Validated exchanges can retain the complete offered-choice distribution, selected and runner-up probabilities, margin, normalized entropy and NONE mass. These are numerical observations, not calibrated correctness. Explicit confidence profiles copy provider semantics and optional default floors at construction. Request profile, configured run and per-run confidence overrides retain precedence. Results report effective floors, and uncalibrated profiles emit `UNCALIBRATED_DECIDER`. Resume never lowers saved floors. A prefix match or `calibrated: true` caller assertion is not independent provider acceptance.

Shadow progress counters distinguish control-state changes from cosmetic page text changes and count revisited states. They restart on resume and report `scope: 'active_segment'`; they never change no-progress budgets, recovery, policy or completion evidence. The default result shape and confidence floors are unchanged when these options are absent.

Form submitters are withheld for active native validation failures. Compilation also rejects submission through Enter with `FORM_INVALID` before requesting or consuming an approval. Native constraints disabled by `novalidate` do not trigger this preflight; application errors remain separate observed evidence. Server validation remains separate: valid browser controls can still be rejected by the application. After an actual submission, a visible application error bound to an empty field can trigger a focused `validation` assessment. The model decides whether resolving that error belongs to the requested workflow and selects an offered input reference or reports missing data. A request to test the rejection does not authorize correcting it. Native `novalidate` disables browser enforcement; authored required metadata and real application errors remain decision evidence.

```ts
const resumed = await agent.resume({
  checkpoint: result.checkpoint,
  resolution: { kind: 'approval', resolution: callerApproval },
  inputs: sensitiveInputs,
});
```

Checkpoints omit sensitive input leaves. Supply them again on resume or explicitly mark their paths unavailable. Checkpoints contain other caller data and should be stored as personal information. By default only the issuing agent instance can resume its checkpoints. Cross-process continuation needs a private `checkpointKey` and a durable `consumeApproval` hook to prevent approval replay. Checkpoints carrying `priorEffects` require the issuing agent instance and fail closed elsewhere.

Sensitive inputs require an input declaration and an allowed binding. Sensitive candidate views carry opaque references; the coordinator materializes a value after policy allows the command. Observations, events, ledger entries, checkpoint contents and transport traces are scrubbed. A transport must use `redactEnvelope` when recording commands and must never record a raw execute payload.

Cancellation propagates to observation, decision and execution. `lastEffect` records `none`, `applied` or `uncertain`. Uncertain lasting changes, sensitive fills and same-document commands are excluded from automatic retries. A pure preparatory fill can proceed in a later authoritative allowed document only when a unique non-sensitive field lacks the required value and the same confident reference remains offered. A caller can resolve other uncertain effects from independently checked state on resume. Engine success alone does not prove completion or persistence.

The executor adds strict target, checked-state, select, scroll and press parameters and corresponding error codes. Existing command entrypoints remain available. `executeAction` now fulfills with a structured failure result instead of rejecting for action failures; callers should inspect the returned success/error fields. ReScript action and error variants include the additions.

`createResearchRequest(question)` applies the restricted read/navigation/scroll/wait profile. `toResearchResult(result)` maps it to the existing research result shape. The existing ResearchGuide and click guide remain available.

Run the local demonstration with the private env file loaded by Node:

```sh
node --env-file=/path/to/private.env examples/task-agent.mjs
```

The example uses the controlled settings application, real Chromium, Jev and the package bundle. It opts into rendered offscreen controls and explicit action/argument/completion confidence floors of 0.2/0.3/0.6. The library defaults remain 0.5/0.6/0.75; the commitment floor remains 0.5. See [the e2e harness](https://github.com/juspay/kriya/blob/main/e2e/README.md) for scenario selection and evidence, and [the normative contract](task-agent-contract.md) for the host, resolver, approval and verification details. Verification status is tracked separately in [task-agent-status.md](task-agent-status.md).
