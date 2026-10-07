# TaskAgent status

Acceptance evidence is in [`e2e/acceptance/`](../e2e/acceptance/README.md). Its README lists every run with its package, result, Jev call count, 10-second aborts and the host load while it ran, and it names the cause of every failed scenario. The figures are computed from the saved run summaries by a script.

## What was verified

- **Original pre-merge package (`ap-premerge`).** Safety nine 9/9, all 30 target scenarios 30/30, and the full 51 (43 live and 8 labelled fault injections, every injection fired) 51/51 on one frozen package. A second pass of the same package was 30/30 and 50/51.
- **Merged package (`aq-merged`).** The branch was merged with `origin/main` PR #49 (scoped automation roots and location providers). `src/agent/` is byte-identical to the pre-merge package; nine DOM, executor and form files differ. The same gates were run again on a new frozen build. See the acceptance README for the exact results and what the failed runs were.
- **Local checks on the merged tree.** Strict source and test TypeScript, zero-warning ESLint, Prettier, 48 Jest suites and 3,739 tests, and all 61 protected starting hashes, with one recorded exception for `README.md` (the upstream merge).
- **Also run.** Real Chromium engine, navigation and bridge proof, a ten-export package receipt, and an evidence audit of every scenario (expected ids, literal goals, pair hashes, API key and long-secret scan).

## Run profile

Caller floors: action 0.2, argument 0.3, completion 0.4, against library defaults of 0.5, 0.6 and 0.75 (no run on the default floors is recorded); commitment 0.5 is the unchanged library default. Observation renders offscreen controls. At most two browser contexts and three concurrent Jev calls. Original goals, fixture apps, backend and UI assertions, grants and library defaults are unchanged, and no red assertion was waived.

## Known limits

- **Lost classifier call.** A commitment-classifier call that times out (10 s) fails closed and asks for approval, so the run ends `awaiting_approval` instead of completing. The action decider retries a lost call; the classifier does not. Six of the eight failed scenarios in the acceptance bundle were this case, on a heavily loaded shared host; the other two were a near-tie completion answer that the adapter rejected and a model-variance block on the pre-merge package. Adding a bounded retry is a candidate follow-up and needs its own package and campaign.
- **Run-to-run variance.** Model judgments near the confidence floors vary, so one passing run is evidence rather than a guarantee. The recorded second pass of the pre-merge package shows one such miss.
- **Many-clause completion requests.** Requests with ten or more clauses can approach the request byte budget, and page text is trimmed last.
- **Surfaces not supported.** Iframes, canvas UIs, `contenteditable`, file inputs and drag and drop are not offered as operations (see the contract).
- **Not proved.** Screenshot pixel secrecy is not established by byte scans, and a secret that a page masks or re-encodes would not be caught by them.

## Where to look

- Design and public contract: [task-agent-contract.md](task-agent-contract.md), [task-agent.md](task-agent.md).
- How to run the live harness: [e2e/README.md](../e2e/README.md).

## Optional completion clause splitting

`completionClauseSplit: 'conjunction'` is an opt-in adapter configuration for state-change goals. The default remains `'punctuation'`, including for Jev; no provider is automatically opted in. It preserves quoted conjunctions, the whole goal context, overflow requirements and existing verdict/confidence composition. Scratch Perplexity experiments motivated this option but do not validate this implementation or establish a calibrated non-Jev provider. The new frozen-package validation is recorded in the draft PR.
