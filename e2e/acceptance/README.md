# TaskAgent acceptance evidence

This directory holds the receipts behind the PR. Raw per-scenario evidence (screenshots, every saved Jev request and response, traces) is about 3 GB, stays out of git (`e2e/evidence/` is ignored) and is summarised here. Every figure below is computed from the copied `run-summary.json` files and the saved call logs by a script, not typed by hand.

## Packages

| Package       | Source SHA-256                                                     | ESM/UMD pair SHA-256                                               | Meaning                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ap-premerge` | `974f563f3586c6757f7645979b55b1fa528fc1ab707fa2b6d28a79048c629369` | `41869cfd512fe63330adc43293bb33746866b9933ad81c20223a65012a2d89bf` | The TaskAgent work on its own base (`98e1126`), before `origin/main` PR #49 was merged in.                                                                                                      |
| `aq-merged`   | `8ca16734ad91947c40f3e5f4188bae0f7d7dc5f105f1aa294cc9d1264b03ce04` | `c43c16e0fca96e3437f61ee1a21c60cb32cbf3cbb70a093b9d1c97d7e5a1a0f6` | The same tree merged with `origin/main` (scoped automation roots). `src/agent/` is byte-identical to `ap-premerge`; nine DOM, executor and form files differ. This is the tree the PR contains. |

Results from different packages are never combined: each row below belongs to the package named in its first column.

## Gate summary

**ap-premerge**

- Safety nine: clean on run 1 of 1 (`resume-ap-canary-20261005-a`: live 8/8, faults 1/1).
- Targeted 30: clean on run 1 of 2 (`resume-ap-targeted-20261005-a`: live 29/29, faults 1/1).
- Full 51 (43 live + 8 faults): clean on run 1 of 2 (`resume-ap-full-20261005-a`: live 43/43, faults 8/8).

**aq-merged**

- Safety nine: clean on run 1 of 1 (`resume-aq-canary-20261005-a`: live 8/8, faults 1/1).
- Targeted 30: clean on run 2 of 2 (`resume-aq-targeted-20261005-b`: live 29/29, faults 1/1).
- Full 51 (43 live + 8 faults): clean on run 4 of 4 (`resume-aq-full-20261005-d`: live 43/43, faults 8/8).

A run counts as clean only when every scenario passed (exit 0). Earlier runs of the same package are in the table below with their causes; they are not hidden or replaced.

## Runs

Profile for every run: `--kind all --jobs 2 --jev-concurrency 3 --observe-offscreen`, action 0.2, argument 0.3, completion 0.4 (commitment 0.5 is the unchanged library default). Live Jev (`jev-1.13.0`), at most two browser contexts and three concurrent Jev calls. Goals, fixture apps, backend and UI assertions, grants and library defaults are unchanged. The action, argument and completion floors are the caller's relaxed campaign values (0.2, 0.3, 0.4) against library defaults of 0.5, 0.6 and 0.75; no run on the default floors is recorded. These runs followed 81 earlier run directories on 44 earlier builds of the same campaign (15 of them full-size, none clean) that are not part of this evidence. `live` counts live scenarios, `faults` counts labelled fault injections that fired and were recovered. `10 s aborts` are Jev calls the client abandoned after its 10 000 ms timeout. `host load` is the 1-minute load average (median / max) sampled every 20 s on the 18-core test host while the run was live.

| Package     | Run id                          | Scope                      | Exit | live  | faults | Jev calls | 10 s aborts | host load |
| ----------- | ------------------------------- | -------------------------- | ---- | ----- | ------ | --------- | ----------- | --------- |
| ap-premerge | `resume-ap-canary-20261005-a`   | safety nine                | 0    | 8/8   | 1/1    | 467       | 0           | 29 / 31   |
| ap-premerge | `resume-ap-targeted-20261005-a` | targeted 30                | 0    | 29/29 | 1/1    | 1506      | 0           | 32 / 51   |
| ap-premerge | `resume-ap-full-20261005-a`     | full 51                    | 0    | 43/43 | 8/8    | 1832      | 0           | 21 / 24   |
| ap-premerge | `resume-ap-targeted-20261005-b` | targeted 30 (confirmation) | 0    | 29/29 | 1/1    | 1508      | 0           | 17 / 22   |
| ap-premerge | `resume-ap-full-20261005-b`     | full 51 (confirmation)     | 1    | 42/43 | 8/8    | 1821      | 0           | 13 / 21   |
| aq-merged   | `resume-aq-canary-20261005-a`   | safety nine                | 0    | 8/8   | 1/1    | 464       | 0           | 42 / 48   |
| aq-merged   | `resume-aq-targeted-20261005-a` | targeted 30                | 1    | 26/29 | 1/1    | 1459      | 4           | 44 / 98   |
| aq-merged   | `resume-aq-full-20261005-a`     | full 51                    | 1    | 41/43 | 8/8    | 1766      | 5           | 65 / 116  |
| aq-merged   | `resume-aq-targeted-20261005-b` | targeted 30 (rerun)        | 0    | 29/29 | 1/1    | 1510      | 2           | 88 / 137  |
| aq-merged   | `resume-aq-full-20261005-b`     | full 51 (rerun)            | 1    | 43/43 | 7/8    | 1819      | 2           | 110 / 182 |
| aq-merged   | `resume-aq-full-20261005-c`     | full 51 (quiet-host rerun) | 1    | 43/43 | 7/8    | 1807      | 0           | 40 / 75   |
| aq-merged   | `resume-aq-full-20261005-d`     | full 51 (final rerun)      | 0    | 43/43 | 8/8    | 1798      | 0           | 28 / 32   |

## Every failed scenario, with its cause

| Run id                          | Scenario                                | Final status      | Failed checks                  | Cause (from the saved trace and call log)                                                                                                                                                                                                                         |
| ------------------------------- | --------------------------------------- | ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resume-ap-full-20261005-b`     | `catalog-b-inputs-brand-budget`         | blocked           | status_mismatch, expect_failed | a 10-clause completion request (page text truncated) had clauses at 0.35 to 0.44 against the 0.4 floor, so the run blocked as MODEL_UNCERTAIN; model variance on a pre-merge package, replay-checked and left unchanged                                           |
| `resume-aq-targeted-20261005-a` | `checkout-b-multistep-spa`              | awaiting_approval | status_mismatch, expect_failed | a Jev call aborted at ~10 s; the commitment classifier failed closed and the run stopped at an approval                                                                                                                                                           |
| `resume-aq-targeted-20261005-a` | `shipping-c-gift-next-day`              | awaiting_approval | status_mismatch, expect_failed | a Jev call aborted at ~10 s; the commitment classifier failed closed and the run stopped at an approval                                                                                                                                                           |
| `resume-aq-targeted-20261005-a` | `shipping-b-gift-priority`              | awaiting_approval | status_mismatch, expect_failed | a Jev call aborted at ~10 s; the commitment classifier failed closed and the run stopped at an approval                                                                                                                                                           |
| `resume-aq-full-20261005-a`     | `checkout-a-adjust-quantity-then-order` | awaiting_approval | status_mismatch, expect_failed | a Jev call aborted at ~10 s; the commitment classifier failed closed and the run stopped at an approval                                                                                                                                                           |
| `resume-aq-full-20261005-a`     | `checkout-b-multistep-spa`              | awaiting_approval | status_mismatch, expect_failed | a Jev call aborted at ~10 s; the commitment classifier failed closed and the run stopped at an approval                                                                                                                                                           |
| `resume-aq-full-20261005-b`     | `fault-premature-done`                  | awaiting_approval | status_mismatch, expect_failed | a Jev call aborted at ~10 s; the commitment classifier failed closed and the run stopped at an approval                                                                                                                                                           |
| `resume-aq-full-20261005-c`     | `fault-premature-done`                  | completed         | expect_failed                  | Jev chose a completion option that was not its most probable one (0.49 against 0.50), so the adapter rejected the answer; the injected premature DONE was dropped without a done_gate event, which the fault proof requires, and the run then completed correctly |

## Reading the failures

- A failed scenario is a failed goal; none was waived and no assertion was changed. Across all 8 failures the only failed check kinds are: `expect_failed`, `status_mismatch`. None recorded an evidence leak. The final-status check runs before the backend and UI assertions and stops at its first failure, so in seven of the eight failures those assertions were not reached; the eighth (the near-tie fault case) passed them and failed only the fault proof. When a classifier call is lost the coordinator fails closed and asks for approval instead of acting.
- `aq-merged/diagnostic-stall-replay.json` replays five of the aborted commitment requests, the ones behind five of the six abort failures (the sixth, in `resume-aq-full-20261005-b`, was not replayed), one at a time, three times each. All 15 returned HTTP 200 in 309 to 494 ms with plausible classifications (NONE and NO_COMMITMENT for selects and toggles, FORM_SUBMIT for a form submit). Those five payloads do not reproduce the stall. The receipt records no expected classification, so plausible is the most it can say.
- The aborts coincide with host load far above the `ap-premerge` runs (load logs are alongside), produced by other sessions on the shared test host. Load is a correlation recorded here, not a proven mechanism: the replay above itself ran while the 1-minute load was still about 121 and every call was fast, so load alone does not explain the aborts.
- The library has no retry for a lost commitment-classifier call, unlike the action decider. That is a candidate follow-up and was not changed here, because any source change needs a new package and a fresh full campaign.

## Other receipts

| File                                                                         | What it shows                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aq-merged/quality.json`, `build.json`                                       | Frozen quality gate (strict source and test TypeScript, zero-warning lint, formatting, full Jest, 61 protected starting hashes) and the single sequential build for the merged package.                                                                                                        |
| `aq-merged/quality-first-attempt-protected-baseline-mismatch.json`           | The first gate attempt, which correctly refused to build: `README.md` and `examples/breeze-jev.mjs` differed from the protected baseline. The example script was restored byte-for-byte; the README change is the upstream merge, recorded with proof in `protected-merge-aq-exceptions.json`. |
| `aq-merged/merge-review.json`                                                | Independent read-only review of the merge resolution, with how each finding was verified or rejected.                                                                                                                                                                                          |
| `aq-merged/chromium-proof.json`, `package-receipt.json`, `source-proof.json` | Real-Chromium engine, navigation and bridge proof on the built package, the ten-export package receipt, and the source/HEAD/protected-file proof.                                                                                                                                              |
| `*/evidence-audit-*.json`                                                    | Per-run integrity audit: expected scenario ids, literal goals, pair hashes, and a scan of every evidence byte for the API key and long secrets (no values are emitted). Integrity does not turn a red scenario green.                                                                          |

## Not proved

Screenshot pixel secrecy is not established by byte scans. Scans cannot see a secret the page masked or re-encoded. Model behaviour near the confidence floors varies from run to run, so a single green run is evidence, not a guarantee.
