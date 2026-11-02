import { arrInstanceLimit, generateWebhookSecret, type ArrConnectionTest, type ArrCopyDefaults, type ArrCopySection, type ArrEventStatus, type ArrMonitorUpdateStatus, type ArrPathMapping, type ArrRootConflict, type ArrSettings, type ArrSettingsInput, type ArrTitleStatus } from "./arr";

export type RadarrPathMapping = ArrPathMapping;
export type RadarrSettingsInput = ArrSettingsInput;
export const generateRadarrWebhookSecret = generateWebhookSecret;
export const radarrInstanceLimit = arrInstanceLimit;
export type RadarrSettings = ArrSettings;

export interface RadarrMovieStatus extends ArrTitleStatus {
  movieId: number;
  tmdbId: number;
}

export interface RadarrEventStatus extends ArrEventStatus {
  movieId: number;
}

export interface RadarrMonitorUpdateStatus extends ArrMonitorUpdateStatus {
  movieId: number;
}

export interface RadarrState {
  settings: RadarrSettings;
  movies: RadarrMovieStatus[];
  events: RadarrEventStatus[];
  monitorUpdates: RadarrMonitorUpdateStatus[];
}

export interface RadarrInstanceSummary {
  settings: RadarrSettings;
  movies: number;
  mapped: number;
  review: number;
  errors: number;
}

export interface RadarrOverview {
  instances: RadarrInstanceSummary[];
  limit: number;
}

export type RadarrCopySection = ArrCopySection;
export type RadarrCopyDefaults = ArrCopyDefaults;
export type RadarrRootConflict = ArrRootConflict;
export type RadarrConnectionTest = ArrConnectionTest;
