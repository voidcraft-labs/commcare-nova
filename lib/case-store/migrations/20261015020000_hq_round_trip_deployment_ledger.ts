// The deployment ledger the HQ round trip reads and writes, all of it
// additive, so a revision that predates it runs over it unchanged.
//
//   (a) `app_deployment_resources.remote_missing_at`: the explicit "CommCare
//       HQ reports this app gone" fact, with a backfill that keeps every
//       existing deployment on the path it is on today. The column is outside
//       the push-token trigger's column list
//       (`20260906000000_deployment_push_tokens.ts`), so writing it rotates no
//       push token.
//   (b) `app_deployments.offered_logo_content_hash`: the logo the deployment
//       last told a person to upload in CommCare HQ, by content hash, which a
//       Project move's asset remap leaves meaningful.
//   (b2) `app_deployments.target_empty_case_list_text`: whether the project
//       space's empty-list text flag was on when the last publish read it.
//   (b3) `app_deployments.target_web_apps_enabled`: whether the HQ app had Web
//       Apps on when the last landed publish read it.
//   (c) `app_deployment_identities`: ids a target holds that are not Nova's
//       derivation. Only a migration writes them, as the migration role.
//   (d) `app_deployment_confirmations`: what a person confirmed about one
//       project space, for one app; withdrawn, never deleted.
//   (e) `app_deployment_baselines`: the app as CommCare HQ returned it when
//       Nova last read it, gzip `bytea` in a table of its own, because `jsonb`
//       refuses `\u0000` and no status read may load an app source. It has no
//       form-id column: no publish reads form ids back.
//   (f) `project_space_resource_baselines`: a lookup table or place as
//       CommCare HQ returned it, keyed by the HQ resource, so two apps whose
//       live mappings name one HQ table or place share one row. Nothing
//       deletes these rows, so the future whole-tenant deletion lifecycle must
//       list this table.
//
// No table here takes a foreign key to `auth_organization` or a composite key
// touching `apps.project_id`, for the reason `20260806000000_deployments.ts`
// gives in its header.

import { type Kysely, sql } from "kysely";

const SERVERS = "'production', 'india', 'eu'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE app_deployment_resources
			ADD COLUMN remote_missing_at timestamptz(3),
			ADD CONSTRAINT app_deployment_resources_missing_is_an_apps
				CHECK (remote_missing_at IS NULL OR kind = 'app')
	`.execute(db);

	// A persisted upload failure beside a live app mapping has only ever meant
	// "gone" (`lib/deployment/resources.ts::plannedInPlaceUpdate`), because no
	// failure is persisted once a deployment displays as reached.
	await sql`
		UPDATE app_deployment_resources r
			SET remote_missing_at = now()
			FROM app_deployments d
			WHERE r.deployment_id = d.id
				AND r.kind = 'app'
				AND r.superseded_at IS NULL
				AND d.phases -> 'upload' ->> 'status' = 'failed'
	`.execute(db);

	await sql`
		ALTER TABLE app_deployments
			ADD COLUMN offered_logo_content_hash text
				CHECK (offered_logo_content_hash IS NULL
					OR btrim(offered_logo_content_hash) <> ''),
			ADD COLUMN target_empty_case_list_text boolean,
			ADD COLUMN target_web_apps_enabled boolean
	`.execute(db);

	await sql`
		CREATE TABLE app_deployment_identities (
			deployment_id uuid NOT NULL
				REFERENCES app_deployments(id) ON DELETE CASCADE,
			entity_kind text NOT NULL CHECK (entity_kind IN ('module', 'form')),
			nova_entity_uuid uuid NOT NULL,
			unique_id text CHECK (unique_id IS NULL
				OR (btrim(unique_id) <> '' AND char_length(unique_id) <= 255)),
			xmlns text CHECK (xmlns IS NULL
				OR (btrim(xmlns) <> '' AND char_length(xmlns) <= 2048)),
			recorded_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (deployment_id, entity_kind, nova_entity_uuid),
			CONSTRAINT app_deployment_identities_holds_an_override
				CHECK (unique_id IS NOT NULL OR xmlns IS NOT NULL),
			CONSTRAINT app_deployment_identities_xmlns_is_a_forms
				CHECK (xmlns IS NULL OR entity_kind = 'form')
		)
	`.execute(db);
	await sql`
		CREATE UNIQUE INDEX app_deployment_identities_unique_id
			ON app_deployment_identities (deployment_id, entity_kind, unique_id)
			WHERE unique_id IS NOT NULL
	`.execute(db);
	await sql`
		CREATE UNIQUE INDEX app_deployment_identities_xmlns
			ON app_deployment_identities (deployment_id, xmlns)
			WHERE xmlns IS NOT NULL
	`.execute(db);

	await sql`
		CREATE TABLE app_deployment_confirmations (
			id uuid PRIMARY KEY DEFAULT uuidv7(),
			deployment_id uuid NOT NULL
				REFERENCES app_deployments(id) ON DELETE CASCADE,
			kind text NOT NULL CHECK (kind IN
				('plan-feature', 'flat-location-fixture', 'connect-forwarder')),
			subject text NOT NULL CHECK (subject ~ '^[a-z][a-z0-9-]{0,63}$'),
			confirmed_by text NOT NULL CHECK (btrim(confirmed_by) <> ''),
			confirmed_at timestamptz(3) NOT NULL DEFAULT now(),
			withdrawn_by text,
			withdrawn_at timestamptz(3),
			CONSTRAINT app_deployment_confirmations_withdrawal_is_attributed
				CHECK ((withdrawn_by IS NULL) = (withdrawn_at IS NULL)),
			CONSTRAINT app_deployment_confirmations_fixture_subject
				CHECK (kind <> 'flat-location-fixture'
					OR subject = 'flat-location-fixture'),
			CONSTRAINT app_deployment_confirmations_forwarder_subject
				CHECK (kind <> 'connect-forwarder' OR subject = 'connect-forwarder')
		)
	`.execute(db);
	await sql`
		CREATE UNIQUE INDEX app_deployment_confirmations_live
			ON app_deployment_confirmations (deployment_id, kind, subject)
			WHERE withdrawn_at IS NULL
	`.execute(db);

	await sql`
		CREATE TABLE app_deployment_baselines (
			deployment_id uuid PRIMARY KEY
				REFERENCES app_deployments(id) ON DELETE CASCADE,
			remote_app_id text NOT NULL CHECK (btrim(remote_app_id) <> ''),
			origin text NOT NULL
				CHECK (origin IN ('create', 'push', 'cutover', 'unread')),
			source_gzip bytea,
			source_bytes integer CHECK (source_bytes > 0),
			source_digest text CHECK (source_digest ~ '^[0-9a-f]{64}$'),
			ownership jsonb,
			observed_at timestamptz(3) NOT NULL,
			observed_by text NOT NULL CHECK (btrim(observed_by) <> ''),
			discarded_digest text CHECK (discarded_digest ~ '^[0-9a-f]{64}$'),
			discarded_by text,
			discarded_at timestamptz(3),
			CONSTRAINT app_deployment_baselines_unread_holds_no_source CHECK (
				(origin = 'unread') = (source_gzip IS NULL)
				AND (source_gzip IS NULL) = (source_bytes IS NULL)
				AND (source_gzip IS NULL) = (source_digest IS NULL)
				AND (source_gzip IS NULL) = (ownership IS NULL)),
			CONSTRAINT app_deployment_baselines_discard_is_attributed CHECK (
				(discarded_digest IS NULL) = (discarded_by IS NULL)
				AND (discarded_by IS NULL) = (discarded_at IS NULL))
		)
	`.execute(db);

	await sql`
		CREATE TABLE project_space_resource_baselines (
			project_id text NOT NULL CHECK (btrim(project_id) <> ''),
			server text NOT NULL CHECK (server IN (${sql.raw(SERVERS)})),
			domain text NOT NULL
				CHECK (btrim(domain) <> '' AND char_length(domain) <= 255),
			kind text NOT NULL CHECK (kind IN ('lookup-table', 'location')),
			remote_id text NOT NULL CHECK (btrim(remote_id) <> ''),
			origin text NOT NULL CHECK (origin IN ('push', 'cutover', 'unread')),
			canonical jsonb,
			digest text CHECK (digest ~ '^[0-9a-f]{64}$'),
			observed_at timestamptz(3) NOT NULL,
			observed_by text NOT NULL CHECK (btrim(observed_by) <> ''),
			observed_from_app_id text NOT NULL
				CHECK (btrim(observed_from_app_id) <> ''),
			discarded_digest text CHECK (discarded_digest ~ '^[0-9a-f]{64}$'),
			discarded_by text,
			discarded_at timestamptz(3),
			PRIMARY KEY (project_id, server, domain, kind, remote_id),
			CONSTRAINT project_space_resource_baselines_unread_holds_no_content
				CHECK ((origin = 'unread') = (canonical IS NULL)
					AND (canonical IS NULL) = (digest IS NULL)),
			CONSTRAINT project_space_resource_baselines_discard_is_attributed
				CHECK ((discarded_digest IS NULL) = (discarded_by IS NULL)
					AND (discarded_by IS NULL) = (discarded_at IS NULL))
		)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE project_space_resource_baselines`.execute(db);
	await sql`DROP TABLE app_deployment_baselines`.execute(db);
	await sql`DROP TABLE app_deployment_confirmations`.execute(db);
	await sql`DROP TABLE app_deployment_identities`.execute(db);
	await sql`
		ALTER TABLE app_deployments
			DROP COLUMN target_web_apps_enabled,
			DROP COLUMN target_empty_case_list_text,
			DROP COLUMN offered_logo_content_hash
	`.execute(db);
	await sql`
		ALTER TABLE app_deployment_resources
			DROP CONSTRAINT app_deployment_resources_missing_is_an_apps,
			DROP COLUMN remote_missing_at
	`.execute(db);
}
