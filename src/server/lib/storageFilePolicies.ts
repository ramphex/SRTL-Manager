import { sql } from "drizzle-orm";
import { nowIso, type DbExecutor } from "../db/database";

export async function reconcileStorageFilePolicies(db: DbExecutor, timestamp = nowIso()): Promise<void> {
  await db.execute(sql`
    with desired_policies as (
      select
        storage_files.id,
        case
          when count(distinct media_links.storage_policy) = 1 then min(media_links.storage_policy)
          else 'unassigned'
        end as storage_policy
      from storage_files
      left join media_links
        on media_links.resolved_storage_file_id = storage_files.id
       and media_links.missing_since is null
      group by storage_files.id
    )
    update storage_files
    set storage_policy = desired_policies.storage_policy,
        updated_at = ${timestamp}
    from desired_policies
    where storage_files.id = desired_policies.id
      and storage_files.storage_policy is distinct from desired_policies.storage_policy
  `);
}
