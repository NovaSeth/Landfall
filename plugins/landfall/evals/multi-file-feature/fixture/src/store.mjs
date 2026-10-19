// In-memory task store. A task is { id, title, done }.

export function createStore() {
  const tasks = [];
  let nextId = 1;
  return {
    add(title) {
      const task = { id: nextId++, title, done: false };
      tasks.push(task);
      return { ...task };
    },
    complete(id) {
      const task = tasks.find((candidate) => candidate.id === id);
      if (!task) return null;
      task.done = true;
      return { ...task };
    },
    all() {
      return tasks.map((task) => ({ ...task }));
    },
  };
}
