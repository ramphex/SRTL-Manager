import { useRef, useState } from "react";
import { RadarrSettingsPanel } from "./radarrSettings";

const integrations = ["Radarr", "Sonarr"] as const;

export function IntegrationSettings() {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  return <div className="integration-settings">
    <div className="integration-tabs" role="tablist" aria-label="Integrations">
      {integrations.map((name, index) => <button key={name} type="button" role="tab" id={`integration-tab-${name}`} aria-controls={`integration-panel-${name}`} aria-selected={active === index} tabIndex={active === index ? 0 : -1} ref={(element) => { tabs.current[index] = element; }} onClick={() => setActive(index)} onKeyDown={(event) => {
        let next: number;
        if (event.key === "ArrowRight") next = (index + 1) % integrations.length;
        else if (event.key === "ArrowLeft") next = (index + integrations.length - 1) % integrations.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = integrations.length - 1;
        else return;
        event.preventDefault();
        setActive(next);
        tabs.current[next]?.focus();
      }}>{name}{name === "Sonarr" ? <small>Coming soon</small> : null}</button>)}
    </div>
    <div role="tabpanel" id="integration-panel-Radarr" aria-labelledby="integration-tab-Radarr" hidden={active !== 0}>
      <RadarrSettingsPanel active={active === 0} />
    </div>
    <div role="tabpanel" id="integration-panel-Sonarr" aria-labelledby="integration-tab-Sonarr" hidden={active !== 1} tabIndex={0}>
      <h2>Sonarr</h2>
      <p className="muted">Coming soon. Sonarr integration is not available yet.</p>
    </div>
  </div>;
}
