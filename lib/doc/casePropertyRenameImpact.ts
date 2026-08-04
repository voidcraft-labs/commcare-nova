import type { Draft } from "immer";
import {
	applyCasePropertyRenamePlan,
	type CasePropertyRenamePlanEntry,
	CasePropertyRenamePlanError,
	casePropertyCarrierNames,
	planCasePropertyRenames,
	rewriteCasePropertyCarriers,
} from "@/lib/doc/casePropertyRenames";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";

export type CasePropertyRenameImpactGroupKey =
	| "field-writers"
	| "case-operation-writes"
	| "typed-reads"
	| "catalog-declarations";

export interface CasePropertyRenameImpactGroup {
	readonly key: CasePropertyRenameImpactGroupKey;
	readonly occurrences: number;
	readonly carriers: number;
}

export interface CasePropertyRenameEntryImpact
	extends CasePropertyRenamePlanEntry {
	readonly occurrences: number;
}

export interface CasePropertyRenameImpact {
	readonly totalOccurrences: number;
	readonly totalCarriers: number;
	readonly groups: readonly CasePropertyRenameImpactGroup[];
	readonly byRename: readonly CasePropertyRenameEntryImpact[];
}

interface ChangedCarrier {
	readonly path: string;
	readonly before: string;
	readonly after: string;
}

const GROUP_ORDER: readonly CasePropertyRenameImpactGroupKey[] = [
	"field-writers",
	"case-operation-writes",
	"typed-reads",
	"catalog-declarations",
];

function decodePointerPart(value: string): string {
	return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function pointerParts(path: string): readonly string[] {
	return path
		.split("/")
		.slice(1)
		.map((part) => decodePointerPart(part));
}

function impactGroup(path: string): CasePropertyRenameImpactGroupKey {
	const parts = pointerParts(path);
	if (
		parts[0] === "fields" &&
		parts[2] === "caseWrite" &&
		parts[3] === "property"
	) {
		return "field-writers";
	}
	if (
		parts[0] === "forms" &&
		parts[2] === "caseOperations" &&
		parts[4] === "writes" &&
		parts[6] === "property"
	) {
		return "case-operation-writes";
	}
	if (
		parts[0] === "caseTypes" &&
		parts[2] === "properties" &&
		parts[4] === "name"
	) {
		return "catalog-declarations";
	}
	return "typed-reads";
}

function carrierKey(path: string, doc: BlueprintDoc): string {
	const parts = pointerParts(path);
	if (
		(parts[0] === "fields" ||
			parts[0] === "forms" ||
			parts[0] === "modules" ||
			parts[0] === "automations") &&
		parts[1] !== undefined
	) {
		return `${parts[0]}:${parts[1]}`;
	}
	if (parts[0] === "caseTypes") {
		const caseTypeIndex = Number(parts[1]);
		const propertyIndex = Number(parts[3]);
		const caseType = doc.caseTypes?.[caseTypeIndex];
		const property = caseType?.properties[propertyIndex];
		return `case-property:${caseType?.name ?? parts[1]}:${property?.name ?? parts[3]}`;
	}
	return "app";
}

function changedCarriers(
	beforeDoc: BlueprintDoc,
	afterDoc: BlueprintDoc,
): readonly ChangedCarrier[] {
	const before = new Map(
		casePropertyCarrierNames(beforeDoc).map((carrier) => [
			carrier.path,
			carrier.value,
		]),
	);
	const after = new Map(
		casePropertyCarrierNames(afterDoc).map((carrier) => [
			carrier.path,
			carrier.value,
		]),
	);
	const changed: ChangedCarrier[] = [];
	for (const [path, value] of before) {
		const next = after.get(path);
		if (next !== undefined && next !== value) {
			changed.push({ path, before: value, after: next });
		}
	}
	return changed;
}

function clonePersistableDoc(doc: BlueprintDoc): BlueprintDoc {
	return structuredClone(toPersistableDoc(doc)) as BlueprintDoc;
}

function changedForEntry(
	doc: BlueprintDoc,
	entry: CasePropertyRenamePlanEntry,
): readonly ChangedCarrier[] {
	const next = clonePersistableDoc(doc);
	rewriteCasePropertyCarriers(next, (caseType, property) =>
		caseType === entry.caseType && property === entry.from
			? entry.to
			: undefined,
	);
	return changedCarriers(doc, next);
}

/**
 * Exact document impact for one valid simultaneous case-property rename.
 *
 * The same carrier walker that applies the semantic command produces this
 * projection. A carrier is counted only when its stored property-name leaf
 * actually changes, so new AST/reference slots cannot silently escape the
 * impact summary: parity with the apply walker is structural, not a second
 * hand-maintained inventory.
 */
export function casePropertyRenameImpact(
	doc: BlueprintDoc,
	renames: readonly CasePropertyRenamePlanEntry[],
): CasePropertyRenameImpact {
	const planned = planCasePropertyRenames(doc, {
		kind: "renameCaseProperties",
		renames: renames.map(({ caseType, from, to }) => ({
			caseType,
			from,
			to,
		})),
	});
	if (!planned.ok) throw new CasePropertyRenamePlanError(planned.issue);

	const next = clonePersistableDoc(doc);
	applyCasePropertyRenamePlan(next as Draft<BlueprintDoc>, planned.plan);
	const changed = changedCarriers(doc, next);
	const groupOccurrences = new Map<CasePropertyRenameImpactGroupKey, number>();
	const groupCarriers = new Map<
		CasePropertyRenameImpactGroupKey,
		Set<string>
	>();
	const allCarriers = new Set<string>();
	for (const carrier of changed) {
		const group = impactGroup(carrier.path);
		groupOccurrences.set(group, (groupOccurrences.get(group) ?? 0) + 1);
		const owner = carrierKey(carrier.path, doc);
		allCarriers.add(owner);
		const owners = groupCarriers.get(group) ?? new Set<string>();
		owners.add(owner);
		groupCarriers.set(group, owners);
	}

	return {
		totalOccurrences: changed.length,
		totalCarriers: allCarriers.size,
		groups: GROUP_ORDER.map((key) => ({
			key,
			occurrences: groupOccurrences.get(key) ?? 0,
			carriers: groupCarriers.get(key)?.size ?? 0,
		})),
		byRename: planned.plan.entries.map((entry) => ({
			...entry,
			occurrences: changedForEntry(doc, entry).length,
		})),
	};
}
