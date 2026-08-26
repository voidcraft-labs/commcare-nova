/**
 * Fail-closed deploy verification for the absolute XPath carrier gate.
 *
 * There is deliberately no writer. A stored incompatibility needs a faithful
 * runtime implementation or a separately reviewed semantic migration; removing
 * an expression merely to satisfy the gate is not a valid repair.
 */

import { loadSchemaAdmittedAppForInspection } from "../../lib/db/apps";
import { getAppDb } from "../../lib/db/pg";
import { hydratePersistedBlueprint } from "../../lib/doc/fieldParent";
import { scanBlueprintXPathCarriers } from "./xpathCompatibilityScan";

const MAX_SNAPSHOT_RETRIES = 4;

export interface XPathCarrierCompatibilityVerificationReport {
	readonly scannedApps: number;
	readonly verifiedApps: number;
	readonly expressions: number;
	readonly errorFindings: number;
	readonly unreadableApps: number;
}

interface AppVersion {
	readonly id: string;
	readonly mutationSeq: string;
}

async function currentAppVersions(
	selectedAppIds: readonly string[] | undefined,
): Promise<AppVersion[]> {
	const db = await getAppDb();
	// Every tombstone remains restorable by the owning Project. Include deleted
	// rows in the one-time admission cutover so restore cannot reintroduce an app
	// that never passed the absolute carrier gate.
	let query = db.selectFrom("apps").select(["id", "mutation_seq"]);
	if (selectedAppIds !== undefined) {
		query = query.where("id", "in", selectedAppIds);
	}
	const rows = await query.orderBy("id").execute();
	return rows.map((row) => ({
		id: row.id,
		mutationSeq: String(row.mutation_seq),
	}));
}

export function xpathCarrierCompatibilityVerificationShouldFail(
	report: Pick<
		XPathCarrierCompatibilityVerificationReport,
		"errorFindings" | "unreadableApps"
	>,
): boolean {
	return report.errorFindings > 0 || report.unreadableApps > 0;
}

/**
 * Verify every selected app's identity-bearing raw XPath. Typed lookup
 * expressions are outside this carrier because their UUID references remain
 * valid across lookup wire-name changes. Per-app failures are counted, never
 * printed with app ids, carrier paths, or authored source. Any finding or
 * unreadable state fails the deploy Job.
 */
export async function runXPathCarrierCompatibilityVerification(
	selectedAppIds?: readonly string[],
): Promise<XPathCarrierCompatibilityVerificationReport> {
	const versions = await currentAppVersions(selectedAppIds);
	if (
		selectedAppIds !== undefined &&
		versions.length !== new Set(selectedAppIds).size
	) {
		throw new Error(
			"XPath carrier verification could not read every selected app.",
		);
	}
	let scannedApps = 0;
	let verifiedApps = 0;
	let expressions = 0;
	let errorFindings = 0;
	let unreadableApps = 0;

	/* Stability is proved per app, not across the whole fleet. The first
	 * admission cutover drains writers before this scan; on later ordinary
	 * deployments, already-admitted app edits may continue without continually
	 * invalidating unrelated work completed earlier in this sequential walk. */
	for (const { id } of versions) {
		let stable = false;
		for (let attempt = 0; attempt <= MAX_SNAPSHOT_RETRIES; attempt += 1) {
			let app:
				| Awaited<ReturnType<typeof loadSchemaAdmittedAppForInspection>>
				| undefined;
			try {
				app = await loadSchemaAdmittedAppForInspection(id);
			} catch {
				unreadableApps += 1;
				stable = true;
				break;
			}
			if (app === null) {
				unreadableApps += 1;
				stable = true;
				break;
			}
			const loadedMutationSeq = String(app.mutation_seq);
			let appExpressions = 0;
			let appErrors = 0;
			let scanFailed = false;
			try {
				const occurrences = scanBlueprintXPathCarriers(
					hydratePersistedBlueprint(app.blueprint),
				);
				appExpressions = occurrences.length;
				appErrors = occurrences.reduce(
					(count, occurrence) =>
						count +
						occurrence.findings.filter(
							(finding) => finding.severity === "error",
						).length,
					0,
				);
			} catch {
				scanFailed = true;
			}

			const after = await currentAppVersions([id]);
			if (after.length === 1 && after[0]?.mutationSeq === loadedMutationSeq) {
				if (scanFailed) {
					unreadableApps += 1;
					stable = true;
					break;
				}
				scannedApps += 1;
				expressions += appExpressions;
				errorFindings += appErrors;
				if (appErrors === 0) verifiedApps += 1;
				stable = true;
				break;
			}
			if (after.length !== 1) {
				unreadableApps += 1;
				stable = true;
				break;
			}
		}
		if (!stable) {
			throw new Error(
				"XPath carrier verification could not obtain a stable app snapshot.",
			);
		}
	}

	const report = {
		scannedApps,
		verifiedApps,
		expressions,
		errorFindings,
		unreadableApps,
	};
	if (xpathCarrierCompatibilityVerificationShouldFail(report)) {
		throw new Error(
			`XPath carrier verification failed with ${errorFindings} compatibility error(s) and ${unreadableApps} unreadable app(s).`,
		);
	}
	return report;
}
