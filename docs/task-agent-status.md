# TaskAgent status

## Consolidated closeout (8 October 2026)

The dependency refresh and scoped independent-view clarification passed 55 suites / 3,913
unit tests. One frozen campaign passed 43/43 ordinary live scenarios and 8/8 labelled fault
scenarios. Its independent audit checked 1,808 physical provider attempts and
4,189 question attempts, with zero literal-goal mismatches, reported-model
mismatches or credential hits. Three provider attempts were unsuccessful; the saved evidence
retains them. Source SHA256: `bcf2c83ab267f33d3193d07d508bc6c6f66de2e9f32e5af725fa5286d7fc4d07`; ESM/UMD pair:
`157fa5b5a520ca7df00049fab4da11750545ad49662d7b71240e932a8ca671f6`.

This is one successful controlled-app campaign, with the caller confidence floors documented
below. Earlier recorded campaigns failed and remain preserved. Public Wikipedia and Selenium
have successful recordings on an earlier build and blocked later reruns. The compound TodoMVC
task requires the labelled caller visibility/ARIA adapter and one bound synthetic approval;
the unadapted task blocked safely. These demonstrations do not establish arbitrary-site accuracy.

Documentation generation now uses an isolated generated API directory and strict MkDocs,
including an authored homepage. Chromium transport controls separately verify cancellation,
exact URL scope including hash changes, GET-only refresh, no POST replay and redirect refusal.
The final hash-race refusal was added after the frozen campaign and verified by those controls;
no library source changed afterward.

The production dependency audit has zero findings. The development audit retains 14 findings
(12 high, 2 moderate), including an unpatched brace parser and bundled npm dependencies.
Version 2.2.0 was subsequently published on 9 October 2026; its public npm tarball passed consumer and Chromium smoke checks and matches the accepted ESM/UMD pair above. A real Perplexity campaign has not run. Current delivery and videos:
[hosted closeout artifact](https://chatgpt.com/space/page_aa0d3f2ebba88191b422acec93bfe748).

## Reliability follow-up checkpoint (8 October 2026)

The follow-up frozen package passed 55 suites / 3,913 tests, strict source/test types, source/test
lint and the package build. Its full campaign passed 43/43 ordinary live scenarios and 8/8
labelled faults on one run. A targeted quantity regression also passed. Source SHA256:
`369a4047455759294fb069abddefabb589dab6700183feb8de60342dd1c0c734`; ESM/UMD pair:
`7dd0e96959e75e260ce93dbeb035b3d41cd68a0302ad6f10ee8dc28b273a941c`.

The predecessor follow-up package passed 42/43 live plus 8/8 faults and exposed an unconfirmed
existing-value rewrite. Its failed run is retained. New task combinations passed only 1/4 on
each of their first two runs. Fixture authorization and visible inventory evidence were corrected;
remaining semantic uncertainty and timeouts are not waived. These cases are development evidence
after their failures are used to make changes; they do not establish general accuracy.

The follow-up implements bounded classifier retries, unavailable-verifier gate events, empty
candidate semantics and mandatory weak-rewrite confirmation. Probability/profile and progress
diagnostics are opt-in. Release formatting is tested locally at generation time; an actual release
and any new provider's live acceptance remain separate gates. The historical receipts below belong
to their original packages, not this follow-up.

Acceptance evidence is in [`e2e/acceptance/`](https://github.com/juspay/kriya/blob/main/e2e/acceptance/README.md). Its README lists every run with its package, result, Jev call count, 10-second aborts and the host load while it ran, and it names the cause of every failed scenario. The figures are computed from the saved run summaries by a script.

## What was verified

- **Original pre-merge package (`ap-premerge`).** Safety nine 9/9, all 30 target scenarios 30/30, and the full 51 (43 live and 8 labelled fault injections, every injection fired) 51/51 on one frozen package. A second pass of the same package was 30/30 and 50/51.
- **Merged package (`aq-merged`).** The branch was merged with `origin/main` PR #49 (scoped automation roots and location providers). `src/agent/` is byte-identical to the pre-merge package; nine DOM, executor and form files differ. The same gates were run again on a new frozen build. See the acceptance README for the exact results and what the failed runs were.
- **Local checks on the merged tree.** Strict source and test TypeScript, zero-warning ESLint, Prettier, 48 Jest suites and 3,739 tests, and all 61 protected starting hashes, with one recorded exception for `README.md` (the upstream merge).
- **Also run.** Real Chromium engine, navigation and bridge proof, a ten-export package receipt, and an evidence audit of every scenario (expected ids, literal goals, pair hashes, API key and long-secret scan).

## Run profile

Caller floors: action 0.2, argument 0.3, completion 0.4, against library defaults of 0.5, 0.6 and 0.75 (no run on the default floors is recorded); commitment 0.5 is the unchanged library default. Observation renders offscreen controls. At most two browser contexts and three concurrent Jev calls. Original goals, fixture apps, backend and UI assertions, grants and library defaults are unchanged, and no red assertion was waived.

## Known limits

- **Historical classifier gap.** In the original acceptance package, a commitment-classifier timeout (10 s) failed closed and asked for approval without retrying. Six of its eight failed scenarios were this case on a heavily loaded shared host; the others were a near-tie completion answer and a model-variance block. The current follow-up permits one additional attempt for a retryable transient read-only classifier failure, within the existing call/failure/wall/cancellation budgets. Invalid responses and non-transient authorization failures are excluded; exhausted classification still fails closed. The current frozen campaign and earlier failed runs are documented above.

- **Run-to-run variance.** Model judgments near the confidence floors vary, so one passing run is evidence rather than a guarantee. The recorded second pass of the pre-merge package shows one such miss.
- **Many-clause completion requests.** Requests with ten or more clauses can approach the request byte budget, and page text is trimmed last.
- **Surfaces not supported.** Iframes, canvas UIs, `contenteditable`, file inputs and drag and drop are not offered as operations (see the contract).
- **Not proved.** Screenshot pixel secrecy is not established by byte scans, and a secret that a page masks or re-encodes would not be caught by them.

## Where to look

- Design and public contract: [task-agent-contract.md](task-agent-contract.md), [task-agent.md](task-agent.md).
- How to run the live harness: [e2e/README.md](https://github.com/juspay/kriya/blob/main/e2e/README.md).
