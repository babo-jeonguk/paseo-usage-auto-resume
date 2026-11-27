/** The label Paseo sets on a subagent, holding the ID of the agent that manages it. */
const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

/**
 * Whether Paseo made this agent a subagent: its labels name a parent, or the turn that just ended
 * carries one. A blank label or ID is not a subagent, so an older record or an empty value from
 * another plugin still schedules normally.
 */
export function isSubagent(agent: {
  labels?: Readonly<Record<string, string>> | null;
  parentAgentId?: string | null;
}): boolean {
  return !!agent.labels?.[PARENT_AGENT_LABEL]?.trim() || !!agent.parentAgentId?.trim();
}
