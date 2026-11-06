import type { PoolClient } from "pg";

/** Serialises first-run setup and every account change, including the owner check at commit. */
export const accountsLockKey = 1_558_042_911;

/**
 * Adds roles to the existing account table and lifts the one-row limit it had.
 * The existing account becomes the owner and keeps its password and sessions.
 *
 * Exactly one owner is held by the database: a unique index allows at most one,
 * and a trigger checked at commit refuses a transaction that leaves none. An
 * empty table is allowed, so setup can still run on a new install.
 */
export async function applyAccountsMigration(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS admin_users (id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)`);
  await client.query(`ALTER TABLE admin_users
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'moderator',
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS created_by TEXT,
    ADD COLUMN IF NOT EXISTS disabled_at TEXT,
    ADD COLUMN IF NOT EXISTS disabled_by TEXT,
    ADD COLUMN IF NOT EXISTS last_sign_in_at TEXT`);
  await client.query(`DROP INDEX IF EXISTS admin_users_singleton_idx`);
  await client.query(`UPDATE admin_users SET role = CASE WHEN id = (SELECT min(id) FROM admin_users) THEN 'owner' ELSE 'admin' END`);
  await client.query(`ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check CHECK (role IN ('owner', 'admin', 'moderator'))`);
  await client.query(`ALTER TABLE admin_users ADD CONSTRAINT admin_users_owner_enabled_check CHECK (role <> 'owner' OR disabled_at IS NULL)`);
  await client.query(`CREATE UNIQUE INDEX admin_users_single_owner_idx ON admin_users ((true)) WHERE role = 'owner'`);
  await client.query(`CREATE UNIQUE INDEX admin_users_username_lower_idx ON admin_users (lower(username))`);
  await client.query(`CREATE FUNCTION admin_users_require_one_owner() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE accounts bigint; owners bigint;
    BEGIN
      PERFORM pg_advisory_xact_lock(${accountsLockKey});
      SELECT count(*), count(*) FILTER (WHERE role = 'owner') INTO accounts, owners FROM admin_users;
      IF accounts > 0 AND owners <> 1 THEN
        RAISE EXCEPTION 'There must be exactly one owner account' USING ERRCODE = '23514';
      END IF;
      RETURN NULL;
    END $$`);
  await client.query(`CREATE CONSTRAINT TRIGGER admin_users_one_owner AFTER INSERT OR UPDATE OF role OR DELETE ON admin_users
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION admin_users_require_one_owner()`);
}
