/**
 * The platforms cutover's content-free report (part 09 §6): JSON Lines in
 * step 3's framing, one Cloud Logging entry per line, each printed as soon as
 * it is made and always ending in an `outcome` line.
 *
 * App ids, asset ids, deployment ids, migration names, feature ids, formats,
 * codes and counts are content-free; names, file names, expressions and
 * values never appear.
 */

import type { BlueprintDoc } from "@/lib/domain";
import { isClockKeepingDate } from "@/lib/domain/expression/datePattern";
import {
	walkExpressionNodes,
	walkExpressionTerms,
} from "@/lib/domain/expression/walk";
import { ownRecordValue } from "@/lib/domain/records";
import {
	expressionSlotValues,
	FIELD_REFERENCE_SLOTS,
} from "@/lib/domain/referenceSlots";
import type { CaseTypeDrift } from "../schemaDrift";
import { needsBytes } from "./media";
import type { PlannedFleet } from "./plan";
import {
	CUTOVER_BLOCKER_CODES,
	type CutoverBlockerCode,
	type CutoverStopCode,
	compareText,
	MEDIA_CAUSES,
} from "./types";

export const REPORT = "hq-round-trip-platforms";

export type ReportMode =
	| "scan"
	| "dry-run"
	| "prove-media-read"
	| "settle-holders"
	| "rehearse"
	| "execute";

export type ReportOutcome =
	| { readonly outcome: "ok" }
	| { readonly outcome: "already-applied" }
	| {
			readonly outcome: "stopped";
			readonly stoppedBy: readonly ("blocker" | CutoverStopCode)[];
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

	text(): string {
		return this.lines.map((line) => JSON.stringify(line)).join("\n");
	}
}

/** Per key, its count, keys in code-point order. */
function tally(keys: Iterable<string>): Record<string, number> {
	const counts = new Map<string, number>();
	for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
	return Object.fromEntries([...counts].sort(([a], [b]) => compareText(a, b)));
}

function sortedUnique(values: Iterable<string>): string[] {
	return [...new Set(values)].sort(compareText);
}

/**
 * The `fleet` line: the fleet's counts, the plan's digest (null in the scan,
 * which classifies no media), the sequence digest, the database's size, the
 * run's peak memory, and whatever the caller measured (the plan's
 * milliseconds, the ledger's state).
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
		appsChanged: fleet.plan.apps.filter((app) => app.targetDigest !== null)
			.length,
		planDigest: fleet.classified ? fleet.plan.digest : null,
		fleetSeqDigest: fleet.fleetSeqDigest,
		databaseBytes: fleet.databaseBytes,
		peakRssBytes: process.resourceUsage().maxRSS * 1024,
		...extra,
	});
}

/** Every section a run that built a plan prints, between `fleet` and `outcome`. */
export function planSections(report: CutoverReport, fleet: PlannedFleet): void {
	declarationsLine(report, fleet);
	splitsLine(report, fleet);
	clockKeepingLine(report, fleet);
	sessionContextLine(report, fleet);
	schemaDriftLine(report, fleet);
	mediaLine(report, fleet);
	deploymentsLine(report, fleet);
	holdersLine(report, fleet);
	blockerLines(report, fleet);
}

/** `declarations`: apps per declaration, and apps per cause feature id. */
function declarationsLine(report: CutoverReport, fleet: PlannedFleet): void {
	const causes: string[] = [];
	for (const app of fleet.plan.apps) {
		const declared = app.changes.find(
			(change) =>
				change.step === "declare-platforms" && change.entityUuid === null,
		);
		const ids = String(declared?.detail.causes ?? "")
			.split(",")
			.filter(Boolean);
		causes.push(...new Set(ids));
	}
	report.line("declarations", {
		apps: tally(fleet.plan.apps.map((app) => app.declaration ?? "blocked")),
		appsDeclaredByCause: tally(causes),
	});
}

/** `splits`: the apps and questions the split reaches, each by writer and non-writer. */
function splitsLine(report: CutoverReport, fleet: PlannedFleet): void {
	const writerApps = new Set<string>();
	const nonWriterApps = new Set<string>();
	let writers = 0;
	let nonWriters = 0;
	for (const app of fleet.plan.apps) {
		for (const change of app.changes) {
			if (change.step !== "declare-platforms" || change.entityUuid === null)
				continue;
			if (change.detail.writer === 1) {
				writers += 1;
				writerApps.add(app.appId);
			} else {
				nonWriters += 1;
				nonWriterApps.add(app.appId);
			}
		}
	}
	report.line("splits", {
		apps: new Set([...writerApps, ...nonWriterApps]).size,
		questions: writers + nonWriters,
		writerQuestions: writers,
		nonWriterQuestions: nonWriters,
		writerApps: sortedUnique(writerApps),
		nonWriterApps: sortedUnique(nonWriterApps),
	});
}

/** The field slots that hold form logic. */
const FORM_LOGIC_SLOTS: ReadonlySet<string> = new Set(
	FIELD_REFERENCE_SLOTS.filter((entry) => entry.kind === "expression").map(
		(entry) => entry.slot,
	),
);

function fieldWrites(doc: BlueprintDoc, uuid: string): boolean {
	const field = ownRecordValue(doc.fields, uuid);
	return (
		field !== undefined && "caseWrite" in field && field.caseWrite !== undefined
	);
}

/** The stored form-logic slots holding a clock-keeping date, by writer and non-writer. */
export function clockKeepingCounts(
	docs: readonly { appId: string; doc: BlueprintDoc }[],
) {
	let writerSlots = 0;
	let nonWriterSlots = 0;
	const writerApps = new Set<string>();
	const nonWriterApps = new Set<string>();
	for (const { appId, doc } of docs) {
		for (const uuid of Object.keys(doc.fields)) {
			for (const value of expressionSlotValues(doc, {
				entity: "field",
				uuid: uuid as never,
			})) {
				if (!FORM_LOGIC_SLOTS.has(value.ref.slot)) continue;
				let holds = false;
				walkExpressionNodes(value.expression, (node) => {
					if (isClockKeepingDate(node)) holds = true;
				});
				if (!holds) continue;
				if (fieldWrites(doc, uuid)) {
					writerSlots += 1;
					writerApps.add(appId);
				} else {
					nonWriterSlots += 1;
					nonWriterApps.add(appId);
				}
			}
		}
	}
	return {
		writerSlots,
		nonWriterSlots,
		writerApps: sortedUnique(writerApps),
		nonWriterApps: sortedUnique(nonWriterApps),
	};
}

function clockKeepingLine(report: CutoverReport, fleet: PlannedFleet): void {
	report.line(
		"clock-keeping-dates",
		clockKeepingCounts(
			fleet.sources.map((app) => ({ appId: app.appId, doc: app.doc })),
		),
	);
}

/** The session context fields step 4 types and offers. */
const COUNTED_CONTEXT_FIELDS = [
	"drift",
	"window_width",
	"applanguage",
] as const;

/** The slot class of a stored expression, as part 03 §6.2 names them. */
function slotClass(entity: "field" | "form" | "module", slot: string): string {
	if (entity === "module") return "module";
	if (entity === "field")
		return slot === "lookup_options_source" ? "lookup-options-source" : "field";
	if (slot === "form_display_condition") return "form-display-condition";
	if (slot.startsWith("form_link_")) return "form-link";
	if (slot.startsWith("case_operation_")) return "case-operation";
	return "connect";
}

/** The stored reads of `drift`, `window_width` and `applanguage`, by field and slot class. */
export function sessionContextCounts(
	docs: readonly { appId: string; doc: BlueprintDoc }[],
) {
	const reads: Record<string, Record<string, number>> = Object.fromEntries(
		COUNTED_CONTEXT_FIELDS.map((field) => [field, {}]),
	);
	const apps = new Set<string>();
	for (const { appId, doc } of docs) {
		const owners = [
			...Object.keys(doc.fields).map((uuid) => ({
				entity: "field" as const,
				uuid,
			})),
			...Object.keys(doc.forms).map((uuid) => ({
				entity: "form" as const,
				uuid,
			})),
			...Object.keys(doc.modules).map((uuid) => ({
				entity: "module" as const,
				uuid,
			})),
		];
		for (const owner of owners) {
			for (const value of expressionSlotValues(doc, {
				entity: owner.entity,
				uuid: owner.uuid as never,
			})) {
				walkExpressionTerms(value.expression, (term) => {
					if (term.kind !== "session-context") return;
					if (
						!(COUNTED_CONTEXT_FIELDS as readonly string[]).includes(term.field)
					)
						return;
					const byClass = reads[term.field] as Record<string, number>;
					const at = slotClass(owner.entity, value.ref.slot);
					byClass[at] = (byClass[at] ?? 0) + 1;
					apps.add(appId);
				});
			}
		}
	}
	return { reads, apps: sortedUnique(apps) };
}

function sessionContextLine(report: CutoverReport, fleet: PlannedFleet): void {
	report.line(
		"session-context",
		sessionContextCounts(
			fleet.sources.map((app) => ({ appId: app.appId, doc: app.doc })),
		),
	);
}

/** Each app's drift by class, as `scan-schema-drift.ts` classes it. */
export function schemaDriftCounts(
	apps: readonly { appId: string; drift: readonly CaseTypeDrift[] }[],
) {
	let missingRow = 0;
	let added = 0;
	let removed = 0;
	let refined = 0;
	let unresolvable = 0;
	const retyped: string[] = [];
	const drifted: string[] = [];
	for (const app of apps) {
		if (app.drift.length === 0) continue;
		drifted.push(app.appId);
		for (const caseType of app.drift) {
			if (caseType.missingRow) missingRow += 1;
			else {
				added += caseType.added.length;
				removed += caseType.removed.length;
			}
			refined += caseType.refined.length;
			unresolvable += caseType.unresolvable.length;
			retyped.push(
				...caseType.retyped.map(
					(property) => `${property.fromType}->${property.toType}`,
				),
			);
		}
	}
	return {
		apps: sortedUnique(drifted),
		caseTypes: apps.reduce((sum, app) => sum + app.drift.length, 0),
		missingRow,
		added,
		removed,
		refined,
		retyped: tally(retyped),
		unresolvable,
	};
}

function schemaDriftLine(report: CutoverReport, fleet: PlannedFleet): void {
	report.line(
		"schema-drift",
		schemaDriftCounts(
			fleet.sources.map((app) => ({ appId: app.appId, drift: app.drift })),
		),
	);
}

/**
 * `media`: the ready media rows by kind and stored MIME and the rows whose
 * bytes must be read; with a classification, the rows by format and cause,
 * the asset ids of `missing` and `too-large` rows, what was read, and the
 * references removed by cause, carrier and format.
 */
export function mediaFields(fleet: PlannedFleet): Record<string, unknown> {
	const bytesRows = fleet.mediaRows.filter((row) => needsBytes(row));
	const fields: Record<string, unknown> = {
		rows: fleet.mediaRows.length,
		rowsByKind: tally(fleet.mediaRows.map((row) => row.kind)),
		rowsByMime: tally(fleet.mediaRows.map((row) => row.mime_type)),
		needsBytes: bytesRows.length,
		needsBytesByMime: tally(bytesRows.map((row) => row.mime_type)),
		classified: fleet.classified,
	};
	if (!fleet.classified) {
		return {
			...fields,
			droppedReadinessCodes: ["MEDIA_FORMAT_NOT_PLAYED"],
		};
	}
	const removals = fleet.plan.apps.flatMap((app) =>
		app.changes.filter((change) => change.step === "remove-unplayed-media"),
	);
	return {
		...fields,
		rowsByFormat: tally(fleet.plan.media.map((plan) => plan.format)),
		rowsByCause: Object.fromEntries(
			MEDIA_CAUSES.map((cause) => [
				cause,
				fleet.plan.media.filter((plan) => plan.cause === cause).length,
			]),
		),
		missingAssetIds: fleet.plan.media
			.filter((plan) => plan.cause === "missing")
			.map((plan) => plan.assetId),
		tooLargeAssetIds: fleet.plan.media
			.filter((plan) => plan.cause === "too-large")
			.map((plan) => plan.assetId),
		objectsRead: fleet.mediaStats?.objectsRead ?? 0,
		bytesRead: fleet.mediaStats?.bytesRead ?? 0,
		classificationMilliseconds: fleet.mediaStats?.milliseconds ?? 0,
		removedReferences: removals.length,
		removedByCause: tally(
			removals.map((change) => String(change.detail.cause)),
		),
		removedByCarrier: tally(
			removals.map((change) => String(change.detail.carrier)),
		),
		removedByFormat: tally(
			removals.map((change) => String(change.detail.format)),
		),
	};
}

function mediaLine(report: CutoverReport, fleet: PlannedFleet): void {
	report.line("media", mediaFields(fleet));
}

/** `deployments`: entries per reason. */
function deploymentsLine(report: CutoverReport, fleet: PlannedFleet): void {
	report.line("deployments", {
		entries: tally(
			fleet.plan.apps.flatMap((app) =>
				app.notice
					.filter((entry) => entry.kind === "deployment")
					.map((entry) => entry.reason),
			),
		),
		documentEntries: tally(
			fleet.plan.apps.flatMap((app) =>
				app.notice
					.filter((entry) => entry.kind === "document")
					.map((entry) => entry.reason),
			),
		),
		appsWithNotice: fleet.plan.apps.filter((app) => app.notice.length > 0)
			.length,
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

/** One `blocker` line per code met, in the registry's order. */
function blockerLines(report: CutoverReport, fleet: PlannedFleet): void {
	const totals = new Map<
		CutoverBlockerCode,
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
	for (const code of CUTOVER_BLOCKER_CODES) {
		const total = totals.get(code);
		if (total === undefined) continue;
		report.line("blocker", {
			code,
			count: total.count,
			apps: total.apps,
			findingCodes: sortedUnique(total.findingCodes),
		});
	}
}

export function outcomeLine(
	report: CutoverReport,
	outcome: ReportOutcome,
): void {
	report.line("outcome", { ...outcome });
}

/**
 * `--app <id> --debug-details`: for one app, its blockers with each finding's
 * message and its planned notice lines with names. Authored content, for the
 * operator's terminal only; nothing of it enters the plan's report.
 */
export function debugDetails(
	fleet: PlannedFleet,
	appId: string,
	findings: readonly { code: string; message: string; where: string }[],
): string[] {
	const plan = fleet.plan.apps.find((app) => app.appId === appId);
	if (plan === undefined)
		return [`App ${appId}: not in the plan. Check the id against the scan.`];
	const source = fleet.sources.find((app) => app.appId === appId);
	const lines = [
		`App ${appId}${source === undefined ? "" : `: ${source.doc.appName}`}`,
	];
	for (const blocker of plan.blockers) {
		lines.push(
			`  ${blocker.code} (${blocker.count}): ${blocker.findingCodes.join(", ")}`,
		);
	}
	for (const finding of findings) {
		lines.push(`    ${finding.code} at ${finding.where}: ${finding.message}`);
	}
	if (plan.blockers.length === 0) lines.push("  no blocker");
	for (const entry of plan.notice) {
		if (entry.kind === "deployment") {
			lines.push(
				`  ${entry.reason} deployment ${entry.deployment.deploymentId} ${entry.deployment.domain}${entry.detail === undefined ? "" : ` ${JSON.stringify(entry.detail)}`}`,
			);
		} else {
			lines.push(
				`  ${entry.reason} ${entry.entity.type} ${entry.entity.uuid ?? ""}: ${entry.entity.nameAtMigration}${entry.detail === undefined ? "" : ` ${JSON.stringify(entry.detail)}`}`,
			);
		}
	}
	return lines;
}
