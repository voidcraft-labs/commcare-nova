// The design-artifact tables — the durable, insert-only record of the
// design pipeline: the source package a session's models consumed, every
// contract revision the author/reviser produced, every independent review,
// each finding's disposition, and the digest-bound build plan.
//
// Why these five tables exist:
//
//   * `design_source_packages` records WHAT the models saw, as references
//     and normalized claims plus the canonical digest over the exact
//     projected package. Raw extracts, transcripts, and attachment bodies
//     are never duplicated in — the digest binds them, the references name
//     them, and re-reading the material goes through its own authorized
//     boundary.
//
//   * `design_revisions` is the immutable contract-revision ledger: one row
//     per revision, monotonic per session, lifecycle fixed at insert
//     (`draft | accepted`). Acceptance is a NEW accepted row whose parent
//     is the reviewed draft — never an update. Supersession derives from
//     the session's active pointer (the design-session unit) and ancestry.
//
//   * `design_reviews` is the independent-review record — one row per
//     fresh-context reviewer call, bound to the exact reviewed revision and
//     its digest. "Reviewed" is true ONLY when such a row exists (and its
//     findings are dispositioned); a failed reviewer call persists nothing
//     and can never be labeled reviewed.
//
//   * `design_review_dispositions` closes the loop: exactly one row per
//     dispositioned finding, keyed (review, finding), naming the revision
//     that resolved it. Disposition closure over every critical/important
//     finding is proved before the accepted revision persists.
//
//   * `design_build_plans` is the slice plan, digest-bound to the exact
//     accepted revision it lowers. A contract revision supersedes prior
//     plans by digest comparison, never by mutating them.
//
// `design_session_id` is an opaque non-null identity with no foreign key:
// `design_sessions` ships with the design-session unit, which adds the
// constraint in its own migration — the same precedent the change-set
// tables set (docs/plans/reviewed-intent-atomic-change-sets-plan.md §18).
//
// Every table is append-only runtime DML (`SELECT, INSERT`): artifacts are
// immutable and explicitly superseded, never updated or deleted in place.
// Retention is a future, separately-owned service path.

import { type Kysely, sql } from "kysely";

const SHA256_HEX = "'^[0-9a-f]{64}$'";
const REVISION_LIFECYCLES = "'draft', 'accepted'";
const DISPOSITION_STATUSES =
	"'accepted', 'rejected-with-rationale', 'deferred-with-user-visible-consequence'";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS design_source_packages (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL,
			project_id text NOT NULL CHECK (btrim(project_id) <> ''),
			package_digest text NOT NULL CHECK (package_digest ~ ${sql.raw(SHA256_HEX)}),
			created_by_run_id text NOT NULL CHECK (btrim(created_by_run_id) <> ''),
			payload jsonb NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			-- The same projection is one package: a retry that rebuilt the
			-- identical bytes converges on the stored row instead of minting a
			-- twin.
			CONSTRAINT design_source_packages_session_digest_unique
				UNIQUE (design_session_id, package_digest)
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_revisions (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL,
			revision bigint NOT NULL CHECK (revision >= 1),
			parent_revision_id uuid REFERENCES design_revisions(id),
			lifecycle text NOT NULL
				CHECK (lifecycle IN (${sql.raw(REVISION_LIFECYCLES)})),
			artifact_digest text NOT NULL
				CHECK (artifact_digest ~ ${sql.raw(SHA256_HEX)}),
			contract_digest text NOT NULL
				CHECK (contract_digest ~ ${sql.raw(SHA256_HEX)}),
			source_package_digest text NOT NULL
				CHECK (source_package_digest ~ ${sql.raw(SHA256_HEX)}),
			producer_model text NOT NULL CHECK (btrim(producer_model) <> ''),
			prompt_version text NOT NULL CHECK (btrim(prompt_version) <> ''),
			created_by_run_id text NOT NULL CHECK (btrim(created_by_run_id) <> ''),
			envelope jsonb NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			-- One monotonic revision sequence per session; the first revision
			-- has no parent, every later one names its predecessor.
			CONSTRAINT design_revisions_session_revision_unique
				UNIQUE (design_session_id, revision),
			CONSTRAINT design_revisions_parent_iff_not_first
				CHECK ((revision = 1) = (parent_revision_id IS NULL))
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_reviews (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL,
			design_revision_id uuid NOT NULL REFERENCES design_revisions(id),
			review_ordinal integer NOT NULL CHECK (review_ordinal >= 1),
			reviewed_revision_digest text NOT NULL
				CHECK (reviewed_revision_digest ~ ${sql.raw(SHA256_HEX)}),
			artifact_digest text NOT NULL
				CHECK (artifact_digest ~ ${sql.raw(SHA256_HEX)}),
			producer_model text NOT NULL CHECK (btrim(producer_model) <> ''),
			prompt_version text NOT NULL CHECK (btrim(prompt_version) <> ''),
			created_by_run_id text NOT NULL CHECK (btrim(created_by_run_id) <> ''),
			envelope jsonb NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			CONSTRAINT design_reviews_revision_ordinal_unique
				UNIQUE (design_revision_id, review_ordinal)
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_review_dispositions (
			review_id uuid NOT NULL REFERENCES design_reviews(id),
			finding_id uuid NOT NULL,
			status text NOT NULL
				CHECK (status IN (${sql.raw(DISPOSITION_STATUSES)})),
			resulting_revision_id uuid NOT NULL REFERENCES design_revisions(id),
			payload jsonb NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (review_id, finding_id)
		)
	`.execute(db);

	await sql`
		CREATE TABLE IF NOT EXISTS design_build_plans (
			id uuid PRIMARY KEY,
			design_session_id uuid NOT NULL,
			design_revision_id uuid NOT NULL REFERENCES design_revisions(id),
			design_revision_digest text NOT NULL
				CHECK (design_revision_digest ~ ${sql.raw(SHA256_HEX)}),
			plan_digest text NOT NULL CHECK (plan_digest ~ ${sql.raw(SHA256_HEX)}),
			artifact_digest text NOT NULL
				CHECK (artifact_digest ~ ${sql.raw(SHA256_HEX)}),
			producer_model text NOT NULL CHECK (btrim(producer_model) <> ''),
			prompt_version text NOT NULL CHECK (btrim(prompt_version) <> ''),
			created_by_run_id text NOT NULL CHECK (btrim(created_by_run_id) <> ''),
			envelope jsonb NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now()
		)
	`.execute(db);

	// Serves "the session's revisions in order" and "the latest accepted
	// revision" without a session pointer (the design-session unit adds the
	// active pointer).
	await sql`
		CREATE INDEX IF NOT EXISTS design_revisions_session_lifecycle
			ON design_revisions (design_session_id, lifecycle, revision DESC)
	`.execute(db);

	await sql`
		CREATE INDEX IF NOT EXISTS design_build_plans_session
			ON design_build_plans (design_session_id, created_at DESC)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS design_build_plans`.execute(db);
	await sql`DROP TABLE IF EXISTS design_review_dispositions`.execute(db);
	await sql`DROP TABLE IF EXISTS design_reviews`.execute(db);
	await sql`DROP TABLE IF EXISTS design_revisions`.execute(db);
	await sql`DROP TABLE IF EXISTS design_source_packages`.execute(db);
}
