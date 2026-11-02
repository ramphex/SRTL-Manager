import { useState } from "react";
import { RadarrSettingsPanel } from "./radarrSettings";
import { SettingsTabs } from "./settingsTabs";

const integrations = [
  { key: "Radarr", label: "Radarr" },
  { key: "Sonarr", label: <>Sonarr<small>Coming soon</small></> }
] as const;

export function IntegrationSettings() {
  const [active, setActive] = useState<(typeof integrations)[number]["key"]>("Radarr");
  return <div className="integration-settings">
    <SettingsTabs label="Integrations" idPrefix="integration" tabs={integrations} active={active} onSelect={setActive} />
    <div role="tabpanel" id="integration-panel-Radarr" aria-labelledby="integration-tab-Radarr" hidden={active !== "Radarr"}>
      <RadarrSettingsPanel active={active === "Radarr"} />
    </div>
    <div role="tabpanel" id="integration-panel-Sonarr" aria-labelledby="integration-tab-Sonarr" hidden={active !== "Sonarr"} tabIndex={0}>
      <h2>Sonarr</h2>
      <p className="muted">Coming soon. Sonarr integration is not available yet.</p>
    </div>
  </div>;
}
