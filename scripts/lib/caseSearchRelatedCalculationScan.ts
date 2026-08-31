import { searchRelatedCalculationCompatibility } from "@/lib/commcare/validator/rules/case-search/searchRelatedCalculationCompatibility";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { uuidSchema } from "@/lib/domain/uuid";

export interface CaseSearchRelatedCalculationFinding {
	readonly moduleUuid: Uuid;
	readonly columnUuid: Uuid;
}

export interface CaseSearchRelatedCalculationObservation {
	readonly appId: string;
	readonly findings: readonly CaseSearchRelatedCalculationFinding[];
}

export interface CaseSearchRelatedCalculationScanReport {
	readonly scannedApps: number;
	readonly affectedApps: number;
	readonly affectedColumns: number;
	readonly findings: readonly (CaseSearchRelatedCalculationFinding & {
		readonly appId: string;
	})[];
	readonly unreadableAppIds: readonly string[];
	readonly exitCode: 0 | 1;
}

/**
 * Inventory the exact historical state the new commit rule refuses.
 *
 * The validator owns the compatibility boundary. This projection intentionally
 * retains only stable identities, so neither its return value nor the rendered
 * fleet report can disclose an authored label, formula, or case-data value.
 */
export function scanCaseSearchRelatedCalculations(
	doc: BlueprintDoc,
): CaseSearchRelatedCalculationFinding[] {
	const findings: CaseSearchRelatedCalculationFinding[] = [];

	for (const [moduleKey, mod] of Object.entries(doc.modules)) {
		const moduleUuid = uuidSchema.parse(moduleKey);
		for (const finding of searchRelatedCalculationCompatibility(
			mod,
			moduleUuid,
			doc,
		)) {
			const columnUuid = uuidSchema.safeParse(finding.details?.columnUuid);
			if (!columnUuid.success) {
				throw new Error(
					"Related-calculation validator finding omitted its column identity.",
				);
			}
			findings.push({
				moduleUuid,
				columnUuid: columnUuid.data,
			});
		}
	}

	return findings.sort(
		(a, b) =>
			a.moduleUuid.localeCompare(b.moduleUuid) ||
			a.columnUuid.localeCompare(b.columnUuid),
	);
}

export function buildCaseSearchRelatedCalculationScanReport(
	observations: readonly CaseSearchRelatedCalculationObservation[],
	unreadableAppIds: readonly string[] = [],
): CaseSearchRelatedCalculationScanReport {
	const findings = observations
		.flatMap((observation) =>
			observation.findings.map((finding) => ({
				appId: observation.appId,
				...finding,
			})),
		)
		.sort(
			(a, b) =>
				a.appId.localeCompare(b.appId) ||
				a.moduleUuid.localeCompare(b.moduleUuid) ||
				a.columnUuid.localeCompare(b.columnUuid),
		);
	const affectedApps = new Set(findings.map((finding) => finding.appId)).size;
	const orderedUnreadableAppIds = [...new Set(unreadableAppIds)].sort((a, b) =>
		a.localeCompare(b),
	);

	return {
		scannedApps: observations.length + orderedUnreadableAppIds.length,
		affectedApps,
		affectedColumns: findings.length,
		findings,
		unreadableAppIds: orderedUnreadableAppIds,
		exitCode: findings.length > 0 || orderedUnreadableAppIds.length > 0 ? 1 : 0,
	};
}

/** Render only stable identities and counts. Authored content never enters. */
export function renderCaseSearchRelatedCalculationScanReport(
	report: CaseSearchRelatedCalculationScanReport,
): string {
	const lines = [
		"Case Search related-calculation scan (read-only)",
		`${report.scannedApps} persisted app(s) scanned; ${report.affectedApps} affected app(s); ${report.affectedColumns} incompatible saved column(s).`,
	];

	if (report.findings.length === 0 && report.unreadableAppIds.length === 0) {
		lines.push(
			"CLEAN: no persisted app saves an unsupported related-case calculation in a module with Search.",
		);
	}

	if (report.findings.length > 0) {
		lines.push("", "Affected identities");
		let currentAppId: string | undefined;
		for (const finding of report.findings) {
			if (finding.appId !== currentAppId) {
				currentAppId = finding.appId;
				lines.push(`app ${finding.appId}`);
			}
			lines.push(
				`  module ${finding.moduleUuid}; column ${finding.columnUuid}`,
			);
		}
	}

	if (report.unreadableAppIds.length > 0) {
		lines.push("", "Apps that could not be scanned");
		for (const appId of report.unreadableAppIds) lines.push(`app ${appId}`);
	}

	if (report.exitCode === 1) {
		lines.push(
			"",
			"Do not activate the stricter validator until every affected app has an owned repair and this scan returns clean.",
		);
	}

	return lines.join("\n");
}
