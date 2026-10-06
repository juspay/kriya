# Current TypeSafe adapter audit

Read-only audit, 2026-10-04. Official installed skill: `~/.codex/skills/typesafe-ai/SKILL.md`. Current official [documentation index](https://docs.typesafe.ai/llms.txt) read, then targeted pages linked below. Markdown page fetches failed in the browser tool; the corresponding normal official pages succeeded. No live inference, credentials, installation, build, production edit, or campaign rerun.

Snapshot: `src/agent/request.ts` SHA256 `aa89cbf59e086c011516d23e0f5498878feffe26955baca0532451602e21820f`; `src/agent/typesafe.ts` SHA256 `0f295e9de380c5174ef5df4747eba489c7b45586f7da08431d5066754cf959a7`. The current saved build receipt reports verified bundle pair `51bc90a0ea92ff48d6c5a7782126658a638a32c27eed00f9f371a8f0710a59a8`. This audit evaluates source on disk, including continuation changes, rather than treating that bundle receipt as source-quality proof.

## Prioritized opportunities

### 1. Make each evidence question about a distinct requirement, and retain evidence uncertainty

**High priority; construction and parsing reproduced offline.** `src/agent/request.ts:1392-1418` gives every evidence slot the same goal and EVIDENCE_RULES over the same candidate set. Rotation changes option order, but slot 1 versus slot 2 has no semantic definition. `src/agent/typesafe.ts:1141-1150` removes NONE_APPROPRIATE, deduplicates IDs, and assigns only the verdict confidence; it does not consume evidence-question confidence.

Official [question guidance](https://docs.typesafe.ai/primitives#define-a-question) states that IDs are code bookkeeping and the model does not see them. [State](https://docs.typesafe.ai/concepts/state) and [fan-out](https://docs.typesafe.ai/patterns/fan-out) say questions evaluate shared state independently. Consequently, evidence_2 cannot see evidence_1 and cannot implicitly mean “another requirement.” The [citation cookbook](https://docs.typesafe.ai/cookbooks/citation_check) distinguishes a present source from a source that actually supports a specific claim.

**Observed:** with rotation disabled, the two generated evidence questions are deeply identical. An injected valid Choice response with a flat evidence distribution (confidence 0), SATISFIED confidence 1, and a selected evidence ID produces a decision that cites that ID and retains verdict confidence 1. This proves adapter behavior, not a completed TaskAgent result; controller freshness, local gates, and independent verification remain separate.

**Small next experiment:** use two supplied requirements (for example contact saved and delivery option saved), with one complete and one incomplete record. Build one evidence-selection question per requirement, stating its claim directly, or use one independent supports/contradicts/insufficient judgment per requirement over named state fields. Measure coverage of both requirements and false SATISFIED versus current identical slots. Preserve UNCERTAIN, raw ledger effects, strict backend assertions, and authorization gates. Define and validate what to do with weak evidence confidence rather than silently treating a citation as reliable. A later new-state request is justified only if earlier answers are needed to fetch or construct evidence.

### 2. Point each judgment at the exact current fields and distinguish historical evidence

**Medium priority; source-supported design improvement, not a measured model gain.** The adapter already gives target questions an explicit operation (`request.ts:950-961`) and argument questions an operation, slot, and target ID (`1060-1078`), so it does not rely solely on question IDs for those meanings. However, most instructions concatenate broad rules and refer generically to “current page,” “recent actions,” or “supplied data.” The model receives separate `task`, `page`, `initialPage`, `elements`, `inputs`, `recentActions`, `goalRequirements`, `expected`, and `collectedEvidence` fields (`740-765`, `1430-1434`).

Official [specific-field guidance](https://docs.typesafe.ai/primitives#reference-specific-fields) recommends backticked dot/index paths. [State guidance](https://docs.typesafe.ai/concepts/state) recommends descriptive JSON fields with explicit relationships.

**Opportunity:** target instructions can explicitly say “Assuming the next operation is FILL, which offered control advances `task` using `inputs` and the current `elements`?” Argument instructions can point to the selected element's actual array index, its label/current value, and input descriptions. Completion can say that `page` and `elements` are current observations, `initialPage` is a baseline, `recentActions` describe attempted actions, and `expected` entries are obligations to compare, not independently verified facts. Avoid telling evidence questions to condition on another same-call answer.

**Small next experiment:** two otherwise identical controls in main checkout and footer signup, plus a completion record where initial data are correct but current data diverge. Compare explicit field paths/premises against current templates on a small labeled set. Keep literal goal exactly unchanged and preserve the existing optional-supplied-value and saved-state rules (`161-175`, `224-234`). No route, app, scenario ID, or fixture-specific instruction is needed.

### 3. Expose candidate coverage and preserve requirement sentinels when no values exist

**High priority; both construction triggers reproduced offline.** `request.ts:1130-1161` reranks oversized candidate lists using exact preview/code matches and token overlap, then `1057-1103` slices values to the option limit (default 60, three reserved requirement outcomes). `1175-1198` can further reduce the list to meet byte limits. The state truncation fields describe elements/text only (`758-762`), so the model is not told that selectable argument values were dropped. Separately, `1081-1083` emits no entries when the candidate array is empty, which removes KEEP_CURRENT, REQUIRED_UNAVAILABLE, and NONE_APPROPRIATE too; finalizeDrafts drops that question (`446-460`).

Official [Choice guidance](https://docs.typesafe.ai/primitives/choice) recommends full candidate coverage where feasible and a no-match outcome. A model cannot select an omitted value. An option/byte ceiling is legitimate; an absent candidate is not proof that caller data are absent.

**Observed:** 65 candidates, desired country described through its capital Rome, and Italy at the end of the list: the default argument question offers 59 candidates plus NONE_APPROPRIATE and omits Italy. No candidate-coverage flag appears. A requirement request with zero candidates generates zero questions instead of offering its three semantic sentinel outcomes. These are direct builder probes; whether the full coordinator can produce the empty-array request was not established.

**Small next experiment:** keep all requirement sentinels even with zero concrete candidates; use empty unrelated/required/keep-existing controls as three builder fixtures. For oversized lists, count total versus offered candidates in safe request metadata, and distinguish truncated coverage from true unavailable data in code. Compare the current lexical shortlist with a bounded semantic shortlist or a wider list within actual API/byte limits on three synonym/alias fixtures. Do not increase proven byte limits blindly or infer user input is missing from an incomplete shortlist. The model has a documented 255-option limit; local size/provenance constraints still apply.

### 4. Preserve the validated distribution for calibration and branch-specific diagnostics

**Medium priority; data loss reproduced offline.** `typesafe.ts:534-564` validates probability key sets, range, sum, and selected argmax. `595` immediately retains only choice/confidence in the private Answer; `903-910` publishes only those two fields. `1027-1050` correctly consumes the selected target branch and uses its minimum confidence with operation confidence. This minimum is a conservative gate statistic; it is not a calibrated joint probability of correct execution.

Official [confidence guidance](https://docs.typesafe.ai/confidence) defines confidence as a statistic of the choice distribution and explicitly offers selected probability and top/second ratio as alternatives to evaluate on domain data. Its thresholds are examples, not universal constants.

**Observed:** a valid injected response succeeds, but no probability distribution survives into exchange answers. That prevents later inspection of whether uncertainty was among two equivalent harmless targets, a wrong neighbor, NONE_APPROPRIATE, or opposing completion verdicts. Forward/reverse commitment agreement (`1095-1122`, `1178-1197`) remains a useful order-sensitivity check; both read the same state, so agreement is not fresh evidence or independent confirmation of an external effect.

**Small next experiment:** first retain distributions in a private, secret-safe diagnostic seam without changing the public contract. Reuse a bounded labeled set of already-authorized responses to compare current confidence floors with selected probability/top-two separation by operation, target, argument, and completion. Consume only relevant branch uncertainty, keep malformed provider responses rejected, and keep commitment authorization independent of confidence. Do not lower a global floor as a substitute for missing evidence or candidate coverage. No calibration benefit has been measured in this packet.

## Current strengths and scope

- Structured Choice instructions and criteria are valid official API shapes (`request.ts:428-432`, `531-556`, `1033-1047`; [API](https://docs.typesafe.ai/api)). Literal goal appears in every question and `state.task`; the goal-preservation probe passed.
- Action operation and all available target branches are batched in one request (`request.ts:969-1010`), and only the chosen branch is consumed (`typesafe.ts:1020-1052`), consistent with speculative fan-out. Separate argument construction is justified when the selected control determines its available values.
- Current requirement/activation and continuation rules include supplied optional fields, KEEP_CURRENT, REQUIRED_UNAVAILABLE, saved-state evidence, retired expectations, and controller independent-read context. This report does not mistake an earlier campaign snapshot for those current templates.
- Parser enforces offered options and distribution validity; transport rejects goal/credential/budget violations and retries only permitted service/transport failures (`typesafe.ts:534-636`, `830-873`, `917-968`). Exhaustive HTTP, cancellation, credential, or API-discriminator testing was outside this packet.

## Executed minimal experiments

Six assertions passed, meaning the stated source behaviors were demonstrated; five demonstrate improvement triggers, not product-success claims. Existing installed TypeScript transpileModule compiled the two source modules and existing typed fixture helper into memory only, with a local module loader. The transport was an injected in-memory `http` function; no API or browser traffic, keys, environment reads, emitted files, or builds.

| Probe                        | Actual result                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| Evidence-slot meaning        | evidence_1 and evidence_2 deep-equal when rotation off                             |
| Oversized semantic candidate | Italy omitted; 59/65 offered; no candidate coverage field                          |
| Empty requirement candidates | zero questions; requirement sentinel options disappear                             |
| Weak evidence consumption    | confidence-0 evidence cited; verdict confidence remains 1; IDs deduplicated to one |
| Probability retention        | validated distribution absent from exchange answers                                |
| Literal goal                 | assertGoalPreserved returns true                                                   |

No live model accuracy, threshold improvement, end-to-end completion, or full Kriya behavior is claimed. Recommended order: evidence/requirement coverage first, exact field paths second, then diagnostics and bounded calibration. Only this report and coordinator-progress.md were written.
