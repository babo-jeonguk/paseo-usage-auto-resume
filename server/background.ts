import type { PaseoAgent, PaseoApi } from "./paseo-types";

type WorkspaceReader = Pick<PaseoApi, "workspaces">;

/**
 * Whether Paseo hides the agent as background: `agent.background || workspace.background`. Both
 * flags are fixed at creation, so one workspace read per agent is enough.
 *
 * The hook payload carries no background field, so callers pass the agent snapshot they load. A
 * workspace that cannot be read is reported and leaves the agent's own flag to decide.
 */
export async function readBackground(
  api: WorkspaceReader,
  agent: Pick<PaseoAgent, "background" | "workspaceId">,
  onWorkspaceError: (workspaceId: string, error: unknown) => void,
): Promise<boolean> {
  if (agent.background) return true;
  const workspaceId = agent.workspaceId;
  if (!workspaceId) return false;
  try {
    const workspace = await api.workspaces.ref(workspaceId).refresh();
    return !!workspace?.background;
  } catch (error) {
    onWorkspaceError(workspaceId, error);
    return false;
  }
}
