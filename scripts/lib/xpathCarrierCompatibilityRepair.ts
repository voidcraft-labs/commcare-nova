/**
 * Finite repair for the two legacy `here()` defaults found by the XPath
 * carrier compatibility production scan. Core registers `here()` only in a
 * menu/detail context, so these XForm defaults could never run on device.
 * Clearing the default preserves the geopoint control's ordinary GPS capture.
 */

import { inspectXPathFunctionCalls } from "../../lib/commcare/xpath/functionCapabilities";
import {
	appendSyntheticBatch,
	loadSchemaAdmittedAppForInspection,
} from "../../lib/db/apps";
import { getAppDb } from "../../lib/db/pg";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "../../lib/doc/fieldParent";
import {
	type BlueprintDoc,
	type PersistableDoc,
	printXPath,
	type Uuid,
	uuidSchema,
	xpathPrintContext,
} from "../../lib/domain";
import { scanBlueprintXPathCarriers } from "./xpathCompatibilityScan";

const REPAIR_ACTOR = "system:xpath-carrier-compatibility" as const;
const REPAIR_BATCH_PREFIX = "xpath-carrier-compatibility-v1";

interface RepairTarget {
	readonly appId: string;
	readonly fieldUuid: Uuid;
}

export const XPATH_CARRIER_COMPATIBILITY_REPAIR_TARGETS: readonly RepairTarget[] =
	[
		{
			appId: "VtNBvpoGFvamB5ND5dzu",
			fieldUuid: uuidSchema.parse("736e6cd2-6ba7-4e8a-a880-30cd2a09b23e"),
		},
		{
			appId: "3O1PtJ7OaFn8VkUai0nw",
			fieldUuid: uuidSchema.parse("0832ab68-7aba-48b6-a7ac-26ef84cf2586"),
		},
	] as const;

export type XPathCarrierCompatibilityRepairStanding =
	| "repairable"
	| "clean"
	| "superseded"
	| "blocked";

export interface XPathCarrierCompatibilityRepairFinding {
	readonly appId: string;
	readonly fieldUuid: Uuid;
	readonly standing: XPathCarrierCompatibilityRepairStanding;
	readonly detail: string;
}

export interface XPathCarrierCompatibilityRepairPlan {
	readonly targetDoc: PersistableDoc;
	readonly findings: readonly XPathCarrierCompatibilityRepairFinding[];
}

export interface XPathCarrierCompatibilityRepairSnapshot {
	readonly appId: string;
	readonly appName: string;
	readonly mutationSeq: number;
	readonly blueprint: BlueprintDoc;
}

export interface XPathCarrierCompatibilityRepairReport {
	readonly scannedApps: number;
	readonly verifiedApps: number;
	readonly repairedApps: number;
	readonly repairedDefaults: number;
	readonly cleanDefaults: number;
	readonly supersededDefaults: number;
	readonly blockedDefaults: number;
}

async function assertFleetHasNoUnsafeJavaRosaCalls(): Promise<number> {
	const db = await getAppDb();
	const rows = await db.selectFrom("apps").select("id").execute();
	const unsafe: string[] = [];
	for (const { id } of rows) {
		const app = await loadSchemaAdmittedAppForInspection(id);
		if (app === null) {
			throw new Error(
				`XPath carrier post-repair verification could not load app ${id}.`,
			);
		}
		const doc = hydratePersistedBlueprint(app.blueprint);
		for (const occurrence of scanBlueprintXPathCarriers(doc)) {
			for (const call of occurrence.calls) {
				if (
					call.javaRosa === "unsupported" ||
					call.javaRosa === "context-handler" ||
					!call.validPathInitializer
				) {
					unsafe.push(`${id}:${occurrence.path}:${call.name}()`);
				}
			}
		}
	}
	if (unsafe.length > 0) {
		throw new Error(
			`XPath carrier post-repair verification found device-unsafe calls: ${unsafe.join(
				", ",
			)}`,
		);
	}
	return rows.length;
}

export function xpathCarrierCompatibilityRepairAppIds(): string[] {
	return [
		...new Set(
			XPATH_CARRIER_COMPATIBILITY_REPAIR_TARGETS.map((target) => target.appId),
		),
	].sort();
}

export function planXPathCarrierCompatibilityRepair(
	doc: BlueprintDoc,
): XPathCarrierCompatibilityRepairPlan {
	const targets = XPATH_CARRIER_COMPATIBILITY_REPAIR_TARGETS.filter(
		(target) => target.appId === doc.appId,
	);
	const targetDoc = hydratePersistedBlueprint(toPersistableDoc(doc));
	const findings: XPathCarrierCompatibilityRepairFinding[] = [];
	for (const target of targets) {
		const field = targetDoc.fields[target.fieldUuid];
		if (field === undefined) {
			findings.push({
				...target,
				standing: "superseded",
				detail: "a later edit removed the reviewed field",
			});
			continue;
		}
		if (!("default_value" in field) || field.default_value === undefined) {
			findings.push({
				...target,
				standing: "clean",
				detail: "the field has no default value",
			});
			continue;
		}
		const source = printXPath(
			field.default_value,
			xpathPrintContext(targetDoc),
		);
		if (source !== "here()") {
			const stillCallsHere = inspectXPathFunctionCalls(source).some(
				(call) => call.name === "here",
			);
			findings.push({
				...target,
				standing: stillCallsHere ? "blocked" : "superseded",
				detail: stillCallsHere
					? `the default still references here() but no longer matches the reviewed exact source: ${source}`
					: "a later edit replaced the reviewed here() default",
			});
			continue;
		}
		if (field.kind !== "geopoint") {
			findings.push({
				...target,
				standing: "blocked",
				detail: `the reviewed field now has kind ${field.kind}`,
			});
			continue;
		}
		const { default_value: _removed, ...repairedField } = field;
		targetDoc.fields[target.fieldUuid] = repairedField;
		findings.push({
			...target,
			standing: "repairable",
			detail: "clear the device-unsupported here() geopoint default",
		});
	}
	return { targetDoc: toPersistableDoc(targetDoc), findings };
}

export async function loadXPathCarrierCompatibilityRepairSnapshot(
	appId: string,
): Promise<XPathCarrierCompatibilityRepairSnapshot | null> {
	const app = await loadSchemaAdmittedAppForInspection(appId);
	if (app === null) return null;
	return {
		appId,
		appName: app.app_name,
		mutationSeq: app.mutation_seq,
		blueprint: hydratePersistedBlueprint(app.blueprint),
	};
}

export async function runXPathCarrierCompatibilityRepair(
	appIds: readonly string[] = xpathCarrierCompatibilityRepairAppIds(),
): Promise<XPathCarrierCompatibilityRepairReport> {
	let scannedApps = 0;
	let repairedApps = 0;
	let repairedDefaults = 0;
	let cleanDefaults = 0;
	let supersededDefaults = 0;
	let blockedDefaults = 0;
	for (const appId of appIds) {
		const snapshot = await loadXPathCarrierCompatibilityRepairSnapshot(appId);
		if (snapshot === null) continue;
		scannedApps += 1;
		const plan = planXPathCarrierCompatibilityRepair(snapshot.blueprint);
		const blocked = plan.findings.filter(
			(finding) => finding.standing === "blocked",
		);
		if (blocked.length > 0) {
			blockedDefaults += blocked.length;
			throw new Error(
				`XPath carrier compatibility repair blocked for ${appId}: ${blocked.map((finding) => `${finding.fieldUuid}: ${finding.detail}`).join("; ")}`,
			);
		}
		const repairable = plan.findings.filter(
			(finding) => finding.standing === "repairable",
		).length;
		cleanDefaults += plan.findings.filter(
			(finding) => finding.standing === "clean",
		).length;
		supersededDefaults += plan.findings.filter(
			(finding) => finding.standing === "superseded",
		).length;
		if (repairable === 0) continue;
		await appendSyntheticBatch({
			appId,
			expectedBaseSeq: snapshot.mutationSeq,
			targetDoc: plan.targetDoc,
			batchId: `${REPAIR_BATCH_PREFIX}:${appId}`,
			authority: {
				kind: "system",
				actorId: REPAIR_ACTOR,
				reason:
					"Clear scan-proven legacy here() geopoint defaults before enforcing the XForm XPath carrier gate.",
			},
		});
		repairedApps += 1;
		repairedDefaults += repairable;
	}
	const verifiedApps = await assertFleetHasNoUnsafeJavaRosaCalls();
	return {
		scannedApps,
		verifiedApps,
		repairedApps,
		repairedDefaults,
		cleanDefaults,
		supersededDefaults,
		blockedDefaults,
	};
}
