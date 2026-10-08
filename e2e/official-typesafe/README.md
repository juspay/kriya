# Official TypeSafe skill and field experiments

The official `typesafe-ai` skill is installed globally for Codex at `~/.codex/skills/typesafe-ai/`. It will be discovered on the next turn; this turn applied its instructions directly. Installation is pinned to `typesafe-ai/skills` commit `65a39f393687675ce170e6094757de20370365b9`. [Official repository](https://github.com/typesafe-ai/skills), local installation/baseline receipt `e2e/official-typesafe/baseline.json`.

The skill requires current primary docs. Its useful distinctions are: Choice selects an option; Noul returns a yes probability; Score returns a probability-weighted level. Question IDs are withheld from the model, so instructions must state the judgment. Choices expose their option IDs/descriptions. Questions in a batch cannot see each other's answers. Confidence measures concentration of the distribution, not correctness of an entire workflow. [Skill source](https://github.com/typesafe-ai/skills/blob/65a39f393687675ce170e6094757de20370365b9/skills/typesafe-ai/SKILL.md), [API](https://docs.typesafe.ai/api), [confidence](https://docs.typesafe.ai/confidence), [state](https://docs.typesafe.ai/concepts/state).

## What was tested

The experiment made **65 real HTTP calls**, all HTTP 200, all resolved to `jev-1.13.0`. Mixed Choice/Noul/Score requests work. Noul responses contain `type` and `noul`, with no provider confidence. Score returns fractional `score`, `probabilities`, `confidence` and `legend`; structured rubric objects survive as object-valued legend entries. The API reference's string-only legend declaration does not describe that observed shape. Nullable instruction/rubric positions were not tested. [Noul](https://docs.typesafe.ai/primitives/noul), [Score](https://docs.typesafe.ai/primitives/score).

Two shadow replay trials used eight recorded final observations: four independently rejected false completions (missing apartment, missing phone, missing outdoor filter, missing kitchen filter) and four independently accepted completions. The corpus came from `continuation-final-20261004-c`. Outcome labels and backend assertions were not sent to the model. Goals, public caller values and recorded observations were preserved. Sensitive caller values were excluded or remained opaque.

| Question form                                                       | Valid outcomes accepted | False completions accepted |
| ------------------------------------------------------------------- | ----------------------: | -------------------------: |
| Existing Choice questions, trial A                                  |                     4/4 |                        4/4 |
| More explicit Choice instructions, trial A                          |                     4/4 |                        4/4 |
| Indexed atomic Noul checks with Score evidence diagnostics, trial A |                     0/4 |                        0/4 |
| Existing Choice questions, trial B                                  |                     4/4 |                        4/4 |
| More explicit Choice instructions, trial B                          |                     4/4 |                        3/4 |
| Direct structured comparison criteria, trial B                      |                     0/4 |                        0/4 |

The atomic composition deliberately abstains on uncertain applicability or support (yes >= 0.9, unrelated <= 0.1). It removes false completion by also withholding every valid case. **That is not a practical accuracy gain and was not adopted into TaskAgent.** The single different explicit-Choice answer is insufficient evidence of a gain: the trials did not hold inference randomness constant, were small and reused the same eight cases. No held-out browser campaign or production improvement is claimed. Local trial receipts: `e2e/evidence/typesafe-fields-20261004-a/summary.json` and `e2e/evidence/typesafe-fields-20261004-b/summary.json`.

Atomic checks exposed uncertainty that the aggregate SATISFIED verdict hid. However, whole-goal Nouls remained weak even for correct outcomes, and uncertain relevance judgments caused excessive abstention. Recorded state lacked some starting facts and independent saved-state evidence. A new primitive cannot supply those facts. Scores are useful evidence-strength/ranking diagnostics; averaging them must not compensate for a missing required field or authorize an effect.

## Field usage that is supported by this work

- Use **Choice** for offered operation/target/value references. Keep complete candidate descriptions and a no-match outcome. Expose candidate coverage when lists are shortened; missing from a shortlist is not missing from caller data.
- Use **Noul** for a narrow supported/contradicted condition over named facts, with uncertainty preserved. Do not turn a broad whole-goal Noul into an unchecked completion flag.
- Use **Score** for a single graded dimension with complete standalone levels. Preserve the full distribution and structured legend. Score is a weighted position, not the most likely level or a boolean.
- Preserve **probabilities**, selected probability, runner-up margin and concentration separately for diagnostics. No confidence threshold or approval policy was changed. For Choice, `C = (p_max - 1/n)/(1 - 1/n)`; changing option count changes the relationship between C and p_max.
- Put explicit question meaning and branch premises in **instructions**; keep actual page/caller values as **state/criteria data**. Evidence slots need distinct requirement meanings: duplicate opaque IDs do not create independent semantic checks.

The immediate source work order is in [adapter-audit.md](adapter-audit.md): retain probability diagnostics; preserve KEEP_CURRENT/REQUIRED_UNAVAILABLE with empty requirement candidates; report candidate coverage; and judge citations against individual requirements with their evidence uncertainty. These are concrete reproduced construction/parsing gaps. Primitive/parser guidance and limits are in [protocol-review.md](protocol-review.md).

## Reproduction and boundaries

```sh
node e2e/official-typesafe/primitives.selftest.mjs
node --env-file=/path/to/private.env \
  e2e/official-typesafe/probe.mjs NEW_RUN_ID
node --env-file=/path/to/private.env \
  e2e/official-typesafe/probe.mjs ANOTHER_NEW_RUN_ID --focused
```

Credentials are only loaded by Node's env-file mechanism and consumed by the Node HTTP sender. Evidence is stored under the already ignored `e2e/evidence/`; IDs cannot overwrite old evidence. Requests are bounded below the previously proven 39,953-byte ceiling, and only transient network/408/429/5xx failures retry, at most twice. Every question carries the literal goal. Raw judgments and local distribution/request diagnostics (`e2e/official-typesafe/diagnostics.json`) remain available; no result was projected into success.

This is **shadow replay over saved observations**, not browser task execution. This work made no host operation, Kriya production-source edit, approval grant, source build, commit, push or PR. Current disk has additional unbuilt requirement-tracking work; the local `e2e/official-typesafe/baseline.json` receipt records the mismatch with its saved bundle receipt. Production source also changed during this experiment, as recorded in the local `e2e/official-typesafe/final-state.json` receipt; those concurrent edits were not overwritten. The historical trial summaries' `productionSourceChanged: false` flags describe the probe's own writes, not a frozen-workspace claim. All 61 protected files still match the inherited manifest.

Both trials parsed every returned primitive successfully. Parser/composition checks cover valid wire shapes, malformed distributions, object-valued Score legends, missing answers, wrong model/type and missing paired evidence. Known credential/long-value artifact scans returned zero hits; their counts include repeated registered values. No browser or screenshots were used, and short-value/pixel secrecy is not claimed from byte scans. Nullable protocol shapes, broader candidate limits and new completion thresholds require their own evaluation before adoption.

## Browser-reference follow-up

The official skill repository, Jev Ultrafast and fastbrowse are now cloned and locally set up in `a local reference-lab checkout`. Their loop, browser, evidence and evaluation mechanisms were traced with pinned source and bounded coverage. The central improvement register (`IMPROVEMENTS.md` in the local reference-lab checkout) retains 15 candidates and separates existing Kriya features from proposed or tested transfers.

A narrow follow-up Noul relevance shortlist recovered five omitted semantic candidates in five synthetic cases, using 15 real Jev calls. This tests candidate coverage, not the broad completion judgments above. It does not change those negative atomic-completion findings or establish a TaskAgent accuracy gain. Local browser guards, repository test suites and one read-only live smoke per navigator are recorded separately in the reference-lab setup report (`README.md` in that local checkout).

These local receipts and reference checkouts are not part of a fresh repository clone. The
[hosted reference findings and evidence](https://chatgpt.com/space/page_aa0d3f2ebba88191b422acec93bfe748)
provide the browser-visible review destination; local paths above identify preserved evidence
rather than repository download links.
