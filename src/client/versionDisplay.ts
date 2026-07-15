import type { AppVersionInfo } from "../shared/types";

export interface CurrentVersionDisplay {
  version: string;
  channel: string;
}

export function formatCurrentVersionDisplay(info: AppVersionInfo): CurrentVersionDisplay {
  const parsed = /^(.+?)-([0-9A-Za-z.-]+)$/.exec(info.currentVersion);
  const prereleaseParts = parsed?.[2].split(".").filter(Boolean) ?? [];
  const channelPartIndex = prereleaseParts.findIndex((part) => part.toLowerCase() === info.currentChannel);

  if (!parsed || channelPartIndex === -1) {
    return {
      version: info.currentVersion,
      channel: info.currentChannelLabel
    };
  }

  const channelSuffix = prereleaseParts.slice(channelPartIndex + 1).join(".");

  return {
    version: parsed[1],
    channel: channelSuffix ? `${info.currentChannelLabel} ${channelSuffix}` : info.currentChannelLabel
  };
}
