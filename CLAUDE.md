# Landfall — rules for agents working on this repository

This repository is the `landfall` Claude Code plugin (`plugins/landfall/`), its marketplace (`.claude-plugin/`), its tests (`tests/`) and generators (`scripts/`).

## Gate
- `npm test` — the whole suite (Node ≥ 18, zero dependencies). Run single files with `node --test --test-timeout=120000 <file>`.
- `node scripts/gen-names.mjs --check`, `node scripts/gen-docs.mjs --check`, `node scripts/gen-method-index.mjs --check` — generated files are up to date (regenerate without `--check`).
- Never run artificial CPU load; run full suites one at a time.

## Global constraints
- GC1 English only, in content and names.
- GC2 Installed outside projects: nothing is written into a project before work starts there; no global config writes.
- GC3 Outcome gates are code; the test baseline cannot shrink without a decision.
- GC4 Every loop ends: caps, stall detection, typed exits, no wakeup after DONE.
- GC5 Stable IDs: rule and decision IDs are never renumbered.
- GC6 One source of truth per fact: help, `docs/cli.md`, hooks and the method index are generated.
- GC7 Always-on context ≤ 1.5k tokens.
- GC8 Hooks: malformed input → allow; a guarded operation without proof → block; < 1 s of CPU.
- GC9 Lossless upgrades: schema-versioned state, newer schema refused; generated files merged three-way.
- GC10 bash 3.2 and Linux, Node ≥ 18, zero runtime dependencies.
- GC11 The repository holds finished solutions only — no process artifacts or analyses.

## Changes
- A change comes with a test that fails without it.
- All terminal output goes through `plugins/landfall/lib/cli/output.mjs`; all state writes go through `plugins/landfall/lib/state`.
- Commit messages in English with a conventional prefix (`feat(<area>):`, `fix:`, `docs:`, `test:`, `chore:`).
