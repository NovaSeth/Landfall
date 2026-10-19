// Command-line front end: run(argv, store) executes one command and returns the text to print.
import { formatList, formatTask } from './format.mjs';

export function run(argv, store) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'add': {
      const title = rest.join(' ').trim();
      if (!title) return 'error: title required';
      return `added ${formatTask(store.add(title))}`;
    }
    case 'done': {
      const task = store.complete(Number(rest[0]));
      return task ? `completed ${formatTask(task)}` : `error: no task ${rest[0]}`;
    }
    case 'list':
      return formatList(store.all());
    default:
      return 'usage: tasks <add|done|list> ...';
  }
}
