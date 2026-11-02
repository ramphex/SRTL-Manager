import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Server } from "lucide-react";

// Shown by features that read Plex or Jellyfin (watch sync, Now Playing, invitations) until a server is connected.
export function MediaServersRequired({ title = "No media server connected", children }: { title?: string; children?: ReactNode }) {
  return <section className="media-servers-required" role="status" aria-label={title}>
    <Server size={24} aria-hidden="true" />
    <div>
      <h2>{title}</h2>
      <p>Connect a Plex or Jellyfin server in Settings &gt; Media servers.</p>
      {children}
    </div>
    <Link to="/settings/media-servers" className="media-servers-required-link"><ArrowRight size={16} />Open Media servers</Link>
  </section>;
}
