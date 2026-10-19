// Text rendering for tasks.

export function formatTask(task) {
  return `${task.done ? '[x]' : '[ ]'} #${task.id} ${task.title}`;
}

export function formatList(tasks) {
  return tasks.length === 0 ? 'No tasks.' : tasks.map(formatTask).join('\n');
}
