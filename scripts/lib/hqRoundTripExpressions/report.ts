import { type CensusVerdict, censusCounts, type FleetCensus } from "./census";
import { appDeploymentChanges, type PlannedFleet } from "./plan";
import {
	CUTOVER_BLOCKER_CODES,
	type CutoverBlockerCode,
	type CutoverStopCode,
	EXPRESSIONS_CHANGE_CLASSES,
	EXPRESSIONS_STEP_IDS,
} from "./types";

export const REPORT = "hq-round-trip-expressions";

export type ReportMode =
	| "scan"
	| "dry-run"
	| "rehearse"
	| "execute"
	| "settle-holders";

/**
 * Stops of a run, beside a blocker and §11's stops (`CutoverStopCode`): the
 * census's base half does not cover the fleet (`census-incomplete`) or read
 * other sequences (`census-stale`), and the run threw (`error`).
 */
export const RUN_STOP_CODES = [
	"census-incomplete",
	"census-stale",
	"error",
] as const;
export type RunStopCode = (typeof RUN_STOP_CODES)[number];

export type ReportOutcome =
	| { readonly outcome: "ok" }
	| { readonly outcome: "already-applied" }
	| {
			readonly outcome: "stopped";
			readonly stoppedBy: readonly (
				| "blocker"
				| CutoverStopCode
				| RunStopCode
			)[];
			/** With `error`: what threw, content-free (`./run.ts::errorClassOf`). */
			readonly errorClass?: string;
	  };

export type ReportLine = Readonly<Record<string, unknown>> & {
	readonly report: typeof REPORT;
	readonly mode: ReportMode;
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
		readonly mode: ReportMode,
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
 * The `fleet` line: the fleet's counts, the plan's digest, the sequence
 * digest the census compares, the database's size and the run's peak memory,
 * and whatever the caller measured before any write (the plan's
 * milliseconds, the migration ledger's state). It is printed as soon as the
 * plan is built; a writer's timings follow in their own `writer` line.
 */
export function fleetLine(
	report: CutoverReport,
	fleet: PlannedFleet,
	extra: Readonly<Record<string, unknown>> = {},
): void {
	report.line("fleet", {
		apps: fleet.appsInFleet,
		appsDeleted: fleet.deletedApps,
		appsPlanned: fleet.plan.apps.length,
		planDigest: fleet.plan.digest,
		fleetSeqDigest: fleet.fleetSeqDigest,
		databaseBytes: fleet.databaseBytes,
		peakRssBytes: process.resourceUsage().maxRSS * 1024,
		...extra,
	});
}

/** The reasons of changes that write nothing (part 09 §6), by kind of entry. */
const BEHAVIOR_DOCUMENT_REASONS = [
	"search-today-is-workers-day",
	"search-date-time-equality-matches",
	"date-time-comparison-compares-moments",
	"case-property-type-now-known",
	"unsaved-assistant-work-discarded",
] as const;
const BEHAVIOR_DEPLOYMENT_REASONS = [
	"expressions-sent-at-next-publish",
	"deep-links-need-republish",
] as const;

/** Every section a run that built a plan prints, between `fleet` and `outcome`. */
export function planSections(report: CutoverReport, fleet: PlannedFleet): void {
	stepsLine(report, fleet);
	behaviorLine(report, fleet);
	schemaLine(report, fleet);
	holdersLine(report, fleet);
	privateWorkLine(report, fleet);
	blockerLines(report, fleet);
}

/**
 * `steps`: per step and class, the apps it changed and its changes; and per
 * notice reason the steps write, the apps and entries the notices will hold.
 */
function stepsLine(report: CutoverReport, fleet: PlannedFleet): void {
	report.line("steps", {
		steps: EXPRESSIONS_STEP_IDS.map((step) => ({
			step,
			classes: (EXPRESSIONS_CHANGE_CLASSES[step] as readonly string[]).map(
				(name) => {
					const counts = fleet.apps.map(
						(app) =>
							app.classes.find(
								(entry) => entry.step === step && entry.class === name,
							)?.count ?? 0,
					);
					return {
						class: name,
						apps: counts.filter((count) => count > 0).length,
						changes: counts.reduce((sum, count) => sum + count, 0),
					};
				},
			),
		})),
		reasons: reasonTotals(
			fleet.plan.apps.map((app) =>
				app.changes
					.map((change) => change.reason as string)
					.filter(
						(reason) =>
							!(BEHAVIOR_DOCUMENT_REASONS as readonly string[]).includes(
								reason,
							),
					),
			),
		),
	});
}

/** Per reason: the apps that hold it and its entries, in first-seen order. */
function reasonTotals(
	perApp: readonly (readonly string[])[],
): { reason: string; apps: number; entries: number }[] {
	const totals = new Map<string, { apps: number; entries: number }>();
	for (const reasons of perApp) {
		const seen = new Set<string>();
		for (const reason of reasons) {
			const total = totals.get(reason) ?? { apps: 0, entries: 0 };
			total.entries += 1;
			if (!seen.has(reason)) total.apps += 1;
			seen.add(reason);
			totals.set(reason, total);
		}
	}
	return [...totals].map(([reason, total]) => ({ reason, ...total }));
}

/** `behavior`: per no-write reason, the apps and entries, and the deployments a deployment reason names. */
function behaviorLine(report: CutoverReport, fleet: PlannedFleet): void {
	report.line("behavior", {
		reasons: BEHAVIOR_DOCUMENT_REASONS.map((reason) => {
			const counts = fleet.plan.apps.map(
				(app) =>
					app.changes.filter((change) => change.reason === reason).length,
			);
			return {
				reason,
				apps: counts.filter((count) => count > 0).length,
				entries: counts.reduce((sum, count) => sum + count, 0),
			};
		}),
		deployments: BEHAVIOR_DEPLOYMENT_REASONS.map((reason) => {
			const apps: string[] = [];
			const deployments: string[] = [];
			for (const app of fleet.plan.apps) {
				const lines = appDeploymentChanges(app).filter(
					(line) => line.reason === reason,
				);
				if (lines.length > 0) apps.push(app.appId);
				deployments.push(...lines.map((line) => line.deploymentId));
			}
			return { reason, apps: apps.length, deployments };
		}),
	});
}

/**
 * `schema`: per planned schema change kind (its source and its types), how
 * many, in which apps, the stored values a declaration would make readable
 * again and the stored values a retype parks. No case type or property: both
 * are authored names.
 */
function schemaLine(report: CutoverReport, fleet: PlannedFleet): void {
	const kinds = new Map<
		string,
		{
			source: string;
			from: string | null;
			to: string;
			count: number;
			apps: Set<string>;
			storedValues: number;
			uncastable: number;
		}
	>();
	for (const app of fleet.apps) {
		for (const impact of app.schemaImpacts) {
			const { source, from, to } = impact.change;
			const key = JSON.stringify([source, from, to]);
			const kind = kinds.get(key) ?? {
				source,
				from,
				to,
				count: 0,
				apps: new Set<string>(),
				storedValues: 0,
				uncastable: 0,
			};
			kind.count += 1;
			kind.apps.add(app.appId);
			kind.storedValues += impact.storedValues;
			kind.uncastable += impact.uncastable;
			kinds.set(key, kind);
		}
	}
	report.line("schema", {
		changes: [...kinds.values()].map((kind) => ({
			source: kind.source,
			from: kind.from,
			to: kind.to,
			count: kind.count,
			apps: [...kind.apps].sort(),
			storedValues: kind.storedValues,
			uncastable: kind.uncastable,
		})),
	});
}

/** `holders`: every holder the fleet holds, by what can be done about it. */
function holdersLine(report: CutoverReport, fleet: PlannedFleet): void {
	const holders = fleet.holders;
	report.line("holders", {
		live: holders.liveApps.length + holders.liveSessions.length,
		liveApps: holders.liveApps,
		liveSessions: holders.liveSessions,
		lapsedOrPaused:
			holders.settleableApps.length + holders.settleableSessions.length,
		lapsedOrPausedApps: holders.settleableApps,
		lapsedOrPausedSessions: holders.settleableSessions,
		unsettledHolds:
			holders.unsettledApps.length + holders.unsettledSessions.length,
		unsettledApps: holders.unsettledApps,
		unsettledSessions: holders.unsettledSessions,
	});
}

/** `private-work`: what the fleet transaction abandons, and the apps told. */
function privateWorkLine(report: CutoverReport, fleet: PlannedFleet): void {
	report.line("private-work", {
		openWorkspaces: fleet.privateWork.openWorkspaces,
		openChangeSets: fleet.privateWork.openChangeSets,
		activeCandidates: fleet.privateWork.activeCandidates,
		apps: fleet.plan.apps
			.filter((app) => app.discardsPrivateWork)
			.map((app) => app.appId),
		endingSessions: fleet.privateWork.endingSessions,
	});
}

/**
 * One `blocker` line per code met, in the registry's order: its count, its
 * apps, its finding or issue codes, and for a target finding each
 * `CODE:reason` (and `CODE:checkCode:checkReason`) with the apps that meet it.
 */
function blockerLines(report: CutoverReport, fleet: PlannedFleet): void {
	const totals = new Map<
		CutoverBlockerCode,
		{
			count: number;
			apps: string[];
			findingCodes: Set<string>;
			findingReasons: Map<string, number>;
		}
	>();
	for (const app of fleet.plan.apps) {
		for (const blocker of app.blockers) {
			const total = totals.get(blocker.code) ?? {
				count: 0,
				apps: [],
				findingCodes: new Set<string>(),
				findingReasons: new Map<string, number>(),
			};
			total.count += blocker.count;
			total.apps.push(app.appId);
			for (const code of blocker.findingCodes) total.findingCodes.add(code);
			for (const reason of blocker.findingReasons ?? [])
				total.findingReasons.set(
					reason,
					(total.findingReasons.get(reason) ?? 0) + 1,
				);
			totals.set(blocker.code, total);
		}
	}
	for (const code of CUTOVER_BLOCKER_CODES) {
		const total = totals.get(code);
		if (total === undefined) continue;
		report.line("blocker", {
			code,
			count: total.count,
			apps: total.apps,
			findingCodes: [...total.findingCodes].sort(),
			findingReasons: [...total.findingReasons]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([reason, apps]) => ({ reason, apps })),
		});
	}
}

/**
 * `census` (the scan, with base digests): the count per verdict, every app
 * not `unchanged` by id with its verdict and, for an `unexplained` one, the
 * file keys no named change explains, and whether the base half read the
 * same fleet sequences.
 */
export function censusLine(report: CutoverReport, census: FleetCensus): void {
	const shown: readonly CensusVerdict[] = ["respelled-only", "named"];
	report.line("census", {
		verdicts: censusCounts(census),
		fleetSeqDigestMatches: census.fleetSeqDigestMatches,
		notCompared: census.notCompared,
		missingBase: census.missingBase,
		emissionFailed: census.emissionFailed,
		apps: census.apps
			.filter((app) => app.verdict !== "unchanged")
			.map((app) => ({
				appId: app.appId,
				verdict: app.verdict,
				respelledFiles: app.respelledFiles,
				namedFiles: app.namedFiles,
				...(shown.includes(app.verdict)
					? {}
					: { unexplainedFiles: app.unexplainedFiles }),
			})),
	});
}

export function outcomeLine(
	report: CutoverReport,
	outcome: ReportOutcome,
): void {
	report.line("outcome", { ...outcome });
}

/**
 * `--debug-details --app <id>`: for one app, every place each blocker met,
 * by entity and slot with the codes and the authored text that met it, then
 * every line its notice will hold. Authored content, for the operator's
 * terminal only; nothing of it enters the plan, the digest or the report.
 */
export function debugDetails(fleet: PlannedFleet, appId: string): string[] {
	const plan = fleet.plan.apps.find((app) => app.appId === appId);
	if (plan === undefined)
		return [`App ${appId}: not in the plan. Check the id against the scan.`];
	const detail = fleet.apps.find((app) => app.appId === appId);
	const name = fleet.targets.get(appId)?.appName;
	const lines = [`App ${appId}${name === undefined ? "" : `: ${name}`}`];
	for (const place of detail?.places ?? []) {
		const entity =
			place.entity === undefined
				? ""
				: ` ${place.entity.kind}${place.entity.uuid === undefined ? "" : `=${place.entity.uuid}`}`;
		lines.push(
			`  ${place.code}${entity}${place.slot === undefined ? "" : ` slot=${place.slot}`}${place.findingCode === undefined ? "" : ` ${place.findingCode}`}${place.text === undefined ? "" : `: ${place.text}`}`,
		);
	}
	if (lines.length === 1) lines.push("  no blocker");
	for (const change of plan.changes) {
		const details = Object.entries(change.detail ?? {})
			.map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
			.join("");
		lines.push(
			`  ${change.reason} ${change.entity.type} ${change.entity.uuid ?? ""}: ${change.entity.nameAtMigration}${details}`,
		);
	}
	for (const line of appDeploymentChanges(plan)) {
		lines.push(`  ${line.reason} deployment ${line.deploymentId}`);
	}
	return lines;
}
