import type { RadarrState } from "../shared/radarr";
import { api } from "./api";
import { ArrSettingsPanel, type ArrUiService } from "./arrSettings";

const radarrService: ArrUiService = {
  key: "radarr",
  name: "Radarr",
  sectionType: "movies",
  sectionTypeLabel: "Movies",
  sectionKind: "movie-type",
  urlPlaceholder: "http://radarr:7878",
  instanceExamples: "1080p, 4K, anime, or remuxes",
  titles: (state) => (state as RadarrState).movies.map((movie) => ({ ...movie, id: movie.movieId })),
  setupMonitoring: "copying a movie to local can unmonitor it in Radarr, and copying it back to remote monitors it again.",
  monitoringHelp: (local, remote) => `After a copy finishes, SRTL checks each mapped movie in it. When every file of the movie reached the destination, copying to ${local} unmonitors it in Radarr and copying to ${remote} monitors it again. Movies with failed files are skipped. Copies started without the option never change monitoring.`,
  monitoringLede: (local, remote) => `Copying a movie to ${local} can unmonitor it in Radarr, and copying it to ${remote} monitors it again.`,
  webhookTriggers: ["On File Import", "On File Upgrade", "On Rename", "On Movie Added", "On Movie Delete", "On Movie File Delete"],
  api: {
    overview: api.getRadarrOverview,
    get: api.getRadarr,
    create: api.createRadarrInstance,
    rename: api.renameRadarrInstance,
    remove: api.removeRadarrInstance,
    save: api.saveRadarr,
    test: api.testRadarr,
    refresh: api.refreshRadarr,
    reconcile: api.reconcileRadarr
  }
};

export function RadarrSettingsPanel({ active }: { active: boolean }) {
  return <ArrSettingsPanel service={radarrService} active={active} />;
}
