/**
 * The case-writes cutover's content-free report (step 5's part 09, section
 * 10.3): JSON Lines in step 4's framing, each line
 * `{ report: "hq-round-trip-case-writes", mode, section, ... }`, one Cloud
 * Logging entry a line, each printed as soon as it is made, and always
 * ending in an `outcome` line, a run that throws included.
 *
 * A line holds app ids, deployment ids, migration names, step ids, change
 * kinds, codes, causes and counts only: never a name, a label, an
 * expression, a case type, a property, a domain or a value. The plan's
 * notice entries carry names, so only their reasons are counted; a
 * schema change names its case type, so only its cause is counted; a
 * deployment's domain and a design session's id are never printed.
 */

import type { HolderCensus } from "./holders";
import type { MigrationLedgerState } from "./ledger";
import { type PlacementCounts, UNHELD_CLASSES } from "./placements";
import type { PrivateWorkCensus } from "./source";
import {
	type AppPlan,
	BLOCKER_CODES,
	type BlockerCode,
	type CaseWritesCutoverPlan,
	compareText,
	type HeldUnit,
	type HoldSource,
	PATH_MOVE_CAUSES,
	type PlannedBaselineKind,
	REPORT,
	type RunMode,
	SCHEMA_CAUSES,
	SEMANTIC_STEPS,
	STOP_CODES,
	STRUCTURE_STEPS,
	type StopCode,
	WRITER_STEPS,
	type WriterStepId,
} from "./types";

export type ReportOutcome =
	| { readonly outcome: "ok" }
	| { readonly outcome: "already-applied" }
	| {
			readonly outcome: "stopped";
			readonly stoppedBy: readonly StopCode[];
			/** With `error`: what threw, content-free (`errorClassOf`). */
			readonly errorClass?: string;
	  };

export type ReportLine = Readonly<Record<string, unknown>> & {
	readonly report: typeof REPORT;
	readonly mode: RunMode;
	readonly section: string;
};

/**
 * The report's lines for one run, in the order it prints them. A script
 * passes a `sink` that prints each line as it is made, so a run that throws
 * has already printed every line before the throw.
 */
export class CutoverReport {
	private readonly lines: ReportLine[] = [];

	constructor(
		readonly mode: RunMode,
		private readonly sink?: (line: ReportLine) => void,
	) {}

	line(section: string, fields: Readonly<Record<string, unknown>>): void {
		const line: ReportLine = {
			report: REPORT,
			mode: this.mode,
			section,
			...fields,
		};
		this.lines.push(line);
		this.sink?.(line);
	}

	all(): readonly ReportLine[] {
		return this.lines;
	}

	/** Each line as one JSON object, as stdout carries it. */
	text(): string {
		return this.lines.map((line) => JSON.stringify(line)).join("\n");
	}
}

/**
 * What the report reads of one planned fleet: the plan, the fleet's counts,
 * each published app's placement counts (part 09 §8, which the plan keeps
 * only as held units), the holders and the private work.
 */
export interface ReportFleet {
	readonly plan: Pick<CaseWritesCutoverPlan, "apps" | "digest">;
	readonly appsInFleet: number;
	readonly deletedApps: number;
	readonly fleetSeqDigest: string;
	readonly databaseBytes: number;
	/** By app id; an app with no entry counts nothing unheld or checked. */
	readonly placementCounts: ReadonlyMap<string, PlacementCounts>;
	readonly holders: HolderCensus;
	readonly privateWork: PrivateWorkCensus;
}

// ─── Counting helpers ─────────────────────────────────────────────────────

/** Every key of `keys` with its count, zero included, in the given order. */
function zeroFilled<K extends string>(
	keys: readonly K[],
	values: Iterable<K>,
): Record<K, number> {
	const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
		K,
		number
	>;
	for (const value of values) counts[value] += 1;
	return counts;
}

function sortedUnique(values: Iterable<string>): string[] {
	return [...new Set(values)].sort(compareText);
}

/** The sum of one detail count over the changes of one step and kind. */
function detailSum(
	apps: readonly AppPlan[],
	step: string,
	kind: string,
	key: string,
): number {
	let sum = 0;
	for (const app of apps)
		for (const change of app.changes)
			if (change.step === step && change.kind === kind)
				sum += change.detail[key] ?? 0;
	return sum;
}

/** Per change kind of one step: the apps, the entities and the changes. */
function stepKinds(apps: readonly AppPlan[], step: string) {
	const kinds = new Map<
		string,
		{ apps: Set<string>; entities: Set<string>; changes: number }
	>();
	const stepApps = new Set<string>();
	const stepEntities = new Set<string>();
	let stepChanges = 0;
	for (const app of apps) {
		for (const change of app.changes) {
			if (change.step !== step) continue;
			const kind = kinds.get(change.kind) ?? {
				apps: new Set<string>(),
				entities: new Set<string>(),
				changes: 0,
			};
			const entity = `${app.appId}|${change.entityUuid ?? ""}`;
			kind.apps.add(app.appId);
			kind.entities.add(entity);
			kind.changes += 1;
			kinds.set(change.kind, kind);
			stepApps.add(app.appId);
			stepEntities.add(entity);
			stepChanges += 1;
		}
	}
	return {
		step,
		apps: stepApps.size,
		entities: stepEntities.size,
		changes: stepChanges,
		kinds: [...kinds]
			.sort(([a], [b]) => compareText(a, b))
			.map(([kind, total]) => ({
				kind,
				apps: total.apps.size,
				entities: total.entities.size,
				changes: total.changes,
			})),
	};
}

// ─── The lines ────────────────────────────────────────────────────────────

/** What the caller measured before any write, for the `fleet` line. */
export interface FleetMeasurements {
	readonly ledger: MigrationLedgerState;
	readonly planMilliseconds: number;
}

/**
 * The `fleet` line: the fleet's counts, the plan's digest (null in the
 * scan, which prints none), the sequence digest, the migration ledger, the
 * plan's milliseconds, the run's peak memory and the database's size.
 */
export function fleetLine(
	report: CutoverReport,
	fleet: ReportFleet,
	measured: FleetMeasurements,
): void {
	const apps = fleet.plan.apps;
	report.line("fleet", {
		apps: fleet.appsInFleet,
		appsDeleted: fleet.deletedApps,
		appsPlanned: apps.length,
		appsChanged: apps.filter(
			(app) => app.targetDigest !== null && app.changes.length > 0,
		).length,
		appsBlocked: apps.filter((app) => app.blockers.length > 0).length,
		planDigest: report.mode === "scan" ? null : fleet.plan.digest,
		fleetSeqDigest: fleet.fleetSeqDigest,
		ledger: {
			horizonApplied: measured.ledger.horizonApplied,
			pendingMigrations: [...measured.ledger.pendingMigrations],
		},
		planMilliseconds: measured.planMilliseconds,
		peakRssBytes: process.resourceUsage().maxRSS * 1024,
		databaseBytes: fleet.databaseBytes,
	});
}

/** Every section a run that built a plan prints, between `fleet` and
 *  `writer`, in section 10.3's order. */
export function planSections(report: CutoverReport, fleet: ReportFleet): void {
	structureLine(report, fleet);
	stepsLine(report, fleet);
	placementsLine(report, fleet);
	pathMovesLine(report, fleet);
	noticeLine(report, fleet);
	schemaLine(report, fleet);
	holdersLine(report, fleet);
	privateWorkLine(report, fleet);
	blockerLines(report, fleet);
}

/**
 * `structure`: per structure step and change kind, the apps, entities and
 * changes; the case list media M4 deleted (each `icon` and `audioLabel`
 * counted); and the translation overlay entries M5 moved.
 */
function structureLine(report: CutoverReport, fleet: ReportFleet): void {
	const apps = fleet.plan.apps;
	report.line("structure", {
		steps: STRUCTURE_STEPS.map((step) => stepKinds(apps, step)),
		deadCaseListMedia:
			detailSum(apps, "renamed-concepts", "dead-case-list-media", "icon") +
			detailSum(apps, "renamed-concepts", "dead-case-list-media", "audioLabel"),
		overlayEntriesMoved: detailSum(
			apps,
			"renamed-concepts",
			"case-list-registration-form",
			"translations",
		),
	});
}

/**
 * `steps`: per semantic step and change kind, the apps, entities and
 * changes, and the carried creates of no extension relationship apart.
 */
function stepsLine(report: CutoverReport, fleet: ReportFleet): void {
	const apps = fleet.plan.apps;
	const nonExtension = apps.flatMap((app) =>
		app.changes
			.filter(
				(change) =>
					change.step === "extension-children" &&
					change.kind === "non-extension-carried-create",
			)
			.map(() => app.appId),
	);
	report.line("steps", {
		steps: SEMANTIC_STEPS.map((step) => stepKinds(apps, step)),
		nonExtensionCarriedCreates: {
			apps: sortedUnique(nonExtension),
			creates: nonExtension.length,
		},
	});
}

const BASELINE_KINDS: readonly PlannedBaselineKind[] = [
	"readable",
	"shell",
	"unread",
	"absent",
	"unreadable",
];
const HELD_TARGETS: readonly HeldUnit["target"][] = [
	"case-operation",
	"own-close",
	"query-repeat",
];
const HOLD_SOURCES: readonly HoldSource[] = ["carried", "unknown-baseline"];

/**
 * `placements`: the published apps, their deployments by baseline kind, the
 * units held by target and by why, the units left unheld by section 8.5's
 * class, and the frozen check's deployments and disagreements.
 */
function placementsLine(report: CutoverReport, fleet: ReportFleet): void {
	const apps = fleet.plan.apps;
	const published = apps.filter((app) => app.deployments.length > 0);
	const held = apps.flatMap((app) => app.held);
	const unheld = zeroFilled(UNHELD_CLASSES, []);
	let frozenChecked = 0;
	let frozenDisagrees = 0;
	for (const app of apps) {
		const counts = fleet.placementCounts.get(app.appId);
		if (counts === undefined) continue;
		for (const unheldClass of UNHELD_CLASSES)
			unheld[unheldClass] += counts.unheld[unheldClass];
		frozenChecked += counts.frozenChecked;
		frozenDisagrees += counts.frozenDisagrees;
	}
	report.line("placements", {
		publishedApps: published.length,
		deployments: zeroFilled(
			BASELINE_KINDS,
			published.flatMap((app) =>
				app.deployments.map((deployment) => deployment.baseline),
			),
		),
		heldByTarget: zeroFilled(
			HELD_TARGETS,
			held.map((unit) => unit.target),
		),
		heldBySource: zeroFilled(
			HOLD_SOURCES,
			held.map((unit) => unit.source),
		),
		appsHolding: sortedUnique(
			apps.filter((app) => app.held.length > 0).map((app) => app.appId),
		),
		unheld,
		frozenChecked,
		frozenDisagrees,
	});
}

/**
 * `path-moves`: per cause, the deployments whose next publish moves a case
 * block or answer path for it and the forms that move on those
 * deployments; then the totals.
 */
function pathMovesLine(report: CutoverReport, fleet: ReportFleet): void {
	const moves = fleet.plan.apps.flatMap((app) => app.pathMoves);
	report.line("path-moves", {
		causes: PATH_MOVE_CAUSES.map((cause) => {
			const named = moves.filter((move) => move.causes.includes(cause));
			return {
				cause,
				deployments: named.length,
				forms: named.reduce((sum, move) => sum + move.forms, 0),
			};
		}),
		deployments: sortedUnique(moves.map((move) => move.deploymentId)),
		forms: moves.reduce((sum, move) => sum + move.forms, 0),
	});
}

/** `notice`: per reason and kind of entry, the entries and the apps. */
function noticeLine(report: CutoverReport, fleet: ReportFleet): void {
	const totals = new Map<
		string,
		{ kind: string; reason: string; entries: number; apps: Set<string> }
	>();
	for (const app of fleet.plan.apps) {
		for (const entry of app.notice) {
			const key = `${entry.kind}|${entry.reason}`;
			const total = totals.get(key) ?? {
				kind: entry.kind,
				reason: entry.reason,
				entries: 0,
				apps: new Set<string>(),
			};
			total.entries += 1;
			total.apps.add(app.appId);
			totals.set(key, total);
		}
	}
	report.line("notice", {
		reasons: [...totals]
			.sort(([a], [b]) => compareText(a, b))
			.map(([, total]) => ({
				kind: total.kind,
				reason: total.reason,
				entries: total.entries,
				apps: total.apps.size,
			})),
		appsWithNotice: fleet.plan.apps.filter((app) => app.notice.length > 0)
			.length,
	});
}

/**
 * `schema`: per section 12 cause, the apps, case types and properties; and
 * what the drift scan will count against the stored rows once the window
 * has run, which is exactly the planned differences, since `judge-target`
 * refuses any other (`case-schema-unplanned`).
 */
function schemaLine(report: CutoverReport, fleet: ReportFleet): void {
	const changes = fleet.plan.apps.flatMap((app) =>
		app.schemaChanges.map((change) => ({ appId: app.appId, change })),
	);
	report.line("schema", {
		causes: SCHEMA_CAUSES.map((cause) => {
			const named = changes.filter(({ change }) => change.cause === cause);
			return {
				cause,
				apps: sortedUnique(named.map(({ appId }) => appId)).length,
				caseTypes: new Set(
					named.map(({ appId, change }) => `${appId}|${change.caseType}`),
				).size,
				properties: named.reduce(
					(sum, { change }) => sum + change.properties,
					0,
				),
			};
		}),
		driftScan: {
			apps: sortedUnique(changes.map(({ appId }) => appId)),
			caseTypes: new Set(
				changes.map(({ appId, change }) => `${appId}|${change.caseType}`),
			).size,
		},
	});
}

/**
 * `holders`: every holder the fleet holds, by what can be done about it:
 * apps by id, design sessions by count.
 */
function holdersLine(report: CutoverReport, fleet: ReportFleet): void {
	const holders = fleet.holders;
	report.line("holders", {
		live: holders.liveApps.length + holders.liveSessions.length,
		liveApps: [...holders.liveApps],
		liveSessions: holders.liveSessions.length,
		lapsedOrPaused:
			holders.settleableApps.length + holders.settleableSessions.length,
		lapsedOrPausedApps: [...holders.settleableApps],
		lapsedOrPausedSessions: holders.settleableSessions.length,
		unsettledHolds:
			holders.unsettledApps.length + holders.unsettledSessions.length,
		unsettledApps: [...holders.unsettledApps],
		unsettledSessions: holders.unsettledSessions.length,
	});
}

/** `private-work`: what the fleet transaction abandons and archives, and
 *  the apps whose notice says so. */
function privateWorkLine(report: CutoverReport, fleet: ReportFleet): void {
	const work = fleet.privateWork;
	report.line("private-work", {
		openWorkspaces: work.openWorkspaces,
		openChangeSets: work.openChangeSets,
		activeCandidates: work.activeCandidates,
		preAppSessions: work.endingSessions.length,
		mutationEvents: work.mutationEvents,
		apps: fleet.plan.apps
			.filter((app) => app.discardsPrivateWork)
			.map((app) => app.appId),
	});
}

/** One `blocker` line per code met, in the registry's order: its count,
 *  its apps and its finding codes. */
function blockerLines(report: CutoverReport, fleet: ReportFleet): void {
	const totals = new Map<
		BlockerCode,
		{ count: number; apps: string[]; findingCodes: Set<string> }
	>();
	for (const app of fleet.plan.apps) {
		for (const blocker of app.blockers) {
			const total = totals.get(blocker.code) ?? {
				count: 0,
				apps: [],
				findingCodes: new Set<string>(),
			};
			total.count += blocker.count;
			total.apps.push(app.appId);
			for (const code of blocker.findingCodes) total.findingCodes.add(code);
			totals.set(blocker.code, total);
		}
	}
	for (const code of BLOCKER_CODES) {
		const total = totals.get(code);
		if (total === undefined) continue;
		report.line("blocker", {
			code,
			count: total.count,
			apps: sortedUnique(total.apps),
			findingCodes: sortedUnique(total.findingCodes),
		});
	}
}

/** What the writer measured, for the `writer` line (`--rehearse` and
 *  `--execute`). */
export interface WriterMeasurements {
	/** Each step's milliseconds; a step the run did not reach is absent. */
	readonly stepMilliseconds: Readonly<Partial<Record<WriterStepId, number>>>;
	readonly walBytes: number;
	readonly databaseGrowthBytes: number;
	readonly migrationsApplied: readonly string[];
}

/** The `writer` line: each writer step's milliseconds, in step order, the
 *  WAL and growth, and the migrations applied. */
export function writerLine(
	report: CutoverReport,
	measured: WriterMeasurements,
): void {
	report.line("writer", {
		steps: WRITER_STEPS.flatMap((step) => {
			const milliseconds = measured.stepMilliseconds[step];
			return milliseconds === undefined ? [] : [{ step, milliseconds }];
		}),
		walBytes: measured.walBytes,
		databaseGrowthBytes: measured.databaseGrowthBytes,
		migrationsApplied: [...measured.migrationsApplied],
	});
}

/** The `outcome` line, last. */
export function outcomeLine(
	report: CutoverReport,
	outcome: ReportOutcome,
): void {
	report.line("outcome", { ...outcome });
}

// ─── A run that throws ────────────────────────────────────────────────────

const STOP_CODE_SET: ReadonlySet<string> = new Set(STOP_CODES);
const SQL_STATE = /^[0-9A-Z]{5}$/;

/**
 * The content-free class of what threw: this cutover's own stop (an error
 * whose `code` is a stop code, as `ledger.ts`'s errors carry), a catalog
 * object the cutover proves missing, the SQLSTATE of a database error (its
 * text can quote a row, so it is never kept), or `internal`.
 */
export function errorClassOf(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as { code?: unknown }).code;
		if (
			error.name.startsWith("Cutover") &&
			typeof code === "string" &&
			STOP_CODE_SET.has(code)
		)
			return code;
		if (error.name === "CatalogObjectMissingError") return "catalog";
	}
	for (
		let cursor: unknown = error, depth = 0;
		cursor !== null && typeof cursor === "object" && depth < 8;
		cursor = (cursor as { cause?: unknown }).cause, depth++
	) {
		const code = (cursor as { code?: unknown }).code;
		if (typeof code === "string" && SQL_STATE.test(code))
			return `database-${code}`;
	}
	return "internal";
}

/**
 * Run `body`, and whatever it throws, end the report with an `outcome` line
 * naming the error's class before the error leaves. A body that returns
 * prints its own outcome.
 */
export async function reported<T>(
	report: CutoverReport,
	body: () => Promise<T>,
): Promise<T> {
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
