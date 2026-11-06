import { Link } from "@tanstack/react-router";
import { ArrowLeft, ShieldX } from "lucide-react";
import { useAccess } from "./access";
import { roleLabels } from "../shared/permissions";

export function NotAllowed() {
  const { role } = useAccess();
  return (
    <div className="page-stack">
      <section className="not-allowed" role="alert" aria-label="Not allowed">
        <ShieldX size={24} aria-hidden="true" />
        <div>
          <h1>Not allowed</h1>
          <p>Your {roleLabels[role].toLowerCase()} account cannot open this page. Ask an admin if you need something here.</p>
          <Link to="/" className="media-servers-required-link"><ArrowLeft size={16} />Back to the dashboard</Link>
        </div>
      </section>
    </div>
  );
}
