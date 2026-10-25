/**
 * The platforms cutover's fleet transaction over real Postgres (part 09
 * §15, the writer row), from `main`'s migration prefix: every migration
 * before step 4's five, so the run applies the stack's ledger itself, inside
 * the transaction, in its two phases.
 *
 * Contract: nothing is written and no DDL applied before every check that
 * can stop has passed, and any stop or failure leaves the database
 * byte-identical; a committed run leaves every app declared, loading and
 * folding to its target, every ready media row holding its format with the
 * presence check validated, a notice on exactly the apps it planned one for,
 * the case schemas untouched, and every later run `already-applied`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import {
	type AppStateTestDb,
	setupAppStateTestDb,
} from "@/lib/db/__tests__/appStateTestDb";
import { loadAppInTransaction } from "@/lib/db/canonicalCommitKernel";
import type { AppDatabase } from "@/lib/db/pg";
import { runCanonicalRuntimeDatabaseProbe } from "@/lib/db/runtimeDatabaseProbe";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import { STACK_MIGRATIONS } from "../ledger";
import type { MediaObjectReader } from "../media";
import { readPlannedFleet, runMigrate, runScan } from "../run";
import {
	type CutoverStoppedError,
	runFleetTransaction,
	WRITER_STEPS,
} from "../writer";
import { featureDoc, splitApp } from "./fixtures";
import {
	databaseImage,
	seedDeployment,
	seedMediaReferences,
	seedMediaRow,
	seedPlatformsApp,
	seedStoredSchemas,
} from "./postgresSeed";

const FIRST_STACK_MIGRATION = STACK_MIGRATIONS[0];
const OWNER = "owner-platforms-cutover";
const PROJECT = "project-platforms-cutover";
const FIXTURES = join(process.cwd(), "lib/media/__tests__/fixtures");

let h: AppStateTestDb;
const harness = setupAppStateTestDb("hq_platforms_writer_", {
	authSchema: "migrated",
	caseStoreMigrationsBefore: FIRST_STACK_MIGRATION,
});
beforeEach(() => {
	h = harness;
});

const ASSETS = {
	hevc: testMediaAssetId("platforms-writer-hevc"),
	high: testMediaAssetId("platforms-writer-high"),
	float: testMediaAssetId("platforms-writer-float"),
	missing: testMediaAssetId("platforms-writer-missing"),
	png: testMediaAssetId("platforms-writer-png"),
	pending: testMediaAssetId("platforms-writer-pending"),
} as const;

/** A survey whose one question's label carries `media`. */
function mediaSurvey(media: Record<string, string>): BlueprintDoc {
	return buildDoc({
		appName: "Media survey",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "intro",
								label: proseText("Intro"),
								label_media: media,
							}),
						],
					},
				],
			},
		],
	});
}

/** A reader over the committed fixtures, counting each read. */
function fixtureReader(): MediaObjectReader & { readonly reads: string[] } {
	const objects = new Map<string, Buffer>([
		[
			`projects/${PROJECT}/hevc`,
			readFileSync(join(FIXTURES, "pattern-hevc.mp4")),
		],
		[
			`projects/${PROJECT}/high`,
			readFileSync(join(FIXTURES, "tiny-video.mp4")),
		],
		[
			`projects/${PROJECT}/float`,
			readFileSync(join(FIXTURES, "tone-float.wav")),
		],
	]);
	const reads: string[] = [];
	return {
		reads,
		size: async (key) => {
			reads.push(`size:${key}`);
			return objects.get(key)?.length ?? null;
		},
		bytes: async (key) => {
			reads.push(`bytes:${key}`);
			const bytes = objects.get(key);
			if (bytes === undefined) throw new Error("no object");
			return bytes;
		},
	};
}

interface SeededFleet {
	readonly appIds: readonly string[];
	readonly split: BlueprintDoc;
}

/**
 * Apps of every class the window meets, a soft-deleted one among them, the
 * media rows they reference, an unreferenced image, a pending row, and one
 * live deployment whose baseline holds Web Apps on for an app the cutover
 * declares Android only.
 */
async function seedFleet(): Promise<SeededFleet> {
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	const split = splitApp();
	const apps: [string, BlueprintDoc, Date?][] = [
		["app-a-android", featureDoc("datetime-question")],
		["app-b-split", split],
		["app-c-hevc", mediaSurvey({ video: ASSETS.hevc })],
		["app-d-high", mediaSurvey({ video: ASSETS.high })],
		["app-e-float", mediaSurvey({ audio: ASSETS.float })],
		["app-f-connect", featureDoc("connect-app")],
		["app-g-deleted", featureDoc("search"), new Date("2026-10-01T00:00:00Z")],
		["app-h-missing", mediaSurvey({ audio: ASSETS.missing })],
	];
	for (const [appId, doc, deletedAt] of apps) {
		await seedPlatformsApp(h.db(), {
			appId,
			projectId: PROJECT,
			owner: OWNER,
			doc,
			...(deletedAt !== undefined && { deletedAt }),
		});
	}
	await seedStoredSchemas(h.db(), "app-b-split", split);
	for (const [key, kind, mime, extension, status] of [
		["hevc", "video", "video/mp4", ".mp4", "ready"],
		["high", "video", "video/mp4", ".mp4", "ready"],
		["float", "audio", "audio/wav", ".wav", "ready"],
		["missing", "audio", "audio/wav", ".wav", "ready"],
		["png", "image", "image/png", ".png", "ready"],
		["pending", "image", "image/png", ".png", "pending"],
	] as const) {
		await seedMediaRow(h.db(), {
			id: ASSETS[key],
			projectId: PROJECT,
			kind,
			mime,
			extension,
			status,
			key: `projects/${PROJECT}/${key}`,
		});
	}
	for (const [appId, doc] of apps) {
		await seedMediaReferences(h.db(), { appId, projectId: PROJECT, doc });
	}
	await seedDeployment(h.db(), {
		id: "01992000-0000-7000-8000-000000000011",
		appId: "app-a-android",
		projectId: PROJECT,
		domain: "field-ops",
		origin: "push",
		source: { cloudcare_enabled: true },
	});
	return { appIds: apps.map(([appId]) => appId), split };
}

function planDigestOf(result: Awaited<ReturnType<typeof runMigrate>>): string {
	return result.report.all().find((line) => line.section === "fleet")
		?.planDigest as string;
}

async function appliedMigrations(db: Kysely<AppDatabase>): Promise<string[]> {
	const rows = await sql<{ name: string }>`
		SELECT name FROM kysely_migration ORDER BY name
	`.execute(db);
	return rows.rows.map((row) => row.name);
}

async function rejectionOf(run: Promise<unknown>): Promise<unknown> {
	try {
		await run;
	} catch (error) {
		return error;
	}
	throw new Error("The run was expected to stop, and it finished.");
}

describe("the fleet transaction from main's migration prefix", () => {
	it("applies the ledger only inside the committed fleet transaction, and writes the plan the dry run printed", async () => {
		const fleet = await seedFleet();
		const ledger = await appliedMigrations(h.db());
		expect(
			ledger.some((name) =>
				(STACK_MIGRATIONS as readonly string[]).includes(name),
			),
		).toBe(false);

		const reader = fixtureReader();
		const dryRun = await runMigrate(h.db(), { mode: "dry-run", reader });
		expect(dryRun.outcome).toEqual({ outcome: "ok" });
		expect(
			dryRun.report.all().find((line) => line.section === "fleet")?.ledger,
		).toEqual({
			validatedApplied: false,
			pendingMigrations: [...STACK_MIGRATIONS],
		});
		const media = dryRun.report.all().find((line) => line.section === "media");
		expect(media).toMatchObject({
			needsBytes: 4,
			rowsByCause: { mime: 1, classified: 2, "no-variant": 1, missing: 1 },
		});
		/* The unreferenced image takes its format from its MIME: its object is
		 * never sized or read. */
		expect(reader.reads.some((read) => read.endsWith("/png"))).toBe(false);
		const digest = planDigestOf(dryRun);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);

		const image = await databaseImage(h.db());
		const rehearsal = await runMigrate(h.db(), {
			mode: "rehearse",
			reader: fixtureReader(),
		});
		expect(rehearsal.outcome).toEqual({ outcome: "ok" });
		expect(
			rehearsal.report.all().find((line) => line.section === "writer")
				?.migrationsApplied,
		).toEqual([...STACK_MIGRATIONS]);
		expect(await databaseImage(h.db())).toBe(image);

		const refused = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: "0".repeat(64),
			reader: fixtureReader(),
		});
		expect(refused.outcome).toEqual({
			outcome: "stopped",
			stoppedBy: ["digest"],
		});
		expect(await databaseImage(h.db())).toBe(image);

		/* A failure after any numbered step rolls the fleet back whole, the
		 * DDL with it: the column still dropped by none, the format column
		 * absent, the size check at its old bound. */
		for (const step of WRITER_STEPS) {
			await expect(
				runMigrate(h.db(), {
					mode: "execute",
					expectPlanDigest: digest,
					reader: fixtureReader(),
					failAfter: step,
				}),
			).rejects.toThrow(`injected failure after ${step}`);
			expect(await databaseImage(h.db()), step).toBe(image);
		}
		const columns = await sql<{ table_name: string; column_name: string }>`
			SELECT table_name, column_name FROM information_schema.columns
			WHERE (table_name = 'app_deployments' AND column_name = 'target_web_apps_enabled')
				OR (table_name = 'media_assets' AND column_name = 'media_format')
		`.execute(h.db());
		expect(columns.rows).toEqual([
			{ table_name: "app_deployments", column_name: "target_web_apps_enabled" },
		]);

		const schemasBefore = await sql<{ row: string }>`
			SELECT s::text AS row FROM case_type_schemas AS s ORDER BY app_id, case_type
		`.execute(h.db());
		const execute = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: digest,
			reader: fixtureReader(),
		});
		expect(execute.outcome).toEqual({ outcome: "ok" });
		expect(await appliedMigrations(h.db())).toEqual(
			expect.arrayContaining([...STACK_MIGRATIONS]),
		);

		const declared = await sql<{
			id: string;
			runs: string | null;
			seq: string;
		}>`
			SELECT id, app_settings ->> 'runsOnlyOn' AS runs, mutation_seq::text AS seq
			FROM apps ORDER BY id
		`.execute(h.db());
		expect(declared.rows).toEqual([
			{ id: "app-a-android", runs: "android", seq: "2" },
			{ id: "app-b-split", runs: "web-apps", seq: "2" },
			{ id: "app-c-hevc", runs: null, seq: "2" },
			{ id: "app-d-high", runs: null, seq: "1" },
			{ id: "app-e-float", runs: null, seq: "2" },
			{ id: "app-f-connect", runs: "android", seq: "2" },
			{ id: "app-g-deleted", runs: null, seq: "1" },
			{ id: "app-h-missing", runs: null, seq: "2" },
		]);
		const formats = await sql<{ id: string; media_format: string | null }>`
			SELECT id, media_format FROM media_assets ORDER BY id
		`.execute(h.db());
		expect(
			new Map(formats.rows.map((row) => [row.id, row.media_format])),
		).toEqual(
			new Map<string, string | null>([
				[ASSETS.hevc, "mp4-hevc"],
				[ASSETS.high, "mp4-h264-high"],
				[ASSETS.float, "unplayable"],
				[ASSETS.missing, "unplayable"],
				[ASSETS.png, "png"],
				[ASSETS.pending, null],
			]),
		);
		const references = await sql<{ app_id: string; asset_id: string }>`
			SELECT app_id, asset_id FROM media_asset_refs ORDER BY app_id
		`.execute(h.db());
		expect(references.rows).toEqual([
			{ app_id: "app-d-high", asset_id: ASSETS.high },
		]);
		const changes = await sql<{
			app_id: string;
			batch_id: string;
			actor_id: string;
			kind: string;
		}>`
			SELECT app_id, batch_id, actor_id, kind FROM app_changes WHERE seq = 2 ORDER BY app_id
		`.execute(h.db());
		expect(changes.rows).toEqual(
			[
				"app-a-android",
				"app-b-split",
				"app-c-hevc",
				"app-e-float",
				"app-f-connect",
				"app-h-missing",
			].map((appId) => ({
				app_id: appId,
				batch_id: `hq-round-trip-platforms:${appId}`,
				actor_id: "system:hq-round-trip-platforms",
				kind: "blueprint-migration",
			})),
		);
		const notices = await sql<{ app_id: string; reasons: string[] }>`
			SELECT app_id, array(SELECT entry ->> 'reason' FROM jsonb_array_elements(entries) AS entry) AS reasons
			FROM app_migration_notices WHERE cutover = 'hq-round-trip-platforms' ORDER BY app_id
		`.execute(h.db());
		expect(
			notices.rows.find((row) => row.app_id === "app-a-android")?.reasons,
		).toEqual(["next-publish-asks-web-apps", "platforms-declared"]);
		expect(
			notices.rows.find((row) => row.app_id === "app-b-split")?.reasons,
		).toEqual([
			"platforms-declared",
			"datetime-question-split",
			"datetime-question-split",
			"datetime-question-split",
		]);
		expect(
			notices.rows.find((row) => row.app_id === "app-c-hevc")?.reasons,
		).toEqual(["media-not-played-removed"]);
		expect(notices.rows.some((row) => row.app_id === "app-d-high")).toBe(false);

		await h.withTransaction(async (tx) => {
			for (const row of declared.rows) {
				expect(await loadAppInTransaction(tx, row.id)).not.toBeNull();
				await loadCanonicalBlueprintAtSequence(tx, {
					appId: row.id,
					seq: Number(row.seq),
					expectedDigest: null,
				});
			}
		});
		const schemasAfter = await sql<{ row: string }>`
			SELECT s::text AS row FROM case_type_schemas AS s ORDER BY app_id, case_type
		`.execute(h.db());
		expect(schemasAfter.rows).toEqual(schemasBefore.rows);
		const validated = await sql<{ convalidated: boolean }>`
			SELECT convalidated FROM pg_constraint WHERE conname = 'media_assets_ready_media_format'
		`.execute(h.db());
		expect(validated.rows).toEqual([{ convalidated: true }]);

		const role = await sql<{
			role: string;
		}>`SELECT current_user AS role`.execute(h.db());
		const probe = await runCanonicalRuntimeDatabaseProbe(
			h.db() as unknown as Kysely<unknown>,
			role.rows[0]?.role ?? "",
		);
		expect(probe.findingCount).toBe(0);

		for (const mode of ["dry-run", "rehearse", "settle-holders"] as const) {
			const again = await runMigrate(h.db(), { mode, reader: fixtureReader() });
			expect(again.outcome).toEqual({ outcome: "already-applied" });
		}
		expect(
			(
				await runMigrate(h.db(), {
					mode: "execute",
					expectPlanDigest: digest,
					reader: fixtureReader(),
				})
			).outcome,
		).toEqual({ outcome: "already-applied" });
		expect((await runScan(h.db())).outcome).toEqual({
			outcome: "already-applied",
		});
		expect(fleet.appIds).toHaveLength(8);
	}, 240_000);

	it("refuses any ledger other than the five pending, with nothing written and no migration applied", async () => {
		await seedFleet();
		const { Migrator } = await import("kysely/migration");
		const { caseStoreMigrations } = await import("@/lib/case-store/migrations");
		const migrated = await new Migrator({
			db: h.db() as unknown as Kysely<unknown>,
			provider: { getMigrations: async () => caseStoreMigrations },
		}).migrateTo(FIRST_STACK_MIGRATION);
		expect(migrated.error).toBeUndefined();
		const image = await databaseImage(h.db());
		const refused = await runMigrate(h.db(), {
			mode: "rehearse",
			reader: fixtureReader(),
		});
		expect(refused.outcome).toEqual({
			outcome: "stopped",
			stoppedBy: ["ledger"],
		});
		expect(await databaseImage(h.db())).toBe(image);
	}, 120_000);

	it("stops on a live holder, an app or a media row that moved after the plan, with nothing written", async () => {
		await seedFleet();
		const image = await databaseImage(h.db());
		const fleet = await readPlannedFleet(h.db(), { reader: fixtureReader() });
		const input = { plan: fleet.plan, targets: fleet.targets };

		await sql`UPDATE media_assets SET original_filename = 'renamed.mp4', extension = '.mov' WHERE id = ${ASSETS.hevc}`.execute(
			h.db(),
		);
		const media = (await rejectionOf(
			runFleetTransaction(h.db(), { mode: "execute", input }),
		)) as CutoverStoppedError;
		expect(media.code).toBe("media-changed");
		await sql`UPDATE media_assets SET original_filename = 'file.mp4', extension = '.mp4' WHERE id = ${ASSETS.hevc}`.execute(
			h.db(),
		);

		await h.withTransaction(async (tx) => {
			await sql`SET LOCAL session_replication_role = replica`.execute(tx);
			await sql`UPDATE apps SET app_name = 'Moved', app_name_lower = 'moved' WHERE id = 'app-d-high'`.execute(
				tx,
			);
		});
		const moved = (await rejectionOf(
			runFleetTransaction(h.db(), { mode: "execute", input }),
		)) as CutoverStoppedError;
		expect(moved.code).toBe("app-changed");
		await h.withTransaction(async (tx) => {
			await sql`SET LOCAL session_replication_role = replica`.execute(tx);
			await sql`UPDATE apps SET app_name = 'Media survey', app_name_lower = 'media survey' WHERE id = 'app-d-high'`.execute(
				tx,
			);
		});

		await sql`UPDATE apps SET lock_run_id = 'run-live', lock_actor_user_id = ${OWNER},
			lock_expire_at = ${new Date(Date.now() + 600_000)} WHERE id = 'app-d-high'`.execute(
			h.db(),
		);
		const held = (await rejectionOf(
			runFleetTransaction(h.db(), { mode: "execute", input }),
		)) as CutoverStoppedError;
		expect(held.code).toBe("holder");
		await sql`UPDATE apps SET lock_run_id = NULL, lock_actor_user_id = NULL,
			lock_expire_at = NULL WHERE id = 'app-d-high'`.execute(h.db());

		expect(await databaseImage(h.db())).toBe(image);
	}, 120_000);

	it("stops on a media read that fails, before anything is written", async () => {
		await seedFleet();
		const image = await databaseImage(h.db());
		const failing: MediaObjectReader = {
			size: async () => {
				throw new Error("403");
			},
			bytes: async () => Buffer.alloc(0),
		};
		const lines: string[] = [];
		await expect(
			runMigrate(h.db(), {
				mode: "dry-run",
				reader: failing,
				onLine: (line) => lines.push(JSON.stringify(line)),
			}),
		).rejects.toThrow(/Reading the stored file of media asset/);
		expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
			section: "outcome",
			outcome: "stopped",
			stoppedBy: ["error"],
			errorClass: "media-read",
		});
		expect(await databaseImage(h.db())).toBe(image);
	}, 120_000);

	it("proves the media read on the lowest row that needs its bytes, and says no-media where none does", async () => {
		await seedFleet();
		const reader = fixtureReader();
		const proved = await runMigrate(h.db(), {
			mode: "prove-media-read",
			reader,
		});
		expect(
			proved.report.all().find((line) => line.section === "media-read"),
		).toMatchObject({
			result: "ok",
		});
		expect(reader.reads).toHaveLength(1);
		await sql`UPDATE media_assets SET status = 'pending' WHERE mime_type <> 'image/png'`.execute(
			h.db(),
		);
		const none = await runMigrate(h.db(), {
			mode: "prove-media-read",
			reader: fixtureReader(),
		});
		expect(
			none.report.all().find((line) => line.section === "media-read"),
		).toMatchObject({
			result: "no-media",
		});
	}, 120_000);
});
