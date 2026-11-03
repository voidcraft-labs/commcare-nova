/**
 * The modes of the case-writes cutover's two scripts (step 5's part 09,
 * sections 6, 10.3 and 13): their arguments, and what each mode does against
 * a database handle, returning its report. The scripts parse, call these and
 * print; the tests call them with their own database, or with their own
 * readers and writer in place of the database (`RunDependencies`).
 *
 * Every mode first reads the migration ledger and counts the apps carrying
 * this cutover's marker (`ledger.ts::readMigrationLedger`,
 * `readMarkerCount`): the horizon migration present with every app marked
 * prints `already-applied` and exits 0; any state between that and neither
 * present stops as `partially-applied`; neither present goes on.
 *
 *   scan                 the plan over one `REPEATABLE READ, READ ONLY`
 *                        snapshot of plain `SELECT`s, with no digest
 *   scan --app           the same for one app
 *   scan --debug-details one app's blocker places and planned changes with
 *                        names, for the operator's terminal only
 *   dry run              the full plan, the report and `planDigest`; writes
 *                        nothing and applies no DDL
 *   --settle-holders     every lapsed or paused holder settled through the
 *                        production reapers, then the holders counted again
 *   --rehearse           the whole fleet transaction, ending in its sentinel
 *                        rollback
 *   --execute            the plan, refused with nothing written on another
 *                        digest than the expected one, written and committed
 */

import { Command, Option } from "commander";
import type { Kysely } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import {
	type HolderCensus,
	holderCensusIsEmpty,
	readHolderCensus,
	type SettleOutcome,
	settleHolders,
} from "./holders";
import {
	CutoverLedgerError,
	CutoverLockTimeoutError,
	CutoverPartiallyAppliedError,
	classifyApplied,
	ledgerIsReviewed,
	type MarkerCount,
	type MigrationLedgerState,
	partiallyApplied,
	readMarkerCount,
	readMigrationLedger,
	unexpectedLedger,
} from "./ledger";
import { type PlannedFleet, planFleet, planHasBlockers } from "./plan";
import {
	CutoverReport,
	errorClassOf,
	fleetLine,
	outcomeLine,
	planSections,
	type ReportLine,
	type ReportOutcome,
	writerLine,
} from "./report";
import { type FleetSource, readFleetSourceSnapshot } from "./source";
import {
	CUTOVER,
	type CutoverBlocker,
	PENDING_MIGRATIONS,
	type RunMode,
	type StopCode,
	type WriterStepId,
} from "./types";
import {
	CutoverAlreadyAppliedError,
	CutoverPostconditionError,
	CutoverStoppedError,
	digestRefusal,
	runFleetTransaction,
	type WriterOptions,
	type WriterReport,
} from "./writer";

// ─── What a run reads and writes through ──────────────────────────────────

/**
 * Every read and write a mode makes, so a test can stand in for the
 * database. The scripts use `PRODUCTION_DEPENDENCIES`.
 */
export interface RunDependencies {
	readonly readLedger: (
		db: Kysely<AppDatabase>,
	) => Promise<MigrationLedgerState>;
	readonly readMarkers: (db: Kysely<AppDatabase>) => Promise<MarkerCount>;
	/** The fleet read in one `REPEATABLE READ, READ ONLY` snapshot. */
	readonly readSource: (
		db: Kysely<AppDatabase>,
		options: { readonly appId?: string },
	) => Promise<FleetSource>;
	/** The holders, read in a snapshot of their own after settling. */
	readonly readHolders: (db: Kysely<AppDatabase>) => Promise<HolderCensus>;
	readonly settleHolders: () => Promise<SettleOutcome>;
	readonly runWriter: (
		db: Kysely<AppDatabase>,
		options: WriterOptions,
	) => Promise<WriterReport>;
}

export const PRODUCTION_DEPENDENCIES: RunDependencies = {
	readLedger: readMigrationLedger,
	readMarkers: readMarkerCount,
	readSource: readFleetSourceSnapshot,
	readHolders: (db) =>
		db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute((tx) => readHolderCensus(tx)),
	settleHolders: () => settleHolders(),
	runWriter: runFleetTransaction,
};

// ─── Arguments (section 6) ────────────────────────────────────────────────

/** The modes of the migrate script. */
export type MigrateMode = Exclude<RunMode, "scan">;

/** A plan digest as the dry run prints it: SHA-256 in lowercase hex. */
const PLAN_DIGEST = /^[0-9a-f]{64}$/;

const JOB = `commcare-nova-${CUTOVER}`;
const RUNBOOK = "docs/plans/hq-round-trip/5-cutover-runbook.md";

export interface MigrateArguments {
	readonly settleHolders?: boolean;
	readonly rehearse?: boolean;
	readonly execute?: boolean;
	readonly expectPlanDigest?: string;
}

export type MigrateInvocation =
	| { readonly ok: true; readonly mode: "dry-run" | "settle-holders" }
	| { readonly ok: true; readonly mode: "rehearse" }
	| {
			readonly ok: true;
			readonly mode: "execute";
			readonly expectPlanDigest: string;
	  }
	| { readonly ok: false; readonly message: string };

/** The migrate script's arguments, as commander reads them. Each mode
 *  conflicts with the other two. */
export function migrateCommand(): Command {
	return new Command()
		.name("migrate-hq-round-trip-case-writes")
		.description(
			"Run the HQ round-trip case-writes cutover: the dry run by default, or one of its explicit modes.",
		)
		.addOption(
			new Option(
				"--settle-holders",
				"settle every lapsed or paused run holder through the production reapers, then stop",
			).conflicts(["rehearse", "execute"]),
		)
		.addOption(
			new Option(
				"--rehearse",
				"local databases only: run the whole write, the ledger inside it, then roll it all back",
			).conflicts(["settleHolders", "execute"]),
		)
		.addOption(
			new Option(
				"--execute",
				"write and commit, the ledger in the same transaction, when the plan's digest is the expected one",
			).conflicts(["settleHolders", "rehearse"]),
		)
		.option(
			"--expect-plan-digest <sha256>",
			"with --execute, the planDigest the dry run printed",
		)
		.addHelpText(
			"after",
			`\nWith no option it runs the dry run, which writes nothing and applies no DDL. Production runs only through the Job ${JOB}, by ${RUNBOOK}. There is no --prod writer.\n`,
		);
}

/** The mode the migrate script's arguments name, or why they name none. */
export function migrateInvocationOf(
	options: MigrateArguments,
): MigrateInvocation {
	if (options.execute === true) {
		const digest = options.expectPlanDigest;
		if (digest === undefined)
			return {
				ok: false,
				message:
					"--execute writes only the plan a dry run printed, so it needs --expect-plan-digest <sha256> with that run's planDigest.",
			};
		if (!PLAN_DIGEST.test(digest))
			return {
				ok: false,
				message: `--expect-plan-digest takes the planDigest a dry run printed, 64 lowercase hex characters, and ${JSON.stringify(digest)} is not one. Copy it from the dry run's fleet line.`,
			};
		return { ok: true, mode: "execute", expectPlanDigest: digest };
	}
	if (options.expectPlanDigest !== undefined)
		return {
			ok: false,
			message:
				"--expect-plan-digest is read only by --execute, so this run would ignore it. Add --execute to write that plan, or leave the digest out for a dry run.",
		};
	if (options.settleHolders === true)
		return { ok: true, mode: "settle-holders" };
	if (options.rehearse === true) return { ok: true, mode: "rehearse" };
	return { ok: true, mode: "dry-run" };
}

export interface ScanArguments {
	readonly prod?: boolean;
	readonly app?: string;
	readonly debugDetails?: boolean;
}

export type ScanInvocation =
	| {
			readonly ok: true;
			readonly prod: boolean;
			readonly appId?: string;
			readonly debugDetails: boolean;
	  }
	| { readonly ok: false; readonly message: string };

/** The scan script's arguments, as commander reads them. */
export function scanCommand(): Command {
	return new Command()
		.name("scan-hq-round-trip-case-writes")
		.description(
			"Report what the HQ round-trip case-writes cutover would change, every blocker and every holder, from the database alone. Never writes.",
		)
		.option("--prod", "scan production through the read-only operator identity")
		.option("--app <appId>", "scope the scan to one app")
		.option(
			"--debug-details",
			"with --app, print that app's blocker places and planned changes with names; never for output that leaves your terminal",
		)
		.addHelpText(
			"after",
			`\nProduction writes run only through the Job ${JOB}, by ${RUNBOOK}.\n`,
		);
}

/** What the scan script's arguments ask for, or why they ask for nothing. */
export function scanInvocationOf(options: ScanArguments): ScanInvocation {
	if (options.app !== undefined && options.app.trim() === "")
		return {
			ok: false,
			message:
				"--app takes the id of one app, and it was given an empty one. Pass the app's id, or leave --app out to scan every app.",
		};
	if (options.debugDetails === true && options.app === undefined)
		return {
			ok: false,
			message:
				"--debug-details prints one app's blocker places and names, so it needs --app <appId> naming that app.",
		};
	return {
		ok: true,
		prod: options.prod === true,
		...(options.app !== undefined && { appId: options.app }),
		debugDetails: options.debugDetails === true,
	};
}

// ─── Results ──────────────────────────────────────────────────────────────

export interface RunResult {
	readonly report: CutoverReport;
	readonly outcome: ReportOutcome;
	/** 1 when a blocker, a holder, a refusal or an error stopped the run. */
	readonly exitCode: 0 | 1;
	/**
	 * A sentence for stderr where the run refused or stopped without
	 * throwing (a wrong digest, an unreviewed ledger, a check under the
	 * writer's locks): ids, digests, counts and migration names only.
	 */
	readonly refusal?: string;
}

function finish(
	report: CutoverReport,
	outcome: ReportOutcome,
	refusal?: string,
): RunResult {
	outcomeLine(report, outcome);
	return {
		report,
		outcome,
		exitCode: outcome.outcome === "stopped" ? 1 : 0,
		...(refusal !== undefined && { refusal }),
	};
}

/** The class `report.ts::errorClassOf` gives, with a failed postcondition
 *  named as one. */
function runErrorClassOf(error: unknown): string {
	return error instanceof CutoverPostconditionError
		? "postcondition"
		: errorClassOf(error);
}

/** The errors whose messages are this cutover's own, naming ids, digests,
 *  counts and migration names only. */
function isOwnError(error: unknown): error is Error {
	return (
		error instanceof CutoverPostconditionError ||
		error instanceof CutoverStoppedError ||
		error instanceof CutoverAlreadyAppliedError ||
		error instanceof CutoverLedgerError ||
		error instanceof CutoverLockTimeoutError ||
		error instanceof CutoverPartiallyAppliedError
	);
}

/**
 * The terminal's account of what threw: this cutover's own message, or for
 * anything else its class alone, since a database error's text can quote
 * stored content.
 */
export function errorTextOf(error: unknown): string {
	const errorClass = runErrorClassOf(error);
	if (isOwnError(error) && error.message !== "")
		return `The cutover stopped (${errorClass}): ${error.message}`;
	return `The cutover stopped on an error of class ${errorClass}. Its text is not printed, because a database error can quote stored content. Reproduce it against a restored copy of the database to read it.`;
}

/** `report.ts::reported`, with a failed postcondition named by its own
 *  class: whatever throws still ends the report with an `outcome` line. */
async function reportedRun(
	report: CutoverReport,
	body: () => Promise<RunResult>,
): Promise<RunResult> {
	try {
		return await body();
	} catch (error) {
		outcomeLine(report, {
			outcome: "stopped",
			stoppedBy: ["error"],
			errorClass: runErrorClassOf(error),
		});
		throw error;
	}
}

// ─── The reads every mode makes first ─────────────────────────────────────

type AppliedCheck =
	| { readonly goOn: true; readonly ledger: MigrationLedgerState }
	| { readonly goOn: false; readonly result: RunResult };

/** The ledger and the marker count, and what they decide (section 6). A run
 *  that does not go on prints its `fleet` line with the two reads alone. */
async function checkApplied(
	db: Kysely<AppDatabase>,
	report: CutoverReport,
	deps: RunDependencies,
): Promise<AppliedCheck> {
	const ledger = await deps.readLedger(db);
	const markers = await deps.readMarkers(db);
	const state = classifyApplied(ledger, markers);
	if (state === "go-on") return { goOn: true, ledger };
	report.line("fleet", {
		ledger: {
			horizonApplied: ledger.horizonApplied,
			pendingMigrations: [...ledger.pendingMigrations],
		},
		markers: { apps: markers.apps, marked: markers.marked },
	});
	return {
		goOn: false,
		result:
			state === "already-applied"
				? finish(report, { outcome: "already-applied" })
				: finish(
						report,
						{ outcome: "stopped", stoppedBy: ["partially-applied"] },
						partiallyApplied(ledger, markers).message,
					),
	};
}

/** The fleet read and the plan, with the `fleet` line and every plan
 *  section printed. */
async function planAndReport(
	db: Kysely<AppDatabase>,
	report: CutoverReport,
	deps: RunDependencies,
	ledger: MigrationLedgerState,
	appId?: string,
): Promise<PlannedFleet> {
	const started = performance.now();
	const fleet = planFleet(
		await deps.readSource(db, appId === undefined ? {} : { appId }),
	);
	fleetLine(report, fleet, {
		ledger,
		planMilliseconds: Math.round(performance.now() - started),
	});
	planSections(report, fleet);
	return fleet;
}

/** The stops every plan-building mode reads from the plan alone. */
function planStops(fleet: PlannedFleet): StopCode[] {
	return [
		...(planHasBlockers(fleet.plan) ? (["blocker"] as const) : []),
		...(holderCensusIsEmpty(fleet.holders) ? [] : (["holder"] as const)),
	];
}

// ─── The migrate script ───────────────────────────────────────────────────

export type MigrateOptions = (
	| { readonly mode: "dry-run" | "settle-holders" | "rehearse" }
	| { readonly mode: "execute"; readonly expectPlanDigest: string }
) & {
	/** Each report line as it is made, so a run that throws has printed it. */
	readonly onLine?: (line: ReportLine) => void;
	/** Tests only: throw right after the named step of the fleet transaction. */
	readonly failAfter?: WriterStepId;
	readonly dependencies?: RunDependencies;
};

/** One run of the migrate script. */
export async function runMigrate(
	db: Kysely<AppDatabase>,
	options: MigrateOptions,
): Promise<RunResult> {
	const report = new CutoverReport(options.mode, options.onLine);
	const deps = options.dependencies ?? PRODUCTION_DEPENDENCIES;
	return reportedRun(report, async () => {
		const applied = await checkApplied(db, report, deps);
		if (!applied.goOn) return applied.result;
		if (options.mode === "settle-holders")
			return settle(db, report, deps, applied.ledger);
		const fleet = await planAndReport(db, report, deps, applied.ledger);
		if (
			options.mode === "execute" &&
			fleet.plan.digest !== options.expectPlanDigest
		)
			return finish(
				report,
				{ outcome: "stopped", stoppedBy: ["digest"] },
				digestRefusal(fleet.plan.digest, options.expectPlanDigest).message,
			);
		const stoppedBy = planStops(fleet);
		if (stoppedBy.length > 0)
			return finish(report, { outcome: "stopped", stoppedBy });
		if (options.mode === "dry-run") return finish(report, { outcome: "ok" });
		if (!ledgerIsReviewed(applied.ledger))
			return finish(
				report,
				{ outcome: "stopped", stoppedBy: ["ledger"] },
				unexpectedLedger(PENDING_MIGRATIONS, applied.ledger.pendingMigrations)
					.message,
			);
		return write(db, report, deps, fleet, options);
	});
}

/** `--settle-holders`: the reapers, then the holders as they now stand. */
async function settle(
	db: Kysely<AppDatabase>,
	report: CutoverReport,
	deps: RunDependencies,
	ledger: MigrationLedgerState,
): Promise<RunResult> {
	report.line("fleet", {
		ledger: {
			horizonApplied: ledger.horizonApplied,
			pendingMigrations: [...ledger.pendingMigrations],
		},
	});
	const settled = await deps.settleHolders();
	const census = await deps.readHolders(db);
	report.line("holders", {
		settledApps: settled.appsSettled,
		settledSessions: settled.sessionsSettled,
		settleFailed: settled.failed,
		live: census.liveApps.length + census.liveSessions.length,
		liveApps: [...census.liveApps],
		liveSessions: census.liveSessions.length,
		lapsedOrPaused:
			census.settleableApps.length + census.settleableSessions.length,
		lapsedOrPausedApps: [...census.settleableApps],
		lapsedOrPausedSessions: census.settleableSessions.length,
		unsettledHolds:
			census.unsettledApps.length + census.unsettledSessions.length,
		unsettledApps: [...census.unsettledApps],
		unsettledSessions: census.unsettledSessions.length,
	});
	return finish(report, { outcome: "ok" });
}

/** `--rehearse` and `--execute`: the fleet transaction, its refusals under
 *  its locks read as this run's outcome. */
async function write(
	db: Kysely<AppDatabase>,
	report: CutoverReport,
	deps: RunDependencies,
	fleet: PlannedFleet,
	options: MigrateOptions,
): Promise<RunResult> {
	const input = { plan: fleet.plan, writes: fleet.writes };
	const failAfter =
		options.failAfter === undefined ? {} : { failAfter: options.failAfter };
	let writer: WriterReport;
	try {
		writer = await deps.runWriter(
			db,
			options.mode === "execute"
				? {
						mode: "execute",
						expectPlanDigest: options.expectPlanDigest,
						input,
						...failAfter,
					}
				: { mode: "rehearse", input, ...failAfter },
		);
	} catch (error) {
		if (error instanceof CutoverAlreadyAppliedError)
			return finish(report, { outcome: "already-applied" }, error.message);
		if (
			error instanceof CutoverStoppedError ||
			error instanceof CutoverPartiallyAppliedError ||
			error instanceof CutoverLedgerError ||
			error instanceof CutoverLockTimeoutError
		)
			return finish(
				report,
				{ outcome: "stopped", stoppedBy: [error.code] },
				error.message,
			);
		throw error;
	}
	writerLine(report, writer);
	return finish(report, { outcome: "ok" });
}

// ─── The scan script ──────────────────────────────────────────────────────

export interface ScanOptions {
	readonly appId?: string;
	/** Each report line as it is made, so a run that throws has printed it. */
	readonly onLine?: (line: ReportLine) => void;
	readonly dependencies?: RunDependencies;
}

/**
 * One run of the scan: plain `SELECT`s in one read-only snapshot, so a role
 * holding only `SELECT` runs it. It prints no digest, and stops where the
 * dry run would on a blocker or any holder.
 */
export async function runScan(
	db: Kysely<AppDatabase>,
	options: ScanOptions = {},
): Promise<RunResult> {
	const report = new CutoverReport("scan", options.onLine);
	const deps = options.dependencies ?? PRODUCTION_DEPENDENCIES;
	return reportedRun(report, async () => {
		const applied = await checkApplied(db, report, deps);
		if (!applied.goOn) return applied.result;
		const fleet = await planAndReport(
			db,
			report,
			deps,
			applied.ledger,
			options.appId,
		);
		const stoppedBy = planStops(fleet);
		return finish(
			report,
			stoppedBy.length === 0
				? { outcome: "ok" }
				: { outcome: "stopped", stoppedBy },
		);
	});
}

// ─── --debug-details ──────────────────────────────────────────────────────

type NamedRecords = Readonly<Record<string, unknown>>;

function nameIn(
	records: unknown,
	uuid: string,
	key: "name" | "id",
): string | undefined {
	if (records === null || typeof records !== "object") return undefined;
	const record = (records as NamedRecords)[uuid];
	if (record === null || typeof record !== "object") return undefined;
	const value = (record as NamedRecords)[key];
	return typeof value === "string" ? value : undefined;
}

/** An entity's name in a document: a module's or form's name, a field's
 *  id. */
function entityName(
	doc: { modules?: unknown; forms?: unknown; fields?: unknown },
	uuid: string,
): string | undefined {
	return (
		nameIn(doc.modules, uuid, "name") ??
		nameIn(doc.forms, uuid, "name") ??
		nameIn(doc.fields, uuid, "id")
	);
}

function blockerText(blocker: CutoverBlocker): string[] {
	const lines = [
		`blocker ${blocker.code}: ${blocker.count} met${blocker.findingCodes.length === 0 ? "" : `, finding codes ${blocker.findingCodes.join(", ")}`}`,
	];
	for (const place of blocker.places ?? []) {
		const where =
			place.entity === undefined
				? "the app"
				: `${place.entity.kind} ${place.entity.uuid}${place.entity.name === undefined ? "" : ` ${JSON.stringify(place.entity.name)}`}`;
		lines.push(
			`  at ${where}${place.findingCode === undefined ? "" : `: ${place.findingCode}`}${place.message === undefined ? "" : ` ${JSON.stringify(place.message)}`}`,
		);
	}
	return lines;
}

/**
 * `--app <id> --debug-details`: that app's blockers with their places by
 * entity id and name and each finding's message, and its planned changes,
 * holds, path moves and notice entries with names. Plain text for the
 * operator's terminal only, never the report.
 */
export async function runDebugDetails(
	db: Kysely<AppDatabase>,
	appId: string,
	dependencies: RunDependencies = PRODUCTION_DEPENDENCIES,
): Promise<readonly string[]> {
	const ledger = await dependencies.readLedger(db);
	const markers = await dependencies.readMarkers(db);
	const state = classifyApplied(ledger, markers);
	if (state === "already-applied")
		return [
			`The cutover has already run: every app carries its horizon, so there is no plan for app ${appId} to detail.`,
		];
	if (state === "partially-applied")
		return [partiallyApplied(ledger, markers).message];
	const source = await dependencies.readSource(db, { appId });
	const sourceApp = source.apps.find((app) => app.appId === appId);
	if (sourceApp === undefined)
		return [
			`No app has id ${appId}, deleted ones included, so there is nothing to detail. Check the id against the scan's blocker lines.`,
		];
	const fleet = planFleet(source);
	const plan = fleet.plan.apps.find((app) => app.appId === appId);
	if (plan === undefined)
		throw new Error(
			`The plan holds no entry for app ${appId}, which the fleet read gave it. This is a defect of the cutover's plan.`,
		);
	const target = fleet.writes.get(appId)?.target;
	const named = (uuid: string | null): string => {
		if (uuid === null) return "the app";
		const name =
			(target === undefined ? undefined : entityName(target, uuid)) ??
			entityName(sourceApp.raw, uuid);
		return name === undefined ? uuid : `${uuid} ${JSON.stringify(name)}`;
	};
	const blockers = fleet.blockerPlaces.get(appId) ?? [];
	const lines = [
		`app ${appId}${plan.deleted ? " (deleted)" : ""}: base sequence ${plan.baseSeq}, ${blockers.length === 0 ? "no blocker" : `${blockers.length} blocker codes`}`,
		...blockers.flatMap(blockerText),
	];
	for (const change of plan.changes)
		lines.push(
			`change ${change.step} ${change.kind} on ${named(change.entityUuid)} ${JSON.stringify(change.detail)}`,
		);
	for (const held of plan.held)
		lines.push(
			held.target === "query-repeat"
				? `held ${JSON.stringify(held)} at question ${named(held.fieldUuid)}`
				: `held ${JSON.stringify(held)} in form ${named(held.formUuid)}`,
		);
	for (const move of plan.pathMoves)
		lines.push(
			`path move in deployment ${move.deploymentId}: ${move.forms} forms, ${move.causes.join(", ")}`,
		);
	for (const entry of plan.notice)
		lines.push(`notice ${JSON.stringify(entry)}`);
	for (const change of plan.schemaChanges)
		lines.push(
			`schema ${change.cause} on case type ${JSON.stringify(change.caseType)}: ${change.properties} properties`,
		);
	return lines;
}
