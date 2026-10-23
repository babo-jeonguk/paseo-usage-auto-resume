// The sidebar, the composer controls and the settings screen share these caches, so a change
// made in one refreshes the others.
export const jobsQueryKey = (hostId: string) => ["usage-auto-resume", "jobs", hostId];
export const historyQueryKey = (hostId: string) => ["usage-auto-resume", "history", hostId];
