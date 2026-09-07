/**
 * Pure scan, report, and repair planner for hidden fields carrying BOTH a
 * `calculate` and a `default_value`.
 *
 * JavaRosa seeds every `default_value` at `xforms-ready` and then
 * re-evaluates every `calculate`, so on such a field the default is
 * overwritten before anyone could read it: only the calculate ever took
 * effect. The planned repair drops exactly the dead `default_value` and
 * changes nothing the running app could observe. Every builder-born hidden
 * field was minted with an inert `default_value` beside whatever calculate
 * the author later typed, so offenders are expected across the fleet.
 *
 * This runs one release BEFORE the validator rule `HIDDEN_VALUE_BOTH_SOURCES`
 * activates. Every app read runs the absolute commit gate and every deploy's
 * migration probe audits every `apps` row, soft-deleted included, so a
 * release carrying the rule while offenders exist could not reach production.
 * The recognizer is shared with the future rule
 * (`lib/domain/fields/hidden.ts::hiddenFieldCarriesBothValueSources`), so the
 * scan, the repair, and the rule cannot drift.
 *
 * Nothing here touches a database; the writer lives in
 * `hiddenValueBothSourcesRepair.ts` so the read-only scanner CLI stays free
 * of the `server-only` boundary the app-state writer reaches. Output names
 * only stable identities and counts, never an authored label or expression.
 */

import { hydratePersistedBlueprint } from "../../lib/doc/fieldParent";
import { findContainingForm } from "../../lib/doc/mutations/helpers";
import {
	type BlueprintDoc,
	hiddenFieldCarriesBothValueSources,
	type PersistableDoc,
	type Uuid,
} from "../../lib/domain";

/** One hidden field holding both value sources, by stable identity only. */
export interface HiddenValueBothSourcesFinding {
	readonly formUuid: Uuid;
	readonly fieldUuid: Uuid;
}

export interface HiddenValueBothSourcesObservation {
	readonly appId: string;
	readonly findings: readonly HiddenValueBothSourcesFinding[];
}

export interface HiddenValueBothSourcesScanReport {
	readonly scannedApps: number;
	readonly affectedApps: number;
	readonly affectedFields: number;
	readonly findings: readonly (HiddenValueBothSourcesFinding & {
		readonly appId: string;
	})[];
	readonly unreadableAppIds: readonly string[];
	readonly exitCode: 0 | 1;
}

function compareFindings(
	a: HiddenValueBothSourcesFinding,
	b: HiddenValueBothSourcesFinding,
): number {
	return (
		a.formUuid.localeCompare(b.formUuid) ||
		a.fieldUuid.localeCompare(b.fieldUuid)
	);
}

/**
 * Every hidden field in the document that carries both value sources, as
 * `(form, field)` identities sorted for stable output. A field not reachable
 * from any form (orphaned order) is reported under its own uuid as the form
 * slot so the count still names it.
 */
export function scanHiddenValueBothSources(
	doc: BlueprintDoc,
): HiddenValueBothSourcesFinding[] {
	const findings: HiddenValueBothSourcesFinding[] = [];
	for (const field of Object.values(doc.fields)) {
		if (field === undefined) continue;
		if (!hiddenFieldCarriesBothValueSources(field)) continue;
		findings.push({
			formUuid: findContainingForm(doc, field.uuid) ?? field.uuid,
			fieldUuid: field.uuid,
		});
	}
	return findings.sort(compareFindings);
}

export function buildHiddenValueBothSourcesScanReport(
	observations: readonly HiddenValueBothSourcesObservation[],
	unreadableAppIds: readonly string[] = [],
): HiddenValueBothSourcesScanReport {
	const findings = observations
		.flatMap((observation) =>
			observation.findings.map((finding) => ({
				appId: observation.appId,
				...finding,
			})),
		)
		.sort((a, b) => a.appId.localeCompare(b.appId) || compareFindings(a, b));
	const affectedApps = new Set(findings.map((finding) => finding.appId)).size;
	const orderedUnreadableAppIds = [...new Set(unreadableAppIds)].sort((a, b) =>
		a.localeCompare(b),
	);
	return {
		scannedApps: observations.length + orderedUnreadableAppIds.length,
		affectedApps,
		affectedFields: findings.length,
		findings,
		unreadableAppIds: orderedUnreadableAppIds,
		exitCode: findings.length > 0 || orderedUnreadableAppIds.length > 0 ? 1 : 0,
	};
}

/** Render only stable identities and counts. Authored content never enters. */
export function renderHiddenValueBothSourcesScanReport(
	report: HiddenValueBothSourcesScanReport,
): string {
	const lines = [
		"Hidden value both-sources scan (read-only)",
		`${report.scannedApps} persisted app(s) scanned; ${report.affectedApps} affected app(s); ${report.affectedFields} hidden field(s) carrying both a calculate and a default_value.`,
	];
	if (report.findings.length === 0 && report.unreadableAppIds.length === 0) {
		lines.push(
			"CLEAN: no persisted hidden field carries both a calculate and a default_value.",
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
			lines.push(`  form ${finding.formUuid}; field ${finding.fieldUuid}`);
		}
	}
	if (report.unreadableAppIds.length > 0) {
		lines.push("", "Apps that could not be scanned");
		for (const appId of report.unreadableAppIds) lines.push(`app ${appId}`);
	}
	if (report.exitCode === 1) {
		lines.push(
			"",
			"Do not activate HIDDEN_VALUE_BOTH_SOURCES until this scan returns clean.",
		);
	}
	return lines.join("\n");
}

export interface HiddenValueBothSourcesRepairPlan {
	readonly targetDoc: PersistableDoc;
	readonly cleared: readonly HiddenValueBothSourcesFinding[];
}

/**
 * Plan the repair for one document. Pure: the returned `targetDoc` is a deep
 * copy with exactly the dead `default_value` removed from each offender and
 * every other byte untouched (`doc` itself when there is nothing to remove);
 * `doc` is not modified. `appendSyntheticBatch` derives the removed key as
 * `updateField { default_value: null }`.
 */
export function planHiddenValueBothSourcesRepair(
	doc: PersistableDoc,
): HiddenValueBothSourcesRepairPlan {
	const cleared = scanHiddenValueBothSources(hydratePersistedBlueprint(doc));
	if (cleared.length === 0) return { targetDoc: doc, cleared };
	const target = structuredClone(doc);
	for (const finding of cleared) {
		const field = target.fields[finding.fieldUuid] as
			| Record<string, unknown>
			| undefined;
		if (field === undefined) continue;
		delete field.default_value;
	}
	return { targetDoc: target, cleared };
}
