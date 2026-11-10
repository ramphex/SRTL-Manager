import type { PoolClient } from "pg";

/** Adds job types to whatever the constraint already allows, so it composes with other migrations that extend it. */
export async function addJobTypes(client: PoolClient, added: string[]): Promise<void> {
  for (const type of added) {
    if (!/^[a-z_]+$/.test(type)) throw new Error(`Invalid job type ${type}`);
  }
  await client.query(
    `DO $$
  DECLARE definition text; types text[]; added text[] := ARRAY[${added.map((type) => `'${type}'`).join(", ")}]::text[]; missing text[];
  BEGIN
    IF to_regclass('public.jobs') IS NULL THEN RETURN; END IF;
    SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conname = 'jobs_type_check' AND conrelid = 'jobs'::regclass;
    IF definition IS NULL THEN RETURN; END IF;
    SELECT array_agg(match[1]) INTO types FROM regexp_matches(definition, '''([a-z_]+)''', 'g') AS match;
    SELECT array_agg(value) INTO missing FROM unnest(added) AS value WHERE NOT value = ANY(types);
    IF missing IS NULL THEN RETURN; END IF;
    types := types || missing;
    ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
    EXECUTE format('ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN (%s))', (SELECT string_agg(quote_literal(value), ', ') FROM unnest(types) AS value));
  END $$`
  );
}

/** Restoring held orphans and discarding partial copies run in the worker, which has write access to storage. */
export async function applyWorkerFileJobsMigration(client: PoolClient): Promise<void> {
  await addJobTypes(client, ["orphan_restore", "partial_copy_discard"]);
}
