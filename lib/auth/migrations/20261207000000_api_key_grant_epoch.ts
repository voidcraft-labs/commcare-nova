import { type Kysely, sql } from "kysely";

/** Only changes to a key's authority invalidate retained downloads and
 * source readings. Better Auth updates usage counters on ordinary requests. */
export async function up(db: Kysely<unknown>) {
	await sql`CREATE TABLE auth_apikey_grant_epoch (
		key_id text PRIMARY KEY REFERENCES auth_apikey(id) ON DELETE CASCADE,
		epoch uuid NOT NULL
	)`.execute(db);
	// The serving revision writes the tables this trigger fires on before
	// convergence grants it the ledger this migration creates, so the function
	// writes that ledger as its owner, through schema-qualified names only.
	await sql`CREATE FUNCTION nova_rotate_api_key_grant() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
	BEGIN
		IF TG_OP='INSERT' OR ROW(OLD.key,OLD."referenceId",OLD."configId",OLD.enabled,OLD."expiresAt",OLD.permissions)
			IS DISTINCT FROM ROW(NEW.key,NEW."referenceId",NEW."configId",NEW.enabled,NEW."expiresAt",NEW.permissions)
		THEN INSERT INTO public.auth_apikey_grant_epoch(key_id,epoch) VALUES (NEW.id,gen_random_uuid())
			ON CONFLICT(key_id) DO UPDATE SET epoch=EXCLUDED.epoch;
		END IF;
		RETURN NULL;
	END $$`.execute(db);
	await sql`CREATE TRIGGER nova_rotate_api_key_grant AFTER INSERT OR UPDATE OF key,"referenceId","configId",enabled,"expiresAt",permissions
		ON auth_apikey FOR EACH ROW EXECUTE FUNCTION nova_rotate_api_key_grant()`.execute(
		db,
	);
}
export async function down(db: Kysely<unknown>) {
	await sql`DROP TRIGGER nova_rotate_api_key_grant ON auth_apikey`.execute(db);
	await sql`DROP FUNCTION nova_rotate_api_key_grant()`.execute(db);
	await db.schema.dropTable("auth_apikey_grant_epoch").execute();
}
