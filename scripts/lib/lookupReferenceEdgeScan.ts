/**
 * Pure comparison + reporting core for the lookup-reference edge inspector.
 *
 * Structural targets and stored targets arrive through their production
 * boundaries. This module only compares the two complete, normalized sets and
 * turns per-app read outcomes into one deterministic operator report. Keeping
 * database access out of this file makes every failure/reporting branch
 * testable without a Postgres container.
 */

import {
	normalizeLookupReferenceTargetSet,
	type LookupColumnReferenceTarget,
	type LookupReferenceTargetSet,
} from "@/lib/doc/lookupReferences";
import type { LookupTableId } from "@/lib/domain/lookupIds";

export interface LookupReferenceScanApp {
	readonly appId: string;
	readonly projectId: string | null;
	readonly appName: string;
	readonly deletedAt: string | null;
}

export type StructuralLookupReferenceRead =
	| {
			readonly kind: "ok";
			readonly targets: LookupReferenceTargetSet;
	  }
	| {
			readonly kind: "unassemblable";
			readonly message: string;
	  }
	| {
			readonly kind: "error";
			readonly stage: "read-blueprint-rows" | "extract-structural-targets";
			readonly message: string;
	  };

export type StoredLookupReferenceRead =
	| {
			readonly kind: "ok";
			readonly targets: LookupReferenceTargetSet;
	  }
	| {
			readonly kind: "error";
			readonly stage: "read-stored-targets";
			readonly message: string;
	  };

/** One independently collected app observation. */
export interface LookupReferenceScanObservation {
	readonly app: LookupReferenceScanApp;
	readonly structural: StructuralLookupReferenceRead;
	readonly stored: StoredLookupReferenceRead;
}

/**
 * A partial set difference. Unlike `LookupReferenceTargetSet`, this does not
 * imply a table target for every column: the parent table may be present on
 * both sides while only the column edge differs.
 */
export interface LookupReferenceTargetDifference {
	readonly tableIds: readonly LookupTableId[];
	readonly columnTargets: readonly LookupColumnReferenceTarget[];
}

export interface LookupReferenceTargetComparison {
	readonly structuralOnly: LookupReferenceTargetDifference;
	readonly storedOnly: LookupReferenceTargetDifference;
}

export interface LookupReferenceAppMismatch
	extends LookupReferenceScanApp,
		LookupReferenceTargetComparison {}

export interface LookupReferenceScanIssue extends LookupReferenceScanApp {
	readonly stage:
		| "assemble-blueprint"
		| "read-blueprint-rows"
		| "extract-structural-targets"
		| "read-stored-targets";
	readonly message: string;
}

export interface LookupReferenceScanReport {
	readonly scannedApps: number;
	readonly comparedApps: number;
	readonly cleanApps: number;
	readonly mismatches: readonly LookupReferenceAppMismatch[];
	readonly unassemblableApps: readonly LookupReferenceScanIssue[];
	readonly operationalErrors: readonly LookupReferenceScanIssue[];
	readonly structuralOnlyApps: number;
	readonly storedOnlyApps: number;
	readonly structuralOnlyTargets: number;
	readonly storedOnlyTargets: number;
	readonly exitCode: 0 | 1;
}

function compareColumnTargets(
	a: LookupColumnReferenceTarget,
	b: LookupColumnReferenceTarget,
): number {
	return (
		a.tableId.localeCompare(b.tableId) || a.columnId.localeCompare(b.columnId)
	);
}

/** Return `left \\ right` for already-sorted, unique arrays. */
function sortedDifference<T>(
	left: readonly T[],
	right: readonly T[],
	compare: (a: T, b: T) => number,
): readonly T[] {
	const difference: T[] = [];
	let rightIndex = 0;

	for (const item of left) {
		while (
			rightIndex < right.length &&
			compare(right[rightIndex] as T, item) < 0
		) {
			rightIndex += 1;
		}
		if (
			rightIndex >= right.length ||
			compare(item, right[rightIndex] as T) !== 0
		) {
			difference.push(item);
		}
	}

	return Object.freeze(difference);
}

/** Exact canonical comparison of the complete structural and stored sets. */
export function compareLookupReferenceTargetSets(
	structuralInput: LookupReferenceTargetSet,
	storedInput: LookupReferenceTargetSet,
): LookupReferenceTargetComparison {
	const structural = normalizeLookupReferenceTargetSet(structuralInput);
	const stored = normalizeLookupReferenceTargetSet(storedInput);
	const byId = (a: LookupTableId, b: LookupTableId) => a.localeCompare(b);

	return {
		structuralOnly: {
			tableIds: sortedDifference(structural.tableIds, stored.tableIds, byId),
			columnTargets: sortedDifference(
				structural.columnTargets,
				stored.columnTargets,
				compareColumnTargets,
			),
		},
		storedOnly: {
			tableIds: sortedDifference(stored.tableIds, structural.tableIds, byId),
			columnTargets: sortedDifference(
				stored.columnTargets,
				structural.columnTargets,
				compareColumnTargets,
			),
		},
	};
}

function targetCount(targets: LookupReferenceTargetDifference): number {
	return targets.tableIds.length + targets.columnTargets.length;
}

function byApp(a: LookupReferenceScanApp, b: LookupReferenceScanApp): number {
	return (
		a.appId.localeCompare(b.appId) ||
		(a.projectId ?? "").localeCompare(b.projectId ?? "")
	);
}

/** Aggregate all app outcomes without allowing one bad app to hide the rest. */
export function buildLookupReferenceScanReport(
	observations: readonly LookupReferenceScanObservation[],
): LookupReferenceScanReport {
	const mismatches: LookupReferenceAppMismatch[] = [];
	const unassemblableApps: LookupReferenceScanIssue[] = [];
	const operationalErrors: LookupReferenceScanIssue[] = [];
	let comparedApps = 0;
	let cleanApps = 0;
	let structuralOnlyApps = 0;
	let storedOnlyApps = 0;
	let structuralOnlyTargets = 0;
	let storedOnlyTargets = 0;

	for (const observation of [...observations].sort((a, b) =>
		byApp(a.app, b.app),
	)) {
		if (observation.structural.kind === "unassemblable") {
			unassemblableApps.push({
				...observation.app,
				stage: "assemble-blueprint",
				message: observation.structural.message,
			});
		} else if (observation.structural.kind === "error") {
			operationalErrors.push({
				...observation.app,
				stage: observation.structural.stage,
				message: observation.structural.message,
			});
		}

		if (observation.stored.kind === "error") {
			operationalErrors.push({
				...observation.app,
				stage: observation.stored.stage,
				message: observation.stored.message,
			});
		}

		if (
			observation.structural.kind !== "ok" ||
			observation.stored.kind !== "ok"
		) {
			continue;
		}

		comparedApps += 1;
		const comparison = compareLookupReferenceTargetSets(
			observation.structural.targets,
			observation.stored.targets,
		);
		const structuralCount = targetCount(comparison.structuralOnly);
		const storedCount = targetCount(comparison.storedOnly);
		if (structuralCount === 0 && storedCount === 0) {
			cleanApps += 1;
			continue;
		}

		if (structuralCount > 0) structuralOnlyApps += 1;
		if (storedCount > 0) storedOnlyApps += 1;
		structuralOnlyTargets += structuralCount;
		storedOnlyTargets += storedCount;
		mismatches.push({ ...observation.app, ...comparison });
	}

	const failed =
		mismatches.length > 0 ||
		unassemblableApps.length > 0 ||
		operationalErrors.length > 0;
	return {
		scannedApps: observations.length,
		comparedApps,
		cleanApps,
		mismatches: Object.freeze(mismatches),
		unassemblableApps: Object.freeze(unassemblableApps),
		operationalErrors: Object.freeze(operationalErrors),
		structuralOnlyApps,
		storedOnlyApps,
		structuralOnlyTargets,
		storedOnlyTargets,
		exitCode: failed ? 1 : 0,
	};
}

function appHeading(app: LookupReferenceScanApp): string {
	const scope = app.projectId ?? "no Project";
	const lifecycle =
		app.deletedAt === null ? "live" : `soft-deleted ${app.deletedAt}`;
	const name = app.appName.length === 0 ? "unnamed" : app.appName;
	return `${app.appId} (${scope}; ${lifecycle}; ${JSON.stringify(name)})`;
}

function countLabel(targets: LookupReferenceTargetDifference): string {
	return `${targets.tableIds.length} table(s), ${targets.columnTargets.length} column(s)`;
}

function renderDifference(
	label: "structural-only" | "stored-only",
	targets: LookupReferenceTargetDifference,
): readonly string[] {
	if (targetCount(targets) === 0) return [];
	return [
		`  ${label}: ${countLabel(targets)}`,
		...targets.tableIds.map((tableId) => `    table ${tableId}`),
		...targets.columnTargets.map(
			({ tableId, columnId }) => `    column ${tableId} / ${columnId}`,
		),
	];
}

/** Stable, actionable plain-text report for terminals and deploy logs. */
export function renderLookupReferenceScanReport(
	report: LookupReferenceScanReport,
): string {
	const lines = [
		"Lookup reference edge audit (read-only)",
		`${report.scannedApps} persisted app(s) scanned; ${report.comparedApps} compared; ${report.cleanApps} clean.`,
	];

	if (report.mismatches.length > 0) {
		lines.push("", `Target mismatches (${report.mismatches.length} app(s))`);
		for (const mismatch of report.mismatches) {
			lines.push(
				appHeading(mismatch),
				...renderDifference("structural-only", mismatch.structuralOnly),
				...renderDifference("stored-only", mismatch.storedOnly),
			);
		}
	}

	if (report.unassemblableApps.length > 0) {
		lines.push("", `Unassemblable apps (${report.unassemblableApps.length})`);
		for (const issue of report.unassemblableApps) {
			lines.push(appHeading(issue), `  ${issue.message}`);
		}
	}

	if (report.operationalErrors.length > 0) {
		lines.push(
			"",
			`Operational scan errors (${report.operationalErrors.length})`,
		);
		for (const issue of report.operationalErrors) {
			lines.push(appHeading(issue), `  ${issue.stage}: ${issue.message}`);
		}
	}

	lines.push("");
	if (report.exitCode === 0) {
		lines.push(
			"CLEAN: every assembled blueprint's structural lookup targets exactly match its complete stored app-wide edge set.",
		);
	} else {
		lines.push(
			`FAILED: ${report.structuralOnlyApps} app(s) have ${report.structuralOnlyTargets} structural-only target(s); ${report.storedOnlyApps} app(s) have ${report.storedOnlyTargets} stored-only target(s); ${report.unassemblableApps.length} app(s) are unassemblable; ${report.operationalErrors.length} operational error(s).`,
			"Investigate with the matching migration, then rerun this read-only scan to zero before activating lookup carriers or destructive schema actions.",
		);
	}

	return lines.join("\n");
}
