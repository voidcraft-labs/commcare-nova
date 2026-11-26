// Each destination binds a logical project search to its own HQ service.
// HQ's CaseSearchEndpoint.id is a Django AutoField, a signed 32-bit integer.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE public.app_deployment_search_bindings (
			deployment_id uuid NOT NULL REFERENCES public.app_deployments(id) ON DELETE CASCADE,
			search_uuid uuid NOT NULL,
			endpoint_id integer NOT NULL CHECK (endpoint_id > 0),
			PRIMARY KEY (deployment_id, search_uuid),
			UNIQUE (deployment_id, endpoint_id)
		)
	`.execute(db);
	// One export generation per affected app and statement. A bulk rotate can
	// otherwise create tens of thousands of versions of the same generation row
	// before the transaction commits.
	await sql`
		CREATE FUNCTION public.nova_invalidate_search_targets() RETURNS trigger
		LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
		DECLARE destinations uuid[];
		BEGIN
			IF TG_OP = 'UPDATE' THEN
				destinations := ARRAY(
					SELECT deployment_id FROM changed_search_bindings
					UNION
					SELECT deployment_id FROM previous_search_bindings
				);
			ELSE
				destinations := ARRAY(SELECT DISTINCT deployment_id FROM changed_search_bindings);
			END IF;
			INSERT INTO public.export_target_versions(project_id, app_id)
			SELECT DISTINCT project_id, app_id
				FROM public.app_deployments
				WHERE id = ANY(destinations)
				ORDER BY project_id, app_id
			ON CONFLICT (project_id, app_id) DO UPDATE
				SET revision = public.export_target_versions.revision + 1;
			RETURN NULL;
		END $$
	`.execute(db);
	await sql`
		CREATE TRIGGER nova_invalidate_search_targets_insert
		AFTER INSERT ON public.app_deployment_search_bindings
		REFERENCING NEW TABLE AS changed_search_bindings
		FOR EACH STATEMENT EXECUTE FUNCTION public.nova_invalidate_search_targets()
	`.execute(db);
	await sql`
		CREATE TRIGGER nova_invalidate_search_targets_delete
		AFTER DELETE ON public.app_deployment_search_bindings
		REFERENCING OLD TABLE AS changed_search_bindings
		FOR EACH STATEMENT EXECUTE FUNCTION public.nova_invalidate_search_targets()
	`.execute(db);
	await sql`
		CREATE TRIGGER nova_invalidate_search_targets_update
		AFTER UPDATE ON public.app_deployment_search_bindings
		REFERENCING OLD TABLE AS previous_search_bindings NEW TABLE AS changed_search_bindings
		FOR EACH STATEMENT EXECUTE FUNCTION public.nova_invalidate_search_targets()
	`.execute(db);
	await sql`REVOKE EXECUTE ON FUNCTION public.nova_invalidate_search_targets() FROM PUBLIC`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE public.app_deployment_search_bindings`.execute(db);
	await sql`DROP FUNCTION public.nova_invalidate_search_targets()`.execute(db);
}
