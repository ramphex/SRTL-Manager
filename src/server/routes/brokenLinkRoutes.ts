import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PathsSettings } from "../../shared/types";
import { getJsonSetting, type Db } from "../db/database";
import { ConflictError } from "../errors";
import { recordActionAudit } from "../lib/actionAudit";
import {
  brokenLinkCleanupResults,
  brokenLinkMountChecks,
  brokenLinkTargetRoot,
  listBrokenLinkReview,
  listRemovedBrokenLinks,
  mountWarning,
  removedBrokenLinks,
  requestRescansForRemovedLinks
} from "../lib/brokenLinks";
import type { JobRunner } from "../jobs/jobRunner";
import { arrDiskCheckState, requestRescansForArrMismatches } from "../lib/arrDiskCheck";

const idList = z.array(z.number().int().positive()).min(1).max(50_000);

export function registerBrokenLinkRoutes(app: FastifyInstance, db: Db, jobs: JobRunner): void {
  app.get("/api/broken-links", async () => listBrokenLinkReview(db));

  app.get("/api/broken-links/removed", async () => listRemovedBrokenLinks(db));

  app.get("/api/broken-links/jobs/:id", async (request) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    return brokenLinkCleanupResults(db, params.id);
  });

  app.post("/api/broken-links/delete", { bodyLimit: 4 * 1024 * 1024 }, async (request) => {
    const body = z
      .object({
        mediaLinkIds: idList,
        // After the delete, ask Radarr or Sonarr to rescan each affected title.
        rescan: z.boolean().default(true),
        // Also search for the removed items. Off unless chosen.
        search: z.boolean().default(false)
      })
      .parse(request.body);
    const mediaLinkIds = [...new Set(body.mediaLinkIds)];
    const jobId = await jobs.startBrokenLinkCleanup(mediaLinkIds, { rescan: body.rescan, search: body.search });
    await recordActionAudit(db, request, {
      action: "broken_link.delete",
      summary: `Deleted ${mediaLinkIds.length} broken library symlink(s)${body.rescan ? ", then asked Radarr/Sonarr to rescan" : ""}${body.search ? ", with a search" : ""}`,
      jobId,
      targets: { jobId, mediaLinkIds, rescan: body.rescan, search: body.search }
    });
    return { jobId };
  });

  // Rescans titles whose broken links were removed earlier. A rescan while the broken link is still there fails in Sonarr,
  // so the links still listed as broken are not offered here.
  app.post("/api/broken-links/rescan", { bodyLimit: 1024 * 1024 }, async (request) => {
    const body = z.object({ operationIds: idList, search: z.boolean().default(false) }).parse(request.body);
    const operationIds = [...new Set(body.operationIds)];
    const records = await removedBrokenLinks(db, operationIds);
    if (records.length === 0) throw new ConflictError("None of the chosen links were removed by a broken link cleanup");
    const paths = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
    // A rescan while storage is down would show every file on it as missing.
    const down = (await brokenLinkMountChecks(paths, records.map((record) => brokenLinkTargetRoot(paths, record.targetPath)))).filter((check) => !check.mounted);
    if (down.length) throw new ConflictError(down.map(mountWarning).join(" "));
    const result = await requestRescansForRemovedLinks(db, operationIds, body.search);
    await recordActionAudit(db, request, {
      action: "broken_link.rescan",
      summary: `Asked Radarr/Sonarr to rescan ${result.asked} title(s) for removed broken links${body.search ? `, and to search for ${result.searched} item(s)` : ""}`,
      targets: { operationIds, search: body.search, asked: result.asked, searched: result.searched, notMatched: result.notMatched }
    });
    return result;
  });

  // Sonarr and Radarr file records with nothing in the library, from the newest check.
  app.get("/api/broken-links/arr-missing", async () => arrDiskCheckState(db));

  app.post("/api/broken-links/arr-missing/check", async () => ({ jobId: await jobs.startArrDiskCheck("manual") }));

  app.post("/api/broken-links/arr-missing/rescan", { bodyLimit: 1024 * 1024 }, async (request) => {
    const body = z.object({ ids: idList, search: z.boolean().default(false) }).parse(request.body);
    const state = await arrDiskCheckState(db);
    if (state.hiddenBecauseStorageDown) throw new ConflictError("Storage looks down, so Radarr and Sonarr are not asked to rescan. Try again once it is back.");
    const ids = [...new Set(body.ids)];
    const result = await requestRescansForArrMismatches(db, ids, body.search);
    if (result.titles === 0) throw new ConflictError("None of the chosen records are listed any more. Reload the list.");
    await recordActionAudit(db, request, {
      action: "broken_link.rescan",
      summary: `Asked Radarr/Sonarr to rescan ${result.asked} title(s) whose records have nothing on disk${body.search ? `, and to search for ${result.searched} item(s)` : ""}`,
      targets: { arrMismatchIds: ids, search: body.search, asked: result.asked, searched: result.searched, notMatched: result.notMatched }
    });
    return result;
  });
}
