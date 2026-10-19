Add due dates to the task tracker:

- `add <title> --due YYYY-MM-DD` stores a due date; the flag may appear anywhere after `add`;
- `list` shows the due date after the title, as `(due YYYY-MM-DD)`;
- `list --overdue` shows only open tasks whose due date is before today; `run` takes today's date as an optional third argument `now` (a `Date`) and defaults to the current date;
- an invalid due date (not a real calendar date in `YYYY-MM-DD` form) is rejected with an `error: ...` message and no task is added.

Due dates can be kept in the store in more than one way. Pick one, and record that decision where future contributors will find it.
