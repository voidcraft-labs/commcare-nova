/**
 * What each mode of the two cutover scripts does, against a database handle,
 * returning its report (part 09 §4, "Arguments"). The scripts parse their
 * arguments and print; the tests call these with their own database and a
 * fake media reader.
 */

import type { Kysely } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { PLATFORMS } from "@/lib/domain/platforms";
import { unavailableUses } from "@/lib/domain/platformUses";
import {
	holderCensusIsEmpty,
	readHolderCensus,
	settleHolders,
} from "./holders";
import {
	CutoverLedgerError,
	CutoverLockTimeoutError,
	ledgerIsReviewed,
	readMigrationLedger,
} from "./ledger";
import {
	classifyFleetMedia,
	type MediaObjectReader,
	MediaReadError,
	PROVE_MEDIA_READ_TIMING,
	type ProveMediaReadTiming,
	proveMediaRead,
	storageMediaReader,
} from "./media";
import { type PlannedFleet, planFleet, planHasBlockers } from "./plan";
import {
	CutoverReport,
	debugDetails,
	fleetLine,
	outcomeLine,
	planSections,
	type ReportLine,
	type ReportMode,
	type ReportOutcome,
} from "./report";
import { readFleetSource, readReadyMediaRows } from "./source";
import {
	CutoverPostconditionError,
	CutoverStoppedError,
	runFleetTransaction,
	type WriterReport,
	type WriterStep,
} from "./writer";

export interface RunResult {
	readonly report: CutoverReport;
	readonly outcome: ReportOutcome;
	/** 1 when a blocker, a holder, a refusal or an error stopped the run. */
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

/**
 * What threw, as the report may say it: a class of this cutover's own, the
 * SQLSTATE of a database error (its text can quote a row, so it is never
 * kept), or `internal`.
 */
export function errorClassOf(error: unknown): string {
	if (error instanceof CutoverPostconditionError) return "postcondition";
	if (error instanceof CutoverLedgerError) return "ledger";
	if (error instanceof CutoverLockTimeoutError) return "lock-timeout";
	if (error instanceof MediaReadError) return "media-read";
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
			error instanceof MediaReadError ||
			error instanceof CutoverStoppedError) &&
		error.message !== ""
	)
		return `The cutover stopped (${errorClass}): ${error.message}`;
	return `The cutover stopped on an error of class ${errorClass}. Its text is not printed, because a database error can quote stored content. Reproduce it against a restored copy of the database to read it.`;
}

/** Whatever throws still ends the report with an `outcome` line before it leaves. */
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

/** The stops every plan-building mode reads from the plan alone. */
function planStops(fleet: PlannedFleet): ("blocker" | "holder")[] {
	return [
		...(planHasBlockers(fleet.plan) ? (["blocker"] as const) : []),
		...(holderCensusIsEmpty(fleet.holders) ? [] : (["holder"] as const)),
	];
}

/** The plan over a read-only snapshot, then the media classified outside it. */
export async function readPlannedFleet(
	db: Kysely<AppDatabase>,
	options: {
		readonly appId?: string;
		/** Null in the scan, which reads no media bytes. */
		readonly reader: MediaObjectReader | null;
	},
): Promise<PlannedFleet> {
	const source = await db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute((tx) =>
			readFleetSource(tx, {
				...(options.appId !== undefined && { appId: options.appId }),
			}),
		);
	const media =
		options.reader === null
			? null
			: await classifyFleetMedia(source.media, options.reader);
	return planFleet(source, media);
}

export type MigrateMode = Exclude<ReportMode, "scan">;

export interface MigrateOptions {
	readonly mode: MigrateMode;
	/** With `execute`, the digest the dry run printed. */
	readonly expectPlanDigest?: string;
	/** The storage boundary; the media bucket unless a test passes its own. */
	readonly reader?: MediaObjectReader;
	/** Tests only: how `--prove-media-read` waits between refusals. */
	readonly proveTiming?: ProveMediaReadTiming;
	/** Tests only: throw right after the named step of the fleet transaction. */
	readonly failAfter?: WriterStep;
	/** Each report line as it is made, so a run that throws has printed it. */
	readonly onLine?: (line: ReportLine) => void;
}

function writerFields(writer: WriterReport): Record<string, unknown> {
	return {
		writerSteps: writer.durations,
		databaseBytesAtCommit: writer.databaseBytes,
		databaseGrowthBytes: writer.databaseGrowthBytes,
		walBytes: writer.walBytes,
		migrationsApplied: writer.migrationsApplied,
		mediaRowsBackfilled: writer.mediaRowsBackfilled,
		appsWritten: writer.appsWritten,
		noticesWritten: writer.noticesWritten,
	};
}

/** One run of the migrate script. */
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
	const reader = options.reader ?? storageMediaReader;
	if (mode === "prove-media-read") {
		const result = await proveMediaRead(
			await readReadyMediaRows(db),
			reader,
			options.proveTiming ?? PROVE_MEDIA_READ_TIMING,
		);
		report.line("media-read", { result });
		return finish(
			report,
			result === "failed"
				? { outcome: "stopped", stoppedBy: ["error"], errorClass: "media-read" }
				: { outcome: "ok" },
		);
	}
	const ledger = await readMigrationLedger(db);
	if (ledger.validatedApplied) {
		report.line("fleet", { ledger });
		return finish(report, { outcome: "already-applied" });
	}
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
	const fleet = await readPlannedFleet(db, { reader });
	fleetLine(report, fleet, {
		planMilliseconds: Math.round(performance.now() - planStarted),
		ledger,
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
	if (!ledgerIsReviewed(ledger)) {
		return finish(report, { outcome: "stopped", stoppedBy: ["ledger"] });
	}
	let writer: WriterReport;
	try {
		writer = await runFleetTransaction(db, {
			mode,
			input: { plan: fleet.plan, targets: fleet.targets },
			...(options.failAfter !== undefined && { failAfter: options.failAfter }),
		});
	} catch (error) {
		if (!(error instanceof CutoverStoppedError)) throw error;
		if (error.code === "already-applied")
			return finish(report, { outcome: "already-applied" });
		return finish(report, { outcome: "stopped", stoppedBy: [error.code] });
	}
	report.line("writer", writerFields(writer));
	return finish(report, { outcome: "ok" });
}

export interface ScanOptions {
	readonly appId?: string;
	/** Each report line as it is made, so a run that throws has printed it. */
	readonly onLine?: (line: ReportLine) => void;
}

/**
 * One run of the scan: plain `SELECT`s in one read-only snapshot, and no media
 * byte read. It stops where `--execute` would on a blocker or any holder.
 */
export async function runScan(
	db: Kysely<AppDatabase>,
	options: ScanOptions = {},
): Promise<RunResult> {
	const report = new CutoverReport("scan", options.onLine);
	return reported(report, async () => {
		const ledger = await readMigrationLedger(db);
		if (ledger.validatedApplied) {
			report.line("fleet", { ledger });
			return finish(report, { outcome: "already-applied" });
		}
		const planStarted = performance.now();
		const fleet = await readPlannedFleet(db, {
			reader: null,
			...(options.appId !== undefined && { appId: options.appId }),
		});
		fleetLine(report, fleet, {
			planMilliseconds: Math.round(performance.now() - planStarted),
			ledger,
		});
		planSections(report, fleet);
		const stoppedBy = planStops(fleet);
		return finish(
			report,
			stoppedBy.length === 0
				? { outcome: "ok" }
				: { outcome: "stopped", stoppedBy },
		);
	});
}

/**
 * `--app <id> --debug-details`: one app's blockers with the uses each
 * platform can't run and the source's gate findings with their messages, and
 * its planned notice lines with names. For the operator's terminal only.
 */
export async function runDebugDetails(
	db: Kysely<AppDatabase>,
	appId: string,
): Promise<readonly string[]> {
	const fleet = await readPlannedFleet(db, { appId, reader: null });
	const source = fleet.sources.find((app) => app.appId === appId);
	const lookup = source && fleet.lookupContexts.get(source.projectId);
	const findings: { code: string; message: string; where: string }[] = [];
	if (source !== undefined && lookup !== undefined) {
		for (const use of unavailableUses(source.doc, PLATFORMS)) {
			findings.push({
				code: use.feature,
				message: "a use one platform can't run",
				where: JSON.stringify(use.owner),
			});
		}
		const verdict = mutationCommitVerdict(source.doc, [], lookup);
		if (!verdict.ok) {
			for (const finding of verdict.findings) {
				findings.push({
					code: finding.code,
					message: finding.message,
					where: JSON.stringify(finding.location),
				});
			}
		}
	}
	return debugDetails(fleet, appId, findings);
}
