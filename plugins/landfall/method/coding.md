# Coding

**Purpose:** coding rules for every stack: tests first, one source of truth, boundaries, gates in code. **Reads:** implementer, reviewer, designer. **When:** implementing or reviewing a task.

**Section map**
- §Tests first — RED/GREEN evidence, discriminating tests, commits, the test baseline, legacy code.
- §Single source of truth — one source per fact, generators, the user's channel, lossless updates, target context.
- §Boundaries and decisions — module interfaces, self-checking guards, decisions cited in code.
- §Gates in code — exit codes, void results, bounded workers, heavy commands.

## Core

### Tests first
**COD-1.** Write the test first: run it, show the failure and its reason in the report, then make it pass; one plan step = one commit, and the tree is clean at the end of the task.
**COD-2.** A test MUST discriminate: correct code passes and the same code with one change fails; a test that passes by rejection proves nothing; check hard-to-reproduce behavior (concurrency, retries, navigation) by mutation.
**COD-3.** [always] MUST NOT remove, skip or weaken a test without a decision that allows it.
**COD-15.** In a migration or refactor, E2E test files stay unchanged (configuration may change), because they prove the behavior did not change.
**COD-4.** Before changing untested legacy code, write a characterization test; a missing test harness is a separate task first.

### Single source of truth
**COD-5.** A fact stated in more than one place (file membership, flags, subcommands, exit codes, step names, thresholds, predicates) has one source; generate the other places from it or guard them with a consistency test.
**COD-6.** Commit generated files marked `GENERATED — DO NOT EDIT`; a generator has `--check` (exit 1 = stale) in the gate and is deterministic (two runs byte-identical), and every generated config (JSON, YAML, TOML, CI workflow) is parsed by the target tool's parser for each option combination; MUST NOT edit generated output.
**COD-7.** Test through the channel the user gets: build the package (pack, wheel, image), unpack and run it instead of the repository clone, and run the README start instructions step by step to the described result.
**COD-8.** An update of files the user may have changed has a property test: no sequence install → user edit → new version → update → update again alters the user's content; missing stored state is read the safest way (keep the file, put the new version beside it).
**COD-9.** A tool acting on a target takes context (identity, configuration, dates, paths) from the target, not the working directory; without a terminal and without explicit consent (`--yes`) it refuses instead of assuming defaults; both cases are tested.

### Boundaries and decisions
**COD-10.** Import another module only through its public interface; a composition file wires dependencies; an architecture test over the full import graph decides, and linters are defense in depth.
**COD-11.** Every guard (architecture test, token test, scanner) checks itself (bad input caught, good input passed) and asserts its scope; MUST NOT weaken it.
**COD-12.** Cite a decision next to the code it constrains: `// D-<handle>-<n>: <why in five words>`.

### Gates in code
**COD-13.** Gate tools exit 0 clean, 1 finding, 2 tool error (never "clean"); delete the old result before a run, and a result whose log lacks its target (device, browser, port) is void.
**COD-14.** Bound test-runner workers in every brief (default 2), check how the package manager passes arguments to the test script, and MUST NOT use unbounded worker flags; when the heavy-command queue is on, run full tests, whole-repository typecheck, lint and build through the CLI `heavy`.
