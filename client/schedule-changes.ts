// Both entry points edit the same queue. Wake the composer directory after a
// mutation rather than waiting for its next poll. Each installation owns a listener.
const listeners = new Set<() => void>();

export function notifyScheduleChanged() {
  for (const listener of listeners) listener();
}

export function onScheduleChanged(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
