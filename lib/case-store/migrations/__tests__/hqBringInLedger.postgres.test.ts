/**
 * The bring-in ledger migration, over the production chain before it, with
 * rows of every kind the previous revision writes. The plausible failures: a
 * mapping left without its server and project space, or a trigger that trusts
 * what a writer names; a duplicate claim the guard misses or a deleted one it
 * refuses instead of releasing; an index that lets two Projects claim one HQ
 * app, or holds a mapping that was given up; a CHECK that admits an
 * unattributed ending, or refuses the row the previous revision's supersede
 * leaves; a revision copied onto the wrong baseline, or a floor that fails the
 * batch on a revision of 0; a media path or keyed prefix the database admits
 * that no writer may write; a replay that drops what a foreign key depends
 * on; a lock wait with no bound behind the serving revision's reader; and a
 * lock timeout left set for the next migration of the batch.
 */

import { type Kysely, type RawBuilder, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { lockReleasedClaimsInTransaction } from "@/lib/db/hqAppClaims";
import type { AppDatabase } from "@/lib/db/pg";
import {
	authoredCaseIdPrefix,
	isAuthoredCaseIdPrefix,
} from "@/lib/domain/caseOperationIdentity";
import { asUuid } from "@/lib/domain/uuid";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";
import { up } from "../20261201000000_hq_bring_in_ledger";
import { up as connectActivityRolesUp } from "../20261208000000_connect_activity_roles";
import { checkConstraintVerdicts } from "./checkConstraint";
import { MEDIA_PATH_FLOOR_CASES } from "./mediaPathFloor";

const MIGRATION = "20261201000000_hq_bring_in_ledger";

const migrationsThrough = (last: string) =>
	Object.fromEntries(
		Object.entries(caseStoreMigrations).filter(([name]) => name <= last),
	);

/* Every migration before this one: the ledger as the previous revision
 * writes it. */
const database = setupPerTestDatabase({
	databaseNamePrefix: "hq_bring_in_ledger_migration_",
	establishLocalMigrationAuthority: true,
	prepareTemplate: async (db) => {
		const result = await new Migrator({
			db,
			provider: {
				getMigrations: async () =>
					Object.fromEntries(
						Object.entries(caseStoreMigrations).filter(
							([name]) => name < MIGRATION,
						),
					),
			},
		}).migrateToLatest();
		if (result.error !== undefined) throw result.error;
	},
});

const GUARD_SENTENCE =
	"Two or more Nova apps publish to one CommCare HQ app, and from this migration only one may. Nothing was changed. The deploy goes through once all but one app of each such group is in recently deleted.";

const CLAIM_INDEX = "app_deployment_resources_hq_app_claim";

const LEDGER_TABLES = [
	"app_deployments",
	"app_deployment_resources",
	"app_deployment_baselines",
	"app_deployment_media_paths",
	"app_deployment_keyed_case_ids",
	"app_deployment_column_field_words",
	"hq_remote_writes",
];

/** The SQLSTATE and constraint a statement fails with, or `undefined` when it succeeds. */
async function refusal(
	run: () => Promise<unknown>,
): Promise<{ code: string; constraint?: string } | undefined> {
	try {
		await run();
		return undefined;
	} catch (error) {
		const { code, constraint } = error as {
			code?: unknown;
			constraint?: unknown;
		};
		if (typeof code !== "string") throw error;
		return typeof constraint === "string" ? { code, constraint } : { code };
	}
}

async function runUp(db: Kysely<unknown>) {
	await db.transaction().execute((tx) => up(tx));
}

async function seedApp(
	db: Kysely<unknown>,
	id: string,
	project: string,
	deleted = false,
) {
	await sql`INSERT INTO public.apps (id, owner, project_id, app_name, app_name_lower,
		module_count, form_count, mutation_seq, status, awaiting_input,
		deleted_at, recoverable_until)
		VALUES (${id}, 'owner', ${project}, ${id}, ${id}, 0, 0, 0, 'complete', false,
			${deleted ? sql`now()` : null},
			${deleted ? sql`now() + interval '30 days'` : null})`.execute(db);
}

async function seedDeployment(
	db: Kysely<unknown>,
	input: {
		id: string;
		app: string;
		project: string;
		server?: "production" | "india" | "eu";
		domain: string;
	},
) {
	await sql`INSERT INTO public.app_deployments
		(id, app_id, project_id, server, domain, state, created_by)
		VALUES (${input.id}::uuid, ${input.app}, ${input.project},
			${input.server ?? "production"}, ${input.domain}, 'uploaded', 'owner')`.execute(
		db,
	);
}

/** The previous revision's insert of a mapping: it names neither server nor domain. */
async function insertMapping(
	db: Kysely<unknown>,
	input: {
		deployment: string;
		kind?: "app" | "lookup-table" | "location" | "worker";
		novaId?: string;
		remoteId: string;
		superseded?: boolean;
		pushedRevision?: number | null;
	},
): Promise<string> {
	const kind = input.kind ?? "app";
	const inserted = await sql<{
		id: string;
	}>`INSERT INTO public.app_deployment_resources
		(deployment_id, kind, nova_resource_id, remote_id, ownership,
			pushed_identity, pushed_at, pushed_revision, superseded_at)
		VALUES (${input.deployment}::uuid, ${kind}, ${input.novaId ?? kind},
			${input.remoteId}, 'nova-created', ${kind === "app" ? null : `${kind}-name`},
			now(), ${input.pushedRevision === undefined ? 1 : input.pushedRevision},
			${input.superseded === true ? sql`now()` : null})
		RETURNING id`.execute(db);
	const id = inserted.rows[0]?.id;
	if (id === undefined) throw new Error("The mapping insert returned no id.");
	return id;
}

async function insertBaseline(
	db: Kysely<unknown>,
	input: {
		deployment: string;
		remoteAppId: string;
		origin: "create" | "push" | "cutover" | "unread" | "read" | "changes";
	},
) {
	const holdsSource = input.origin !== "unread";
	await sql`INSERT INTO public.app_deployment_baselines
		(deployment_id, remote_app_id, origin, source_gzip, source_bytes,
			source_digest, ownership, observed_at, observed_by)
		VALUES (${input.deployment}::uuid, ${input.remoteAppId}, ${input.origin},
			${holdsSource ? sql`decode('1f8b', 'hex')` : null},
			${holdsSource ? 2 : null}, ${holdsSource ? "a".repeat(64) : null},
			${holdsSource ? sql`'{}'::jsonb` : null}, now(), 'owner')`.execute(db);
}

async function seedAsset(db: Kysely<unknown>, id: string, hash: string) {
	await sql`INSERT INTO public.media_assets (id, project_id, owner, content_hash,
		mime_type, extension, size_bytes, kind, gcs_object_key, original_filename, status)
		VALUES (${id}::uuid, 'project-a', 'owner', ${hash}, 'application/pdf', '.pdf', 10,
			'pdf', ${`projects/project-a/${hash}`}, 'guide.pdf', 'ready')`.execute(
		db,
	);
}

/** Every catalog row of the ledger's tables that this migration could touch, by name. */
async function catalog(db: Kysely<unknown>) {
	const rows = await sql<{ name: string; definition: string }>`
		SELECT 'column ' || c.relname || '.' || a.attname AS name,
			format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull
				|| ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS definition
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${LEDGER_TABLES}::text[])
			AND a.attnum > 0 AND NOT a.attisdropped
		UNION ALL
		SELECT 'constraint ' || c.relname || '.' || k.conname, pg_get_constraintdef(k.oid)
			|| ' validated=' || k.convalidated
		FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
		WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${LEDGER_TABLES}::text[])
		UNION ALL
		SELECT 'index ' || indexname, indexdef FROM pg_indexes
		WHERE schemaname = 'public' AND tablename = ANY(${LEDGER_TABLES}::text[])
		UNION ALL
		SELECT 'trigger ' || t.tgname, pg_get_triggerdef(t.oid)
		FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
		WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
			AND c.relname = ANY(${LEDGER_TABLES}::text[])
		UNION ALL
		SELECT 'routine ' || p.proname, pg_get_functiondef(p.oid)
		FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
			AND p.proname = 'nova_fill_deployment_resource_target'
		ORDER BY 1
	`.execute(db);
	return rows.rows;
}

/** Every data row of the ledger's tables the previous revision writes, in a stable order. */
async function data(db: Kysely<unknown>) {
	const rows = await sql<{ name: string; rows: unknown }>`
		SELECT 'app_deployments' AS name,
			(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb)
				FROM public.app_deployments t) AS rows
		UNION ALL
		SELECT 'app_deployment_resources',
			(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb)
				FROM public.app_deployment_resources t)
		UNION ALL
		SELECT 'app_deployment_baselines',
			(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.deployment_id), '[]'::jsonb)
				FROM public.app_deployment_baselines t)
	`.execute(db);
	return rows.rows;
}

const A = "01992000-0000-7000-8000-0000000000a1";
const B = "01992000-0000-7000-8000-0000000000b1";
const C = "01992000-0000-7000-8000-0000000000c1";
const D = "01992000-0000-7000-8000-0000000000d1";
const E = "01992000-0000-7000-8000-0000000000e1";

/** A live app in each of two Projects, and two apps in recently deleted, all
 *  on the same project space. */
async function seedFourApps(db: Kysely<unknown>) {
	await seedApp(db, "app-a", "project-a");
	await seedApp(db, "app-b", "project-b");
	await seedApp(db, "app-c", "project-c", true);
	await seedApp(db, "app-d", "project-d", true);
	await seedDeployment(db, {
		id: A,
		app: "app-a",
		project: "project-a",
		domain: "clinic",
	});
	await seedDeployment(db, {
		id: B,
		app: "app-b",
		project: "project-b",
		domain: "clinic",
	});
	await seedDeployment(db, {
		id: C,
		app: "app-c",
		project: "project-c",
		domain: "clinic",
	});
	await seedDeployment(db, {
		id: D,
		app: "app-d",
		project: "project-d",
		domain: "clinic",
	});
}

async function mappingTargets(db: Kysely<unknown>) {
	return (
		await sql<{ remote_id: string; matches: boolean }>`
			SELECT r.remote_id, (r.server = d.server AND r.domain = d.domain) AS matches
			FROM public.app_deployment_resources r
			JOIN public.app_deployments d ON d.id = r.deployment_id
			ORDER BY r.remote_id`.execute(db)
	).rows;
}

async function releasedByRemoteId(db: Kysely<unknown>) {
	return (
		await sql<{ app_id: string; remote_id: string; released: boolean }>`
			SELECT d.app_id, r.remote_id, r.released_at IS NOT NULL AS released
			FROM public.app_deployment_resources r
			JOIN public.app_deployments d ON d.id = r.deployment_id
			WHERE r.kind = 'app' ORDER BY r.remote_id, d.app_id`.execute(db)
	).rows;
}

describe(MIGRATION, () => {
	it("gives every mapping its deployment's server and project space, and the trigger fills or overwrites each one inserted after", async () => {
		const db = database.db;
		await seedApp(db, "app-a", "project-a");
		await seedDeployment(db, {
			id: A,
			app: "app-a",
			project: "project-a",
			domain: "clinic",
		});
		await seedDeployment(db, {
			id: B,
			app: "app-a",
			project: "project-a",
			server: "india",
			domain: "district",
		});
		await insertMapping(db, { deployment: A, remoteId: "hq-app" });
		await insertMapping(db, {
			deployment: A,
			remoteId: "hq-old",
			superseded: true,
		});
		await insertMapping(db, {
			deployment: A,
			kind: "lookup-table",
			remoteId: "hq-table",
		});
		await insertMapping(db, {
			deployment: B,
			kind: "location",
			remoteId: "hq-place",
		});
		await insertMapping(db, {
			deployment: B,
			kind: "worker",
			remoteId: "hq-worker",
		});
		await insertMapping(db, { deployment: B, remoteId: "hq-india-app" });
		const tokens =
			await sql`SELECT id, push_token FROM public.app_deployment_resources
			ORDER BY id`.execute(db);

		await runUp(db);

		expect(await mappingTargets(db)).toEqual(
			[
				"hq-app",
				"hq-india-app",
				"hq-old",
				"hq-place",
				"hq-table",
				"hq-worker",
			].map((remote_id) => ({ remote_id, matches: true })),
		);
		// The copy wrote no column the push-token trigger watches.
		expect(
			(
				await sql`SELECT id, push_token FROM public.app_deployment_resources
					ORDER BY id`.execute(db)
			).rows,
		).toEqual(tokens.rows);

		await insertMapping(db, {
			deployment: B,
			kind: "lookup-table",
			remoteId: "hq-new",
		});
		await sql`INSERT INTO public.app_deployment_resources
			(deployment_id, kind, nova_resource_id, remote_id, ownership, pushed_identity,
				server, domain)
			VALUES (${B}::uuid, 'location', 'place-2', 'hq-named', 'nova-created', 'site',
				'eu', 'elsewhere')`.execute(db);
		const inserted = await sql<{
			remote_id: string;
			server: string;
			domain: string;
		}>`
			SELECT remote_id, server, domain FROM public.app_deployment_resources
			WHERE remote_id IN ('hq-new', 'hq-named') ORDER BY remote_id`.execute(db);
		expect(inserted.rows).toEqual([
			{ remote_id: "hq-named", server: "india", domain: "district" },
			{ remote_id: "hq-new", server: "india", domain: "district" },
		]);
	});

	it("stops with its sentence while two live Nova apps publish to one CommCare HQ app, and changes nothing", async () => {
		const db = database.db;
		await seedFourApps(db);
		await insertMapping(db, { deployment: A, remoteId: "hq-shared" });
		await insertMapping(db, { deployment: B, remoteId: "hq-shared" });
		await insertMapping(db, { deployment: C, remoteId: "hq-shared" });
		const before = { catalog: await catalog(db), data: await data(db) };

		await expect(runUp(db)).rejects.toThrow(GUARD_SENTENCE);

		expect({ catalog: await catalog(db), data: await data(db) }).toEqual(
			before,
		);
	});

	it("releases each deleted app's mapping another mapping names, keeps every other claim, and builds the index", async () => {
		const db = database.db;
		await seedFourApps(db);
		await seedApp(db, "app-e", "project-e", true);
		await seedDeployment(db, {
			id: E,
			app: "app-e",
			project: "project-e",
			domain: "clinic",
		});
		// A live app and a deleted one on one HQ app.
		await insertMapping(db, { deployment: A, remoteId: "hq-1" });
		await insertMapping(db, { deployment: C, remoteId: "hq-1" });
		// Two deleted apps on another: both give it up.
		await insertMapping(db, {
			deployment: D,
			novaId: "app-d",
			remoteId: "hq-2",
		});
		await insertMapping(db, { deployment: E, remoteId: "hq-2" });
		// A deleted app alone on its HQ app keeps it.
		await insertMapping(db, {
			deployment: D,
			kind: "lookup-table",
			remoteId: "hq-3",
		});
		await insertMapping(db, {
			deployment: B,
			remoteId: "hq-4",
			superseded: true,
		});
		await insertMapping(db, {
			deployment: D,
			novaId: "app-d-2",
			remoteId: "hq-4",
		});

		await runUp(db);

		expect(await releasedByRemoteId(db)).toEqual([
			{ app_id: "app-a", remote_id: "hq-1", released: false },
			{ app_id: "app-c", remote_id: "hq-1", released: true },
			{ app_id: "app-d", remote_id: "hq-2", released: true },
			{ app_id: "app-e", remote_id: "hq-2", released: true },
			{ app_id: "app-b", remote_id: "hq-4", released: false },
			{ app_id: "app-d", remote_id: "hq-4", released: false },
		]);
		const index = await sql<{ indexdef: string }>`
			SELECT indexdef FROM pg_indexes
			WHERE schemaname = 'public' AND indexname = ${CLAIM_INDEX}`.execute(db);
		expect(index.rows).toEqual([
			{
				indexdef:
					"CREATE UNIQUE INDEX app_deployment_resources_hq_app_claim ON public.app_deployment_resources USING btree (server, domain, remote_id) WHERE ((kind = 'app'::text) AND (superseded_at IS NULL) AND (released_at IS NULL))",
			},
		]);
	});

	it("refuses a second live claim of one HQ app from another Project, and admits it once the first is superseded or released", async () => {
		const db = database.db;
		await seedFourApps(db);
		await runUp(db);
		const first = await insertMapping(db, { deployment: A, remoteId: "hq-1" });

		expect(
			await refusal(() =>
				insertMapping(db, { deployment: B, remoteId: "hq-1" }),
			),
		).toEqual({ code: "23505", constraint: CLAIM_INDEX });
		// Another kind, or another project space's app of the same id, is no claim of it.
		await insertMapping(db, {
			deployment: B,
			kind: "lookup-table",
			remoteId: "hq-1",
		});
		await seedDeployment(db, {
			id: E,
			app: "app-b",
			project: "project-b",
			server: "eu",
			domain: "clinic",
		});
		await insertMapping(db, { deployment: E, remoteId: "hq-1" });

		await sql`UPDATE public.app_deployment_resources SET superseded_at = now()
			WHERE id = ${first}::uuid`.execute(db);
		const second = await insertMapping(db, { deployment: B, remoteId: "hq-1" });
		expect(
			await refusal(() =>
				insertMapping(db, { deployment: C, remoteId: "hq-1" }),
			),
		).toEqual({ code: "23505", constraint: CLAIM_INDEX });

		await sql`UPDATE public.app_deployment_resources SET released_at = now()
			WHERE id = ${second}::uuid`.execute(db);
		expect(
			await refusal(() =>
				insertMapping(db, { deployment: C, remoteId: "hq-1" }),
			),
		).toBeUndefined();
	});

	it("refuses an ending with no person, a release on any mapping but an app's, a revision below zero, and a media record that is no object", async () => {
		const db = database.db;
		await seedFourApps(db);
		await runUp(db);
		const live = await insertMapping(db, {
			deployment: A,
			remoteId: "hq-live",
		});
		const ended = await insertMapping(db, {
			deployment: A,
			novaId: "app-old",
			remoteId: "hq-ended",
			superseded: true,
		});
		const end = (id: string, by: string | null, reason: string | null) =>
			refusal(() =>
				sql`UPDATE public.app_deployment_resources
					SET ended_by = ${by}, ended_reason = ${reason} WHERE id = ${id}::uuid`.execute(
					db,
				),
			);
		const endingCheck = {
			code: "23514",
			constraint: "app_deployment_resources_ending_is_attributed",
		};
		expect(await end(ended, null, "stopped")).toEqual(endingCheck);
		expect(await end(ended, "  ", "stopped")).toEqual(endingCheck);
		expect(await end(ended, "owner", null)).toEqual(endingCheck);
		expect(await end(ended, "owner", "deleted")).toEqual(endingCheck);
		expect(await end(live, "owner", "stopped")).toEqual(endingCheck);
		expect(await end(ended, "owner", "stopped")).toBeUndefined();
		expect(await end(ended, "owner", "claimed-elsewhere")).toBeUndefined();

		for (const kind of ["lookup-table", "location", "worker"] as const) {
			const id = await insertMapping(db, {
				deployment: B,
				kind,
				remoteId: `hq-${kind}`,
			});
			expect(
				await refusal(() =>
					sql`UPDATE public.app_deployment_resources SET released_at = now()
						WHERE id = ${id}::uuid`.execute(db),
				),
			).toEqual({
				code: "23514",
				constraint: "app_deployment_resources_release_is_an_apps",
			});
		}

		await insertBaseline(db, {
			deployment: A,
			remoteAppId: "hq-live",
			origin: "read",
		});
		const baseline = (assignment: RawBuilder<unknown>) =>
			refusal(() =>
				sql`UPDATE public.app_deployment_baselines SET ${assignment}
					WHERE deployment_id = ${A}::uuid`.execute(db),
			);
		expect(await baseline(sql`nova_revision = -1`)).toEqual({
			code: "23514",
			constraint: "app_deployment_baselines_nova_revision_is_a_sequence",
		});
		expect(await baseline(sql`nova_revision = 0`)).toBeUndefined();
		for (const value of ["[]", '"commcare/logo.png"', "1", "null"]) {
			expect(await baseline(sql`media_files = ${value}::jsonb`)).toEqual({
				code: "23514",
				constraint: "app_deployment_baselines_media_files_is_a_map",
			});
		}
		expect(
			await baseline(
				sql`media_files = '{"commcare/logo.png": "abc123"}'::jsonb`,
			),
		).toBeUndefined();

		expect(
			await refusal(() =>
				sql`UPDATE public.app_deployments SET state = 'gone'
					WHERE id = ${A}::uuid`.execute(db),
			),
		).toEqual({ code: "23514", constraint: "app_deployments_state_check" });
		await sql`UPDATE public.app_deployments SET state = 'ended', endings = endings + 1
			WHERE id = ${A}::uuid`.execute(db);
		expect(
			await refusal(() =>
				sql`UPDATE public.app_deployments SET endings = -1
					WHERE id = ${A}::uuid`.execute(db),
			),
		).toMatchObject({ code: "23514" });
	});

	it("holds a first-publish list only on a baseline that holds a source", async () => {
		const db = database.db;
		await seedFourApps(db);
		await runUp(db);
		const nullable = await sql<{ is_nullable: string; data_type: string }>`
			SELECT is_nullable, data_type FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'app_deployment_baselines'
				AND column_name = 'first_publish_changes'`.execute(db);
		expect(nullable.rows).toEqual([{ is_nullable: "YES", data_type: "jsonb" }]);

		const list = JSON.stringify({
			ids: ["web-apps-on"],
			webAppsOnInHq: false,
			of: "first-publish",
		});
		const deployments = [
			[A, "read"],
			[B, "push"],
			[C, "create"],
			[D, "unread"],
		] as const;
		for (const [deployment, origin] of deployments)
			await insertBaseline(db, { deployment, remoteAppId: "hq-app", origin });
		const hold = (deployment: string) =>
			refusal(() =>
				sql`UPDATE public.app_deployment_baselines
					SET first_publish_changes = ${list}::jsonb
					WHERE deployment_id = ${deployment}::uuid`.execute(db),
			);
		const needsSource = {
			code: "23514",
			constraint:
				"app_deployment_baselines_first_publish_changes_need_a_source",
		};
		expect(await hold(A)).toBeUndefined();
		expect(await hold(B)).toBeUndefined();
		expect(await hold(C)).toEqual(needsSource);
		expect(await hold(D)).toEqual(needsSource);
		// An upsert of the previous revision that turns a listed row into a
		// `create` one is refused, with nothing written.
		expect(
			await refusal(() =>
				sql`UPDATE public.app_deployment_baselines SET origin = 'create'
					WHERE deployment_id = ${A}::uuid`.execute(db),
			),
		).toEqual(needsSource);
		// The two other origins that hold a source keep a list too: a bring-in
		// of changes, and the cutover's.
		for (const [deployment, origin] of [
			[A, "changes"],
			[B, "cutover"],
		] as const)
			expect(
				await refusal(() =>
					sql`UPDATE public.app_deployment_baselines SET origin = ${origin}
						WHERE deployment_id = ${deployment}::uuid`.execute(db),
				),
			).toBeUndefined();
	});

	it("pairs each push baseline with its live mapping's revision, revision 0 included, leaves every other origin null, and changes nothing on a replay", async () => {
		const db = database.db;
		await seedApp(db, "app-a", "project-a");
		const cases = [
			{
				domain: "push-7",
				origin: "push",
				remote: "hq-7",
				mapped: "hq-7",
				revision: 7,
			},
			{
				domain: "push-0",
				origin: "push",
				remote: "hq-0",
				mapped: "hq-0",
				revision: 0,
			},
			{
				domain: "push-other",
				origin: "push",
				remote: "hq-old",
				mapped: "hq-new",
				revision: 4,
			},
			{
				domain: "push-unpushed",
				origin: "push",
				remote: "hq-u",
				mapped: "hq-u",
				revision: null,
			},
			{
				domain: "create",
				origin: "create",
				remote: "hq-c",
				mapped: "hq-c",
				revision: 3,
			},
			{
				domain: "cutover",
				origin: "cutover",
				remote: "hq-x",
				mapped: "hq-x",
				revision: 3,
			},
			{
				domain: "unread",
				origin: "unread",
				remote: "hq-r",
				mapped: "hq-r",
				revision: 3,
			},
		] as const;
		for (const [index, one] of cases.entries()) {
			const id = `01992000-0000-7000-8000-00000000010${index}`;
			await seedDeployment(db, {
				id,
				app: "app-a",
				project: "project-a",
				domain: one.domain,
			});
			await insertMapping(db, {
				deployment: id,
				remoteId: one.mapped,
				pushedRevision: one.revision,
			});
			await insertBaseline(db, {
				deployment: id,
				remoteAppId: one.remote,
				origin: one.origin,
			});
		}
		// A superseded mapping of the same HQ app is not the pair.
		await insertMapping(db, {
			deployment: "01992000-0000-7000-8000-000000000102",
			novaId: "app-earlier",
			remoteId: "hq-old",
			superseded: true,
			pushedRevision: 2,
		});
		const revisions = async () =>
			(
				await sql<{ domain: string; nova_revision: string | null }>`
					SELECT d.domain, b.nova_revision::text AS nova_revision
					FROM public.app_deployment_baselines b
					JOIN public.app_deployments d ON d.id = b.deployment_id
					ORDER BY d.domain`.execute(db)
			).rows;

		await runUp(db);

		expect(await revisions()).toEqual([
			{ domain: "create", nova_revision: null },
			{ domain: "cutover", nova_revision: null },
			{ domain: "push-0", nova_revision: "0" },
			{ domain: "push-7", nova_revision: "7" },
			{ domain: "push-other", nova_revision: null },
			{ domain: "push-unpushed", nova_revision: null },
			{ domain: "unread", nova_revision: null },
		]);

		// A revision a later publish wrote is not the fill's to change.
		await sql`UPDATE public.app_deployment_baselines b SET nova_revision = 9
			FROM public.app_deployments d
			WHERE d.id = b.deployment_id AND d.domain = 'push-7'`.execute(db);
		const after = await revisions();
		await runUp(db);
		expect(await revisions()).toEqual(after);

		// The old writer can still lose its post-import read. Its upsert
		// replaces all four source fields but cannot clear nova_revision.
		const oldPush = "01992000-0000-7000-8000-000000000100";
		await sql`INSERT INTO public.app_deployment_baselines
			(deployment_id, remote_app_id, origin, observed_at, observed_by)
			VALUES (${oldPush}::uuid, 'hq-7', 'unread', now(), 'owner')
			ON CONFLICT (deployment_id) DO UPDATE SET
				origin = EXCLUDED.origin, source_gzip = EXCLUDED.source_gzip,
				source_bytes = EXCLUDED.source_bytes, source_digest = EXCLUDED.source_digest,
				ownership = EXCLUDED.ownership`.execute(db);
		expect(
			(
				await sql`SELECT origin, nova_revision, source_digest FROM public.app_deployment_baselines
			WHERE deployment_id = ${oldPush}::uuid`.execute(db)
			).rows,
		).toEqual([{ origin: "unread", nova_revision: "9", source_digest: null }]);
		// An observation holding actual bytes, in contrast, may never claim
		// that those bytes represent a saved revision of the Nova app.
		expect(
			await refusal(() =>
				sql`UPDATE public.app_deployment_baselines
			SET source_gzip = decode('1f8b','hex'), source_bytes = 2,
				source_digest = ${"a".repeat(64)}, ownership = '{}'::jsonb
			WHERE deployment_id = ${oldPush}::uuid`.execute(db),
			),
		).toEqual({
			code: "23514",
			constraint: "app_deployment_baselines_source_shape",
		});
	});

	it("lets the previous revision supersede a released mapping and insert the fresh one beside it", async () => {
		const db = database.db;
		await seedFourApps(db);
		await insertMapping(db, { deployment: A, remoteId: "hq-1" });
		await insertMapping(db, {
			deployment: C,
			novaId: "app-c",
			remoteId: "hq-1",
		});
		await runUp(db);
		expect(await releasedByRemoteId(db)).toEqual([
			{ app_id: "app-a", remote_id: "hq-1", released: false },
			{ app_id: "app-c", remote_id: "hq-1", released: true },
		]);

		// `store.ts::writeResourceMapping` as the previous revision runs it, for
		// the app CommCare HQ created when the restored app published again.
		await db.transaction().execute(async (tx) => {
			await sql`UPDATE app_deployment_resources SET superseded_at = now()
				WHERE deployment_id = ${C}::uuid AND kind = 'app' AND nova_resource_id = 'app-c'
					AND superseded_at IS NULL AND remote_id <> 'hq-fresh'`.execute(tx);
			await sql`INSERT INTO app_deployment_resources
				(deployment_id, kind, nova_resource_id, remote_id, ownership, adopted_at,
					adopted_by, pushed_identity, pushed_revision, pushed_at, remote_revision,
					remote_observed_at)
				VALUES (${C}::uuid, 'app', 'app-c', 'hq-fresh', 'nova-created', NULL, NULL, NULL,
					3, now(), NULL, NULL)
				ON CONFLICT (deployment_id, kind, nova_resource_id) WHERE superseded_at IS NULL
				DO UPDATE SET remote_id = 'hq-fresh', pushed_revision = 3, pushed_at = now(),
					remote_missing_at = NULL`.execute(tx);
		});

		const rows = await sql<{
			remote_id: string;
			superseded: boolean;
			released: boolean;
			server: string;
			domain: string;
		}>`SELECT remote_id, superseded_at IS NOT NULL AS superseded,
				released_at IS NOT NULL AS released, server, domain
			FROM public.app_deployment_resources
			WHERE deployment_id = ${C}::uuid ORDER BY remote_id`.execute(db);
		expect(rows.rows).toEqual([
			{
				remote_id: "hq-1",
				superseded: true,
				released: true,
				server: "production",
				domain: "clinic",
			},
			{
				remote_id: "hq-fresh",
				superseded: false,
				released: false,
				server: "production",
				domain: "clinic",
			},
		]);
		// A settle of the app's released claims finds none left to settle. The
		// settle is today's code, which reads the app row as the later
		// migrations leave it: with the Connect roles column.
		await db.transaction().execute((tx) => connectActivityRolesUp(tx));
		const locks = await (db as unknown as Kysely<AppDatabase>)
			.transaction()
			.execute((tx) => lockReleasedClaimsInTransaction(tx, "app-c"));
		expect(locks?.released).toEqual([]);
	});

	it("holds a media path to the floor the database states, under any directory and one path per letter case", async () => {
		const db = database.db;
		await seedFourApps(db);
		await runUp(db);
		const verdicts = await checkConstraintVerdicts(
			db,
			"public.app_deployment_media_paths",
			"app_deployment_media_paths_path_shape",
			"wire_path",
			MEDIA_PATH_FLOOR_CASES.map((one) => one.path),
		);
		expect(verdicts.map((one) => one.admitted === true)).toEqual(
			MEDIA_PATH_FLOOR_CASES.map((one) => one.floorAdmits),
		);

		const assets = [
			"01992000-0000-7000-8000-000000000201",
			"01992000-0000-7000-8000-000000000202",
			"01992000-0000-7000-8000-000000000203",
		] as const;
		for (const [index, id] of assets.entries())
			await seedAsset(db, id, String(index).repeat(64));
		const hold = (deployment: string, asset: string, path: string) =>
			refusal(() =>
				sql`INSERT INTO public.app_deployment_media_paths
					(deployment_id, media_asset_id, wire_path)
					VALUES (${deployment}::uuid, ${asset}::uuid, ${path})`.execute(db),
			);
		expect(await hold(A, assets[0], "media/logo.png")).toBeUndefined();
		expect(
			await hold(A, assets[1], "commcare/image/photo.jpg"),
		).toBeUndefined();
		expect(await hold(A, assets[2], "Media/Logo.PNG")).toEqual({
			code: "23505",
			constraint: "app_deployment_media_paths_path_folded",
		});
		expect(await hold(A, assets[2], "media/logo.png")).toMatchObject({
			code: "23505",
		});
		expect(await hold(A, assets[0], "media/other.png")).toEqual({
			code: "23505",
			constraint: "app_deployment_media_paths_pkey",
		});
		// Another deployment holds its own paths.
		expect(await hold(B, assets[2], "media/logo.png")).toBeUndefined();
		expect(await hold(B, assets[0], "commcare/../logo.png")).toEqual({
			code: "23514",
			constraint: "app_deployment_media_paths_path_shape",
		});

		const held = async () =>
			(
				await sql<{ wire_path: string }>`SELECT wire_path
					FROM public.app_deployment_media_paths ORDER BY deployment_id, wire_path`.execute(
					db,
				)
			).rows.map((row) => row.wire_path);
		await sql`DELETE FROM public.media_assets WHERE id = ${assets[1]}::uuid`.execute(
			db,
		);
		expect(await held()).toEqual(["media/logo.png", "media/logo.png"]);
		await sql`DELETE FROM public.app_deployments WHERE id = ${A}::uuid`.execute(
			db,
		);
		expect(await held()).toEqual(["media/logo.png"]);
	});

	it("folds a media path by ASCII letter case alone, so no locale refuses two paths the rule holds apart", async () => {
		const db = database.db;
		await seedFourApps(db);
		await runUp(db);
		/* `toLowerCase()` gives ας for ΑΣ (a final sigma) and i̇ for İ, so
		 * assignMediaPaths keeps each pair; a locale's lower() would fold both
		 * pairs together. */
		const paths = [
			"media/ΑΣ-1.png",
			"media/ασ-1.png",
			"media/İ.png",
			"media/i.png",
			"media/Logo.png",
			"media/logo.png",
		];
		const assets = paths.map(
			(_, index) =>
				`01992000-0000-7000-8000-0000000003${String(index).padStart(2, "0")}`,
		);
		for (const [index, id] of assets.entries())
			await seedAsset(db, id, String(index).repeat(64));
		const verdicts: ({ code: string; constraint?: string } | undefined)[] = [];
		for (const [index, path] of paths.entries())
			verdicts.push(
				await refusal(() =>
					sql`INSERT INTO public.app_deployment_media_paths
						(deployment_id, media_asset_id, wire_path)
						VALUES (${A}::uuid, ${assets[index]}::uuid, ${path})`.execute(db),
				),
			);
		expect(verdicts).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ code: "23505", constraint: "app_deployment_media_paths_path_folded" },
		]);
	});

	it("holds a keyed create's prefix in the shape Nova derives, one per operation, gone with its deployment", async () => {
		const db = database.db;
		await seedFourApps(db);
		await runUp(db);
		const derived = authoredCaseIdPrefix({
			appId: "app-a",
			formUuid: asUuid("01992000-0000-7000-8000-000000000301"),
			operationUuid: asUuid("01992000-0000-7000-8000-000000000302"),
			caseType: "patient",
		});
		const uuid = derived.slice("nova-case-v1:".length, -1);
		const prefixes = [
			derived,
			"",
			"nova-case-v1:",
			`nova-case-v1:${uuid}`,
			`nova-case-v1:${uuid.toUpperCase()}:`,
			`nova-case-v1:${uuid.slice(0, 14)}4${uuid.slice(15)}:`,
			`nova-case-v2:${uuid}:`,
			`nova-case-v1:${uuid}:extra`,
		];
		const verdicts = await checkConstraintVerdicts(
			db,
			"public.app_deployment_keyed_case_ids",
			"app_deployment_keyed_case_ids_prefix_shape",
			"case_id_prefix",
			prefixes,
		);
		expect(verdicts.map((one) => one.admitted === true)).toEqual([
			true,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
		]);
		// The reader holds a keyed create only under a prefix this floor stores.
		expect(verdicts.map((one) => one.admitted === true)).toEqual(
			prefixes.map(isAuthoredCaseIdPrefix),
		);

		const record = (deployment: string, operation: string, caseType: string) =>
			refusal(() =>
				sql`INSERT INTO public.app_deployment_keyed_case_ids
					(deployment_id, nova_operation_uuid, case_type, case_id_prefix)
					VALUES (${deployment}::uuid, ${operation}::uuid, ${caseType}, ${derived})`.execute(
					db,
				),
			);
		const operation = "01992000-0000-7000-8000-000000000302";
		expect(await record(A, operation, "patient")).toBeUndefined();
		expect(await record(A, operation, "visit")).toEqual({
			code: "23505",
			constraint: "app_deployment_keyed_case_ids_pkey",
		});
		for (const caseType of ["", "  ", "c".repeat(256)])
			expect(
				await record(B, "01992000-0000-7000-8000-000000000303", caseType),
			).toEqual({
				code: "23514",
				constraint: "app_deployment_keyed_case_ids_case_type_named",
			});
		expect(await record(B, operation, "patient")).toBeUndefined();

		await sql`DELETE FROM public.app_deployments WHERE id = ${A}::uuid`.execute(
			db,
		);
		const left = await sql<{ deployment_id: string }>`
			SELECT deployment_id FROM public.app_deployment_keyed_case_ids`.execute(
			db,
		);
		expect(left.rows).toEqual([{ deployment_id: B }]);
	});

	it("holds a column's field word only where it is one Nova does not write, one per column and screen, gone with its deployment", async () => {
		const db = database.db;
		await seedFourApps(db);
		await runUp(db);
		const column = "01992000-0000-7000-8000-000000000401";
		const record = (deployment: string, screen: string, word: string) =>
			refusal(() =>
				sql`INSERT INTO public.app_deployment_column_field_words
					(deployment_id, nova_column_uuid, screen, field_word)
					VALUES (${deployment}::uuid, ${column}::uuid, ${screen}, ${word})`.execute(
					db,
				),
			);
		/* The words Nova writes, `name`, `date-opened` and `external_id`, are no row. */
		for (const word of ["name", "date-opened", "external_id", "status", ""])
			expect(await record(A, "short", word)).toEqual({
				code: "23514",
				constraint: "app_deployment_column_field_words_word",
			});
		expect(await record(A, "detail", "case_name")).toEqual({
			code: "23514",
			constraint: "app_deployment_column_field_words_screen",
		});
		for (const word of ["case_name", "date_opened", "external-id"]) {
			await sql`DELETE FROM public.app_deployment_column_field_words`.execute(
				db,
			);
			expect(await record(A, "short", word)).toBeUndefined();
		}
		expect(await record(A, "short", "case_name")).toEqual({
			code: "23505",
			constraint: "app_deployment_column_field_words_pkey",
		});
		expect(await record(A, "long", "case_name")).toBeUndefined();
		expect(await record(B, "short", "case_name")).toBeUndefined();

		await sql`DELETE FROM public.app_deployments WHERE id = ${A}::uuid`.execute(
			db,
		);
		const left = await sql<{ deployment_id: string }>`
			SELECT deployment_id FROM public.app_deployment_column_field_words`.execute(
			db,
		);
		expect(left.rows).toEqual([{ deployment_id: B }]);
	});

	it("holds a write Nova let out to CommCare HQ to its deployment's project space, its kind and its resource, gone with its deployment", async () => {
		const db = database.db;
		await seedFourApps(db);
		await runUp(db);
		const write = (input: {
			readonly domain?: string;
			readonly resourceKind?: string;
			readonly resourceId?: string | null;
			readonly writeKind?: string;
			readonly jobId?: string | null;
			readonly heldUntil?: string;
		}) =>
			refusal(() =>
				sql`INSERT INTO public.hq_remote_writes
					(deployment_id, server, domain, app_id, project_id, actor_user_id,
						resource_kind, resource_id, write_kind, held_until, hq_job_id)
					VALUES (${A}::uuid, 'production', ${input.domain ?? "clinic"},
						'app-a', 'project-a', 'owner', ${input.resourceKind ?? "app"},
						${input.resourceId === undefined ? "hq-app" : input.resourceId},
						${input.writeKind ?? "import"},
						${sql.raw(input.heldUntil ?? "now() + interval '5 minutes'")},
						${input.jobId ?? null})`.execute(db),
			);
		expect(await write({})).toBeUndefined();
		/* A create HQ has not answered names no app yet; nothing else may. */
		expect(
			await write({ writeKind: "create", resourceId: null }),
		).toBeUndefined();
		expect(await write({ resourceId: null })).toEqual({
			code: "23514",
			constraint: "hq_remote_writes_resource_named",
		});
		expect(await write({ resourceId: " " })).toEqual({
			code: "23514",
			constraint: "hq_remote_writes_resource_named",
		});
		expect(await write({ writeKind: "media", jobId: "job-1" })).toBeUndefined();
		expect(await write({ jobId: "job-1" })).toEqual({
			code: "23514",
			constraint: "hq_remote_writes_job_is_media",
		});
		expect(
			await write({ resourceKind: "lookup-table", writeKind: "workbook" }),
		).toBeUndefined();
		expect(await write({ resourceKind: "lookup-table" })).toEqual({
			code: "23514",
			constraint: "hq_remote_writes_kind_pairs",
		});
		expect(
			await write({
				resourceKind: "location",
				resourceId: "place-uuid",
				writeKind: "places",
			}),
		).toBeUndefined();
		expect(
			await write({ resourceKind: "location", resourceId: "place-uuid" }),
		).toEqual({
			code: "23514",
			constraint: "hq_remote_writes_kind_pairs",
		});
		expect(
			await write({
				resourceKind: "worker",
				resourceId: "persona-uuid",
				writeKind: "worker",
			}),
		).toBeUndefined();
		expect(
			await write({ resourceKind: "worker", resourceId: "persona-uuid" }),
		).toEqual({
			code: "23514",
			constraint: "hq_remote_writes_kind_pairs",
		});
		expect(await write({ heldUntil: "now() - interval '1 second'" })).toEqual({
			code: "23514",
			constraint: "hq_remote_writes_held_after_opening",
		});
		expect(await write({ domain: "elsewhere" })).toEqual({
			code: "23503",
			constraint: "hq_remote_writes_deployment_fk",
		});

		await sql`DELETE FROM public.app_deployments WHERE id = ${A}::uuid`.execute(
			db,
		);
		const left = await sql<{ n: string }>`
			SELECT count(*)::text AS n FROM public.hq_remote_writes`.execute(db);
		expect(left.rows).toEqual([{ n: "0" }]);
	});

	it("takes a level's code as the subject of a worker-level confirmation, and holds every other kind to its own subject grammar", async () => {
		const db = database.db;
		await seedFourApps(db);
		await runUp(db);
		const confirm = (kind: string, subject: string) =>
			refusal(() =>
				sql`INSERT INTO public.app_deployment_confirmations
					(deployment_id, kind, subject, confirmed_by)
					VALUES (${A}::uuid, ${kind}, ${subject}, 'owner')`.execute(db),
			);
		expect(await confirm("worker-level", "District_Level")).toBeUndefined();
		expect(await confirm("worker-level", "_ward-2")).toBeUndefined();
		expect(await confirm("worker-level", "2nd")).toEqual({
			code: "23514",
			constraint: "app_deployment_confirmations_worker_level_subject",
		});
		expect(await confirm("worker-level", "a".repeat(51))).toEqual({
			code: "23514",
			constraint: "app_deployment_confirmations_worker_level_subject",
		});
		expect(await confirm("plan-feature", "District_Level")).toEqual({
			code: "23514",
			constraint: "app_deployment_confirmations_subject_check",
		});
		expect(await confirm("commtrack-off", "commtrack-off")).toBeUndefined();
		expect(await confirm("worker-levels", "district")).toEqual({
			code: "23514",
			constraint: "app_deployment_confirmations_kind_check",
		});
	});

	it("runs again over its own result with its ledger row erased, and changes no catalog row and no data row", async () => {
		const db = database.db;
		await seedFourApps(db);
		await insertMapping(db, {
			deployment: A,
			remoteId: "hq-1",
			pushedRevision: 5,
		});
		await insertMapping(db, { deployment: C, remoteId: "hq-1" });
		await insertMapping(db, {
			deployment: B,
			kind: "lookup-table",
			remoteId: "hq-table",
		});
		await insertBaseline(db, {
			deployment: A,
			remoteAppId: "hq-1",
			origin: "push",
		});
		await insertBaseline(db, {
			deployment: B,
			remoteAppId: "hq-b",
			origin: "unread",
		});
		const migrator = new Migrator({
			db,
			provider: { getMigrations: async () => migrationsThrough(MIGRATION) },
		});
		const first = await migrator.migrateToLatest();
		expect(first.error).toBeUndefined();
		expect(first.results?.map((one) => one.migrationName)).toEqual([MIGRATION]);
		const after = { catalog: await catalog(db), data: await data(db) };

		await sql`DELETE FROM kysely_migration WHERE name = ${MIGRATION}`.execute(
			db,
		);
		const replay = await migrator.migrateToLatest();
		expect(replay.error).toBeUndefined();
		expect(replay.results).toEqual([
			{ migrationName: MIGRATION, direction: "Up", status: "Success" },
		]);

		expect({ catalog: await catalog(db), data: await data(db) }).toEqual(after);
	});

	it("gives up after five seconds behind a reader, changes nothing, and resets the timeout once it runs", {
		timeout: 30_000,
	}, async () => {
		const db = database.db;
		await seedFourApps(db);
		await insertMapping(db, { deployment: A, remoteId: "hq-1" });
		await insertMapping(db, { deployment: C, remoteId: "hq-1" });
		await insertBaseline(db, {
			deployment: A,
			remoteAppId: "hq-1",
			origin: "push",
		});
		const before = { catalog: await catalog(db), data: await data(db) };
		const reader = new Client({ connectionString: database.uri });
		await reader.connect();
		try {
			await reader.query("BEGIN");
			await reader.query(
				"LOCK TABLE public.app_deployment_baselines IN ACCESS SHARE MODE",
			);

			const started = performance.now();
			const refused = await refusal(() => runUp(db));
			const waited = performance.now() - started;
			expect(refused?.code).toBe("55P03");
			expect(waited).toBeGreaterThanOrEqual(5_000);
			expect(waited).toBeLessThan(10_000);
			expect({ catalog: await catalog(db), data: await data(db) }).toEqual(
				before,
			);

			await reader.query("COMMIT");
			const timeout = await db.transaction().execute(async (tx) => {
				await up(tx);
				const shown = await sql<{
					lock_timeout: string;
				}>`SHOW lock_timeout`.execute(tx);
				return shown.rows[0]?.lock_timeout;
			});
			expect(timeout).toBe("0");
			expect(await releasedByRemoteId(db)).toEqual([
				{ app_id: "app-a", remote_id: "hq-1", released: false },
				{ app_id: "app-c", remote_id: "hq-1", released: true },
			]);
		} finally {
			await reader.end();
		}
	});

	it("holds no ledger table while it waits for another, so the previous revision's baseline read and baseline write pass it in either order", {
		timeout: 30_000,
	}, async () => {
		const db = database.db;
		await seedFourApps(db);
		await insertBaseline(db, {
			deployment: A,
			remoteAppId: "hq-1",
			origin: "push",
		});
		const publisher = new Client({ connectionString: database.uri });
		const reader = new Client({ connectionString: database.uri });
		const observer = new Client({ connectionString: database.uri });
		await publisher.connect();
		await reader.connect();
		await observer.connect();
		let migration: Promise<{ code: string } | undefined> | undefined;
		let settled = false;
		try {
			/* The previous revision's mapping insert, still open: it holds
			 * app_deployment_resources, and app_deployments through its foreign key. */
			await publisher.query("BEGIN");
			await publisher.query(
				`INSERT INTO public.app_deployment_resources
					(deployment_id, kind, nova_resource_id, remote_id, ownership, pushed_at, pushed_revision)
					VALUES ($1::uuid, 'app', 'app', 'hq-b', 'nova-created', now(), 1)`,
				[B],
			);
			const publisherPid = (
				await publisher.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
			).rows[0]?.pid;
			if (publisherPid === undefined)
				throw new Error("The publisher's connection named no backend.");

			migration = refusal(() => runUp(db)).finally(() => {
				settled = true;
			});
			/* Wait until the migration is contending for its locks. */
			for (let attempt = 0; ; attempt += 1) {
				await observer.query("SELECT pg_stat_clear_snapshot()");
				const waiting = await observer.query<{ count: number }>(
					`SELECT count(*)::int AS count FROM pg_stat_activity
						WHERE datname = current_database()
							AND pid NOT IN (pg_backend_pid(), $1)
							AND state = 'active'
							AND (wait_event_type = 'Lock' OR wait_event = 'PgSleep')`,
					[publisherPid],
				);
				if ((waiting.rows[0]?.count ?? 0) > 0) break;
				if (settled)
					throw new Error(
						"The migration finished before it ever waited behind the open mapping insert.",
					);
				if (attempt > 2_000)
					throw new Error(
						"The migration never reached its wait behind the open mapping insert.",
					);
				await new Promise<void>((resolve) => setImmediate(resolve));
			}

			/* A request that waited behind the migration fails here instead of
			 * hanging, and one caught in a cycle with it fails with 40P01. */
			await reader.query("SET lock_timeout = '3s'");
			const read = await reader.query<{ deployment_id: string }>(
				`SELECT b.deployment_id FROM public.app_deployment_baselines b
					JOIN public.app_deployments d ON d.id = b.deployment_id
					WHERE d.app_id = 'app-a'`,
			);
			expect(read.rows).toEqual([{ deployment_id: A }]);

			await reader.query("BEGIN");
			await reader.query(
				"SELECT id FROM public.app_deployments WHERE id = $1::uuid FOR UPDATE",
				[A],
			);
			await reader.query(
				`UPDATE public.app_deployment_baselines SET observed_at = now()
					WHERE deployment_id = $1::uuid`,
				[A],
			);
			await reader.query("COMMIT");
			expect(settled).toBe(false);

			await publisher.query("COMMIT");
			expect(await migration).toBeUndefined();
			expect(await mappingTargets(db)).toEqual([
				{ remote_id: "hq-b", matches: true },
			]);
		} finally {
			/* A ROLLBACK outside a transaction only warns. */
			await publisher.query("ROLLBACK");
			await reader.query("ROLLBACK");
			await migration;
			await publisher.end();
			await reader.end();
			await observer.end();
		}
	});
});
