import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { jobStoppableWithoutDeleting, roleHasPermission, type AccountRole, type Permission } from "../shared/permissions";
import type { JobRecord } from "../shared/types";

/**
 * What to show this person. The server enforces every one of these on its own;
 * this only keeps controls that would be refused off the screen. While the role
 * is unknown nothing extra is offered.
 */
export function useAccess(): { role: AccountRole; can: (permission: Permission) => boolean; canStopJob: (job: Pick<JobRecord, "type" | "options">) => boolean } {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const role = me.data?.user?.role ?? "moderator";
  const can = (permission: Permission) => roleHasPermission(role, permission);
  return { role, can, canStopJob: (job) => can("library.delete") || jobStoppableWithoutDeleting(job) };
}
