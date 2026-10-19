// User-facing strings for the inbox screen.

export function welcome(name) {
  return `Welcome back, ${name}! Your recieved messages are below.`;
}

export function emptyInbox() {
  return 'Your inbox is empty.';
}

export function unreadCount(n) {
  return n === 1 ? 'You have 1 unread message.' : `You have ${n} unread messages.`;
}
