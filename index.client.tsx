import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { AutoResumeScreen } from "./client/screen";
import { ProviderSettingsScreen } from "./client/settings";
import { installConversationControls } from "./client/conversations";
import { ConversationControls } from "./client/conversation";

// Same ID as the 0.10 sidebar item, so saved `/plugin/usage-auto-resume/scheduled` links keep opening it.
const SCREEN_ID = "scheduled";

function AutoResumeItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="AlarmClock"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const removeConversations = installConversationControls(client, ConversationControls);
  const removeSettings = client.addSettingsScreen({
    id: "providers",
    title: "Settings",
    icon: "AlarmClock",
    Component: ProviderSettingsScreen,
  });
  const removeScreen = client.addScreen({ id: SCREEN_ID, title: "Auto Resume", Component: AutoResumeScreen });
  const removeSidebarItem = client.addSidebarHeaderItem({ id: SCREEN_ID, title: "Auto Resume", Component: AutoResumeItem });
  return async () => {
    removeConversations();
    await removeSettings();
    await removeSidebarItem();
    await removeScreen();
  };
}
