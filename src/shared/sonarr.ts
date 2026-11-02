import { arrInstanceLimit, type ArrConnectionTest, type ArrCopyDefaults, type ArrEventStatus, type ArrMonitorUpdateStatus, type ArrSettings, type ArrSettingsInput, type ArrTitleStatus } from "./arr";

export type SonarrSettingsInput = ArrSettingsInput;
export type SonarrSettings = ArrSettings;
export const sonarrInstanceLimit = arrInstanceLimit;

export interface SonarrSeriesStatus extends ArrTitleStatus {
  seriesId: number;
  tvdbId: number;
}

export interface SonarrEventStatus extends ArrEventStatus {
  seriesId: number;
}

// Copy monitoring changes single episodes; the series itself stays monitored so new episodes still arrive.
export interface SonarrMonitorUpdateStatus extends ArrMonitorUpdateStatus {
  seriesId: number;
  episodeId: number;
}

export interface SonarrState {
  settings: SonarrSettings;
  series: SonarrSeriesStatus[];
  events: SonarrEventStatus[];
  monitorUpdates: SonarrMonitorUpdateStatus[];
}

export interface SonarrInstanceSummary {
  settings: SonarrSettings;
  series: number;
  mapped: number;
  review: number;
  errors: number;
}

export interface SonarrOverview {
  instances: SonarrInstanceSummary[];
  limit: number;
}

export type SonarrCopyDefaults = ArrCopyDefaults;
export type SonarrConnectionTest = ArrConnectionTest;
