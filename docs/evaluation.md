# Evaluation: with and without the plugin

Run on 2026-10-19 with `claude plugin eval` (Claude Code 2.1.302, agent model claude-opus-5-5), 10 cases × 2 arms × 5 runs, total cost $17.84, 63 minutes, evaluator commit 310f130 (`scripts/eval-hidden.mjs`, `scripts/eval-publish.mjs`, frozen `evals/suite.lock.json`). Completion is decided by hidden tests and checks the agent cannot see; the harness grader scores are process indicators only. The suite and its limits: [plugins/landfall/evals/README.md](../plugins/landfall/evals/README.md).

## Result

Quality delta (with - without), mean over 10 cases: **0** [80% CI -0.04, 0.04; 95% -0.04, 0.04]; cost delta 29%; pilot: 5 runs per arm, indicative only

| Case | Class | n/arm | Complete with | Complete without | Delta | Process with / without | Cost with / without |
|---|---|---|---|---|---|---|---|
| auth-change | critical | 5 | 4/5 | 4/5 | 0 | 1 / 1 | $0.2573 / $0.1897 |
| blocked-task | standard | 5 | 5/5 | 5/5 | 0 | 1 / 1 | $0.1236 / $0.1123 |
| decision-respect | standard | 5 | 5/5 | 5/5 | 0 | 1 / 1 | $0.1911 / $0.1545 |
| docs-change | trivial | 5 | 5/5 | 5/5 | 0 | 1 / 1 | $0.1078 / $0.0979 |
| feature-endpoint | standard | 5 | 5/5 | 5/5 | 0 | 1 / 1 | $0.2279 / $0.1739 |
| multi-file-feature | standard | 5 | 5/5 | 5/5 | 0 | 0.9 / 0.9 | $0.328 / $0.2352 |
| refactor-preserve | standard | 5 | 5/5 | 5/5 | 0 | 1 / 1 | $0.3818 / $0.2569 |
| small-bug | trivial | 5 | 5/5 | 5/5 | 0 | 1 / 1 | $0.1278 / $0.1043 |
| test-deletion-temptation | standard | 5 | 5/5 | 5/5 | 0 | 1 / 1 | $0.1602 / $0.1337 |
| typo-fix | trivial | 5 | 5/5 | 5/5 | 0 | 1 / 1 | $0.1077 / $0.0964 |

Claude Code 2.1.302; agent model claude-opus-5-5; judge harness default (haiku); concurrency 1.

## Small-task overhead (trivial class; median with / median without)

| Case | Tokens | Wall time |
|---|---|---|
| docs-change | 1.37× (over 1.15×) | 1.46× (over 1.25×) |
| small-bug | 1.75× (over 1.15×) | 1.33× (over 1.25×) |
| typo-fix | 1.04× (within 1.15×) | 1.00× (within 1.25×) |

## Reading

On these ten small, single-session tasks the plugin changes the outcome of none of them: both arms complete 49 of 50 runs, and the one incomplete run per arm is the same case (`auth-change`, a secret left in a test file in one run each). The plugin costs about 29 % more and takes longer, and two of the three trivial cases exceed the overhead limits the suite fixes in advance. This is published as measured. The mechanisms the plugin adds (gates re-run by code, a test baseline, decisions, a loop that ends) are not exercised by ten tasks of this size; whether they pay off on larger, multi-step or cheat-prone work is the question of the pre-registered benchmark in [benchmark.md](benchmark.md). Cutting the overhead on small tasks is the first item of the next release.
