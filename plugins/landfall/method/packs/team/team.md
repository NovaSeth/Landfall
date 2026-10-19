# Team

**Purpose:** several people orchestrating agents in their own lanes without colliding on lanes, shared parts or records. **Reads:** every developer (lane orchestrator), shared-part owners, the security owner, the PO. **When:** tier L2 or higher, a new developer, a lane changing hands, a shared-part change.

**Section map**
- §People and roles — role owners, approvals, the developer as orchestrator, the team file.
- §Lanes and claims — one orchestrator per lane, claiming, refusals, listing, release, takeover, claim refs.
- §Plan for lanes — lane table, repository layout, phases, start conditions.
- §Tasks and decisions — own tasks only, decisions that reach other lanes.
- §Shared parts — ownership, gaps found in a lane, trial merges, impact notes, rewiring.
- §CI and branches — protection of main, process-record branches, pull requests, gates without CI.
- §Onboarding and handover — first setup, reading order, handing a lane over, taking it over.
- §Rhythm and scale — syncs, teams of teams.

## Pack: team

### People and roles
**COL-1.** Assign each role to named people in the team file (default `docs/team.md`): the PO (scope, priorities, area-gate acceptance, lane disputes), shared-part owners, lane orchestrators (every developer) and the security owner (guide, audit, release gates).
**COL-2.** Every shared part (contract, tokens, UI kit, platform core, CI, process tooling) and every lane has an owner in the team file; one person may hold several roles.
**COL-3.** The author of a pull request never approves it: another person approves, and for a shared part its owner does.
**COL-4.** Every developer orchestrates the agents of their own lanes, with the same duties and limits as any orchestrator.
**COL-5.** Keep assignments (people, lanes, directories, rhythm) in the team file and change them only through a pull request.

### Lanes and claims
**COL-6.** One lane has one orchestrator at a time; MUST NOT dispatch agents in a lane claimed by another person.
**COL-7.** Claim a lane with the CLI `lane claim <lane>` before the first dispatch in it, and work in it only while your claim is live (task events in the lane renew it).
**COL-8.** When a claim is refused (exit 1: another person holds the lane), agree with that person; MUST NOT work around the claim mechanism.
**COL-9.** Check the CLI `lane list` before claiming and at every daily sync; an expired claim means a talk with its owner, not a free lane.
**COL-10.** Release your lane with the CLI `lane release` at a handover and when your work there ends.
**COL-11.** Take over a foreign or expired claim only after agreeing with its owner (with the PO when the owner is unreachable) and recording a decision; an expired claim never passes to anyone by itself.
**COL-12.** Server-side branch protection MUST NOT cover the claim refs; never merge a claim ref and never open a pull request from it.

### Plan for lanes
**COL-13.** A team plan has the lane table `Lane | Exclusive directory | Tasks (in order) | Starts after`; parallelism comes from disjoint directories, and two lanes MUST NOT share a directory.
**COL-14.** Default layout: shared parts in `packages/*` (contract, data world, API client, tokens, UI kit, catalog) and `src/platform/`, lanes in `apps/<app>/src/features/<area>` or `src/modules/<module>`.
**COL-15.** Default phases: F0 environment, rules, repository and CI (orchestrator) · F1 foundation in sequence (contract, data world, design-system export, backend skeleton, UI kit, API client) · F2 areas in lanes (default 3–5 implementers) · F3 offline, queues, conflicts, edge cases · F4 real external systems · F5 hardening, security, release.
**COL-16.** Lanes start only once the contract and the data world exist; work that waits for external keys is a separate late phase, and a phase closes with the area gate of each of its areas (REV-12).

### Tasks and decisions
**COL-17.** Act only on tasks of your own lanes or tasks without a lane; MUST NOT dispatch another orchestrator's task or record its state.
**COL-18.** Give a decision that affects other lanes or shared parts a scope that covers them, and raise it at the next daily sync.

### Shared parts
**COL-19.** List the shared parts with their owners in CODEOWNERS: the plugin's generated files, the shared project configuration, CI, hooks, security docs and the stack's shared parts (contract, tokens, UI kit, package manifest, lockfile).
**COL-20.** A lane task MUST NOT patch a gap in a shared part: it stops with NEEDS_CONTEXT and the orchestrator opens a shared task (PRI-7, ORC-17).
**COL-21.** Before merging a shared task, trial-merge it into every open task branch (`git merge --no-commit --no-ff`, `git diff --cached --stat`, `git merge --abort`) and write an impact note listing per lane the replacements `file:line → new version`.
**COL-22.** After a shared task merges, its author sends the impact note; each lane orchestrator merges `origin/main` and rewires in a separate commit `refactor(<area>): rewire after <shared task>`.

### CI and branches
**COL-23.** Protect `main`: the aggregate result job of the generated CI as the only required check, Code Owners approval, at least one human approval and no direct push.
**COL-24.** Commit process records on a `process/<handle>` branch and open a pull request from it at least daily and before a lane handover; code reaches `main` only through a task branch and a pull request.
**COL-25.** A pull request description gives the task, its decisions, RED → GREEN evidence, the review, the security review and the shared tasks it depends on.
**COL-26.** Without CI on the repository platform, run the same gates locally and paste the results (counts, exit codes) into the pull request.

### Onboarding and handover
**COL-27.** Before your first dispatch on a machine, install the plugin, register your handle with the CLI `team add` and check that the generated pre-push hook is active.
**COL-28.** Before your first dispatch in the project, read the project instruction file, the team file and the orchestrator handbook.
**COL-29.** To hand a lane over, write the resume note (MEM-4), push the branches and the process-record pull request, stop your background processes and release the lane.
**COL-30.** The successor claims the lane, runs the resume procedure (MEM-5) and updates the lane's orchestrator in the team file.

### Rhythm and scale
**COL-31.** Hold a daily sync (default 10 min: shared decisions, lane claims, blockers, needed shared tasks, process pull requests), a weekly lesson review with deferred-Minor triage, and a PO report after each area gate; record your own lengths and frequencies as a decision.
**COL-32.** At tier L3, assign each lane to exactly one team in the team file; the lane orchestrator comes from that team.
**COL-33.** At tier L3, a platform team owns the shared parts in CODEOWNERS and approves shared tasks.
