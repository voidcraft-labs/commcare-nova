/**
 * The cutover's modes and arguments (step 5's part 09, section 6), pure:
 * the real plan over a fleet source built from the pre-step fixtures read
 * raw, with the ledger read, the marker count, the fleet read, the reapers
 * and the fleet transaction stood in for, and a database handle that throws
 * on any use, so a mode that reached past the reads it is given fails.
 *
 * The plausible failures: a mode that reads the fleet or writes once the
 * ledger and the markers say the cutover ran, or once they disagree; an
 * execute run that writes a plan other than the dry run's, or one holding a
 * blocker or a holder; a dry run or a scan that reaches the writer; a
 * refusal under the writer's locks reported as success; an argument
 * combination that runs a mode nobody asked for.
 */

import { CommanderError } from "commander";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { AppDatabase } from "@/lib/db/pg";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { CASE_CLAIM_CASE_TYPE, type MediaAssetId } from "@/lib/domain";
import { ALL_ICON_SLUGS } from "@/lib/domain/builtinIcons";
import { caseTypeToJsonSchema } from "@/lib/domain/expression/jsonSchema";
import { builtinAssetRows } from "@/lib/media/builtinIconAssets";
import { canonicalJsonText } from "@/lib/utils/canonicalJson";
import type { HolderCensus } from "../holders";
import {
	CutoverLedgerError,
	type MarkerCount,
	type MigrationLedgerState,
} from "../ledger";
import { rawDocumentDigest, readRawDocument } from "../oldShape";
import type { ReportLine } from "../report";
import {
	errorTextOf,
	type MigrateOptions,
	migrateCommand,
	migrateInvocationOf,
	type RunDependencies,
	runDebugDetails,
	runMigrate,
	runScan,
	scanCommand,
	scanInvocationOf,
} from "../run";
import type { FleetSource, SourceApp } from "../source";
import { writesIntoOperations } from "../steps/writesIntoOperations";
import { parseHead, structurePhase } from "../structure";
import { HORIZON_MIGRATION, PENDING_MIGRATIONS, WRITER_STEPS } from "../types";
import {
	CutoverAlreadyAppliedError,
	CutoverPostconditionError,
	CutoverStoppedError,
	type WriterOptions,
	type WriterReport,
} from "../writer";
import { carriersOfPersistedDoc, readPreStepJson } from "./rawFixture";

// ─── The fleet ────────────────────────────────────────────────────────────

const CLEAN = "targeted-migration-attachment";
/** The one fixture a blocker stops (part 09 §7.4's C9 arm under `forEach`). */
const BLOCKED = "pre-step-own-close-operation";
const PROJECT = "c3a3e0f4-2b8e-4c39-9f7e-6d1b2c3d4e5f";

const MEDIA: ReadonlyMap<MediaAssetId, MediaAssetRecord> = new Map(
	builtinAssetRows(ALL_ICON_SLUGS).map((record) => [
		record.id as MediaAssetId,
		record,
	]),
);

const NO_HOLDERS: HolderCensus = {
	liveApps: [],
	liveSessions: [],
	settleableApps: [],
	settleableSessions: [],
	unsettledApps: [],
	unsettledSessions: [],
};

/** One fixture as the fleet read gives it, its case schemas the ones
 *  `main`'s deploy stored (its writes made operations, without the claim
 *  type's row, which the drift writer adds). */
function sourceApp(fixtureId: string): SourceApp {
	const doc = readPreStepJson(`${fixtureId}.json`) as Record<string, unknown>;
	const appId = doc.appId as string;
	const carriers = carriersOfPersistedDoc(doc);
	const raw = readRawDocument(appId, carriers);
	const structure = structurePhase(raw);
	const head = parseHead(appId, structure.persisted);
	if (!head.ok) throw new Error(`The fixture ${fixtureId} does not parse.`);
	const stored = new Map<string, string>();
	for (const caseType of buildCaseTypeMap(
		toPersistableDoc(writesIntoOperations(head.doc, structure.facts).doc),
	).values())
		if (caseType.name !== CASE_CLAIM_CASE_TYPE)
			stored.set(
				caseType.name,
				canonicalJsonText(caseTypeToJsonSchema(caseType)),
			);
	return {
		appId,
		projectId: PROJECT,
		deleted: false,
		baseSeq: 4,
		carriers,
		raw,
		baseDigest: rawDocumentDigest(raw),
		context: {
			appId,
			projectId: PROJECT,
			lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			mediaRecords: MEDIA,
			deployments: [],
			storedSchemas: stored,
			liveDeployments: [],
			mutationSeq: 4,
			discardsPrivateWork: false,
		},
	};
}

function fleetOf(
	fixtureIds: readonly string[],
	holders: HolderCensus = NO_HOLDERS,
): FleetSource {
	const apps = fixtureIds.map(sourceApp);
	return {
		apps,
		projects: new Map(),
		privateWork: {
			openWorkspaces: 0,
			openChangeSets: 0,
			activeCandidates: 0,
			endingSessions: [],
			mutationEvents: 0,
			apps: [],
		},
		holders,
		appsInFleet: apps.length,
		deletedApps: 0,
		fleetSeqDigest: "f".repeat(64),
		databaseBytes: 0,
	};
}

const CLEAN_APP_ID = sourceApp(CLEAN).appId;

// ─── The stand-ins ────────────────────────────────────────────────────────

/** A handle every mode is given and none may use: each read and write
 *  goes through the dependencies. */
const UNUSED_DB = new Proxy(
	{},
	{
		get() {
			throw new Error(
				"The run reached the database directly, past the reads it was given.",
			);
		},
	},
) as Kysely<AppDatabase>;

const NOT_RUN: LedgerState = {
	ledger: { horizonApplied: false, pendingMigrations: [...PENDING_MIGRATIONS] },
	markers: { apps: 2, marked: 0 },
};
const APPLIED: LedgerState = {
	ledger: { horizonApplied: true, pendingMigrations: [] },
	markers: { apps: 2, marked: 2 },
};

interface LedgerState {
	readonly ledger: MigrationLedgerState;
	readonly markers: MarkerCount;
}

const WRITER_REPORT: WriterReport = {
	mode: "execute",
	stepMilliseconds: Object.fromEntries(
		WRITER_STEPS.map((step) => [step, 1]),
	) as WriterReport["stepMilliseconds"],
	databaseBytes: 1000,
	databaseGrowthBytes: 10,
	walBytes: 20,
	migrationsApplied: [...PENDING_MIGRATIONS],
	appsWritten: 1,
	noticesWritten: 0,
	eventsArchived: 0,
	workspacesAbandoned: 0,
	changeSetsAbandoned: 0,
	candidatesCleared: 0,
	sessionsEnded: 0,
};

interface Calls {
	sourceReads: { appId?: string }[];
	writes: WriterOptions[];
	settles: number;
	holderReads: number;
}

function standIns(
	args: {
		readonly state?: LedgerState;
		readonly source?: FleetSource;
		readonly writer?: (options: WriterOptions) => Promise<WriterReport>;
		readonly afterSettle?: HolderCensus;
	} = {},
): { deps: RunDependencies; calls: Calls } {
	const state = args.state ?? NOT_RUN;
	const calls: Calls = {
		sourceReads: [],
		writes: [],
		settles: 0,
		holderReads: 0,
	};
	const deps: RunDependencies = {
		readLedger: async () => state.ledger,
		readMarkers: async () => state.markers,
		readSource: async (_db, options) => {
			calls.sourceReads.push(options);
			return args.source ?? fleetOf([CLEAN]);
		},
		readHolders: async () => {
			calls.holderReads += 1;
			return args.afterSettle ?? NO_HOLDERS;
		},
		settleHolders: async () => {
			calls.settles += 1;
			return { appsSettled: 2, sessionsSettled: 1, failed: 0 };
		},
		runWriter: async (_db, options) => {
			calls.writes.push(options);
			return args.writer === undefined
				? { ...WRITER_REPORT, mode: options.mode }
				: args.writer(options);
		},
	};
	return { deps, calls };
}

function section(lines: readonly ReportLine[], name: string) {
	return lines.find((line) => line.section === name);
}

function sections(lines: readonly ReportLine[]): string[] {
	return lines.map((line) => line.section);
}

async function dryRunDigest(deps: RunDependencies): Promise<string> {
	const result = await runMigrate(UNUSED_DB, {
		mode: "dry-run",
		dependencies: deps,
	});
	const digest = section(result.report.all(), "fleet")?.planDigest;
	if (typeof digest !== "string")
		throw new Error("The dry run printed no planDigest.");
	return digest;
}

// ─── Arguments ────────────────────────────────────────────────────────────

/** Parse as the script does, with commander's exits turned into throws. */
function parsed(
	command: ReturnType<typeof migrateCommand>,
	argv: readonly string[],
) {
	command
		.exitOverride()
		.configureOutput({ writeErr: () => {}, writeOut: () => {} });
	command.parse([...argv], { from: "user" });
	return command.opts();
}

describe("the migrate script's arguments", () => {
	it("runs the dry run with no option, and each named mode alone", () => {
		expect(migrateInvocationOf(parsed(migrateCommand(), []))).toEqual({
			ok: true,
			mode: "dry-run",
		});
		expect(
			migrateInvocationOf(parsed(migrateCommand(), ["--settle-holders"])),
		).toEqual({ ok: true, mode: "settle-holders" });
		expect(
			migrateInvocationOf(parsed(migrateCommand(), ["--rehearse"])),
		).toEqual({ ok: true, mode: "rehearse" });
		const digest = "a".repeat(64);
		expect(
			migrateInvocationOf(
				parsed(migrateCommand(), ["--execute", "--expect-plan-digest", digest]),
			),
		).toEqual({ ok: true, mode: "execute", expectPlanDigest: digest });
	});

	it("refuses two modes at once", () => {
		for (const argv of [
			["--execute", "--rehearse"],
			["--settle-holders", "--execute"],
			["--rehearse", "--settle-holders"],
		]) {
			expect(() => parsed(migrateCommand(), argv)).toThrow(CommanderError);
		}
	});

	it("refuses --execute without a well-formed digest, and a digest without --execute", () => {
		const refusals = [
			["--execute"],
			["--execute", "--expect-plan-digest", "A".repeat(64)],
			["--execute", "--expect-plan-digest", "a".repeat(63)],
			["--expect-plan-digest", "a".repeat(64)],
			["--rehearse", "--expect-plan-digest", "a".repeat(64)],
		].map((argv) => migrateInvocationOf(parsed(migrateCommand(), argv)));
		for (const refusal of refusals) expect(refusal.ok).toBe(false);
		expect(refusals.map((refusal) => !refusal.ok && refusal.message)).toEqual([
			expect.stringContaining("needs --expect-plan-digest"),
			expect.stringContaining("64 lowercase hex characters"),
			expect.stringContaining("64 lowercase hex characters"),
			expect.stringContaining("read only by --execute"),
			expect.stringContaining("read only by --execute"),
		]);
	});

	it("has no --prod: production writes only through the Job", () => {
		expect(() => parsed(migrateCommand(), ["--prod"])).toThrow(CommanderError);
		expect(migrateCommand().helpInformation()).not.toContain("--prod");
	});
});

describe("the scan script's arguments", () => {
	it("scans every app or one, locally or in production", () => {
		expect(scanInvocationOf(parsed(scanCommand(), []))).toEqual({
			ok: true,
			prod: false,
			debugDetails: false,
		});
		expect(
			scanInvocationOf(
				parsed(scanCommand(), ["--prod", "--app", "app-1", "--debug-details"]),
			),
		).toEqual({ ok: true, prod: true, appId: "app-1", debugDetails: true });
	});

	it("refuses --debug-details without --app, and an empty app id", () => {
		const withoutApp = scanInvocationOf(
			parsed(scanCommand(), ["--debug-details"]),
		);
		expect(withoutApp).toEqual({
			ok: false,
			message: expect.stringContaining("needs --app <appId>"),
		});
		expect(scanInvocationOf(parsed(scanCommand(), ["--app", " "])).ok).toBe(
			false,
		);
	});
});

// ─── The two reads every mode makes first ─────────────────────────────────

const EVERY_MODE: readonly MigrateOptions[] = [
	{ mode: "dry-run" },
	{ mode: "settle-holders" },
	{ mode: "rehearse" },
	{ mode: "execute", expectPlanDigest: "a".repeat(64) },
];

describe("already applied and partially applied", () => {
	it("prints already-applied and exits 0 in every mode and in the scan, reading nothing else", async () => {
		for (const options of EVERY_MODE) {
			const { deps, calls } = standIns({ state: APPLIED });
			const result = await runMigrate(UNUSED_DB, {
				...options,
				dependencies: deps,
			});
			expect(result.outcome).toEqual({ outcome: "already-applied" });
			expect(result.exitCode).toBe(0);
			expect(sections(result.report.all())).toEqual(["fleet", "outcome"]);
			expect(section(result.report.all(), "fleet")).toMatchObject({
				ledger: { horizonApplied: true, pendingMigrations: [] },
				markers: { apps: 2, marked: 2 },
			});
			expect(calls).toEqual({
				sourceReads: [],
				writes: [],
				settles: 0,
				holderReads: 0,
			});
		}
		const { deps, calls } = standIns({ state: APPLIED });
		const scan = await runScan(UNUSED_DB, { dependencies: deps });
		expect(scan.outcome).toEqual({ outcome: "already-applied" });
		expect(scan.exitCode).toBe(0);
		expect(calls.sourceReads).toEqual([]);
		expect(await runDebugDetails(UNUSED_DB, CLEAN_APP_ID, deps)).toEqual([
			expect.stringContaining("already run"),
		]);
	});

	it("stops as partially-applied, naming the counts, for a ledger and markers no committed run leaves", async () => {
		for (const state of [
			{
				ledger: { horizonApplied: true, pendingMigrations: [] },
				markers: { apps: 3, marked: 1 },
			},
			{
				ledger: {
					horizonApplied: false,
					pendingMigrations: [...PENDING_MIGRATIONS],
				},
				markers: { apps: 3, marked: 1 },
			},
		]) {
			for (const options of EVERY_MODE) {
				const { deps, calls } = standIns({ state });
				const result = await runMigrate(UNUSED_DB, {
					...options,
					dependencies: deps,
				});
				expect(result.outcome).toEqual({
					outcome: "stopped",
					stoppedBy: ["partially-applied"],
				});
				expect(result.exitCode).toBe(1);
				expect(result.refusal).toContain("1 of 3 apps");
				expect(result.refusal).toContain(HORIZON_MIGRATION);
				expect(calls.sourceReads).toEqual([]);
				expect(calls.writes).toEqual([]);
				expect(calls.settles).toBe(0);
			}
			const { deps } = standIns({ state });
			const scan = await runScan(UNUSED_DB, { dependencies: deps });
			expect(scan.outcome).toEqual({
				outcome: "stopped",
				stoppedBy: ["partially-applied"],
			});
		}
	});
});

// ─── The modes ────────────────────────────────────────────────────────────

describe("the modes", () => {
	it("the dry run prints the whole plan and its digest and never reaches the writer; the scan prints no digest", async () => {
		const { deps, calls } = standIns();
		const dryRun = await runMigrate(UNUSED_DB, {
			mode: "dry-run",
			dependencies: deps,
		});
		expect(dryRun.outcome).toEqual({ outcome: "ok" });
		expect(dryRun.exitCode).toBe(0);
		expect(sections(dryRun.report.all())).toEqual([
			"fleet",
			"structure",
			"steps",
			"placements",
			"path-moves",
			"notice",
			"schema",
			"holders",
			"private-work",
			"outcome",
		]);
		expect(section(dryRun.report.all(), "fleet")?.planDigest).toMatch(
			/^[0-9a-f]{64}$/,
		);
		expect(calls.writes).toEqual([]);

		const scan = await runScan(UNUSED_DB, {
			appId: CLEAN_APP_ID,
			dependencies: deps,
		});
		expect(scan.outcome).toEqual({ outcome: "ok" });
		expect(section(scan.report.all(), "fleet")).toMatchObject({
			planDigest: null,
		});
		expect(calls.sourceReads.at(-1)).toEqual({ appId: CLEAN_APP_ID });
		expect(calls.writes).toEqual([]);
	});

	it("prints each line as it is made", async () => {
		const printed: ReportLine[] = [];
		const { deps } = standIns();
		const result = await runMigrate(UNUSED_DB, {
			mode: "dry-run",
			dependencies: deps,
			onLine: (line) => printed.push(line),
		});
		expect(printed).toEqual(result.report.all());
	});

	it("--execute writes the dry run's plan with its digest, and refuses another digest with nothing written", async () => {
		const { deps, calls } = standIns();
		const digest = await dryRunDigest(deps);
		const refused = await runMigrate(UNUSED_DB, {
			mode: "execute",
			expectPlanDigest: "0".repeat(64),
			dependencies: deps,
		});
		expect(refused.outcome).toEqual({
			outcome: "stopped",
			stoppedBy: ["digest"],
		});
		expect(refused.exitCode).toBe(1);
		expect(refused.refusal).toContain(digest);
		expect(refused.refusal).toContain("0".repeat(64));
		expect(calls.writes).toEqual([]);

		const executed = await runMigrate(UNUSED_DB, {
			mode: "execute",
			expectPlanDigest: digest,
			dependencies: deps,
		});
		expect(executed.outcome).toEqual({ outcome: "ok" });
		expect(calls.writes).toHaveLength(1);
		const [write] = calls.writes;
		expect(write).toMatchObject({ mode: "execute", expectPlanDigest: digest });
		expect(write?.input.plan.digest).toBe(digest);
		expect(write?.input.writes.has(CLEAN_APP_ID)).toBe(true);
		expect(section(executed.report.all(), "writer")).toMatchObject({
			walBytes: 20,
			databaseGrowthBytes: 10,
			migrationsApplied: [...PENDING_MIGRATIONS],
		});
		expect(sections(executed.report.all()).slice(-2)).toEqual([
			"writer",
			"outcome",
		]);
	});

	it("--rehearse runs the writer in its rehearsal mode, passing a test's injected failure through", async () => {
		const { deps, calls } = standIns();
		const result = await runMigrate(UNUSED_DB, {
			mode: "rehearse",
			failAfter: "apps",
			dependencies: deps,
		});
		expect(result.outcome).toEqual({ outcome: "ok" });
		expect(calls.writes).toEqual([
			expect.objectContaining({ mode: "rehearse", failAfter: "apps" }),
		]);
		expect(calls.writes[0]).not.toHaveProperty("expectPlanDigest");
	});

	it("stops every plan-building mode on a blocker, with the writer never reached", async () => {
		const { deps, calls } = standIns({ source: fleetOf([BLOCKED, CLEAN]) });
		const digest = await dryRunDigest(deps);
		for (const options of [
			{ mode: "dry-run" },
			{ mode: "rehearse" },
			{ mode: "execute", expectPlanDigest: digest },
		] as const) {
			const result = await runMigrate(UNUSED_DB, {
				...options,
				dependencies: deps,
			});
			expect(result.outcome).toEqual({
				outcome: "stopped",
				stoppedBy: ["blocker"],
			});
			expect(result.exitCode).toBe(1);
			expect(
				result.report.all().filter((line) => line.section === "blocker"),
			).not.toHaveLength(0);
		}
		const scan = await runScan(UNUSED_DB, { dependencies: deps });
		expect(scan.outcome).toEqual({
			outcome: "stopped",
			stoppedBy: ["blocker"],
		});
		expect(calls.writes).toEqual([]);
	});

	it("stops on any holder, and on a ledger that is not the window's three pending", async () => {
		const held = standIns({
			source: fleetOf([CLEAN], { ...NO_HOLDERS, liveApps: [CLEAN_APP_ID] }),
		});
		const holder = await runMigrate(UNUSED_DB, {
			mode: "rehearse",
			dependencies: held.deps,
		});
		expect(holder.outcome).toEqual({
			outcome: "stopped",
			stoppedBy: ["holder"],
		});
		expect(held.calls.writes).toEqual([]);

		const extra = standIns({
			state: {
				ledger: {
					horizonApplied: false,
					pendingMigrations: [
						...PENDING_MIGRATIONS,
						"20261201000000_unreviewed",
					].sort(),
				},
				markers: { apps: 1, marked: 0 },
			},
		});
		const dryRun = await runMigrate(UNUSED_DB, {
			mode: "dry-run",
			dependencies: extra.deps,
		});
		expect(dryRun.outcome).toEqual({ outcome: "ok" });
		const rehearse = await runMigrate(UNUSED_DB, {
			mode: "rehearse",
			dependencies: extra.deps,
		});
		expect(rehearse.outcome).toEqual({
			outcome: "stopped",
			stoppedBy: ["ledger"],
		});
		expect(rehearse.refusal).toContain("20261201000000_unreviewed");
		expect(extra.calls.writes).toEqual([]);
	});

	it("reads the writer's refusals under its locks as the run's outcome", async () => {
		const cases: readonly [Error, object][] = [
			[
				new CutoverStoppedError("app-changed", "app moved"),
				{ outcome: "stopped", stoppedBy: ["app-changed"] },
			],
			[
				new CutoverStoppedError("holder", "a holder appeared"),
				{ outcome: "stopped", stoppedBy: ["holder"] },
			],
			[
				new CutoverLedgerError("other ledger"),
				{ outcome: "stopped", stoppedBy: ["ledger"] },
			],
			[
				new CutoverAlreadyAppliedError("another run committed"),
				{ outcome: "already-applied" },
			],
		];
		for (const [error, outcome] of cases) {
			const { deps } = standIns({ writer: () => Promise.reject(error) });
			const result = await runMigrate(UNUSED_DB, {
				mode: "rehearse",
				dependencies: deps,
			});
			expect(result.outcome).toEqual(outcome);
			expect(result.refusal).toBe(error.message);
			expect(result.exitCode).toBe(
				(outcome as { outcome: string }).outcome === "stopped" ? 1 : 0,
			);
		}
	});

	it("ends a run that throws with a stopped outcome naming the error's class, never its text", async () => {
		const postcondition = new CutoverPostconditionError(
			"The cutover's postcondition failed: app a no longer loads.",
		);
		const database = Object.assign(new Error("row text: Alice"), {
			code: "23505",
		});
		for (const [error, errorClass] of [
			[postcondition, "postcondition"],
			[database, "database-23505"],
		] as const) {
			const printed: ReportLine[] = [];
			const { deps } = standIns({ writer: () => Promise.reject(error) });
			await expect(
				runMigrate(UNUSED_DB, {
					mode: "rehearse",
					dependencies: deps,
					onLine: (line) => printed.push(line),
				}),
			).rejects.toBe(error);
			expect(printed.at(-1)).toMatchObject({
				section: "outcome",
				outcome: "stopped",
				stoppedBy: ["error"],
				errorClass,
			});
		}
		expect(errorTextOf(postcondition)).toContain("app a no longer loads");
		expect(errorTextOf(database)).not.toContain("Alice");
		expect(errorTextOf(database)).toContain("database-23505");
	});

	it("--settle-holders runs the reapers, then counts the holders again, and never plans or writes", async () => {
		const { deps, calls } = standIns({
			afterSettle: { ...NO_HOLDERS, liveApps: ["app-live"] },
		});
		const result = await runMigrate(UNUSED_DB, {
			mode: "settle-holders",
			dependencies: deps,
		});
		expect(result.outcome).toEqual({ outcome: "ok" });
		expect(section(result.report.all(), "holders")).toMatchObject({
			settledApps: 2,
			settledSessions: 1,
			settleFailed: 0,
			live: 1,
			liveApps: ["app-live"],
			lapsedOrPaused: 0,
		});
		expect(calls).toMatchObject({
			sourceReads: [],
			writes: [],
			settles: 1,
			holderReads: 1,
		});
	});

	it("--debug-details names one app's blockers and changes, and an id no app has", async () => {
		const { deps } = standIns({ source: fleetOf([BLOCKED]) });
		const blockedId = sourceApp(BLOCKED).appId;
		const lines = await runDebugDetails(UNUSED_DB, blockedId, deps);
		expect(lines[0]).toContain(`app ${blockedId}`);
		expect(lines.some((line) => line.startsWith("blocker "))).toBe(true);
		const missing = await runDebugDetails(UNUSED_DB, "app-nobody", deps);
		expect(missing).toEqual([expect.stringContaining("No app has id")]);
	});
});
