// Durable deployment records and the CommCare HQ resources they own.
//
// Why these two tables exist:
//
//   * `app_deployments` is the answer to "what does this CommCare HQ
//     project space currently hold of this app". It is keyed by app,
//     Project, server, and domain, because all four pick out a different
//     publication: the same app in another Project is another tenant's,
//     and CommCare HQ's US, India, and EU deployments are separate
//     installations whose account databases share nothing.
//
//   * `app_deployment_resources` is the ownership ledger. Nova may only
//     repoint or update something it demonstrably created or was
//     explicitly told to adopt, so the pair (what Nova calls it, what
//     CommCare HQ calls it) has to be durable rather than re-derived from
//     a name. Nothing here is ever matched by name.
//
// A superseded mapping is kept, not deleted. CommCare HQ has no atomic app
// update, so publishing again creates a NEW app there and leaves the
// previous one sitting on the project space; the author can only be told
// about it if Nova still remembers it.
//
// Tenancy: `project_id` travels with `app_id` under the same deferred
// composite foreign key `cases` uses, so a Project move may carry the
// whole closure in one transaction while no mismatched row can commit.

import { type Kysely, sql } from "kysely";

const STATES =
	"'preflight', 'uploaded', 'built', 'released', 'runnable', 'incomplete'";
const PHASES = "'preflight', 'upload', 'build', 'release', 'probe'";
const SERVERS = "'production', 'india', 'eu'";
const RESOURCE_KINDS = "'app'";
const OWNERSHIPS = "'nova-created', 'adopted'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS app_deployments (
			id uuid PRIMARY KEY DEFAULT uuidv7(),
			app_id text NOT NULL,
			project_id text NOT NULL CHECK (btrim(project_id) <> ''),
			server text NOT NULL CHECK (server IN (${sql.raw(SERVERS)})),
			domain text NOT NULL
				CHECK (btrim(domain) <> '' AND char_length(domain) <= 255),
			state text NOT NULL CHECK (state IN (${sql.raw(STATES)})),
			resume_phase text CHECK (resume_phase IN (${sql.raw(PHASES)})),
			phases jsonb NOT NULL DEFAULT '{}'::jsonb,
			created_by text NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			updated_at timestamptz(3) NOT NULL DEFAULT now(),
			last_observed_at timestamptz(3),
			CONSTRAINT app_deployments_target_unique
				UNIQUE (app_id, project_id, server, domain),
			-- A resume phase is exactly the state 'incomplete' carries, so the
			-- two cannot drift into "refused, but nowhere to retry from" or
			-- "succeeded, but still pointing at a failure".
			CONSTRAINT app_deployments_resume_phase_pairs_with_incomplete
				CHECK ((state = 'incomplete') = (resume_phase IS NOT NULL)),
			CONSTRAINT app_deployments_project_app_tenant_fk
				FOREIGN KEY (project_id, app_id) REFERENCES apps(project_id, id)
				ON UPDATE NO ACTION ON DELETE CASCADE
				DEFERRABLE INITIALLY DEFERRED
		)
	`.execute(db);

	// Serves the builder and MCP read: every deployment of one app, newest
	// activity first.
	await sql`
		CREATE INDEX IF NOT EXISTS app_deployments_app
			ON app_deployments (app_id, updated_at DESC)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS app_deployment_resources (
			id uuid PRIMARY KEY DEFAULT uuidv7(),
			deployment_id uuid NOT NULL
				REFERENCES app_deployments(id) ON DELETE CASCADE,
			kind text NOT NULL CHECK (kind IN (${sql.raw(RESOURCE_KINDS)})),
			nova_resource_id text NOT NULL CHECK (btrim(nova_resource_id) <> ''),
			remote_id text NOT NULL CHECK (btrim(remote_id) <> ''),
			ownership text NOT NULL CHECK (ownership IN (${sql.raw(OWNERSHIPS)})),
			adopted_at timestamptz(3),
			adopted_by text,
			pushed_revision bigint CHECK (pushed_revision >= 0),
			pushed_at timestamptz(3),
			remote_revision bigint CHECK (remote_revision >= 0),
			remote_observed_at timestamptz(3),
			superseded_at timestamptz(3),
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			-- Adoption is an event with an actor and a moment, so an adopted
			-- mapping always carries both and a Nova-created one carries
			-- neither. This is what makes "who attached this to our project
			-- space, and when" answerable from the row itself.
			CONSTRAINT app_deployment_resources_adoption_is_attributed
				CHECK (
					(ownership = 'adopted')
					= (adopted_at IS NOT NULL AND btrim(coalesce(adopted_by, '')) <> '')
				)
		)
	`.execute(db);

	// Exactly one mapping is in force per Nova resource at a time. The
	// partial index makes the alternative unrepresentable rather than
	// leaving it to every writer to remember.
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS app_deployment_resources_active
			ON app_deployment_resources (deployment_id, kind, nova_resource_id)
			WHERE superseded_at IS NULL
	`.execute(db);

	// Serves the read that loads a deployment's active and superseded
	// mappings together, which every reporting surface needs at once.
	await sql`
		CREATE INDEX IF NOT EXISTS app_deployment_resources_deployment
			ON app_deployment_resources (deployment_id, superseded_at)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS app_deployment_resources`.execute(db);
	await sql`DROP TABLE IF EXISTS app_deployments`.execute(db);
}
