/**
 * The advisory scan over a pre-step database (part 09 §15, the scan row): its
 * counts, run as a role holding only `SELECT`, which proves it takes no lock
 * and writes nothing, and its case-schema drift line, the one computation
 * the drift writer converges after the deploy.
 */

import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { AppDatabase } from "@/lib/db/pg";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import { STACK_MIGRATIONS } from "../ledger";
import type { ReportLine } from "../report";
import { runScan } from "../run";
import { featureDoc, splitApp } from "./fixtures";
import {
	databaseImage,
	seedMediaRow,
	seedPlatformsApp,
	seedStoredSchemas,
} from "./postgresSeed";

const h = setupAppStateTestDb("hq_platforms_scan_", {
	authSchema: "migrated",
	caseStoreMigrationsBefore: STACK_MIGRATIONS[0],
});

const OWNER = "owner-platforms-scan";
const PROJECT = "project-platforms-scan";

function section(lines: readonly ReportLine[], name: string) {
	return lines.find((line) => line.section === name);
}

/** A visit case whose `seen` property a Hidden Value writes from a clock-keeping date. */
function clockWriter(): BlueprintDoc {
	return buildDoc({
		appName: "Clock writer",
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "seen", label: proseText("Seen") },
				],
			},
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: {
					columns: [],
					searchInputs: [],
				},
				forms: [
					{
						name: "Book",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								label: proseText("Name"),
								caseWrite: { caseType: "visit", property: "case_name" },
							}),
							f({
								kind: "hidden",
								id: "seen",
								calculate: "date(format-date(now(), '%Y-%m-%dT%H:%M:%S.%3%Z'))",
								caseWrite: { caseType: "visit", property: "seen" },
							}),
						],
					},
				],
			},
		],
	});
}

/** A client whose role may only read: any write, lock or DDL fails. */
async function selectOnlyReader(): Promise<{
	reader: Kysely<AppDatabase>;
	close: () => Promise<void>;
}> {
	const role = `platforms_scan_reader_${randomUUID().replaceAll("-", "")}`;
	await sql`CREATE ROLE ${sql.id(role)} NOLOGIN`.execute(h.db());
	await sql`GRANT USAGE ON SCHEMA public TO ${sql.id(role)}`.execute(h.db());
	await sql`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${sql.id(role)}`.execute(
		h.db(),
	);
	const pool = new Pool({
		connectionString: h.uri(),
		options: `-c role=${role}`,
		max: 1,
	});
	const reader = new Kysely<AppDatabase>({
		dialect: new PostgresDialect({ pool }),
	});
	return {
		reader,
		close: async () => {
			await reader.destroy();
			await sql`DROP OWNED BY ${sql.id(role)}`.execute(h.db());
			await sql`DROP ROLE ${sql.id(role)}`.execute(h.db());
		},
	};
}

describe("the advisory scan", () => {
	it("counts the plan as a role that may only read, and changes nothing", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		const split = splitApp();
		for (const [appId, doc] of [
			["app-a-android", featureDoc("datetime-question")],
			["app-b-split", split],
			[
				"app-c-neither",
				(() => {
					const doc = featureDoc("case-list-here");
					return {
						...doc,
						modules: Object.fromEntries(
							Object.entries(doc.modules).map(([uuid, module]) => [
								uuid,
								{ ...module, caseSearchConfig: { searchFirst: true } },
							]),
						),
					} as BlueprintDoc;
				})(),
			],
		] as const) {
			await seedPlatformsApp(h.db(), {
				appId,
				projectId: PROJECT,
				owner: OWNER,
				doc,
			});
		}
		await seedStoredSchemas(h.db(), "app-b-split", split);
		for (const [id, kind, mime, extension] of [
			["10000000-0000-4000-8000-000000000001", "image", "image/png", ".png"],
			["10000000-0000-4000-8000-000000000002", "audio", "audio/wav", ".wav"],
			["10000000-0000-4000-8000-000000000003", "audio", "audio/ogg", ".ogg"],
			["10000000-0000-4000-8000-000000000004", "video", "video/mp4", ".mp4"],
			["10000000-0000-4000-8000-000000000005", "video", "video/webm", ".webm"],
		] as const) {
			await seedMediaRow(h.db(), {
				id,
				projectId: PROJECT,
				kind,
				mime,
				extension,
			});
		}
		const image = await databaseImage(h.db());
		const { reader, close } = await selectOnlyReader();
		try {
			const result = await runScan(reader);
			const lines = result.report.all();
			expect(result.outcome).toEqual({
				outcome: "stopped",
				stoppedBy: ["blocker"],
			});
			expect(section(lines, "fleet")).toMatchObject({
				apps: 3,
				planDigest: null,
				ledger: {
					validatedApplied: false,
					pendingMigrations: [...STACK_MIGRATIONS],
				},
			});
			expect(section(lines, "declarations")).toMatchObject({
				apps: { android: 1, "web-apps": 1, blocked: 1 },
			});
			expect(section(lines, "splits")).toMatchObject({
				questions: 3,
				writerQuestions: 1,
				nonWriterQuestions: 2,
			});
			expect(section(lines, "media")).toMatchObject({
				rows: 5,
				needsBytes: 4,
				needsBytesByMime: {
					"audio/ogg": 1,
					"audio/wav": 1,
					"video/mp4": 1,
					"video/webm": 1,
				},
				classified: false,
			});
			expect(lines.filter((line) => line.section === "blocker")).toEqual([
				expect.objectContaining({
					code: "runs-on-neither",
					apps: ["app-c-neither"],
				}),
			]);
			/* The case app stored no schema row: drift of class missing-row. */
			expect(section(lines, "schema-drift")).toMatchObject({
				apps: ["app-c-neither"],
				missingRow: 1,
				retyped: {},
			});
		} finally {
			await close();
		}
		expect(await databaseImage(h.db())).toBe(image);
	}, 120_000);

	it("counts a stored date the merged code types as a date and time as drift, and an app in step as none", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		const writer = clockWriter();
		await seedPlatformsApp(h.db(), {
			appId: "app-a-clock",
			projectId: PROJECT,
			owner: OWNER,
			doc: writer,
		});
		await seedStoredSchemas(h.db(), "app-a-clock", writer, { seen: "date" });
		const inStep = splitApp();
		await seedPlatformsApp(h.db(), {
			appId: "app-b-in-step",
			projectId: PROJECT,
			owner: OWNER,
			doc: inStep,
		});
		await seedStoredSchemas(h.db(), "app-b-in-step", inStep);
		const result = await runScan(h.db());
		const lines = result.report.all();
		expect(section(lines, "schema-drift")).toMatchObject({
			apps: ["app-a-clock"],
			retyped: { "date->datetime": 1 },
			unresolvable: 0,
		});
		expect(section(lines, "clock-keeping-dates")).toMatchObject({
			writerSlots: 1,
			writerApps: ["app-a-clock"],
		});
	}, 120_000);
});
