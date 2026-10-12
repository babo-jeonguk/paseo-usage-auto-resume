import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { AutoResumeScreen } from "./client/screen";

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
  const removeScreen = client.addScreen({ id: SCREEN_ID, title: "Auto Resume", Component: AutoResumeScreen });
  const removeSidebarItem = client.addSidebarHeaderItem({ id: SCREEN_ID, title: "Auto Resume", Component: AutoResumeItem });
  return async () => {
    await removeSidebarItem();
    await removeScreen();
  };
}
