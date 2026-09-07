import { type Kysely, sql } from "kysely";

/** A push is an acknowledgement, not a millisecond or source revision.
 * Existing mappings receive independent identities. The trigger also covers
 * writers that predate this column and same-value UPDATEs from a republish.
 * Observing a remote revision or superseding a mapping does not rotate it. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE app_deployment_resources
		ADD COLUMN push_token uuid NOT NULL DEFAULT uuidv7()`.execute(db);
	await sql`CREATE FUNCTION rotate_deployment_push_token() RETURNS trigger
		LANGUAGE plpgsql AS $$
		BEGIN
			NEW.push_token := uuidv7();
			RETURN NEW;
		END;
		$$`.execute(db);
	await sql`CREATE TRIGGER app_deployment_resources_push_token
		BEFORE UPDATE OF pushed_at, pushed_revision, remote_id
		ON app_deployment_resources FOR EACH ROW
		EXECUTE FUNCTION rotate_deployment_push_token()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TRIGGER app_deployment_resources_push_token
		ON app_deployment_resources`.execute(db);
	await sql`DROP FUNCTION rotate_deployment_push_token()`.execute(db);
	await sql`ALTER TABLE app_deployment_resources DROP COLUMN push_token`.execute(
		db,
	);
}
