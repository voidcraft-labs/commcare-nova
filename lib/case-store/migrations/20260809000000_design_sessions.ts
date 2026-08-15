// Design sessions — the pre-app generation target — plus the target unions
// on the chat protocol tables and the exact split of conversation media
// references out of the app-wide projection.
//
// What this migration establishes:
//
//   * `design_sessions` — the durable, Project-scoped workflow row for one
//     high-level build (mode `build`, existing before any app) or one
//     design-aware edit (mode `edit`, an artifact scope bound to an app whose
//     row remains the sole run/credit authority). A build session carries the
//     same holder + reservation column groups the `apps` row carries, as
//     closed groups: the CHECKs below make a partial holder, a partial
//     reservation, a holder on an edit session, and authority columns on a
//     terminal session unrepresentable
//     (docs/plans/reviewed-intent-atomic-change-sets-plan.md §11.2, §18.4).
//
//   * The waiting `design_session_id` columns on the change-set tables
//     (20260807000000) and the design-artifact tables (20260808000000) gain
//     their foreign keys — the constraint those migrations deliberately
//     deferred to this unit.
//
//   * `threads`, `chat_stream_chunks`, and `run_summaries` become
//     target-polymorphic: nullable `app_id`, nullable `design_session_id`,
//     and an exactly-one-target CHECK. Existing rows stay app-targeted
//     unchanged. `run_summaries` trades its `(app_id, run_id)` PRIMARY KEY
//     for the two partial unique indexes (§18.11) because a PK column cannot
//     be nullable; the first-write unique-race retry behaves identically
//     under the partial index.
//
//   * `thread_media_refs` — conversation attachment references split out of
//     the app-wide `media_asset_refs` projection (§11.8): one row per
//     `(thread, asset)`, Project-stamped, replaced under the thread's own
//     transaction. After this migration `media_asset_refs` carries ONLY
//     authored Blueprint references.
//
//   * The backfill: every existing thread's exact transcript attachment set
//     lands in `thread_media_refs`, and every edge-bearing app's
//     `media_asset_refs` set is rebuilt to the Blueprint-only projection.
//     This runs here — not as an operator-timed script — because the new
//     revision's deletion guard reads `thread_media_refs` from its first
//     request, and the migrate Job is the one point ordered before that.
//     It IMPORTS the production walks (`collectThreadAttachmentAssetIds`,
//     `blueprintMediaRequirements`) rather than freezing copies: this is a
//     derived-projection REBUILD, not an equivalence oracle — a replay must
//     converge on the projection the current runtime maintains, exactly as
//     the runtime writers themselves would. (The old revision keeps writing
//     thread-contributed edges until the deploy cutover; the paired
//     scan/migrate convergence scripts re-run this same rebuild once the old
//     revision drains.)
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";
import { collectThreadAttachmentAssetIds } from "@/lib/chat/threadAttachments";
import { blueprintMediaRequirements } from "@/lib/db/canonicalCommitKernel";
import {
	assemblePersistedBlueprintJsonText,
	type PersistedBlueprintRootText,
	type PersistedEntityRowText,
} from "@/lib/db/persistedJson";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";

const SESSION_MODES = "'build', 'edit'";
const SESSION_STATES = "'active', 'materialized', 'completed', 'abandoned'";
const TERMINAL_STATES = "'materialized', 'completed', 'abandoned'";

/** Every table 20260807000000/20260808000000 left with an opaque, FK-less
 * `design_session_id`, now bound to `design_sessions(id)`. */
const SESSION_ID_CARRIERS = [
	"design_change_sets",
	"design_committed_slices",
	"design_source_packages",
	"design_revisions",
	"design_reviews",
	"design_build_plans",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS design_sessions (
			id uuid PRIMARY KEY,
			mode text NOT NULL CHECK (mode IN (${sql.raw(SESSION_MODES)})),
			project_id text NOT NULL CHECK (btrim(project_id) <> ''),
			owner_user_id text NOT NULL CHECK (btrim(owner_user_id) <> ''),

			proposed_app_id text CHECK (proposed_app_id IS NULL OR btrim(proposed_app_id) <> ''),
			app_id text REFERENCES apps(id) ON DELETE CASCADE,

			state text NOT NULL CHECK (state IN (${sql.raw(SESSION_STATES)})),
			awaiting_input boolean NOT NULL DEFAULT false,

			run_id text CHECK (run_id IS NULL OR btrim(run_id) <> ''),
			run_holder_nonce uuid,
			run_actor_user_id text CHECK (run_actor_user_id IS NULL OR btrim(run_actor_user_id) <> ''),
			run_mode text CHECK (run_mode IS NULL OR run_mode IN (${sql.raw(SESSION_MODES)})),
			run_lease_expires_at timestamptz(3),

			res_period text CHECK (res_period IS NULL OR btrim(res_period) <> ''),
			res_reserved integer CHECK (res_reserved IS NULL OR res_reserved >= 0),
			res_settled boolean,
			res_user_id text CHECK (res_user_id IS NULL OR btrim(res_user_id) <> ''),
			res_run_id text CHECK (res_run_id IS NULL OR btrim(res_run_id) <> ''),

			last_error_type text,
			active_design_revision_id uuid REFERENCES design_revisions(id),
			active_build_plan_id uuid REFERENCES design_build_plans(id),

			created_at timestamptz(3) NOT NULL DEFAULT now(),
			updated_at timestamptz(3) NOT NULL DEFAULT now(),

			-- A build session names the app it proposes; an edit session names
			-- the app it annotates. Neither can exist targetless.
			CONSTRAINT design_sessions_mode_target CHECK (
				(mode = 'build' AND proposed_app_id IS NOT NULL) OR
				(mode = 'edit' AND app_id IS NOT NULL)
			),
			-- Materialization is the build path's terminal success and carries
			-- the created app; completion is the edit path's.
			CONSTRAINT design_sessions_materialized_is_build_with_app CHECK (
				state <> 'materialized' OR (mode = 'build' AND app_id IS NOT NULL)
			),
			CONSTRAINT design_sessions_completed_is_edit_with_app CHECK (
				state <> 'completed' OR (mode = 'edit' AND app_id IS NOT NULL)
			),
			CONSTRAINT design_sessions_edit_never_materializes CHECK (
				mode <> 'edit' OR state <> 'materialized'
			),
			-- A pre-app build session gains its app only by materializing.
			CONSTRAINT design_sessions_active_build_has_no_app CHECK (
				mode <> 'build' OR state <> 'active' OR app_id IS NULL
			),
			CONSTRAINT design_sessions_abandoned_build_has_no_app CHECK (
				NOT (mode = 'build' AND app_id IS NOT NULL AND state = 'abandoned')
			),
			-- Only a build session may hold a run, and only in build mode; an
			-- edit design session's app row is the sole holder authority.
			CONSTRAINT design_sessions_run_only_on_build CHECK (
				run_id IS NULL OR (mode = 'build' AND run_mode = 'build')
			),
			CONSTRAINT design_sessions_reservation_names_run CHECK (
				res_run_id IS NULL OR res_run_id = run_id
			),
			CONSTRAINT design_sessions_reservation_names_actor CHECK (
				res_user_id IS NULL OR res_user_id = run_actor_user_id
			),
			-- A terminal session carries no authority columns at all: the
			-- materialization transfer moved them to the app row, and
			-- completion/abandonment released them.
			CONSTRAINT design_sessions_terminal_clears_authority CHECK (
				state NOT IN (${sql.raw(TERMINAL_STATES)}) OR (
					run_id IS NULL AND run_holder_nonce IS NULL
					AND run_actor_user_id IS NULL AND run_mode IS NULL
					AND run_lease_expires_at IS NULL
					AND res_period IS NULL AND res_reserved IS NULL
					AND res_settled IS NULL AND res_user_id IS NULL
					AND res_run_id IS NULL
				)
			),
			-- The holder column group travels whole (the lease deadline may
			-- ride only beside a holder).
			CONSTRAINT design_sessions_holder_group_complete CHECK (
				(run_id IS NULL AND run_holder_nonce IS NULL
					AND run_actor_user_id IS NULL AND run_mode IS NULL
					AND run_lease_expires_at IS NULL)
				OR
				(run_id IS NOT NULL AND run_holder_nonce IS NOT NULL
					AND run_actor_user_id IS NOT NULL AND run_mode IS NOT NULL)
			),
			-- The reservation column group travels whole.
			CONSTRAINT design_sessions_reservation_group_complete CHECK (
				(res_period IS NULL AND res_reserved IS NULL AND res_settled IS NULL
					AND res_user_id IS NULL AND res_run_id IS NULL)
				OR
				(res_period IS NOT NULL AND res_reserved IS NOT NULL
					AND res_settled IS NOT NULL AND res_user_id IS NOT NULL
					AND res_run_id IS NOT NULL)
			),
			-- An edit design session is an artifact scope only: no pause flag,
			-- no holder, no reservation may ever land on it.
			CONSTRAINT design_sessions_edit_carries_no_authority CHECK (
				mode <> 'edit' OR (
					awaiting_input = false
					AND run_id IS NULL AND run_holder_nonce IS NULL
					AND run_actor_user_id IS NULL AND run_mode IS NULL
					AND run_lease_expires_at IS NULL
					AND res_period IS NULL AND res_reserved IS NULL
					AND res_settled IS NULL AND res_user_id IS NULL
					AND res_run_id IS NULL
				)
			)
		)
	`.execute(db);

	// The materialized/completed/edit lineage of an app, for Project-move
	// re-tenanting and admin joins.
	await sql`
		CREATE INDEX IF NOT EXISTS design_sessions_app
			ON design_sessions (app_id)
			WHERE app_id IS NOT NULL
	`.execute(db);
	// The cross-target one-active-generation scan: an actor's live build
	// sessions, freshest first.
	await sql`
		CREATE INDEX IF NOT EXISTS design_sessions_actor_active
			ON design_sessions (run_actor_user_id, updated_at DESC)
			WHERE state = 'active' AND run_id IS NOT NULL
	`.execute(db);

	// Bind the waiting opaque identity columns. Drop-before-add keeps the
	// replay idempotent (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
	for (const table of SESSION_ID_CARRIERS) {
		await sql`
			ALTER TABLE ${sql.raw(table)}
				DROP CONSTRAINT IF EXISTS ${sql.raw(`${table}_design_session_fk`)}
		`.execute(db);
		await sql`
			ALTER TABLE ${sql.raw(table)}
				ADD CONSTRAINT ${sql.raw(`${table}_design_session_fk`)}
				FOREIGN KEY (design_session_id) REFERENCES design_sessions(id)
		`.execute(db);
	}

	// ── threads: exactly one generation target ─────────────────────────
	await sql`
		ALTER TABLE threads
			ADD COLUMN IF NOT EXISTS design_session_id uuid
				REFERENCES design_sessions(id) ON DELETE CASCADE
	`.execute(db);
	await sql`ALTER TABLE threads ALTER COLUMN app_id DROP NOT NULL`.execute(db);
	await sql`
		ALTER TABLE threads
			DROP CONSTRAINT IF EXISTS threads_exactly_one_target
	`.execute(db);
	await sql`
		ALTER TABLE threads
			ADD CONSTRAINT threads_exactly_one_target CHECK (
				(app_id IS NOT NULL)::int + (design_session_id IS NOT NULL)::int = 1
			)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS threads_design_session_updated
			ON threads (design_session_id, updated_at DESC)
			WHERE design_session_id IS NOT NULL
	`.execute(db);

	// ── chat_stream_chunks: exactly one generation target ──────────────
	await sql`
		ALTER TABLE chat_stream_chunks
			ADD COLUMN IF NOT EXISTS design_session_id uuid
				REFERENCES design_sessions(id) ON DELETE CASCADE
	`.execute(db);
	await sql`
		ALTER TABLE chat_stream_chunks ALTER COLUMN app_id DROP NOT NULL
	`.execute(db);
	await sql`
		ALTER TABLE chat_stream_chunks
			DROP CONSTRAINT IF EXISTS chat_stream_chunks_exactly_one_target
	`.execute(db);
	await sql`
		ALTER TABLE chat_stream_chunks
			ADD CONSTRAINT chat_stream_chunks_exactly_one_target CHECK (
				(app_id IS NOT NULL)::int + (design_session_id IS NOT NULL)::int = 1
			)
	`.execute(db);

	// ── run_summaries: exactly one generation target ───────────────────
	await sql`
		ALTER TABLE run_summaries
			ADD COLUMN IF NOT EXISTS design_session_id uuid
				REFERENCES design_sessions(id) ON DELETE CASCADE
	`.execute(db);
	await sql`
		ALTER TABLE run_summaries DROP CONSTRAINT IF EXISTS run_summaries_pkey
	`.execute(db);
	await sql`
		ALTER TABLE run_summaries ALTER COLUMN app_id DROP NOT NULL
	`.execute(db);
	await sql`
		ALTER TABLE run_summaries
			DROP CONSTRAINT IF EXISTS run_summaries_exactly_one_target
	`.execute(db);
	await sql`
		ALTER TABLE run_summaries
			ADD CONSTRAINT run_summaries_exactly_one_target CHECK (
				(app_id IS NOT NULL)::int + (design_session_id IS NOT NULL)::int = 1
			)
	`.execute(db);
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS run_summaries_app_run
			ON run_summaries (app_id, run_id)
			WHERE app_id IS NOT NULL
	`.execute(db);
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS run_summaries_design_session_run
			ON run_summaries (design_session_id, run_id)
			WHERE design_session_id IS NOT NULL
	`.execute(db);

	// ── thread_media_refs: exact conversation attachment references ────
	await sql`
		CREATE TABLE IF NOT EXISTS thread_media_refs (
			thread_id text NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
			asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
			project_id text NOT NULL CHECK (btrim(project_id) <> ''),
			PRIMARY KEY (thread_id, asset_id)
		)
	`.execute(db);
	// The deletion guard's "is this asset referenced by any conversation" read.
	await sql`
		CREATE INDEX IF NOT EXISTS thread_media_refs_asset
			ON thread_media_refs (asset_id)
	`.execute(db);

	await backfillThreadMediaRefs(db);
	await rebuildBlueprintOnlyMediaRefs(db);
}

interface ThreadBackfillRow {
	thread_id: string;
	app_id: string | null;
	messages: unknown;
}

interface AppProjectRow {
	id: string;
	project_id: string;
}

/**
 * Project every existing thread's exact transcript attachment set into
 * `thread_media_refs`. Convergent: `ON CONFLICT DO NOTHING` on replay, and a
 * re-run over a database whose runtime already writes the table only re-adds
 * what an old-revision writer skipped during the deploy window.
 *
 * Deliberately LENIENT where the runtime writers are strict — this walk
 * crosses history the current admission rules never saw, and a deploy-blocking
 * Job must not fail closed on it:
 *  - a transcript whose attachment metadata does not parse contributes
 *    nothing (there is no reference identity to protect) and is counted;
 *  - an attachment naming an asset with no `media_assets` row is skipped
 *    (the FK would reject it, and a reference to vanished bytes guards
 *    nothing) and is counted.
 * Threads page through a keyset loop so the Job's memory stays bounded by
 * the batch, not the table.
 */
async function backfillThreadMediaRefs(db: Kysely<unknown>): Promise<void> {
	const BATCH = 200;
	let cursor = "";
	let unparseableThreads = 0;
	let missingAssetRefs = 0;
	for (;;) {
		const threads = await sql<ThreadBackfillRow>`
			SELECT thread_id, app_id, messages FROM threads
			WHERE thread_id > ${cursor}
			ORDER BY thread_id
			LIMIT ${BATCH}
		`.execute(db);
		if (threads.rows.length === 0) break;
		cursor = threads.rows[threads.rows.length - 1].thread_id;
		const appIds = [
			...new Set(
				threads.rows
					.map((row) => row.app_id)
					.filter((appId): appId is string => appId !== null),
			),
		];
		const projectByApp = new Map<string, string>();
		if (appIds.length > 0) {
			const apps = await sql<AppProjectRow>`
				SELECT id, project_id FROM apps
				WHERE id IN (${sql.join(appIds.map((id) => sql`${id}`))})
			`.execute(db);
			for (const app of apps.rows) projectByApp.set(app.id, app.project_id);
		}
		const candidates: Array<{
			threadId: string;
			assetId: string;
			projectId: string;
		}> = [];
		for (const thread of threads.rows) {
			const projectId =
				thread.app_id === null
					? null
					: (projectByApp.get(thread.app_id) ?? null);
			if (projectId === null) continue;
			let assetIds: string[];
			try {
				assetIds = [
					...new Set(collectThreadAttachmentAssetIds(thread.messages)),
				];
			} catch {
				unparseableThreads += 1;
				continue;
			}
			for (const assetId of assetIds) {
				candidates.push({ threadId: thread.thread_id, assetId, projectId });
			}
		}
		if (candidates.length === 0) continue;
		const candidateAssetIds = [...new Set(candidates.map((c) => c.assetId))];
		const existing = await sql<{ id: string }>`
			SELECT id::text AS id FROM media_assets
			WHERE id IN (${sql.join(candidateAssetIds.map((id) => sql`${id}::uuid`))})
		`.execute(db);
		const existingIds = new Set(existing.rows.map((row) => row.id));
		const inserts = candidates.filter((c) => existingIds.has(c.assetId));
		missingAssetRefs += candidates.length - inserts.length;
		if (inserts.length === 0) continue;
		await sql`
			INSERT INTO thread_media_refs (thread_id, asset_id, project_id)
			VALUES ${sql.join(
				inserts.map(
					(c) => sql`(${c.threadId}, ${c.assetId}::uuid, ${c.projectId})`,
				),
			)}
			ON CONFLICT (thread_id, asset_id) DO NOTHING
		`.execute(db);
	}
	if (unparseableThreads > 0 || missingAssetRefs > 0) {
		console.warn(
			`design_sessions backfill: skipped ${unparseableThreads} thread(s) whose ` +
				`attachment metadata did not parse and ${missingAssetRefs} attachment ` +
				`reference(s) naming no media_assets row. Nothing was lost — those ` +
				`references guard no stored bytes — but if the counts look wrong, ` +
				`re-run scripts/scan-media-ref-projection-split.ts to inspect them.`,
		);
	}
}

interface EdgeAppRow {
	id: string;
	project_id: string;
	app_name: string;
	connect_type: string | null;
	logo: string | null;
	case_types_text: string | null;
}

interface EntityTextRow {
	uuid: string;
	kind: string;
	parent_uuid: string | null;
	ordinal: number;
	data_text: string;
}

/**
 * Rebuild every edge-bearing app's `media_asset_refs` set to the
 * Blueprint-only projection — the final shape in which conversation carriers
 * live exclusively in `thread_media_refs`. Delete-then-reinsert per app, the
 * same replacement the runtime writers perform, inside the migration's one
 * transaction.
 */
async function rebuildBlueprintOnlyMediaRefs(
	db: Kysely<unknown>,
): Promise<void> {
	const edgeApps = await sql<EdgeAppRow>`
		SELECT apps.id, apps.project_id, apps.app_name, apps.connect_type,
			apps.logo, apps.case_types::text AS case_types_text
		FROM apps
		WHERE EXISTS (
			SELECT 1 FROM media_asset_refs WHERE media_asset_refs.app_id = apps.id
		)
	`.execute(db);
	for (const app of edgeApps.rows) {
		const entities = await sql<EntityTextRow>`
			SELECT uuid, kind, parent_uuid, ordinal, data::text AS data_text
			FROM blueprint_entities
			WHERE app_id = ${app.id}
			ORDER BY uuid
		`.execute(db);
		const persisted = assemblePersistedBlueprintJsonText(
			app.id,
			{
				app_name: app.app_name,
				connect_type: app.connect_type,
				case_types_text: app.case_types_text,
				localization_text: null,
				logo: app.logo,
			} as PersistedBlueprintRootText,
			entities.rows as unknown as PersistedEntityRowText[],
		);
		const doc = hydratePersistedBlueprint(persisted);
		const blueprintAssetIds = [
			...new Set(blueprintMediaRequirements(doc).map((ref) => ref.assetId)),
		];
		await sql`
			DELETE FROM media_asset_refs WHERE app_id = ${app.id}
		`.execute(db);
		for (const assetId of blueprintAssetIds) {
			await sql`
				INSERT INTO media_asset_refs (project_id, asset_id, app_id)
				VALUES (${app.project_id}, ${assetId}::uuid, ${app.id})
				ON CONFLICT DO NOTHING
			`.execute(db);
		}
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`DROP TABLE IF EXISTS thread_media_refs`.execute(db);
	await sql`DROP INDEX IF EXISTS run_summaries_design_session_run`.execute(db);
	await sql`DROP INDEX IF EXISTS run_summaries_app_run`.execute(db);
	await sql`
		ALTER TABLE run_summaries
			DROP CONSTRAINT IF EXISTS run_summaries_exactly_one_target
	`.execute(db);
	await sql`
		ALTER TABLE run_summaries DROP COLUMN IF EXISTS design_session_id
	`.execute(db);
	await sql`
		ALTER TABLE chat_stream_chunks
			DROP CONSTRAINT IF EXISTS chat_stream_chunks_exactly_one_target
	`.execute(db);
	await sql`
		ALTER TABLE chat_stream_chunks DROP COLUMN IF EXISTS design_session_id
	`.execute(db);
	await sql`
		ALTER TABLE threads DROP CONSTRAINT IF EXISTS threads_exactly_one_target
	`.execute(db);
	await sql`DROP INDEX IF EXISTS threads_design_session_updated`.execute(db);
	await sql`ALTER TABLE threads DROP COLUMN IF EXISTS design_session_id`.execute(
		db,
	);
	for (const table of [...SESSION_ID_CARRIERS].reverse()) {
		await sql`
			ALTER TABLE ${sql.raw(table)}
				DROP CONSTRAINT IF EXISTS ${sql.raw(`${table}_design_session_fk`)}
		`.execute(db);
	}
	await sql`DROP TABLE IF EXISTS design_sessions`.execute(db);
}
