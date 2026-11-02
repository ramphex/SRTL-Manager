import type { SonarrState } from "../shared/sonarr";
import { api } from "./api";
import { ArrSettingsPanel, type ArrUiService } from "./arrSettings";

const sonarrService: ArrUiService = {
  key: "sonarr",
  name: "Sonarr",
  sectionType: "shows",
  sectionTypeLabel: "Shows",
  sectionKind: "show-type",
  urlPlaceholder: "http://sonarr:8989",
  instanceExamples: "1080p, 4K, or anime",
  titles: (state) => (state as SonarrState).series.map((series) => ({ ...series, id: series.seriesId })),
  setupMonitoring: "copying episodes to local can unmonitor those episodes in Sonarr, and copying them back to remote monitors them again. The series stays monitored, so new episodes still arrive.",
  monitoringHelp: (local, remote) => `SRTL checks each episode file as soon as it is copied and verified. Copying to ${local} unmonitors the episodes in that file in Sonarr and copying to ${remote} monitors them again; the series itself stays monitored so new episodes still download. Episodes whose files failed to copy are skipped. Copies started without the option never change monitoring.`,
  monitoringLede: (local, remote) => `Copying episodes to ${local} can unmonitor them in Sonarr, and copying them to ${remote} monitors them again. The series stays monitored.`,
  webhookTriggers: ["On File Import", "On File Upgrade", "On Rename", "On Series Add", "On Series Delete", "On Episode File Delete"],
  api: {
    overview: api.getSonarrOverview,
    get: api.getSonarr,
    create: api.createSonarrInstance,
    rename: api.renameSonarrInstance,
    remove: api.removeSonarrInstance,
    save: api.saveSonarr,
    test: api.testSonarr,
    refresh: api.refreshSonarr,
    reconcile: api.reconcileSonarr
  }
};

export function SonarrSettingsPanel({ active }: { active: boolean }) {
  return <ArrSettingsPanel service={sonarrService} active={active} />;
}
