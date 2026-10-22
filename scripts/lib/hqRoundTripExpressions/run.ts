/**
 * What each mode of the two cutover scripts does, against a database handle,
 * returning its report. The scripts parse their arguments and print; the
 * tests call these with their own database (part 09 §3, "Arguments").
 */

import type { Kysely } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import {
	BaseCensusError,
	censusStops,
	fleetCensus,
	parseBaseCensus,
} from "./census";
import { readPlannedFleet, readRecipients } from "./fleet";
import {
	holderCensusIsEmpty,
	readHolderCensus,
	settleHolders,
} from "./holders";
import { type PlannedFleet, planHasBlockers } from "./plan";
import {
	CutoverReport,
	censusLine,
	debugDetails,
	fleetLine,
	outcomeLine,
	planSections,
	type ReportLine,
	type ReportMode,
	type ReportOutcome,
} from "./report";
import {
	CutoverLedgerError,
	CutoverLockTimeoutError,
	CutoverPostconditionError,
	CutoverStoppedError,
	readMarkedAppCounts,
	readMigrationLedger,
	runFleetTransaction,
	type WriterInput,
	type WriterReport,
	type WriterStep,
} from "./writer";

export interface RunResult {
	readonly report: CutoverReport;
	readonly outcome: ReportOutcome;
	/** 1 when a blocker, a holder, a digest refusal, the census or an error stopped the run. */
	readonly exitCode: 0 | 1;
}

function finish(report: CutoverReport, outcome: ReportOutcome): RunResult {
	outcomeLine(report, outcome);
	return {
		report,
		outcome,
		exitCode: outcome.outcome === "stopped" ? 1 : 0,
	};
}

/** Some apps carry the horizon and some do not: no run of this writer leaves that state. */
export class CutoverPartialHorizonError extends Error {
	readonly name = "CutoverPartialHorizonError";
}

/**
 * What threw, as the report may say it: a class of this cutover's own, the
 * SQLSTATE of a database error (its text can quote a row, so it is never
 * kept), or `internal`.
 */
export function errorClassOf(error: unknown): string {
	if (error instanceof CutoverPostconditionError) return "postcondition";
	if (error instanceof CutoverLedgerError) return "ledger";
	if (error instanceof CutoverLockTimeoutError) return "lock-timeout";
	if (error instanceof CutoverPartialHorizonError) return "partial-horizon";
	if (error instanceof BaseCensusError) return "base-census";
	if (error instanceof CutoverStoppedError) return `writer-${error.code}`;
	for (
		let cursor: unknown = error, depth = 0;
		cursor !== null && typeof cursor === "object" && depth < 8;
		cursor = (cursor as { cause?: unknown }).cause, depth++
	) {
		const code = (cursor as { code?: unknown }).code;
		if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code))
			return `database-${code}`;
	}
	return "internal";
}

/**
 * The terminal's account of what threw: this cutover's own messages, which
 * name ids and counts only, or for anything else its class alone, since a
 * database error's text can quote authored content.
 */
export function errorTextOf(error: unknown): string {
	const errorClass = errorClassOf(error);
	if (
		(error instanceof CutoverPostconditionError ||
			error instanceof CutoverLedgerError ||
			error instanceof CutoverLockTimeoutError ||
			error instanceof CutoverPartialHorizonError ||
			error instanceof BaseCensusError ||
			error instanceof CutoverStoppedError) &&
		error.message !== ""
	)
		return `The cutover stopped (${errorClass}): ${error.message}`;
	return `The cutover stopped on an error of class ${errorClass}. Its text is not printed, because a database error can quote stored content. Reproduce it against a restored copy of the database to read it.`;
}

/**
 * Run one mode against its report: whatever throws still ends the report
 * with an `outcome` line, `stopped` by `error` with its class, before the
 * error leaves.
 */
async function reported(
	report: CutoverReport,
	body: () => Promise<RunResult>,
): Promise<RunResult> {
	try {
		return await body();
	} catch (error) {
		outcomeLine(report, {
			outcome: "stopped",
			stoppedBy: ["error"],
			errorClass: errorClassOf(error),
		});
		throw error;
	}
}

/** The modes of the migrate script. */
export type MigrateMode = Exclude<ReportMode, "scan">;

export interface MigrateOptions {
	readonly mode: MigrateMode;
	/** With `execute`, the digest the dry run printed. */
	readonly expectPlanDigest?: string;
	/** Tests only: throw right after the named step of the fleet transaction. */
	readonly failAfter?: WriterStep;
	/** Each report line as it is made, so a run that throws has printed it. */
	readonly onLine?: (line: ReportLine) => void;
}

/**
 * Every mode counts the marked apps first, before any old-shape read: all of
 * them is `already-applied`; some of them refuses, since no run of this
 * writer leaves that state.
 */
async function alreadyApplied(
	db: Kysely<AppDatabase>,
	report: CutoverReport,
): Promise<RunResult | null> {
	const counts = await readMarkedAppCounts(db);
	if (counts.apps > 0 && counts.marked === counts.apps) {
		report.line("fleet", { apps: counts.apps, appsMarked: counts.marked });
		return finish(report, { outcome: "already-applied" });
	}
	if (counts.marked > 0) {
		throw new CutoverPartialHorizonError(
			`${counts.marked} of ${counts.apps} apps carry the hq-round-trip-expressions horizon and the rest do not. No run of this writer leaves that state, so it refuses to read the fleet. Restore the database from the window's restore point before running it again.`,
		);
	}
	return null;
}

/** What the writer writes, from the plan the run built. */
export function writerInputOf(fleet: PlannedFleet): WriterInput {
	return {
		plan: fleet.plan,
		apps: new Map(
			fleet.plan.apps.flatMap((app) => {
				const target = fleet.targets.get(app.appId);
				return target === undefined
					? []
					: [
							[
								app.appId,
								{
									plan: app,
									target,
									noticeEntries: fleet.noticeEntries.get(app.appId) ?? [],
								},
							] as const,
						];
			}),
		),
		lookupContexts: fleet.lookupContexts,
		mediaManifests: fleet.mediaManifests,
	};
}

function writerFields(writer: WriterReport): Record<string, unknown> {
	return {
		writerSteps: writer.durations,
		databaseBytesAtCommit: writer.databaseBytes,
		walBytes: writer.walBytes,
		migrationsApplied: writer.migrationsApplied,
		appsWritten: writer.appsWritten,
		noticesWritten: writer.noticesWritten,
		eventsArchived: writer.eventsArchived,
		workspacesAbandoned: writer.workspacesAbandoned,
		changeSetsAbandoned: writer.changeSetsAbandoned,
		candidatesCleared: writer.candidatesCleared,
		sessionsEnded: writer.sessionsEnded,
	};
}

/**
 * Any holder at all, by the writer's own predicate: a live one, a lapsed or
 * paused one, or an unsettled hold. The fleet transaction refuses every one,
 * so no read-only mode may say `ok` past one.
 */
function anyHolder(fleet: PlannedFleet): boolean {
	return !holderCensusIsEmpty(fleet.holders);
}

/** The stops every plan-building mode reads from the plan alone. */
function planStops(fleet: PlannedFleet): ("blocker" | "holder")[] {
	return [
		...(planHasBlockers(fleet.plan) ? (["blocker"] as const) : []),
		...(anyHolder(fleet) ? (["holder"] as const) : []),
	];
}

/**
 * One run of the migrate script. Nothing is written, and no DDL applied,
 * before every check that can stop has passed: the plan's blockers and
 * holders and, under `--execute`, its digest, here; then the writer's own
 * checks under its locks, after which it applies the ledgered DDL inside the
 * same transaction as the fleet.
 */
export async function runMigrate(
	db: Kysely<AppDatabase>,
	options: MigrateOptions,
): Promise<RunResult> {
	const report = new CutoverReport(options.mode, options.onLine);
	return reported(report, () => migrate(db, report, options));
}

async function migrate(
	db: Kysely<AppDatabase>,
	report: CutoverReport,
	options: MigrateOptions,
): Promise<RunResult> {
	const { mode } = options;
	const applied = await alreadyApplied(db, report);
	if (applied !== null) return applied;

	if (mode === "settle-holders") {
		const settled = await settleHolders();
		const census = await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute((tx) => readHolderCensus(tx));
		report.line("holders", {
			settledApps: settled.appsSettled,
			settledSessions: settled.sessionsSettled,
			live: census.liveApps.length + census.liveSessions.length,
			lapsedOrPaused:
				census.settleableApps.length + census.settleableSessions.length,
			unsettledHolds:
				census.unsettledApps.length + census.unsettledSessions.length,
		});
		return finish(report, { outcome: "ok" });
	}

	const planStarted = performance.now();
	const fleet = await readPlannedFleet(db);
	const planMilliseconds = Math.round(performance.now() - planStarted);
	fleetLine(report, fleet, {
		planMilliseconds,
		ledger: await readMigrationLedger(db),
	});
	planSections(report, fleet);

	if (mode === "execute" && fleet.plan.digest !== options.expectPlanDigest) {
		return finish(report, { outcome: "stopped", stoppedBy: ["digest"] });
	}
	const stoppedBy = planStops(fleet);
	if (stoppedBy.length > 0) {
		return finish(report, { outcome: "stopped", stoppedBy });
	}
	if (mode === "dry-run") return finish(report, { outcome: "ok" });

	let writer: WriterReport;
	try {
		writer = await runFleetTransaction(db, {
			mode,
			input: writerInputOf(fleet),
			...(options.failAfter !== undefined && {
				failAfter: options.failAfter,
			}),
		});
	} catch (error) {
		if (!(error instanceof CutoverStoppedError)) throw error;
		if (error.code === "already-applied")
			return finish(report, { outcome: "already-applied" });
		/* An app that moved under the locks is a fleet that no longer matches
		 * the plan, which the report states as its digest. */
		return finish(report, {
			outcome: "stopped",
			stoppedBy: [
				error.code === "holder" || error.code === "blocker"
					? error.code
					: "digest",
			],
		});
	}
	report.line("writer", writerFields(writer));
	return finish(report, { outcome: "ok" });
}

export interface ScanOptions {
	readonly appId?: string;
	/** The base emitter's JSON Lines, for the census's head half. */
	readonly baseDigests?: string;
	/** Each report line as it is made, so a run that throws has printed it. */
	readonly onLine?: (line: ReportLine) => void;
}

/**
 * One run of the scan: plain `SELECT`s in one read-only snapshot, then the
 * ledger's one `SELECT`. It stops where `--execute` would: on a blocker or
 * any holder, and with base digests on every census stop.
 */
export async function runScan(
	db: Kysely<AppDatabase>,
	options: ScanOptions = {},
): Promise<RunResult> {
	const report = new CutoverReport("scan", options.onLine);
	return reported(report, () => scan(db, report, options));
}

async function scan(
	db: Kysely<AppDatabase>,
	report: CutoverReport,
	options: ScanOptions,
): Promise<RunResult> {
	const applied = await alreadyApplied(db, report);
	if (applied !== null) return applied;
	const planStarted = performance.now();
	const fleet = await readPlannedFleet(db, {
		...(options.appId !== undefined && { appId: options.appId }),
	});
	fleetLine(report, fleet, {
		planMilliseconds: Math.round(performance.now() - planStarted),
		ledger: await readMigrationLedger(db),
	});
	planSections(report, fleet);
	const census: ReturnType<typeof censusStops> = [];
	if (options.baseDigests !== undefined) {
		const compared = fleetCensus({
			apps: fleet.plan.apps,
			deleted: new Set(
				fleet.apps.filter((app) => app.deleted).map((app) => app.appId),
			),
			targets: fleet.targets,
			lookupDefinitions: fleet.lookupDefinitions,
			fleetSeqDigest: fleet.fleetSeqDigest,
			base: parseBaseCensus(options.baseDigests),
		});
		censusLine(report, compared);
		census.push(...censusStops(compared));
	}
	const stoppedBy = [...planStops(fleet), ...census];
	return finish(
		report,
		stoppedBy.length === 0
			? { outcome: "ok" }
			: { outcome: "stopped", stoppedBy },
	);
}

/** `--recipients`: the announcement's addresses, from one read-only snapshot. */
export async function runRecipients(
	db: Kysely<AppDatabase>,
	appId: string | undefined,
): Promise<readonly string[]> {
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute((tx) => readRecipients(tx, appId));
}

/** `--app <id> --debug-details`: one app's blocker places, for the terminal only. */
export async function runDebugDetails(
	db: Kysely<AppDatabase>,
	appId: string,
): Promise<readonly string[]> {
	const fleet = await readPlannedFleet(db, { appId });
	return debugDetails(fleet, appId);
}
