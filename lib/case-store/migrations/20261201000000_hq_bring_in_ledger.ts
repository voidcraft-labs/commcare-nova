// The deployment ledger an app brought in from CommCare HQ needs, additive for
// the revision that serves while it runs.
//
//   (1) `app_deployments.endings` and the state `ended`: a deployment a person
//       stopped publishing to, and how many times that happened, which every
//       store write of a publish compares with the count it read.
//   (2-6) `app_deployment_resources.server` and `domain`, copied from the
//       deployment by a `BEFORE INSERT` trigger and held to it by a composite
//       foreign key, so no writer sets them and an insert that names neither
//       keeps working; `released_at`, set on a live `app` mapping whose HQ app
//       another Nova app took while this one was in recently deleted;
//       `ended_by` / `ended_reason` on the mapping an ending superseded; and
//       `pushed_remote_revision`, CommCare HQ's save counter as the import
//       that wrote the mapping's push fields acknowledged it, which orders two
//       publishes of one app by HQ's saves rather than by their commits.
//   (7-9) One CommCare HQ app, one Nova app: a deleted app gives up an HQ app
//       another mapping also names, a guard refuses the deploy where two live
//       apps still name one, and a partial unique index holds the rule from
//       then on, across Projects and both ownerships.
//   (10, 10b) On the baseline, the origins `read` and `changes`, the Nova
//       revision the stored source describes (filled for the `push` rows a
//       publish already wrote, from the live mapping written with them), the
//       file CommCare HQ keeps at each media path, and the first-publish list
//       a brought-in app's source carries.
//   (11) `app_deployment_media_paths`: the path CommCare HQ keeps a media file
//       under for one deployment, one per asset and per path.
//   (11b) `app_deployment_keyed_case_ids`: the id prefix a create keyed by an
//       answer writes on the project space an app was brought in from, one per
//       operation, so a key entered again after the first publish reaches the
//       case it reached before.
//   (11b') `app_deployment_column_field_words`: the word a case list column's
//       field names the case's name, opening date or external id by on one
//       screen of the project space an app was brought in from, where it is
//       not the word Nova writes, so a publish keeps the column, and the app
//       strings HQ's build names by it, where HQ keeps them.
//   (11c) `hq_remote_writes`: each write Nova let out to CommCare HQ (an app's
//       create, its import, its media bundle, a lookup table workbook, a
//       batch of places, a worker account), open until its process settles
//       it (`settled_at`) or its hold ends (`held_until`). Another Nova app is granted an HQ app, a table is handed back
//       and an app moves Project only while none of its writes is open. It
//       starts empty.
//   (11d) `app_deployment_confirmations` takes a sixth kind, `worker-level`:
//       that places at one level of a project space whose places CommCare HQ
//       manages take workers there, its subject the level's code. Additive in
//       effect: every row the revision before writes still passes.
//
// Every statement replays over its own result, because the adoption tests
// erase the migration ledger and run the chain again.
//
// The serving revision reads and writes the three ledger tables while this
// runs, and it takes them in both orders: a baseline read joins
// `app_deployment_baselines` to `app_deployments`, while a publish's write
// holds the deployment row and then upserts the baseline. A migration that
// held one of them while it waited for another would close a cycle with
// whichever request held the other and waited back, and PostgreSQL would end
// one of the two. So statement 0b takes every table lock the batch needs
// before its first change, never waiting while it holds one: it asks for all
// of them at once without waiting, gives back what it got when any is busy,
// and asks again until five seconds have passed. No request of the serving
// revision can then deadlock with it; a request only waits for the commit.
// Statement 0's five-second timeout bounds the one other lock it takes, the
// read of `apps`, and statement 12 hands the timeout back as it found it.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// 0. Wait five seconds for a lock, and no longer, while the previous revision serves.
	await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

	// 0b. Every table lock the batch takes, all at once and only while none is
	//     busy, so it never waits while it holds one. ACCESS EXCLUSIVE on the
	//     four ledger tables statements 1 to 10 and 11d alter, and SHARE ROW
	//     EXCLUSIVE on `media_assets`, which statement 11's foreign key takes.
	//     A lock taken in the inner block is released when that block fails.
	await sql`
		DO $$
		DECLARE
			deadline constant timestamptz := clock_timestamp() + interval '5 seconds';
		BEGIN
			LOOP
				BEGIN
					LOCK TABLE public.app_deployments, public.app_deployment_resources,
						public.app_deployment_baselines, public.app_deployment_confirmations
						IN ACCESS EXCLUSIVE MODE NOWAIT;
					LOCK TABLE public.media_assets IN SHARE ROW EXCLUSIVE MODE NOWAIT;
					RETURN;
				EXCEPTION WHEN lock_not_available THEN
					IF clock_timestamp() >= deadline THEN
						RAISE EXCEPTION USING ERRCODE = 'lock_not_available',
							MESSAGE = 'The bring-in ledger migration could not take app_deployments, app_deployment_resources, app_deployment_baselines, app_deployment_confirmations and media_assets together within five seconds, because the serving revision was using one of them each time it asked. It never waits for one while it holds another, so it stopped, and nothing was changed. Running the deploy again tries again.';
					END IF;
				END;
				PERFORM pg_sleep(0.01);
			END LOOP;
		END $$
	`.execute(db);

	// 1. The ended state and the count of endings.
	await sql`
		ALTER TABLE public.app_deployments
			ADD COLUMN IF NOT EXISTS endings integer NOT NULL DEFAULT 0 CHECK (endings >= 0),
			DROP CONSTRAINT IF EXISTS app_deployments_state_check,
			ADD CONSTRAINT app_deployments_state_check CHECK (state IN
				('preflight', 'resources', 'uploaded', 'built', 'released', 'runnable', 'incomplete', 'ended'))
	`.execute(db);

	// 2. The key the mapping's composite foreign key points at. Guarded, never
	//    dropped: on a replay statement 6's foreign key depends on it, and
	//    PostgreSQL refuses the drop (2BP01).
	await sql`
		DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint
				WHERE conname = 'app_deployments_id_target_unique'
					AND conrelid = 'public.app_deployments'::regclass) THEN
				ALTER TABLE public.app_deployments
					ADD CONSTRAINT app_deployments_id_target_unique UNIQUE (id, server, domain);
			END IF;
		END $$
	`.execute(db);

	// 3. The mapping's new columns.
	await sql`
		ALTER TABLE public.app_deployment_resources
			ADD COLUMN IF NOT EXISTS server text,
			ADD COLUMN IF NOT EXISTS domain text,
			ADD COLUMN IF NOT EXISTS released_at timestamptz(3),
			ADD COLUMN IF NOT EXISTS ended_by text,
			ADD COLUMN IF NOT EXISTS ended_reason text,
			ADD COLUMN IF NOT EXISTS pushed_remote_revision bigint
				CONSTRAINT app_deployment_resources_pushed_remote_revision_is_a_count
				CHECK (pushed_remote_revision >= 0)
	`.execute(db);

	// 4. No writer sets server or domain: the trigger copies them from the deployment.
	await sql`
		CREATE OR REPLACE FUNCTION public.nova_fill_deployment_resource_target() RETURNS trigger
			LANGUAGE plpgsql AS $$
			BEGIN
				SELECT d.server, d.domain INTO STRICT NEW.server, NEW.domain
					FROM public.app_deployments d WHERE d.id = NEW.deployment_id;
				RETURN NEW;
			END;
			$$
	`.execute(db);
	await sql`
		DROP TRIGGER IF EXISTS app_deployment_resources_target ON public.app_deployment_resources
	`.execute(db);
	await sql`
		CREATE TRIGGER app_deployment_resources_target
			BEFORE INSERT ON public.app_deployment_resources
			FOR EACH ROW EXECUTE FUNCTION public.nova_fill_deployment_resource_target()
	`.execute(db);

	// 5. Existing rows. Outside the push-token trigger's columns, so no token rotates.
	await sql`
		UPDATE public.app_deployment_resources r SET server = d.server, domain = d.domain
			FROM public.app_deployments d
			WHERE d.id = r.deployment_id
				AND (r.server IS DISTINCT FROM d.server OR r.domain IS DISTINCT FROM d.domain)
	`.execute(db);

	// 6. Hold them. The release CHECK holds no clause about superseded_at: the
	//    previous revision supersedes a released mapping by setting that column
	//    alone, and this CHECK must admit the row it leaves.
	await sql`
		ALTER TABLE public.app_deployment_resources
			ALTER COLUMN server SET NOT NULL,
			ALTER COLUMN domain SET NOT NULL,
			DROP CONSTRAINT IF EXISTS app_deployment_resources_target_fk,
			ADD CONSTRAINT app_deployment_resources_target_fk
				FOREIGN KEY (deployment_id, server, domain)
				REFERENCES public.app_deployments (id, server, domain) ON DELETE CASCADE,
			DROP CONSTRAINT IF EXISTS app_deployment_resources_release_is_an_apps,
			ADD CONSTRAINT app_deployment_resources_release_is_an_apps
				CHECK (released_at IS NULL OR kind = 'app'),
			DROP CONSTRAINT IF EXISTS app_deployment_resources_ending_is_attributed,
			ADD CONSTRAINT app_deployment_resources_ending_is_attributed CHECK (
				(ended_reason IS NULL) = (ended_by IS NULL)
				AND (ended_reason IS NULL OR (kind = 'app' AND superseded_at IS NOT NULL
					AND btrim(ended_by) <> '' AND ended_reason IN ('stopped', 'claimed-elsewhere'))))
	`.execute(db);

	// 7. An app in recently deleted gives up an HQ app another mapping also names.
	await sql`
		UPDATE public.app_deployment_resources r SET released_at = now()
			FROM public.app_deployments d JOIN public.apps a ON a.id = d.app_id
			WHERE r.deployment_id = d.id AND r.kind = 'app' AND r.superseded_at IS NULL
				AND r.released_at IS NULL AND a.deleted_at IS NOT NULL
				AND EXISTS (SELECT 1 FROM public.app_deployment_resources o
					WHERE o.id <> r.id AND o.kind = 'app' AND o.superseded_at IS NULL
						AND o.released_at IS NULL AND o.server = r.server AND o.domain = r.domain
						AND o.remote_id = r.remote_id)
	`.execute(db);

	// 8. The guard: two or more live Nova apps on one HQ app stop the deploy, worded.
	await sql`
		DO $$ BEGIN
			IF EXISTS (SELECT 1 FROM public.app_deployment_resources
				WHERE kind = 'app' AND superseded_at IS NULL AND released_at IS NULL
				GROUP BY server, domain, remote_id HAVING count(*) > 1) THEN
				RAISE EXCEPTION 'Two or more Nova apps publish to one CommCare HQ app, and from this migration only one may. Nothing was changed. The deploy goes through once all but one app of each such group is in recently deleted.';
			END IF;
		END $$
	`.execute(db);

	// 9. One HQ app, one Nova app.
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS app_deployment_resources_hq_app_claim
			ON public.app_deployment_resources (server, domain, remote_id)
			WHERE kind = 'app' AND superseded_at IS NULL AND released_at IS NULL
	`.execute(db);

	// 10. The read and changes origins, the Nova revision, the media record, and
	//     the first-publish list. The revision's floor is pushed_revision's
	//     (pushed_revision >= 0), so the copy of 10b cannot be refused: an app's
	//     sequence starts at 0 (apps.mutation_seq DEFAULT 0).
	await sql`
		ALTER TABLE public.app_deployment_baselines
			DROP CONSTRAINT IF EXISTS app_deployment_baselines_origin_check,
			ADD CONSTRAINT app_deployment_baselines_origin_check
				CHECK (origin IN ('create', 'push', 'cutover', 'read', 'changes', 'unread')),
			ADD COLUMN IF NOT EXISTS nova_revision bigint,
			DROP CONSTRAINT IF EXISTS app_deployment_baselines_nova_revision_is_a_sequence,
			ADD CONSTRAINT app_deployment_baselines_nova_revision_is_a_sequence
				CHECK (nova_revision IS NULL OR nova_revision >= 0),
			ADD COLUMN IF NOT EXISTS media_files jsonb,
			DROP CONSTRAINT IF EXISTS app_deployment_baselines_media_files_is_a_map,
			ADD CONSTRAINT app_deployment_baselines_media_files_is_a_map
				CHECK (media_files IS NULL OR jsonb_typeof(media_files) = 'object'),
			ADD COLUMN IF NOT EXISTS first_publish_changes jsonb,
			DROP CONSTRAINT IF EXISTS app_deployment_baselines_first_publish_changes_need_a_source,
			ADD CONSTRAINT app_deployment_baselines_first_publish_changes_need_a_source
				CHECK (first_publish_changes IS NULL OR origin NOT IN ('create', 'unread'))
	`.execute(db);

	// 10b. Rows a publish wrote before this migration: the baseline and the live
	//      mapping one transaction wrote together.
	await sql`
		UPDATE public.app_deployment_baselines b SET nova_revision = r.pushed_revision
			FROM public.app_deployment_resources r
			WHERE r.deployment_id = b.deployment_id AND r.kind = 'app' AND r.superseded_at IS NULL
				AND r.remote_id = b.remote_app_id AND r.pushed_revision IS NOT NULL
				AND b.origin = 'push' AND b.nova_revision IS NULL
	`.execute(db);

	// 11. Where CommCare HQ keeps each media file of a deployment. The CHECK and
	//     the folded index are the floor the database can state without its
	//     locale: a directory and a name, no empty, `.` or `..` segment, no
	//     backslash, no control character (the code points of Unicode's Cc,
	//     named, where a locale's `[:cntrl:]` also takes U+2028 and U+2029), no
	//     space at either end, none of the names a `.ccz` gives its own files
	//     or a name under one (the root files, `<directory>/app_strings.txt`,
	//     `modules-<n>/forms-<n>.xml`, in any ASCII letter case:
	//     `lib/commcare/cczMembers.ts::isGeneratedMemberPath`), and no two
	//     paths of one deployment that differ only by ASCII letter case
	//     (`lower()` under the C collation, where a locale's folds Σ with σ and
	//     İ with i). No writer matches rows by that fold: the key every
	//     decision compares by is `hqMedia.ts::wirePathKey`, in TypeScript,
	//     whose fold takes the ASCII one and more. The TypeScript rule holds
	//     each of those apart, and the floor must never refuse a path the rule
	//     holds.
	await sql`
		CREATE TABLE IF NOT EXISTS public.app_deployment_media_paths (
			deployment_id uuid NOT NULL REFERENCES public.app_deployments(id) ON DELETE CASCADE,
			media_asset_id uuid NOT NULL REFERENCES public.media_assets(id) ON DELETE CASCADE,
			wire_path text NOT NULL,
			recorded_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (deployment_id, media_asset_id),
			CONSTRAINT app_deployment_media_paths_path_unique UNIQUE (deployment_id, wire_path),
			CONSTRAINT app_deployment_media_paths_path_shape CHECK (
				char_length(wire_path) <= 255
				AND wire_path COLLATE "C" ~ '^[^/\\\\\\x01-\\x1f\\x7f-\\x9f]+(/[^/\\\\\\x01-\\x1f\\x7f-\\x9f]+)+$'
				AND wire_path !~ '(^|/)\\.{1,2}(/|$)'
				AND wire_path !~ '^ | $'
				AND lower(wire_path COLLATE "C") !~ '^(profile\\.ccpr|suite\\.xml|media_suite\\.xml)(/|$)'
				AND lower(wire_path COLLATE "C") !~ '^[^/]+/app_strings\\.txt(/|$)'
				AND lower(wire_path COLLATE "C") !~ '^modules-[0-9]+/forms-[0-9]+\\.xml(/|$)')
		)
	`.execute(db);
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS app_deployment_media_paths_path_folded
			ON public.app_deployment_media_paths (deployment_id, lower(wire_path COLLATE "C"))
	`.execute(db);

	// 11b. The id prefix each kept keyed create writes on the project space the
	//      app was brought in from. The prefix CHECK is the shape
	//      `lib/domain/caseOperationIdentity.ts::authoredCaseIdPrefix` writes:
	//      the version marker, a lowercase version-5 UUID and a colon.
	await sql`
		CREATE TABLE IF NOT EXISTS public.app_deployment_keyed_case_ids (
			deployment_id uuid NOT NULL REFERENCES public.app_deployments(id) ON DELETE CASCADE,
			nova_operation_uuid uuid NOT NULL,
			case_type text NOT NULL,
			case_id_prefix text NOT NULL,
			recorded_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (deployment_id, nova_operation_uuid),
			CONSTRAINT app_deployment_keyed_case_ids_case_type_named
				CHECK (btrim(case_type) <> '' AND char_length(case_type) <= 255),
			CONSTRAINT app_deployment_keyed_case_ids_prefix_shape CHECK (case_id_prefix
				~ '^nova-case-v1:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:$')
		)
	`.execute(db);

	// 11b'. The word each kept case list column's field holds on one screen,
	//       where it is not the word Nova writes: `case_name` for the case's
	//       name (Nova writes `name`), `date_opened` for its opening date (Nova
	//       writes `date-opened`) and `external-id` for its external id (Nova
	//       writes `external_id`), which HQ's build reads alike
	//       (`detail_screen.py::CASE_PROPERTY_MAP`;
	//       `lib/commcare/suite/wire.ts::hqColumnFieldText`).
	await sql`
		CREATE TABLE IF NOT EXISTS public.app_deployment_column_field_words (
			deployment_id uuid NOT NULL REFERENCES public.app_deployments(id) ON DELETE CASCADE,
			nova_column_uuid uuid NOT NULL,
			screen text NOT NULL,
			field_word text NOT NULL,
			recorded_at timestamptz(3) NOT NULL DEFAULT now(),
			PRIMARY KEY (deployment_id, nova_column_uuid, screen),
			CONSTRAINT app_deployment_column_field_words_screen
				CHECK (screen IN ('short', 'long')),
			CONSTRAINT app_deployment_column_field_words_word
				CHECK (field_word IN ('case_name', 'date_opened', 'external-id'))
		)
	`.execute(db);

	// 11c. Every write Nova let out to CommCare HQ, open while `settled_at` is
	//      null and `held_until` is in the future: a settle is a state, which a
	//      transaction that began before it commits reads as settled, and a
	//      hold ends by the clock, so a crashed process needs no reaper.
	//      `resource_id` is the HQ app's id for an app write, the Nova table's
	//      id for a workbook, the Nova place's for a batch of places and the
	//      persona's for a worker account, null only on a create whose app is
	//      not recorded yet; `hq_job_id` is the media job HQ named, polled by
	//      that id. The server and the project space are the deployment's, held
	//      so by the composite key.
	await sql`
		CREATE TABLE IF NOT EXISTS public.hq_remote_writes (
			id uuid PRIMARY KEY DEFAULT uuidv7(),
			deployment_id uuid NOT NULL,
			server text NOT NULL,
			domain text NOT NULL,
			app_id text NOT NULL,
			project_id text NOT NULL,
			actor_user_id text NOT NULL,
			resource_kind text NOT NULL,
			resource_id text,
			write_kind text NOT NULL,
			opened_at timestamptz(3) NOT NULL DEFAULT now(),
			held_until timestamptz(3) NOT NULL,
			settled_at timestamptz(3),
			hq_job_id text,
			CONSTRAINT hq_remote_writes_deployment_fk
				FOREIGN KEY (deployment_id, server, domain)
				REFERENCES public.app_deployments (id, server, domain) ON DELETE CASCADE,
			CONSTRAINT hq_remote_writes_kind_pairs CHECK (
				(resource_kind = 'app' AND write_kind IN ('create', 'import', 'media'))
				OR (resource_kind = 'lookup-table' AND write_kind = 'workbook')
				OR (resource_kind = 'location' AND write_kind = 'places')
				OR (resource_kind = 'worker' AND write_kind = 'worker')),
			CONSTRAINT hq_remote_writes_resource_named CHECK (
				(resource_id IS NULL AND write_kind = 'create')
				OR (resource_id IS NOT NULL AND btrim(resource_id) <> '')),
			CONSTRAINT hq_remote_writes_job_is_media CHECK (
				hq_job_id IS NULL OR (write_kind = 'media' AND btrim(hq_job_id) <> '')),
			CONSTRAINT hq_remote_writes_held_after_opening CHECK (held_until >= opened_at)
		)
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS hq_remote_writes_resource
			ON public.hq_remote_writes (resource_kind, server, domain, resource_id, held_until)
			WHERE settled_at IS NULL
	`.execute(db);
	await sql`
		CREATE INDEX IF NOT EXISTS hq_remote_writes_app
			ON public.hq_remote_writes (app_id, held_until)
			WHERE settled_at IS NULL
	`.execute(db);

	// 11d. A person may confirm that a level of a project space whose places
	//      CommCare HQ manages takes workers, by the level's code (the grammar
	//      `lib/domain/organization.ts::LEVEL_CODE_PATTERN` holds, at most 50),
	//      which the other kinds' subject grammar does not admit: the column's
	//      own CHECK holds every kind but this one, and this one has its own.
	await sql`
		ALTER TABLE public.app_deployment_confirmations
			DROP CONSTRAINT IF EXISTS app_deployment_confirmations_kind_check,
			ADD CONSTRAINT app_deployment_confirmations_kind_check CHECK (kind IN
				('plan-feature', 'flat-location-fixture', 'connect-forwarder',
					'form-entry-sync-off', 'commtrack-off', 'worker-level')),
			DROP CONSTRAINT IF EXISTS app_deployment_confirmations_subject_check,
			ADD CONSTRAINT app_deployment_confirmations_subject_check
				CHECK (kind = 'worker-level' OR subject ~ '^[a-z][a-z0-9-]{0,63}$'),
			DROP CONSTRAINT IF EXISTS app_deployment_confirmations_worker_level_subject,
			ADD CONSTRAINT app_deployment_confirmations_worker_level_subject
				CHECK (kind <> 'worker-level' OR subject ~ '^[a-zA-Z_][-a-zA-Z0-9_]{0,49}$')
	`.execute(db);

	// 12. Hand the batch back as it was found.
	await sql`SET LOCAL lock_timeout = 0`.execute(db);
}

/** Forward only: undoing it would delete what people confirmed and where their apps came from. */
export async function down(): Promise<void> {
	throw new Error(
		"This migration is forward-only: taking it back would delete where brought-in apps came from and what people confirmed about them. A change to it goes forward in a new migration.",
	);
}
