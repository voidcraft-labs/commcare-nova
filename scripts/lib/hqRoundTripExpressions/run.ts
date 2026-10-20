/**
 * What each mode of the two cutover scripts does, against a database handle,
 * returning its report. The scripts parse their arguments and print; the
 * tests call these with their own database (part 09 §3, "Arguments").
 */

import type { Kysely } from "kysely";
import { runCaseStoreMigrationsWithReport } from "@/lib/case-store/migrate";
import type { AppDatabase } from "@/lib/db/pg";
import { censusHasUnexplained, fleetCensus, parseBaseCensus } from "./census";
import { readPlannedFleet, readRecipients } from "./fleet";
import { readHolderCensus, settleHolders } from "./holders";
import { type PlannedFleet, planHasBlockers } from "./plan";
import {
	CutoverReport,
	censusLine,
	debugDetails,
	fleetLine,
	outcomeLine,
	planSections,
	type ReportMode,
	type ReportOutcome,
} from "./report";
import {
	CutoverStoppedError,
	readMarkedAppCounts,
	runFleetTransaction,
	type WriterInput,
	type WriterReport,
	type WriterStep,
} from "./writer";

export interface RunResult {
	readonly report: CutoverReport;
	readonly outcome: ReportOutcome;
	/** 1 when a blocker, a live holder, a digest refusal or an unexplained census stopped the run. */
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

/** The modes of the migrate script. */
export type MigrateMode = Exclude<ReportMode, "scan">;

export interface MigrateOptions {
	readonly mode: MigrateMode;
	/** With `execute`, the digest the dry run printed. */
	readonly expectPlanDigest?: string;
	/** Tests only: throw right after the named step of the fleet transaction. */
	readonly failAfter?: WriterStep;
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
		throw new Error(
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
		appsWritten: writer.appsWritten,
		noticesWritten: writer.noticesWritten,
		eventsArchived: writer.eventsArchived,
		workspacesAbandoned: writer.workspacesAbandoned,
		changeSetsAbandoned: writer.changeSetsAbandoned,
		candidatesCleared: writer.candidatesCleared,
		sessionsEnded: writer.sessionsEnded,
	};
}

function liveHolders(fleet: PlannedFleet): boolean {
	return fleet.holders.liveApps.length + fleet.holders.liveSessions.length > 0;
}

/** One run of the migrate script. */
export async function runMigrate(
	db: Kysely<AppDatabase>,
	options: MigrateOptions,
): Promise<RunResult> {
	const { mode } = options;
	const report = new CutoverReport(mode);
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

	if (mode === "rehearse" || mode === "execute") {
		await runCaseStoreMigrationsWithReport(db as unknown as Kysely<unknown>);
	}
	const planStarted = performance.now();
	const fleet = await readPlannedFleet(db);
	const planMilliseconds = Math.round(performance.now() - planStarted);
	const stoppedBy = [
		...(planHasBlockers(fleet.plan) ? (["blocker"] as const) : []),
		...(liveHolders(fleet) ? (["holder"] as const) : []),
	];
	const digestMoved =
		mode === "execute" && fleet.plan.digest !== options.expectPlanDigest;

	let writer: WriterReport | null = null;
	let writerStop: CutoverStoppedError | null = null;
	if (
		(mode === "rehearse" || mode === "execute") &&
		stoppedBy.length === 0 &&
		!digestMoved
	) {
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
			writerStop = error;
		}
	}

	fleetLine(report, fleet, {
		planMilliseconds,
		...(writer === null ? {} : writerFields(writer)),
	});
	planSections(report, fleet);
	if (digestMoved) {
		return finish(report, { outcome: "stopped", stoppedBy: ["digest"] });
	}
	if (stoppedBy.length > 0) {
		return finish(report, { outcome: "stopped", stoppedBy });
	}
	if (writerStop !== null) {
		/* An app or the marker that moved under the locks is a fleet that no
		 * longer matches the plan, which the report states as its digest. */
		return finish(report, {
			outcome: "stopped",
			stoppedBy: [
				writerStop.code === "holder" || writerStop.code === "blocker"
					? writerStop.code
					: "digest",
			],
		});
	}
	return finish(report, { outcome: "ok" });
}

export interface ScanOptions {
	readonly appId?: string;
	/** The base emitter's JSON Lines, for the census's head half. */
	readonly baseDigests?: string;
}

/** One run of the scan: plain `SELECT`s in one read-only snapshot. */
export async function runScan(
	db: Kysely<AppDatabase>,
	options: ScanOptions = {},
): Promise<RunResult> {
	const report = new CutoverReport("scan");
	const applied = await alreadyApplied(db, report);
	if (applied !== null) return applied;
	const planStarted = performance.now();
	const fleet = await readPlannedFleet(db, {
		...(options.appId !== undefined && { appId: options.appId }),
	});
	fleetLine(report, fleet, {
		planMilliseconds: Math.round(performance.now() - planStarted),
	});
	planSections(report, fleet);
	let unexplained = false;
	if (options.baseDigests !== undefined) {
		const census = fleetCensus({
			apps: fleet.plan.apps,
			deleted: new Set(
				fleet.apps.filter((app) => app.deleted).map((app) => app.appId),
			),
			targets: fleet.targets,
			lookupDefinitions: fleet.lookupDefinitions,
			fleetSeqDigest: fleet.fleetSeqDigest,
			base: parseBaseCensus(options.baseDigests),
		});
		censusLine(report, census);
		unexplained = censusHasUnexplained(census);
	}
	const stoppedBy = [
		...(planHasBlockers(fleet.plan) ? (["blocker"] as const) : []),
		...(liveHolders(fleet) ? (["holder"] as const) : []),
		...(unexplained ? (["unexplained"] as const) : []),
	];
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
