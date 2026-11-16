/** What a failed settings save was trying to do, in the user's words. */
export type SaveTarget = { kind: "switch"; label: string; on: boolean } | { kind: "named"; name: string } | { kind: "unknown" };

/** A failed save as the user sees it. The raw error stays out of it; log that instead. */
export interface SaveFailure {
  message: string;
  /** The save raced another client's change; the user must reload before retrying. */
  reload: boolean;
}

// Paseo reports a revision conflict ("Settings changed on another client. Reload before saving again.") and a schema-version mismatch ("Reload or reset settings before saving a different schema version") only as text; both ask for a reload.
const CONFLICT = /changed on another client|before saving a different schema version/i;

export function saveFailure(error: string | null, target: SaveTarget): SaveFailure {
  if (error && CONFLICT.test(error)) {
    return { message: "Settings changed elsewhere. Reload and try again.", reload: true };
  }
  const message =
    target.kind === "switch"
      ? `Couldn’t turn ${target.on ? "on" : "off"} ${target.label}. Try again.`
      : target.kind === "named"
        ? `Couldn’t save the ${target.name}. Try again.`
        : "Couldn’t save the setting. Try again.";
  return { message, reload: false };
}
