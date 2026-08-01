import { sql, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";

export function unresolvedCopyReconciliation(): SQL {
  return sql`
    ${schema.copyOperations.stage} = 'reconciliation_required'
    AND NOT EXISTS (
      SELECT 1
      FROM copy_operations AS superseding_operation
      WHERE superseding_operation.id > ${schema.copyOperations.id}
        AND superseding_operation.media_link_id = ${schema.copyOperations.mediaLinkId}
        AND superseding_operation.link_path = ${schema.copyOperations.linkPath}
        AND superseding_operation.stage = 'committed'
        AND superseding_operation.result_status IN ('copied', 'repointed')
    )
  `;
}
