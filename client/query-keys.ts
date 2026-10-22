// The sidebar, the composer controls and the settings screen share these caches, so a change
// made in one refreshes the others.
export const jobsKey = (hostId: string) => ["usage-auto-resume", "jobs", hostId];
export const historyKey = (hostId: string) => ["usage-auto-resume", "history", hostId];
