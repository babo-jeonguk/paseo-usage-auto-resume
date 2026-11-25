// Keep prior identities when an intermediate parent vanishes during shutdown.
export function trackWindowsChildren(tracked, roots, processes) {
  for (const [pid, started] of roots) tracked.set(pid, started);
  const live = new Map(processes.map(row => [row.pid, row.started]));
  for (let previous; previous !== tracked.size;) {
    previous = tracked.size;
    for (const { pid, parent, started } of processes) {
      const parentStarted = tracked.get(parent);
      // A child from a previous owner of this PID would predate the live parent.
      if (!tracked.has(pid) && parentStarted && live.get(parent) === parentStarted && started > parentStarted) {
        tracked.set(pid, started);
      }
    }
  }
}
