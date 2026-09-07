# CodeQL CI timing diagnosis — read-only

Observed 2026-09-07 UTC for voidcraft-labs/commcare-nova PR #572. No repository files, workflows, GitHub settings, or runner selection were changed. No tests or paid runner jobs were started.

## Finding

PR #572 changed 2,202 files. CodeQL's automatic incremental analysis was already enabled and a compatible cached base database was available. The action abandoned incremental analysis because its GitHub compare API response was capped at 300 files, then correctly ran the complete analysis. This is not missing dependency caching, an npm/build problem, or a disabled incremental setting.

Pinned action cdf488f595d80d6e07e03d4674febd5ab45fa938, CodeQL CLI 2.26.4, JavaScript query pack 2.4.4. The action's current main source also retains the same cap as of this inspection.

Live log /tmp/nova-ci-codeql-js.log:
- Lines 630–631: overlay with caching selected for the pull request.
- Line 633: “Cannot retrieve the full diff because there are too many (300) changed files in the pull request.”
- Line 634: overlay disabled because PR diff ranges could not be computed.
- Line 1131: diff-informed analysis skipped.
- Lines 8118–8127: full database finalization then query execution.

The limit applies to the whole compare result, including changes outside the JavaScript source set. Additional commits on this same PR do not reduce its cumulative diff against the base.

## Measured wall time

| Run | Entire workflow | JavaScript job | Result |
| --- | --- | --- | --- |
| PR #572, 34086766720 | 10m27s | 10m21s | Full analysis after diff cap |
| PR #570, 33988344832 | 2m36s | 2m31s | Cached incremental analysis |
| PR #570, 33987925520 | 2m17s | See run | Normal PR comparison |
| PR #570, 33987510151 | 2m44s | See run | Normal PR comparison |
| Main after #570, 33994832328 | 9m38s | 9m32s | Full base analysis |

PR #572 JavaScript: setup/checkout about 13s; extraction about 103s; finalization about 31s; queries about 457s; interpretation/upload about 10s. All 89 queries ran. The longest reported query evaluation was InsufficientPasswordHash at 6m12s, followed by UnvalidatedDynamicMethodCall at 5m16s. Evaluation durations overlap and include shared work; they must not be added, or interpreted as isolated query benchmarks.

The job already uses all four standard-runner cores and approximately 14.2 GiB RAM. The four language jobs already run in parallel. API aliases javascript/javascript-typescript/typescript do not create three JavaScript jobs. Default setup reports the default query suite and remote threat model.

## Can a bounded explicit complete diff fix the official action?

No supported init/analyze input supplies precomputed complete diff ranges. In the pinned source:

1. src/diff-informed-analysis-utils.ts:148–175 returns undefined when compare response file count is >=300. It cannot prove the response complete.
2. src/config-utils.ts:1283–1294 calls that computation unconditionally during configuration; 1016–1037 disables automatic overlay when it returns false.
3. Therefore, putting a complete JSON file at the action's internal temporary path before init does not cause the computation to return true and does not preserve automatic overlay.
4. There is a source-level CODEQL_OVERLAY_DATABASE_MODE override (config-utils.ts:696–759). It switches to manual cache management. The fallback's source comment at 1007–1010 says overlay has only been validated together with diff-informed analysis. Bypassing this guard is not a demonstrated safe optimization and is not recommended here.
5. Altering vendored action internals, mocking GitHub's response, or truncating the diff would replace the action's correctness boundary. Those are not bounded configuration fixes.

A custom analysis workflow can use the documented CodeQL CLI: compute the complete Git diff locally, maintain a compatible whole-repository overlay base and its file identities, and execute the existing security queries against the resulting database. That avoids this API cap without splitting source analysis. It also transfers cache lifecycle, full-diff validation, SARIF handling, fallback, and version compatibility to Nova. This is a separate implementation and benchmark, not a verified five-minute remedy for this large PR.

## Coverage-preserving options and practical limits

- Keep default setup for ordinary PRs. Recent measured runs are already below five minutes. This preserves the existing query suite, language coverage, automatic caches, and fallback behavior. Three short PR runs are evidence, not a universal guarantee.
- Accept/report this audit PR's complete-analysis cost. Its very broad diff triggers the conservative fallback; rerunning it does not remove that reason. A fresh main full analysis also remains around 9–13 minutes historically, so “all GitHub CI on every event is <=5 minutes” is not presently demonstrated.
- A future series of smaller PRs can avoid this specific threshold only when each compare is below 300 files and its target has a usable analyzed base. Changing the delivery structure of this already-reviewed PR is a separate scope decision; stacked commits alone do not help.
- A separately validated custom complete-diff CLI workflow is technically available. No timings show a 2,202-file overlay will meet five minutes. The initial/cold base still needs a full scan.
- Query partitioning over a complete database could preserve source context, but extraction/finalization must still occur and slow query evaluations are unresolved. No five-minute result is established. Do not substitute source-directory shards: GitHub explicitly warns that some security behaviors require complete cross-component data flow.
- Increasing hardware is a documented option but paid/larger runners are outside this request. Existing threads/memory and language parallelism offer no unused obvious knob.
- Excluding tests, dropping queries/languages, suppressing checks, or moving coverage to a scheduled scan would weaken the present per-change gate and are not recommended as compliance with the requested target.

## Primary sources and reproducible evidence

- PR #572 run: https://github.com/voidcraft-labs/commcare-nova/actions/runs/34086766720
- PR #570 comparison: https://github.com/voidcraft-labs/commcare-nova/actions/runs/33988344832
- Main comparison: https://github.com/voidcraft-labs/commcare-nova/actions/runs/33994832328
- Exact cap: https://github.com/github/codeql-action/blob/cdf488f595d80d6e07e03d4674febd5ab45fa938/src/diff-informed-analysis-utils.ts#L148-L175
- Guard and explicit-mode ownership: https://github.com/github/codeql-action/blob/cdf488f595d80d6e07e03d4674febd5ab45fa938/src/config-utils.ts#L1007-L1037 and #L696-L759
- Official action inputs: https://github.com/github/codeql-action/blob/cdf488f595d80d6e07e03d4674febd5ab45fa938/init/action.yml and /analyze/action.yml
- Official incremental/CLI contract: https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/scan-from-the-command-line/incremental-analysis
- Official optimization tradeoffs: https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/analysis-takes-too-long

Local captured logs: /tmp/nova-ci-codeql-js.log, /tmp/nova-codeql-pr570.log, /tmp/nova-codeql-main570.log. Recent run metadata: /tmp/nova-codeql-recent-runs.jsonl. Pinned source captures: /tmp/nova-codeql-diff-utils.ts, /tmp/nova-codeql-src-config-utils.ts, /tmp/nova-codeql-init-action.yml, /tmp/nova-codeql-analyze-action.yml. This report makes no repository mutation or measured speedup claim.
