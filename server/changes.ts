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

/**
 * One feed listener per open subscription. Aborting a subscription, or the plugin's own cleanup,
 * releases its listener, so reconnects cannot leave stale entries in the plugin's cleanup.
 */
export function createChangeSubscriptions(feed: ChangeFeed) {
  const listeners = new Set<() => void>();
  return {
    listen(push: (revision: number) => void, signal: AbortSignal): void {
      const unsubscribe = feed.subscribe(push);
      listeners.add(unsubscribe);
      signal.addEventListener("abort", () => {
        unsubscribe();
        listeners.delete(unsubscribe);
      }, { once: true });
    },
    /** Releases every listener still open; safe to call when none are. */
    clear(): void {
      for (const unsubscribe of listeners) unsubscribe();
      listeners.clear();
    },
  };
}

export type ChangeSubscriptions = ReturnType<typeof createChangeSubscriptions>;
