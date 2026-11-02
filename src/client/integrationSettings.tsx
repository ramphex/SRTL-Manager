import { useState } from "react";
import { RadarrSettingsPanel } from "./radarrSettings";
import { SettingsTabs } from "./settingsTabs";
import { SonarrSettingsPanel } from "./sonarrSettings";

const integrations = [
  { key: "Radarr", label: "Radarr" },
  { key: "Sonarr", label: "Sonarr" }
] as const;

export function IntegrationSettings() {
  const [active, setActive] = useState<(typeof integrations)[number]["key"]>("Radarr");
  // Sonarr loads when its tab is first opened and then stays mounted, so switching back keeps unsaved edits.
  const [sonarrOpened, setSonarrOpened] = useState(false);
  const select = (key: (typeof integrations)[number]["key"]) => {
    if (key === "Sonarr") setSonarrOpened(true);
    setActive(key);
  };
  return <div className="integration-settings">
    <SettingsTabs label="Integrations" idPrefix="integration" tabs={integrations} active={active} onSelect={select} />
    <div role="tabpanel" id="integration-panel-Radarr" aria-labelledby="integration-tab-Radarr" hidden={active !== "Radarr"}>
      <RadarrSettingsPanel active={active === "Radarr"} />
    </div>
    <div role="tabpanel" id="integration-panel-Sonarr" aria-labelledby="integration-tab-Sonarr" hidden={active !== "Sonarr"}>
      {sonarrOpened ? <SonarrSettingsPanel active={active === "Sonarr"} /> : null}
    </div>
  </div>;
}
