/**
 * Exact classifier and history-preserving writer for the three historical RDT
 * case-list filters exposed by the built-in-status lifecycle cutover.
 *
 * The repair is intentionally finite: it recognizes only the app/module/value
 * tuples observed by the production scan, requires the old predicate byte
 * shape and a compatible `status_value` declaration, and changes only the
 * property reference. A user correction that no longer reads built-in status
 * is treated as superseding this migration; every other divergence blocks.
 */

import { appendSyntheticBatch } from "../../lib/db/apps";
import { getAppDb } from "../../lib/db/pg";
import { deepEqual } from "../../lib/doc/deepEqual";
import { type PersistableDoc, type Uuid, uuidSchema } from "../../lib/domain";
import { type Predicate, walkTerms } from "../../lib/domain/predicate";
import { safePersistedSequence } from "../../lib/utils/persistedSequence";
import { loadPersistedBlueprintReadOnly } from "./loadPersistedBlueprint";

const REPAIR_ACTOR = "system:case-status-filter-cutover" as const;
const REPAIR_BATCH_PREFIX = "case-status-filter-cutover-v1";

interface RepairTarget {
	readonly appId: string;
	readonly moduleUuid: Uuid;
	readonly caseType: "rdt_sample";
	readonly value: "collected" | "delivered";
	readonly literalDataType: "text" | "single_select";
}

export const CASE_STATUS_FILTER_REPAIR_TARGETS: readonly RepairTarget[] = [
	{
		appId: "NJEsUdfCjbgBqAv3nXDN",
		moduleUuid: uuidSchema.parse("6e22e5f6-83c9-4892-b325-f1a6725640b9"),
		caseType: "rdt_sample",
		value: "collected",
		literalDataType: "single_select",
	},
	{
		appId: "NJEsUdfCjbgBqAv3nXDN",
		moduleUuid: uuidSchema.parse("37b1183e-05ff-40b8-acec-76633a69380b"),
		caseType: "rdt_sample",
		value: "delivered",
		literalDataType: "single_select",
	},
	{
		appId: "vPgekIpjxRVLyVhJORw6",
		moduleUuid: uuidSchema.parse("4f420f0b-a16c-4d9b-98eb-712de9078d5d"),
		caseType: "rdt_sample",
		value: "collected",
		literalDataType: "text",
	},
] as const;

export type CaseStatusFilterRepairStanding =
	| "repairable"
	| "clean"
	| "superseded"
	| "blocked";

export interface CaseStatusFilterRepairFinding {
	readonly appId: string;
	readonly moduleUuid: Uuid;
	readonly standing: CaseStatusFilterRepairStanding;
	readonly detail: string;
}

export interface CaseStatusFilterRepairPlan {
	readonly targetDoc: PersistableDoc;
	readonly findings: readonly CaseStatusFilterRepairFinding[];
}

export interface CaseStatusFilterRepairAppSnapshot {
	readonly appId: string;
	readonly appName: string;
	readonly mutationSeq: number;
	readonly blueprint: PersistableDoc;
}

export interface CaseStatusFilterRepairReport {
	readonly scannedApps: number;
	readonly repairedApps: number;
	readonly repairedFilters: number;
	readonly cleanFilters: number;
	readonly supersededFilters: number;
	readonly blockedFilters: number;
}

function expectedFilter(
	target: RepairTarget,
	property: "status" | "status_value",
): Predicate {
	return {
		kind: "eq",
		left: {
			kind: "term",
			term: {
				kind: "prop",
				caseType: target.caseType,
				property,
				via: { kind: "self" },
			},
		},
		right: {
			kind: "term",
			term: {
				kind: "literal",
				value: target.value,
				data_type: target.literalDataType,
			},
		},
	};
}

function filterReadsBuiltInStatus(predicate: Predicate | undefined): boolean {
	if (predicate === undefined) return false;
	let found = false;
	walkTerms(predicate, (term) => {
		if (term.kind === "prop" && term.property === "status") found = true;
	});
	return found;
}

function compatibleStatusValueProperty(
	doc: PersistableDoc,
	target: RepairTarget,
): boolean {
	const caseType = doc.caseTypes?.find(
		(candidate) => candidate.name === target.caseType,
	);
	const property = caseType?.properties.find(
		(candidate) => candidate.name === "status_value",
	);
	return (
		property?.data_type === "single_select" &&
		property.options?.some((option) => option.value === target.value) === true
	);
}

function replaceFilter(
	doc: PersistableDoc,
	target: RepairTarget,
	filter: Predicate,
): PersistableDoc {
	const module = doc.modules[target.moduleUuid];
	if (module?.caseListConfig === undefined) return doc;
	return {
		...doc,
		modules: {
			...doc.modules,
			[target.moduleUuid]: {
				...module,
				caseListConfig: { ...module.caseListConfig, filter },
			},
		},
	};
}

export function planCaseStatusFilterRepair(
	doc: PersistableDoc,
): CaseStatusFilterRepairPlan {
	const targets = CASE_STATUS_FILTER_REPAIR_TARGETS.filter(
		(target) => target.appId === doc.appId,
	);
	let targetDoc = doc;
	const findings: CaseStatusFilterRepairFinding[] = [];
	for (const target of targets) {
		const module = targetDoc.modules[target.moduleUuid];
		if (module === undefined || module.caseType !== target.caseType) {
			findings.push({
				appId: target.appId,
				moduleUuid: target.moduleUuid,
				standing: "blocked",
				detail: "the expected module or case-type binding no longer exists",
			});
			continue;
		}
		const current = module.caseListConfig?.filter;
		const oldFilter = expectedFilter(target, "status");
		const repairedFilter = expectedFilter(target, "status_value");
		if (deepEqual(current, repairedFilter)) {
			findings.push({
				appId: target.appId,
				moduleUuid: target.moduleUuid,
				standing: "clean",
				detail: `already reads status_value = ${target.value}`,
			});
			continue;
		}
		if (!deepEqual(current, oldFilter)) {
			const stillReadsStatus = filterReadsBuiltInStatus(current);
			findings.push({
				appId: target.appId,
				moduleUuid: target.moduleUuid,
				standing: stillReadsStatus ? "blocked" : "superseded",
				detail: stillReadsStatus
					? "the filter still reads built-in status but no longer matches the reviewed source shape"
					: "a later edit replaced or removed the historical built-in-status filter",
			});
			continue;
		}
		if (!compatibleStatusValueProperty(targetDoc, target)) {
			findings.push({
				appId: target.appId,
				moduleUuid: target.moduleUuid,
				standing: "blocked",
				detail: `status_value no longer declares the ${target.value} option`,
			});
			continue;
		}
		targetDoc = replaceFilter(targetDoc, target, repairedFilter);
		findings.push({
			appId: target.appId,
			moduleUuid: target.moduleUuid,
			standing: "repairable",
			detail: `change built-in status to status_value for ${target.value}`,
		});
	}
	return { targetDoc, findings };
}

export async function loadCaseStatusFilterRepairSnapshot(
	appId: string,
): Promise<CaseStatusFilterRepairAppSnapshot | null> {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const row = await tx
				.selectFrom("apps")
				.select(["id", "app_name", "mutation_seq"])
				.where("id", "=", appId)
				.executeTakeFirst();
			if (row === undefined) return null;
			const blueprint = await loadPersistedBlueprintReadOnly(tx, appId);
			if (blueprint === null) return null;
			return {
				appId,
				appName: row.app_name,
				mutationSeq: safePersistedSequence(
					row.mutation_seq,
					`apps.mutation_seq for app ${appId}`,
				),
				blueprint,
			};
		});
}

export async function runCaseStatusFilterRepair(): Promise<CaseStatusFilterRepairReport> {
	const appIds = [
		...new Set(CASE_STATUS_FILTER_REPAIR_TARGETS.map((target) => target.appId)),
	].sort();
	let scannedApps = 0;
	let repairedApps = 0;
	let repairedFilters = 0;
	let cleanFilters = 0;
	let supersededFilters = 0;
	let blockedFilters = 0;
	for (const appId of appIds) {
		const snapshot = await loadCaseStatusFilterRepairSnapshot(appId);
		if (snapshot === null) continue;
		scannedApps++;
		const plan = planCaseStatusFilterRepair(snapshot.blueprint);
		const blocked = plan.findings.filter(
			(finding) => finding.standing === "blocked",
		);
		if (blocked.length > 0) {
			blockedFilters += blocked.length;
			throw new Error(
				`Case-status filter repair blocked for ${appId}: ${blocked.map((finding) => `${finding.moduleUuid}: ${finding.detail}`).join("; ")}`,
			);
		}
		const repairable = plan.findings.filter(
			(finding) => finding.standing === "repairable",
		).length;
		cleanFilters += plan.findings.filter(
			(finding) => finding.standing === "clean",
		).length;
		supersededFilters += plan.findings.filter(
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
					"Repair historical program-stage filters exposed by the built-in case-status lifecycle gate.",
			},
		});
		repairedApps++;
		repairedFilters += repairable;
	}
	return {
		scannedApps,
		repairedApps,
		repairedFilters,
		cleanFilters,
		supersededFilters,
		blockedFilters,
	};
}
