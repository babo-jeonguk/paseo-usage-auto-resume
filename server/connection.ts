/**
 * Whether an error says the daemon closed the plugin's connection, rather than that one read or
 * send failed. A closed connection is a fact about the session: nothing more can be read or sent,
 * so a fallback value, a decision or an error log derived from it would be wrong. Catches that
 * turn a daemon failure into a fallback must let this one propagate, and the operation boundary
 * that sees it stops.
 *
 * The client throws `DaemonConnectionError` for a lost transport and a plain
 * `Error("Daemon client closed")` once its own runtime is closed.
 */
export function isConnectionClosed(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "DaemonConnectionError"
    || error.message === "Daemon client closed"
    || error.message.startsWith("Transport not connected");
}

/**
 * Called from a catch that has a fallback for one unreadable item: a closed connection is not
 * that item's failure, so it is rethrown unchanged for the operation boundary to handle.
 */
export function throwIfConnectionClosed(error: unknown): void {
  if (isConnectionClosed(error)) throw error;
}
