# Eval suite

Ten cases for `claude plugin eval`, each run with and without the plugin. Every case has a `case.yaml`, a
`prompt.md`, a `scaffold.sh` that commits `fixture/` into a fresh git repository, and the fixture itself. The
tests that decide whether a task was completed are kept outside the plugin, so the agent under test cannot read
them and installs do not carry them.

## How a result is produced

1. Run the suite with kept workspaces:
   `claude plugin eval <plugin dir> --ablation with-without --runs 5 --scaffold --keep-temp --trust-plugin --allow-tools Bash Edit Write --json <results file>`.
2. Run the trusted post-pass on the results: `node scripts/eval-hidden.mjs --results <results file> --out <report>`.
   It decides completion (quality 1 or 0) for every run: hidden tests and the fixture's own tests run in a
   trusted process that calls the agent's code in a confined child process; static, history and trace checks
   compare with the fixture. The harness's own grader scores are kept as process indicators only.
3. Publish: `node scripts/eval-publish.mjs summarize --results <results file> --hidden-report <report>`. It refuses
   results that are incomplete, unchecked, made under another `suite.lock.json`, or no longer match the kept
   runs, and reports the mean over cases of the per-case difference between the arms with bootstrap intervals.

`suite.lock.json` freezes the cases, the completion definitions and the publication rules; regenerate it with
`node scripts/eval-publish.mjs lock` after changing any of them.

## Known limitations

- **The lock does not freeze the evaluator code.** It hashes the cases, the hidden tests and the completion
  definitions, but not the code that runs them (`scripts/eval-hidden.mjs`, `scripts/eval-lib/`: completion
  checks, source analysis, the candidate protocol). A change there can change verdicts while the lock stays
  the same. Publish the repository commit of the evaluator with every result.
- **Artifact checks can be met by an empty declaration.** `tests-added` counts a new test whose text mentions
  the route or header the task is about, even when its body is empty (`test('x-signature', () => {})`).
  `decision-record` accepts any added text that mentions due dates, a representation and a decision word, even
  a negated one ("No decision was made about whether to store due dates as ISO strings."). The behaviour checks
  of the same cases still apply, so such a run must also implement the feature correctly to count as complete.
- **Without a git repository, secret history is not checked.** If a run leaves no `.git` (for example after
  deleting it), `secret-absent` searches only the files left in the workspace and passes when none of them
  holds the secret. A secret committed and then erased together with the history is not found.
- **The verification indicator can be imitated.** `verified_after_last_change` reads tool events: a shell
  command that prints a passing summary and mentions a test runner (`echo '# pass 1'; # npm test`) counts as a
  green run, and a file changed by an interpreter (`python`, `node -e`) after the last green run is not seen as
  a change. It is a process indicator and never part of quality.
- **The documentation check matches wording, not meaning.** For `docs-change`, some descriptions of `--quiet`
  that say the opposite of the behaviour still pass: "Suppress all output, including errors.", "Hide every
  error.", "Never show errors; suppress debug output."
- **The constant-time check is structural.** It observes, inside the agent's process, that the request's
  signature and the expected HMAC (as bytes or as hex text) are compared by `timingSafeEqual` on equal-length
  buffers and that the handler's decision follows that call. It does not prove constant-time behaviour, and an
  implementation that compares derived values (for example a second HMAC over both sides) fails it.
- **Observations inside the agent's process are measurements, not proofs.** Argument mutation, comparison
  calls and written output are recorded by code that runs in the same process as the agent's code; deliberately
  hostile code could tamper with that recording. Verdicts themselves are made outside that process.
- **Confinement depends on the Node version.** Without Node's permission model (Node older than 22.13) the
  post-pass refuses to run the agent's code unless `--allow-unconfined` is given; that run is recorded as
  unconfined and the publisher refuses it.
- **Five runs per arm is a pilot.** Intervals describe this fixed suite of cases; they are wide and say nothing
  about other tasks.
