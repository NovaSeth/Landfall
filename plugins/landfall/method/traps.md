# Tool traps

**Purpose:** recurring shell, git, process and agent traps, each with its symptom. **Reads:** every executor. **When:** writing scripts, running background or long work, reading results.

**Section map**
- §Shell — word splitting, pipes and exit codes, stdin, heredocs.
- §Git and worktrees — runs on agent branches, force pushes, experiment copies.
- §Processes — liveness, parallel runs, ports, time limits, queues, test environments, cleanup.
- §Agents and automation — verified effects, definitions changed mid-session, closing threads.

## Core

### Shell
**TRP-1.** Loop over a list with a bash array or a literal list; in zsh use `${=VAR}` or `xargs`, because zsh does not split `$VAR` into words. Symptom: the loop ran once.
**TRP-2.** MUST NOT run a gate through a pipe; when a pipe is needed, use `set -o pipefail` or save `rc=$?` in its own statement first, because `script | tail -1` returns the code of `tail` and `echo "EXIT=$?"` after a substitution reports the wrong command. Symptom: the gate passed although the script failed.
**TRP-3.** Give each command inside a `while read … done <<LIST` loop `</dev/null`, because it otherwise consumes the rest of stdin. Symptom: the loop stops after the first item.
**TRP-4.** Create files containing backticks or `$` with the edit tool or a quoted heredoc (`<<'EOF'`), because `<<EOF` runs backticks and expands variables. Symptom: fragments are missing or replaced by command output.

### Git and worktrees
**TRP-5.** Run checks on an agent's branch only after its commit or completion. Symptom: tests ran on a half-written file.
**TRP-6.** MUST NOT force-push `main` or `master` (`--force`, `-f`, `--force-with-lease`); revert a change on `main` with `git revert` through a pull request. Symptom: other people's commits vanish.
**TRP-7.** Give a worktree copy for an experiment (for example mutation testing) its own clean dependency install, because a shared dependency directory rewrites the original's links. Symptom: the copy broke the original worktree.

### Processes
**TRP-8.** After starting a background process, check that it is alive (`pgrep`), because the starter's exit code proves nothing; keep logs and results that must survive a restart outside `/tmp`. Symptom: results and locks vanished after a restart.
**TRP-17.** Detach a parallel run as a whole with `( a && b > log ) &` or `nohup bash -c '…' &` and check that every process is alive, because `a && b > log; echo X >> log &` sends only the last command to the background. Symptom: a "parallel" run waits for the previous one.
**TRP-9.** Kill only listening processes (`lsof -ti tcp:PORT -sTCP:LISTEN`) or a known PID, because `lsof -ti tcp:PORT` also returns outgoing connections. Symptom: killing by port hit an innocent process.
**TRP-10.** Make nested timeouts strictly shorter than the outer ones and enforce it with a check in the script. Symptom: the whole batch died because a step alarm equaled the supervisor's silence limit.
**TRP-14.** Give every long run (full tests, E2E, build) a hard time limit (default 30 min) and a no-output limit (default 10 min), each ending with its own exit code, and split batches to about 15 min of run time. Symptom: a hung run holds the device or the queue for hours.
**TRP-15.** A queue's control commands (status, cancel, pause) never wait in the queue they control. Symptom: cancelling a stuck run hangs behind it.
**TRP-11.** Start every E2E run with a warm-up test and run all steps of a task in that one run, not one run per step; more than 2 retries of one test (default) need a decision. Symptom: the first test after a cold start fails for no reason.
**TRP-19.** When a test environment (emulator, container, dev server) has run past its threshold or the warm-up fails, cold-restart it before diagnosing code and compare A/B on the same fresh environment. Symptom: a degraded environment looks like a regression.
**TRP-20.** A task that changes shared environment state (data, login, device) restores it before it ends. Symptom: a "regression" is state left behind by another task.
**TRP-12.** Tests that start processes have a cleanup `trap` and a teardown check; after a crash, look for processes with PPID 1 or pointing at deleted worktrees; before naming the cause of a slowdown, measure load, top processes and swap. Symptom: load grows with working time.

### Agents and automation
**TRP-13.** Verify the effect of automation (new ID, file, record), not its "ok" status, and check a change to how values reach a child process with a control run that passes with the value and fails without it. Symptom: a reported success changed nothing.
**TRP-16.** An agent or skill definition added or changed mid-session applies only from the next session start or plugin reload; until then dispatch a general agent with the model and effort from the definition. Symptom: the new agent type is unknown or behaves as before.
**TRP-18.** Verify that a thread (comment, finding, TODO) is closed with a script that searches the whole artifact, not by eye. Symptom: the thread is closed but leftovers remain elsewhere.
