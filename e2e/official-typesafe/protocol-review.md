# Official TypeSafe protocol review

Reviewed 2026-10-04 using the installed [TypeSafe skill](https://github.com/typesafe-ai/skills/blob/65a39f393687675ce170e6094757de20370365b9/skills/typesafe-ai/SKILL.md) and current official pages discovered through [llms.txt](https://docs.typesafe.ai/llms.txt). This is documentation verification and experiment design. No credentials, model calls, source changes, builds or runtime correctness claims.

## Wire fields and typed meanings

`POST https://api.typesafe.ai/v1/systemone` takes required `state`, `model`, and `questions`. `state` is string/object/array; `questions` maps application IDs to questions containing `type`, `instructions`, and primitive-specific `criteria`. The response contains resolved `model`, matching `answers` IDs, and `usage.input_tokens` / `usage.output_tokens` integers. Question IDs are returned unchanged but withheld from the underlying model; instructions must carry the complete question. Authentication belongs on the server. [API reference](https://docs.typesafe.ai/api)

| Primitive | Request fields                                                                                    | Answer fields                                            | Interpretation                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Choice    | `type: "choice"`; `instructions`; required `criteria` map from option identifiers to descriptions | `type`, `choice`, `probabilities`, `confidence`          | `choice` selects the highest-probability option; distribution keys are the supplied identifiers and sum to one.                   |
| Noul      | `type: "noul"`; `instructions`; optional `criteria` with `true` / `false` descriptions            | `type`, `noul`                                           | `noul` is the yes probability in [0,1]. There is no separate confidence field.                                                    |
| Score     | `type: "score"`; `instructions`; required ordered `criteria` array                                | `type`, `score`, `legend`, `probabilities`, `confidence` | `score` is the probability-weighted level index, possibly fractional. Wire legend/distribution indices are strings such as `"0"`. |

Field shapes and primitive semantics: [Choice](https://docs.typesafe.ai/primitives/choice), [Noul](https://docs.typesafe.ai/primitives/noul), [Score](https://docs.typesafe.ai/primitives/score).

Choice option identifiers **and** descriptions are model-visible; opaque `t17` therefore needs a description containing the target's actual meaning. A null Choice description is useful only when its identifier communicates that meaning. Question-map IDs such as `completion` do not supply semantics. Independent effects can overlap: separate Nouls avoid forcing mutually exclusive classification. Noul near 0.5 indicates uncertain truth, not halfway intensity. [Choice](https://docs.typesafe.ai/primitives/choice), [Noul](https://docs.typesafe.ai/primitives/noul)

Score levels are evaluated separately: their positions and neighboring levels are not visible to the evaluator. Every level needs a complete concrete description; relative phrases and bare numbers fail to define the judgment. One dimension per Score, with deterministic arithmetic and aggregation in code. The same expected score can conceal opposing distributions. [Score](https://docs.typesafe.ai/primitives/score)

Structured instruction/rubric objects can name compared paths, definitions, inclusions, exclusions and examples. The Advanced page accepts string/object/array/null for instructions, Choice values, Score entries and Noul true/false values. **Unresolved documentation seams:** API reference explicitly lists null only for Choice values; its Score legend schema says string values while the Score structured-rubric example returns object values. Root should probe these positions individually before broadening a production parser. [Advanced structure](https://docs.typesafe.ai/primitives/advanced), [API reference](https://docs.typesafe.ai/api), [Score structured examples](https://docs.typesafe.ai/primitives/score)

## Distribution and confidence

For probabilities `p_i`, option/level count `n`, and modal level `m`, current documented calculations are:

```text
Choice C = (max(p_i) - 1/n) / (1 - 1/n)
Score S  = sum(i * p_i)
Score C = max(0, 1 - sum(p_i * abs(i-m)) / U)
U = sum(abs(i - (n-1)/2)) / n
Noul optional application-derived certainty = abs(2*noul - 1)
```

Choice uses only the maximum probability and option count, not entropy: `(0.6,0.3,0.1)` and `(0.6,0.2,0.2)` both yield 0.4. Score also measures distance between levels. Derived example: Choice confidence 0.48 means top probability 0.74 with two options but 0.545 with eight. Preserve the full distribution; compare top probability and top/runner-up ratio empirically. Define zero-denominator and tie behavior in code. Confidence is a distribution statistic, not independent proof of truth, authorization or persistence. Thresholds require domain and risk calibration. [Confidence](https://docs.typesafe.ai/confidence), [Score](https://docs.typesafe.ai/primitives/score)

## Independent questions and evidence

Each question sees the same state independently; another answer in that request cannot become its context. Explicitly conditional speculative questions can be batched, then code consumes only the applicable branch. A dependent question needing newly fetched evidence needs a subsequent request. Independence of evaluation does not establish statistical independence, so multiplying answer probabilities requires additional justification. [Primitives and batching](https://docs.typesafe.ai/primitives)

Use structured state separating actual observations, freshness and source identity from desired outcome. Name relevant nested paths directly. Include sufficient local context without irrelevant full-page material. The current text-only model cannot inspect screenshot pixels. [State](https://docs.typesafe.ai/concepts/state)

The citation cookbook performs normalized quote matching in code first, then sends `{claim, section}` to a three-way Choice: support, contradiction or no coverage. A matching quote alone proves neither support nor truth. Its published eight-case result uses Jev 1.12 and cached 2026-08-16 calls; its 0.8 review threshold is an example, not a guarantee for Jev 1.13 or browser completion. [Citation checking](https://docs.typesafe.ai/cookbooks/citation_check)

Suggested shadow design, not an implemented guarantee: independently judge each explicit claim against its chosen passage and complete local context. Keep target/evidence ID existence, freshness, origin/authorization, exact checked/value equality and numeric predicates deterministic. Distinguish requested local UI state from evidence of persisted state. A checked box or generic success notice cannot manufacture unavailable backend proof; missing evidence must remain unknown. Aggregate atomic outcomes in code, retaining contradictions and uncertainty. These are proposed safety constraints inferred from the documented pattern, not claims that the model enforces them.

## Current limits and bounded experiments

As published today: Choice supports up to 255 options; Score accepts 2–10 levels. Jev 1.13.0 has 64k tokens for state plus all questions and a separate 32k budget for state plus the longest question. Published rates are 100k tokens/second and 80 requests/second, explicitly subject to change. `jev-latest` and `jev-preview` currently resolve to Jev 1.13.0; record response `model` and pin versions for calibrated experiments. [Choice](https://docs.typesafe.ai/primitives/choice), [API reference](https://docs.typesafe.ai/api), [Models](https://docs.typesafe.ai/models)

Jev 1.13 jaggedness documents literal boundaries, weak exact arithmetic, irrelevant-context degradation, option-order bias and adversarial-content susceptibility. Keep arithmetic in code, make criteria explicit, test shuffled options and hostile text. These are version-specific observations, not permanent capabilities or hard security barriers. [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

Root's isolated experiments should retain unprojected responses and compare against independent expected labels:

1. Probe plain/structured Choice, Noul and Score, then nullable positions and structured Score legend individually. Validate exact IDs, type tags, finite ranges, distribution keys/sums, resolved model and formula consistency.
2. Rename only question IDs versus rename only option identifiers; compare single versus batched independent questions. Repeat or compare distributions rather than assuming sample identity.
3. Shuffle option order; test explicit neutral opener versus committing action criteria, with complete descriptions and no authority inferred from label text.
4. Check atomic claim/context pairs for supported, contradicted, missing and generic-success evidence. Include a requested local change with absent persistence evidence; never insert private assertion/backend truth into production-visible state.
5. Compare concentration confidence, top probability and runner-up margin on labeled baseline and held-out cases. Report false completion, unsafe approval and unnecessary abstention separately; a raised confidence alone does not establish improvement.

No experiment above was executed in this review. Nullable protocol acceptance, parser compatibility, calibration gains and browser-task accuracy remain unproved until root's live probes and independent scenario checks land.
