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
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE public.app_deployment_search_bindings`.execute(db);
}
