import type { PoolClient } from "pg";

/** Adds backup to whatever job types the constraint already allows, so it composes with other migrations that extend it. */
export async function applyBackupMigration(client: PoolClient): Promise<void> {
  await client.query(`DO $$
  DECLARE definition text; types text[];
  BEGIN
    IF to_regclass('public.jobs') IS NULL THEN RETURN; END IF;
    SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conname = 'jobs_type_check' AND conrelid = 'jobs'::regclass;
    IF definition IS NULL OR position('''backup''' in definition) > 0 THEN RETURN; END IF;
    SELECT array_agg(match[1]) INTO types FROM regexp_matches(definition, '''([a-z_]+)''', 'g') AS match;
    types := array_append(types, 'backup');
    ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
    EXECUTE format('ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN (%s))', (SELECT string_agg(quote_literal(value), ', ') FROM unnest(types) AS value));
  END $$`);
}
