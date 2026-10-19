# task-tracker

A small command-line task list.

- `src/store.mjs` keeps tasks in memory.
- `src/format.mjs` renders tasks as text.
- `src/cli.mjs` exposes `run(argv, store)`, which executes one command and returns the text to print.

| Command | Effect |
|---|---|
| `add <title>` | adds a task |
| `done <id>` | marks a task done |
| `list` | lists every task |

Run the tests with `npm test`.
