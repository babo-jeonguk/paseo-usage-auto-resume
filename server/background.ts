import type { PaseoAgent, PaseoApi } from "./paseo-types";
import { throwIfConnectionClosed } from "./connection";

type WorkspaceReader = Pick<PaseoApi, "workspaces">;

/**
 * Whether Paseo hides the agent as background: `agent.background || workspace.background`. Both
 * flags are fixed at creation, so one workspace read per agent is enough.
 *
 * The hook payload carries the agent's own background flag but not its workspace's, so callers pass
 * the agent snapshot they load. When this workspace alone cannot be read, it is reported and the
 * agent's own flag decides. A daemon connection the session lost is not an unreadable workspace:
 * it says nothing about any agent, so it is rethrown for the caller to stop on.
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
    throwIfConnectionClosed(error);
    onWorkspaceError(workspaceId, error);
    return false;
  }
}
