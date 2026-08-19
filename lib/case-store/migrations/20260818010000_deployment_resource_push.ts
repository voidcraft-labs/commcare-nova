// The resource-push rung, and the ledger columns a pushed resource needs.
//
// Publishing an app used to be the only externally visible thing Nova did,
// so the lifecycle went straight from `preflight` to `upload`. It cannot
// any more: an app whose selects read a lookup table needs that table on
// the target BEFORE the app arrives, and pushing it is a real mutation of
// somebody else's project space. That step gets its own rung rather than
// hiding inside preflight, because a person has to be able to see where a
// publish stopped and a retry has to resume there without re-importing
// the app.
//
// Two columns join the ownership ledger:
//
//   * `pushed_identity` is the external name the resource was pushed
//     under — a lookup table's tag, later a place's site code or a
//     worker's username. The remote id alone cannot answer "what did an
//     earlier publish leave behind" after a rename, because the thing left
//     behind is findable on CommCare HQ only by the name it still carries.
//
//   * `adopted_at` / `adopted_by` attribute an adoption. Nova never takes
//     over a same-named resource it did not create; a person has to say so
//     explicitly, and the ledger records who and when so the decision is
//     auditable rather than folklore.
//
// Every statement is idempotent. These tables predate this migration, and
// a database that has already seen an earlier shape of them must converge
// rather than fail.

import { type Kysely, sql } from "kysely";

const STATE_CHECK = "app_deployments_state_check";
const RESUME_PHASE_CHECK = "app_deployments_resume_phase_check";
const KIND_CHECK = "app_deployment_resources_kind_check";
const OWNERSHIP_CHECK = "app_deployment_resources_ownership_check";
const ADOPTION_ATTRIBUTED = "app_deployment_resources_adoption_is_attributed";

const STATES =
	"'preflight', 'resources', 'uploaded', 'built', 'released', 'runnable', " +
	"'incomplete'";
const PHASES =
	"'preflight', 'resources', 'upload', 'build', 'release', 'probe'";
const RESOURCE_KINDS = "'app', 'lookup-table'";
const OWNERSHIPS = "'nova-created', 'adopted'";

const PREVIOUS_STATES =
	"'preflight', 'uploaded', 'built', 'released', 'runnable', 'incomplete'";
const PREVIOUS_PHASES = "'preflight', 'upload', 'build', 'release', 'probe'";
const PREVIOUS_RESOURCE_KINDS = "'app'";
const PREVIOUS_OWNERSHIPS = "'nova-created'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE app_deployments
			DROP CONSTRAINT IF EXISTS ${sql.id(STATE_CHECK)},
			ADD CONSTRAINT ${sql.id(STATE_CHECK)}
				CHECK (state IN (${sql.raw(STATES)})),
			DROP CONSTRAINT IF EXISTS ${sql.id(RESUME_PHASE_CHECK)},
			ADD CONSTRAINT ${sql.id(RESUME_PHASE_CHECK)}
				CHECK (resume_phase IN (${sql.raw(PHASES)}))
	`.execute(db);

	await sql`
		ALTER TABLE app_deployment_resources
			ADD COLUMN IF NOT EXISTS pushed_identity text,
			ADD COLUMN IF NOT EXISTS adopted_at timestamptz(3),
			ADD COLUMN IF NOT EXISTS adopted_by text
	`.execute(db);

	await sql`
		ALTER TABLE app_deployment_resources
			DROP CONSTRAINT IF EXISTS ${sql.id(KIND_CHECK)},
			ADD CONSTRAINT ${sql.id(KIND_CHECK)}
				CHECK (kind IN (${sql.raw(RESOURCE_KINDS)})),
			DROP CONSTRAINT IF EXISTS ${sql.id(OWNERSHIP_CHECK)},
			ADD CONSTRAINT ${sql.id(OWNERSHIP_CHECK)}
				CHECK (ownership IN (${sql.raw(OWNERSHIPS)}))
	`.execute(db);

	// An adoption is exactly the rows that name who made it and when. The
	// pairing is a constraint rather than a convention because "adopted,
	// by nobody, at no time" is the shape an accidental default produces,
	// and it is indistinguishable afterwards from a real adoption.
	await sql`
		ALTER TABLE app_deployment_resources
			DROP CONSTRAINT IF EXISTS ${sql.id(ADOPTION_ATTRIBUTED)},
			ADD CONSTRAINT ${sql.id(ADOPTION_ATTRIBUTED)}
				CHECK (
					(ownership = 'adopted')
					= (adopted_at IS NOT NULL AND btrim(COALESCE(adopted_by, '')) <> '')
				)
	`.execute(db);

	// A pushed identity is a real external name or absent. An empty string
	// would be a third state meaning neither, and every reader would have
	// to remember to treat it as absent.
	await sql`
		ALTER TABLE app_deployment_resources
			DROP CONSTRAINT IF EXISTS app_deployment_resources_pushed_identity_check,
			ADD CONSTRAINT app_deployment_resources_pushed_identity_check
				CHECK (pushed_identity IS NULL OR btrim(pushed_identity) <> '')
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE app_deployment_resources
			DROP CONSTRAINT IF EXISTS app_deployment_resources_pushed_identity_check,
			DROP CONSTRAINT IF EXISTS ${sql.id(ADOPTION_ATTRIBUTED)},
			DROP CONSTRAINT IF EXISTS ${sql.id(KIND_CHECK)},
			ADD CONSTRAINT ${sql.id(KIND_CHECK)}
				CHECK (kind IN (${sql.raw(PREVIOUS_RESOURCE_KINDS)})),
			DROP CONSTRAINT IF EXISTS ${sql.id(OWNERSHIP_CHECK)},
			ADD CONSTRAINT ${sql.id(OWNERSHIP_CHECK)}
				CHECK (ownership IN (${sql.raw(PREVIOUS_OWNERSHIPS)})),
			DROP COLUMN IF EXISTS pushed_identity,
			DROP COLUMN IF EXISTS adopted_at,
			DROP COLUMN IF EXISTS adopted_by
	`.execute(db);

	await sql`
		ALTER TABLE app_deployments
			DROP CONSTRAINT IF EXISTS ${sql.id(STATE_CHECK)},
			ADD CONSTRAINT ${sql.id(STATE_CHECK)}
				CHECK (state IN (${sql.raw(PREVIOUS_STATES)})),
			DROP CONSTRAINT IF EXISTS ${sql.id(RESUME_PHASE_CHECK)},
			ADD CONSTRAINT ${sql.id(RESUME_PHASE_CHECK)}
				CHECK (resume_phase IN (${sql.raw(PREVIOUS_PHASES)}))
	`.execute(db);
}
