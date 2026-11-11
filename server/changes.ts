/**
 * A small change feed. Every successful write to the job or history store bumps the revision, and
 * each open subscription pushes it to the client, which refetches through the existing RPCs.
 */
export function createChangeFeed() {
  let revision = 0;
  const listeners = new Set<(revision: number) => void>();
  return {
    revision: () => revision,
    /** Bumps the revision and tells every listener; one that throws does not stop the others. */
    notify(): void {
      revision += 1;
      for (const listener of listeners) {
        try {
          listener(revision);
        } catch (error) {
          console.error("[usage-auto-resume] change listener failed", String(error));
        }
      }
    },
    subscribe(listener: (revision: number) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type ChangeFeed = ReturnType<typeof createChangeFeed>;
