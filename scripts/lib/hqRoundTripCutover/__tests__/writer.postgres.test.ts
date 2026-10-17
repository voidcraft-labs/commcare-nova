/**
 * The cutover's fleet transaction over the frozen pre-step fixtures: from the
 * migration prefix the previous revision leaves, where the run applies this
 * revision's migrations itself, and in a migrated database, for what it
 * writes, what it refuses, and that nothing it refuses or rolls back leaves a
 * trace.
 */

import { type Kysely, sql } from "kysely";
import { Client } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import {
	type AppStateTestDb,
	setupAppStateTestDb,
} from "@/lib/db/__tests__/appStateTestDb";
import { loadAppInTransaction } from "@/lib/db/canonicalCommitKernel";
import type { AppDatabase } from "@/lib/db/pg";
import { runCanonicalRuntimeDatabaseProbe } from "@/lib/db/runtimeDatabaseProbe";
import type { BlueprintDoc } from "@/lib/domain";
import {
	DEPLOYMENT_NOTICE_REASONS,
	DOCUMENT_NOTICE_REASONS,
} from "@/lib/notices/migrationNotice";
import type { BuildPlanOptions } from "../plan";
import { CUTOVER_BLOCKER_CODES, readPlannedFleet } from "../plan";
import { runMigrate } from "../run";
import { CONNECT_BLOCK_KINDS } from "../steps/connectIds";
import { CUTOVER_STEPS } from "../transform";
import {
	type CutoverStoppedError,
	readCutoverBaselines,
	runFleetTransaction,
	WRITER_STEPS,
} from "../writer";
import {
	readFixtureCarriers,
	readFixtureManifest,
	readFixtureProject,
} from "./fixtures/preStep";
import {
	fixtureApp,
	seedFixtureApp,
	seedFixtureProject,
} from "./fixtures/seed";

/** The first migration this revision adds; the previous revision's ledger ends before it. */
const FIRST_CUTOVER_MIGRATION = "20261015000000_hq_round_trip_fold_horizon";

/** The harness of the describe block running the current test. */
let h: AppStateTestDb;

function useHarness(prefix: string, caseStoreMigrationsBefore?: string): void {
	const harness = setupAppStateTestDb(prefix, {
		authSchema: "migrated",
		...(caseStoreMigrationsBefore !== undefined && {
			caseStoreMigrationsBefore,
		}),
	});
	beforeEach(() => {
		h = harness;
	});
}

const OWNER = "owner-cutover";
const PROJECT = "project-cutover";

/** Every fixture whose document the writer takes as it is: none built to stop it. */
const writableFixtures = readFixtureManifest()
	.fixtures.filter((fixture) =>
		fixture.blockers.every(
			(code) =>
				code === "app-mapping-without-pushed-revision" ||
				code === "lookup-tag-rename-collision" ||
				code === "lookup-tag-unparsable" ||
				code === "target-parse",
		),
	)
	.map((fixture) => fixture.id);

interface SeededFleet {
	readonly appIds: readonly string[];
	readonly deletedAppId: string;
}

/**
 * Every writable fixture as an app of a Project of its own, holding that
 * fixture's lookup tables and uploads, and one more app soft-deleted.
 */
async function seedFleet(): Promise<SeededFleet> {
	const appIds: string[] = [];
	for (const [index, id] of writableFixtures.entries()) {
		const appId = `app-${String(index).padStart(2, "0")}-${id}`;
		const projectId = `${PROJECT}-${String(index).padStart(2, "0")}`;
		await h.seedProjectMember(OWNER, projectId, "owner");
		await seedFixtureProject(h.db(), projectId, readFixtureProject(id), OWNER);
		await seedFixtureApp(
			h.db(),
			fixtureApp(id, { appId, projectId, owner: OWNER }),
		);
		appIds.push(appId);
	}
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	const deletedAppId = "app-99-deleted";
	await seedFixtureApp(h.db(), {
		...fixtureApp("navigation-base", {
			appId: deletedAppId,
			projectId: PROJECT,
			owner: OWNER,
		}),
		deletedAt: new Date("2026-10-01T00:00:00Z"),
	});
	appIds.push(deletedAppId);
	return { appIds, deletedAppId };
}

/**
 * Every name a fixture's author wrote: the app's, each menu's and form's,
 * and each question's id and label, at least five characters long so a
 * report's own keys never collide with one by chance.
 */
function authoredStrings(id: string): string[] {
	const carriers = readFixtureCarriers(id);
	const strings = [carriers.root.app_name];
	for (const row of carriers.rows) {
		const data = JSON.parse(row.data_text) as {
			name?: unknown;
			id?: unknown;
			label?: { parts?: { kind: string; text?: string }[] };
		};
		if (typeof data.name === "string") strings.push(data.name);
		if (row.kind === "field" && typeof data.id === "string")
			strings.push(data.id);
		for (const part of data.label?.parts ?? []) {
			if (part.kind === "text" && part.text !== undefined)
				strings.push(part.text);
		}
	}
	return [...new Set(strings)].filter(
		(value) => value.length >= 5 && !/^[0-9a-f-]+$/.test(value),
	);
}

/** Every string value a report holds, its keys left out. */
function stringValues(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(stringValues);
	if (value !== null && typeof value === "object") {
		return Object.values(value).flatMap(stringValues);
	}
	return [];
}

/** Every row the cutover could touch, as text, so two images compare byte for byte. */
async function databaseImage(db: Kysely<AppDatabase>): Promise<string> {
	const tables = [
		["apps", "id"],
		["blueprint_entities", "app_id, uuid"],
		["app_changes", "app_id, seq"],
		["app_change_fold_baselines", "app_id, seq"],
		["case_type_schemas", "app_id, case_type"],
		["events", "id"],
		["threads", "thread_id"],
		["chat_stream_chunks", "stream_id, first_index"],
		["presence", "app_id, user_id, session_id"],
		["authoring_sessions", "id"],
		["authoring_workspaces", "id"],
		["design_change_sets", "id"],
		["design_sessions", "id"],
		["app_migration_notices", "id"],
		["app_migration_notice_key_readers", "cutover, user_id, server, domain"],
		["lookup_table_references", "app_id, table_id"],
		["app_location_references", "app_id"],
		[
			"app_deployment_identities",
			"deployment_id, entity_kind, nova_entity_uuid",
		],
		["app_deployment_baselines", "deployment_id"],
		[
			"project_space_resource_baselines",
			"project_id, server, domain, kind, remote_id",
		],
	] as const;
	const parts: string[] = [];
	for (const [table, order] of tables) {
		/* The ledger's tables arrive with this revision's migrations, which a
		 * database at the previous revision's prefix does not hold yet. */
		const present = await sql<{ present: boolean }>`
			SELECT to_regclass(${table}) IS NOT NULL AS present
		`.execute(db);
		if (present.rows[0]?.present !== true) {
			parts.push(`${table}:absent`);
			continue;
		}
		const rows = await sql<{ row: string }>`
			SELECT t::text AS row FROM ${sql.table(table)} AS t ORDER BY ${sql.raw(order)}
		`.execute(db);
		parts.push(`${table}:${rows.rows.map((row) => row.row).join("\n")}`);
	}
	return parts.join("\n\n");
}

/** The plan and the baselines a run with no HQ reads hands the writer. */
async function plannedWithBaselines(db: Kysely<AppDatabase>) {
	const planned = await readPlannedFleet(db);
	return {
		build: planned.build,
		baselines: await readCutoverBaselines(db, planned, {
			deploymentReads: null,
			readProjectSpace: null,
			transientAsUnreadable: false,
		}),
	};
}

/** One deployment with a live app mapping last pushed at `pushedRevision`. */
async function seedDeployment(
	appId: string,
	domain: string,
	pushedRevision: number | null,
): Promise<string> {
	const deployment = await sql<{ id: string }>`
		INSERT INTO app_deployments (app_id, project_id, server, domain, state, phases, created_by)
		VALUES (${appId}, ${PROJECT}, 'production', ${domain}, 'uploaded', '{}'::jsonb, ${OWNER})
		RETURNING id::text AS id
	`.execute(h.db());
	const id = deployment.rows[0]?.id ?? "";
	await sql`
		INSERT INTO app_deployment_resources (deployment_id, kind, nova_resource_id, remote_id,
			ownership, pushed_revision, pushed_at)
		VALUES (${id}::uuid, 'app', ${appId}, ${`hq-${appId}`}, 'nova-created', ${pushedRevision},
			${pushedRevision === null ? null : new Date("2026-10-01T00:00:00Z")}::timestamptz)
	`.execute(h.db());
	return id;
}

async function seedMutationEvents(appId: string): Promise<void> {
	for (const seq of [1, 2]) {
		await sql`
			INSERT INTO events (app_id, run_id, ts, seq, source, kind, event)
			VALUES (${appId}, 'run-history', ${1_700_000_000_000 + seq}, ${seq}, 'chat', 'mutation',
				${JSON.stringify({
					kind: "mutation",
					runId: "run-history",
					ts: 1_700_000_000_000 + seq,
					seq,
					source: "chat",
					actor: "agent",
					mutation: { kind: "retired-vocabulary", hint_media: seq },
				})}::jsonb)
		`.execute(h.db());
	}
}

describe("the fleet transaction from the previous migration prefix", () => {
	useHarness("hq_cutover_prefix_", FIRST_CUTOVER_MIGRATION);

	it("applies this revision's migrations, rehearses with nothing left behind, then commits", async () => {
		const fleet = await seedFleet();
		const tables = async () =>
			(
				await sql<{ name: string }>`
					SELECT table_name AS name FROM information_schema.tables
					WHERE table_schema = current_schema()
						AND table_name IN ('app_migration_notices',
							'app_migration_notice_key_readers', 'app_deployment_baselines')
					ORDER BY table_name
				`.execute(h.db())
			).rows.map((row) => row.name);
		expect(await tables()).toEqual([]);

		const dryRun = await runMigrate(h.db(), { mode: "dry-run" });
		expect(dryRun.outcome).toEqual({ outcome: "ok" });
		expect(await tables()).toEqual([]);
		const digest = dryRun.report.all().find((line) => line.section === "fleet")
			?.planDigest as string;

		const rehearsal = await runMigrate(h.db(), { mode: "rehearse" });
		expect(rehearsal.outcome).toEqual({ outcome: "ok" });
		expect(await tables()).toEqual([
			"app_deployment_baselines",
			"app_migration_notice_key_readers",
			"app_migration_notices",
		]);
		const image = await databaseImage(h.db());
		const residue = await sql<{ notices: string; readers: string }>`
			SELECT (SELECT count(*) FROM app_migration_notices)::text AS notices,
				(SELECT count(*) FROM app_migration_notice_key_readers)::text AS readers
		`.execute(h.db());
		expect(residue.rows[0]).toEqual({ notices: "0", readers: "0" });

		const execute = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: digest,
		});
		expect(execute.outcome).toEqual({ outcome: "ok" });
		expect(await databaseImage(h.db())).not.toBe(image);
		const markers = await sql<{ app_id: string }>`
			SELECT app_id FROM app_changes
			WHERE batch_id = 'fold-baseline:hq-round-trip-emission'
			ORDER BY app_id
		`.execute(h.db());
		expect(markers.rows.map((row) => row.app_id)).toEqual(
			[...fleet.appIds].sort(),
		);
	}, 60_000);
});

describe("the fleet transaction over the frozen fixtures", () => {
	useHarness("hq_cutover_writer_");

	it("establishes one horizon per app, with zero steps, and commits only under the rehearsal's digest", async () => {
		const fleet = await seedFleet();
		const [eventApp] = fleet.appIds;
		if (eventApp === undefined) throw new Error("The fleet is empty.");
		await seedMutationEvents(eventApp);
		const before = await sql<{
			id: string;
			updated_at: Date;
			mutation_seq: string;
		}>`
			SELECT id, updated_at, mutation_seq::text AS mutation_seq FROM apps ORDER BY id
		`.execute(h.db());

		const dryRun = await runMigrate(h.db(), { mode: "dry-run" });
		expect(dryRun.outcome).toEqual({ outcome: "ok" });
		// A notice reason, a step id, a blocker code and a Connect block's
		// kind are codes of the report's and an app id is the fleet's own, and
		// an authored name may fall inside any of them: a question named
		// "checked" in the reason `case-name-now-checked`, one named "space" in
		// the app id `app-42-hand-open-workspace`, an entry point named "entry"
		// in the step id `entry-point-ids`.
		const ownValues: ReadonlySet<string> = new Set([
			...DOCUMENT_NOTICE_REASONS,
			...DEPLOYMENT_NOTICE_REASONS,
			...CUTOVER_STEPS.map((step) => step.id),
			...CUTOVER_BLOCKER_CODES,
			...CONNECT_BLOCK_KINDS,
			...before.rows.map((row) => row.id),
		]);
		const reportValues = stringValues(dryRun.report.all()).filter(
			(value) => !ownValues.has(value),
		);
		// The report's own vocabulary: an author may name a question "outcome".
		const vocabulary = new Set(
			dryRun.report
				.all()
				.flatMap((line) => [
					line.report,
					line.mode,
					line.section,
					line.outcome,
				]),
		);
		for (const id of writableFixtures) {
			for (const authored of authoredStrings(id).filter(
				(value) => !vocabulary.has(value),
			)) {
				expect(
					reportValues.filter((value) => value.includes(authored)),
					`the report names ${JSON.stringify(authored)}`,
				).toEqual([]);
			}
		}
		const fleetLine = dryRun.report
			.all()
			.find((line) => line.section === "fleet");
		const digest = fleetLine?.planDigest as string;
		expect(digest).toMatch(/^[0-9a-f]{64}$/);

		const rehearsalImage = await databaseImage(h.db());
		const rehearsal = await runMigrate(h.db(), { mode: "rehearse" });
		expect(rehearsal.outcome).toEqual({ outcome: "ok" });
		expect(
			rehearsal.report.all().find((line) => line.section === "fleet")
				?.planDigest,
		).toBe(digest);
		expect(await databaseImage(h.db())).toBe(rehearsalImage);

		const execute = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: digest,
		});
		expect(execute.outcome).toEqual({ outcome: "ok" });

		const after = await sql<{
			id: string;
			updated_at: Date;
			mutation_seq: string;
		}>`
			SELECT id, updated_at, mutation_seq::text AS mutation_seq FROM apps ORDER BY id
		`.execute(h.db());
		expect(after.rows.map((row) => row.updated_at.toISOString())).toEqual(
			before.rows.map((row) => row.updated_at.toISOString()),
		);
		expect(after.rows.map((row) => Number(row.mutation_seq))).toEqual(
			before.rows.map((row) => Number(row.mutation_seq) + 1),
		);
		// Step app-settings counts no deployment here, so every app holds what
		// a Nova archive showed before the cutover.
		const settings = await sql<{ id: string; app_settings: unknown }>`
			SELECT id, app_settings FROM apps ORDER BY id
		`.execute(h.db());
		expect(settings.rows).toEqual(
			after.rows.map((row) => ({
				id: row.id,
				app_settings: { showSavedForms: false, showIncompleteForms: true },
			})),
		);
		const markers = await sql<{ app_id: string; seq: string }>`
			SELECT app_id, seq::text AS seq FROM app_changes
			WHERE batch_id = 'fold-baseline:hq-round-trip-emission'
				AND actor_id = 'system:hq-round-trip-emission' AND run_id IS NULL
			ORDER BY app_id
		`.execute(h.db());
		expect(markers.rows.map((row) => row.app_id)).toEqual(
			[...fleet.appIds].sort(),
		);
		const committed = new Map<string, BlueprintDoc>();
		await h.withTransaction(async (tx) => {
			for (const row of after.rows) {
				expect(await loadAppInTransaction(tx, row.id)).not.toBeNull();
				const loaded = await loadCanonicalBlueprintAtSequence(tx, {
					appId: row.id,
					seq: Number(row.mutation_seq),
					expectedDigest: null,
				});
				committed.set(row.id, loaded.doc);
			}
		});
		// Each fixture's app holds the notice of each identifier and form
		// content step its fixture witnessed, which reads the document alone.
		const notices = await sql<{
			app_id: string;
			entries: { kind: string; reason: string }[];
		}>`SELECT app_id, entries FROM app_migration_notices`.execute(h.db());
		const documentReasons: ReadonlySet<string> = new Set([
			"question-renamed",
			"case-operation-renamed",
			"connect-block-renamed",
			"connect-task-moved-to-own-form",
			"entry-point-renamed",
			"option-value-split",
			"empty-form-label-added",
			"session-read-removed",
		]);
		const manifest = readFixtureManifest();
		for (const [index, id] of writableFixtures.entries()) {
			const appId = fleet.appIds[index];
			const written = notices.rows
				.filter((row) => row.app_id === appId)
				.flatMap((row) => row.entries)
				.filter((entry) => entry.kind === "document")
				.map((entry) => entry.reason);
			const witnessed =
				manifest.fixtures
					.find((fixture) => fixture.id === id)
					?.reasons.filter((reason) => documentReasons.has(reason)) ?? [];
			expect(written, id).toEqual(expect.arrayContaining(witnessed));
		}
		const appOf = (id: string): BlueprintDoc => {
			const doc = committed.get(
				fleet.appIds[writableFixtures.indexOf(id)] ?? "",
			);
			if (doc === undefined) throw new Error(`The fleet holds no ${id}.`);
			return doc;
		};
		// Step `connect-task-forms` gives the deliver form's task a survey
		// form of its own, after its source.
		const connect = appOf("connect-deliver-default");
		const deliverBlocks = (uuid: string) => {
			const block = connect.forms[uuid]?.connect;
			return {
				type: connect.forms[uuid]?.type,
				deliver: block !== undefined && "deliver_unit" in block,
				task:
					block !== undefined && "task" in block ? block.task?.id : undefined,
			};
		};
		const deliverForms = Object.values(connect.formOrder).find((forms) =>
			forms.some((uuid) => deliverBlocks(uuid).task !== undefined),
		);
		expect(deliverForms?.map(deliverBlocks)).toEqual([
			{ type: expect.any(String), deliver: true, task: undefined },
			{ type: "survey", deliver: false, task: "q_task" },
		]);
		// Step `option-values` renames the second holder of a value.
		const options = appOf("hand-option-values");
		const consent = options.fields["00000000-0000-4000-8000-000000000201"];
		expect(
			consent !== undefined && "optionsSource" in consent
				? consent.optionsSource
				: undefined,
		).toMatchObject({
			options: [{ value: "yes" }, { value: "yes_2" }, { value: "no" }],
		});

		const events = await sql<{ kind: string; archived: string }>`
			SELECT kind, (event -> 'archived')::text AS archived FROM events ORDER BY id
		`.execute(h.db());
		expect(events.rows.map((row) => row.kind)).toEqual([
			"archived-mutation",
			"archived-mutation",
		]);
		expect(JSON.parse(events.rows[0]?.archived ?? "null")).toMatchObject({
			kind: "mutation",
			mutation: { kind: "retired-vocabulary", hint_media: 1 },
		});

		const role = await sql<{
			role: string;
		}>`SELECT current_user AS role`.execute(h.db());
		const probe = await runCanonicalRuntimeDatabaseProbe(
			h.db() as unknown as Kysely<unknown>,
			role.rows[0]?.role ?? "",
		);
		expect(probe.findingCount).toBe(0);

		for (const mode of ["dry-run", "rehearse", "settle-holders"] as const) {
			const again = await runMigrate(h.db(), { mode });
			expect(again.outcome).toEqual({ outcome: "already-applied" });
		}
	}, 60_000);

	it("writes each planned notice and a key-readers row for each key the run sent", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		const appId = "app-00-entry-points";
		await seedFixtureApp(
			h.db(),
			fixtureApp("targeted-invalid-question-ids", {
				appId,
				projectId: PROJECT,
				owner: OWNER,
			}),
		);
		const deployment = await seedDeployment(appId, "field-ops", 1);
		const uses = [
			{
				userId: OWNER,
				firstUsedAt: "2026-10-15T10:00:00.000Z",
				lastUsedAt: "2026-10-15T10:00:07.000Z",
			},
		];
		await sql`
			INSERT INTO user_settings (user_id, commcare_username, commcare_api_key, commcare_server, approved_domains)
			VALUES (${OWNER}, 'owner@example.org', 'ciphertext', 'production', '[{"name":"field-ops","displayName":"Field ops"}]'::jsonb)
		`.execute(h.db());
		// HQ refused the key the run sent, so the deployment is unreadable and
		// the key's use is still recorded.
		const plan: BuildPlanOptions = {
			readDeployment: async () => ({
				source: { kind: "refused", status: 401 },
				formIds: null,
				keyUses: uses,
				sourceAnswer: null,
			}),
		};
		const dryRun = await runMigrate(h.db(), { mode: "dry-run", plan });
		const digest = dryRun.report.all().find((line) => line.section === "fleet")
			?.planDigest as string;
		const executed = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: digest,
			plan,
		});
		expect(executed.outcome).toEqual({ outcome: "ok" });
		const notices = await sql<{
			app_id: string;
			cutover: string;
			entries: unknown;
		}>`
			SELECT app_id, cutover, entries FROM app_migration_notices
		`.execute(h.db());
		expect(notices.rows).toEqual([
			{
				app_id: appId,
				cutover: "hq-round-trip-emission",
				entries: [
					{
						kind: "deployment",
						reason: "ids-change-once-unreadable",
						deployment: {
							deploymentId: deployment,
							server: "production",
							domain: "field-ops",
						},
					},
					{
						kind: "deployment",
						reason: "data-paths-move-once",
						deployment: {
							deploymentId: deployment,
							server: "production",
							domain: "field-ops",
						},
					},
					{
						kind: "deployment",
						reason: "deep-links-need-republish",
						deployment: {
							deploymentId: deployment,
							server: "production",
							domain: "field-ops",
						},
					},
					// No key read the app, so its baseline is `unread`.
					{
						kind: "deployment",
						reason: "next-publish-asks-before-overwriting",
						deployment: {
							deploymentId: deployment,
							server: "production",
							domain: "field-ops",
						},
					},
					{
						kind: "deployment",
						reason: "settings-unknown-unreadable",
						deployment: {
							deploymentId: deployment,
							server: "production",
							domain: "field-ops",
						},
					},
					// Step `question-ids` renames the three ids HQ's form builder
					// can't keep, and step `entry-point-ids` the deep link HQ
					// would not save as written.
					...(
						[
							["39160b11-9a57-5bd5-ad4d-5763f2529661", "_notes", "notes"],
							["d0b66252-a2f7-5d8e-a0e9-cc900926e1a2", "XMLcode", "qXMLcode"],
							["4cdc70c4-40a5-5f60-a6f5-61867579a734", "Meta", "q_Meta"],
						] as const
					).map(([uuid, from, to]) => ({
						kind: "document",
						reason: "question-renamed",
						entity: { type: "field", uuid, nameAtMigration: to },
						detail: { form: "Intake", kind: "question", from, to },
					})),
					{
						kind: "document",
						reason: "entry-point-renamed",
						entity: {
							type: "entryPoint",
							uuid: "8a8e7e87-2b04-53bb-a4b3-b44509bbb157",
							nameAtMigration: "intake",
						},
						detail: { from: "intake_", to: "intake" },
					},
					// No deployment was read, so the stored settings get no
					// line; every app is told about the downloaded file.
					{
						kind: "document",
						reason: "local-archive-changes",
						entity: { type: "app", nameAtMigration: "Question ids" },
					},
				],
			},
		]);
		const readers = await sql<{
			user_id: string;
			server: string;
			domain: string;
			first_used_at: Date;
			last_used_at: Date;
		}>`
			SELECT user_id, server, domain, first_used_at, last_used_at
			FROM app_migration_notice_key_readers
		`.execute(h.db());
		expect(
			readers.rows.map((row) => ({
				...row,
				first_used_at: row.first_used_at.toISOString(),
				last_used_at: row.last_used_at.toISOString(),
			})),
		).toEqual([
			{
				user_id: OWNER,
				server: "production",
				domain: "field-ops",
				first_used_at: "2026-10-15T10:00:00.000Z",
				last_used_at: "2026-10-15T10:00:07.000Z",
			},
		]);
	});

	it("refuses a digest the rebuilt plan does not hold, with nothing written", async () => {
		await seedFleet();
		const image = await databaseImage(h.db());
		const refused = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: "0".repeat(64),
		});
		expect(refused.outcome).toEqual({
			outcome: "stopped",
			stoppedBy: ["digest"],
		});
		expect(refused.exitCode).toBe(1);
		expect(await databaseImage(h.db())).toBe(image);
	}, 60_000);

	it("stops a second run within the lock timeout, with nothing written", async () => {
		await seedFleet();
		const planned = await plannedWithBaselines(h.db());
		const image = await databaseImage(h.db());
		const firstRun = new Client({ connectionString: h.uri() });
		await firstRun.connect();
		try {
			await firstRun.query("BEGIN");
			await firstRun.query(
				"SELECT pg_advisory_xact_lock(hashtextextended('cutover:hq-round-trip-emission', 0))",
			);
			await expect(
				runFleetTransaction(h.db(), { mode: "execute", ...planned }),
			).rejects.toThrow(/Another run of this cutover held its lock/);
		} finally {
			await firstRun.query("ROLLBACK");
			await firstRun.end();
		}
		expect(await databaseImage(h.db())).toBe(image);
	}, 60_000);

	it("stops with nothing written when an app changed after the plan was built", async () => {
		const fleet = await seedFleet();
		const planned = await plannedWithBaselines(h.db());
		const [changed] = fleet.appIds;
		await h
			.db()
			.updateTable("apps")
			.set({ app_name: "Renamed after the plan" })
			.where("id", "=", changed ?? "")
			.execute();
		const image = await databaseImage(h.db());
		await expect(
			runFleetTransaction(h.db(), { mode: "execute", ...planned }),
		).rejects.toMatchObject({
			code: "app-changed",
		} satisfies Partial<CutoverStoppedError>);
		expect(await databaseImage(h.db())).toBe(image);
	}, 60_000);

	it("stops on a live holder", async () => {
		await seedFleet();
		await h.seedApp({
			id: "app-live-edit",
			owner: OWNER,
			project_id: PROJECT,
			run_id: "run-live",
			run_holder_nonce: "6a0a35a4-1111-4222-8333-944445555777",
			run_lock: {
				runId: "run-live",
				actorUserId: OWNER,
				expireAt: new Date(Date.now() + 600_000),
			},
			reservation: {
				period: "2026-10",
				reserved: 1,
				settled: false,
				userId: OWNER,
				runId: "run-live",
			},
		});
		const image = await databaseImage(h.db());
		const rehearsal = await runMigrate(h.db(), { mode: "rehearse" });
		expect(rehearsal.outcome).toMatchObject({
			outcome: "stopped",
			stoppedBy: expect.arrayContaining(["holder"]),
		});
		expect(await databaseImage(h.db())).toBe(image);
	}, 60_000);

	it("refuses a database where some apps carry the marker and some do not", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await seedFixtureApp(
			h.db(),
			fixtureApp("navigation-base", {
				appId: "app-00-marked",
				projectId: PROJECT,
				owner: OWNER,
			}),
		);
		await runFleetTransaction(h.db(), {
			mode: "execute",
			...(await plannedWithBaselines(h.db())),
		});
		await seedFixtureApp(
			h.db(),
			fixtureApp("navigation-base", {
				appId: "app-01-unmarked",
				projectId: PROJECT,
				owner: OWNER,
			}),
		);
		const image = await databaseImage(h.db());
		for (const mode of ["dry-run", "rehearse"] as const) {
			await expect(runMigrate(h.db(), { mode })).rejects.toThrow(
				"1 of 2 apps carry the hq-round-trip-emission horizon",
			);
		}
		expect(await databaseImage(h.db())).toBe(image);
	});

	it.each(WRITER_STEPS)(
		"leaves the database byte-identical when it fails after %s",
		async (step) => {
			const fleet = await seedFleet();
			await seedMutationEvents(fleet.appIds[0] ?? "");
			const planned = await plannedWithBaselines(h.db());
			const image = await databaseImage(h.db());
			await expect(
				runFleetTransaction(h.db(), {
					mode: "execute",
					...planned,
					failAfter: step,
				}),
			).rejects.toThrow(`injected failure after ${step}`);
			expect(await databaseImage(h.db())).toBe(image);
		},
		60_000,
	);
});
