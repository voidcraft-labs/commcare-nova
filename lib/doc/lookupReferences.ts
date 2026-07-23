/**
 * Structural lookup-reference extraction.
 *
 * Lookup rows live outside `BlueprintDoc`, while domain carriers store stable
 * lookup table/column identities in the doc. This module is the
 * client-safe seam between those structural carriers, validation, and the
 * normalized reference-edge writer. S05a registers the first production
 * carriers after the dormant schemas and rolling envelope can preserve them.
 *
 * Extractors are explicit immutable values. Tests may inject a synthetic
 * registry; production validation imports the frozen registry below. There is no
 * mutable global registration API, so test order, module evaluation order, and
 * long-lived server instances cannot change what a document means.
 */

import type { BlueprintDoc, Field, Form, Module, Uuid } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate";
import type {
	LookupDataType,
	LookupRevision,
	LookupTableDefinition,
} from "@/lib/lookup/types";

/** External lookup definitions available to one pure validation run. */
export type LookupValidationContext =
	| {
			readonly kind: "available";
			readonly projectId: string;
			readonly projectRevision: LookupRevision;
			readonly definitions: readonly LookupTableDefinition[];
	  }
	| { readonly kind: "unavailable" };

/** The explicit context for a client/test that has no definition snapshot. */
export const LOOKUP_CONTEXT_UNAVAILABLE: LookupValidationContext =
	Object.freeze({
		kind: "unavailable",
	});

export type LookupReferenceValidationScope =
	| "app"
	| "module"
	| "form"
	| "field";

/**
 * Validator provenance copied at extraction time. Names are display-only;
 * UUIDs plus `field` are the stable anchors used by validator locations.
 */
export interface LookupReferenceValidationLocation {
	readonly scope: LookupReferenceValidationScope;
	readonly moduleUuid?: Uuid;
	readonly moduleName?: string;
	readonly formUuid?: Uuid;
	readonly formName?: string;
	readonly fieldUuid?: Uuid;
	readonly fieldId?: string;
	readonly field?: string;
}

export type LookupReferencePathSegment = string | number;

/**
 * Canonical, typed JSON-pointer-like path for a nested reference inside one
 * registry slot. Key and index segments have different prefixes so `"0"` and
 * `0` cannot alias; RFC 6901 escaping keeps separators unambiguous.
 */
export function canonicalLookupReferenceSubpath(
	segments: readonly LookupReferencePathSegment[],
): string {
	if (segments.length === 0) return "";
	return segments
		.map((segment) => {
			if (typeof segment === "number") {
				if (!Number.isSafeInteger(segment) || segment < 0) {
					throw new Error(
						"Lookup reference path indices must be nonnegative safe integers.",
					);
				}
				return `/i:${segment}`;
			}
			return `/k:${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`;
		})
		.join("");
}

/** One exact structural occurrence in a future lookup-bearing carrier. */
export interface LookupReferenceOccurrence {
	readonly carrierUuid: Uuid;
	/** Stable registry-owned slot id, never an array position or display name. */
	readonly registrySlot: string;
	/** Canonical path below the registry slot; empty string means the slot root. */
	readonly subpath: string;
	readonly tableId: LookupTableId;
	readonly columnId?: LookupColumnId;
	/**
	 * Extractor-owned type contract for a column-bearing occurrence. Absent means
	 * the carrier accepts every lookup data type; a supplied set is nonempty.
	 */
	readonly acceptedColumnTypes?: readonly LookupDataType[];
	readonly location: LookupReferenceValidationLocation;
}

/** Candidate shape returned by one registry entry before slot/path stamping. */
export interface ExtractedLookupReference {
	readonly carrierUuid: Uuid;
	readonly subpath: readonly LookupReferencePathSegment[];
	readonly tableId: LookupTableId;
	readonly columnId?: LookupColumnId;
	readonly acceptedColumnTypes?: readonly LookupDataType[];
	readonly location: LookupReferenceValidationLocation;
}

/** One immutable structural carrier walker. */
export interface LookupReferenceExtractor {
	readonly registrySlot: string;
	readonly extract: (doc: BlueprintDoc) => readonly ExtractedLookupReference[];
}

export type LookupReferenceExtractorRegistry =
	readonly LookupReferenceExtractor[];

/**
 * Collect the two lookup identity node kinds from one known Predicate /
 * ValueExpression carrier. The path is the literal typed-AST object path, not
 * a traversal counter, so edits in a sibling branch cannot rename an existing
 * occurrence. A caller may prefix that path with a semantic member anchor for
 * an array member that has no UUID. Walking object structure inside a
 * schema-owned AST also means a new recursive operator arm cannot silently
 * hide nested lookup identities.
 */
function extractAstLookupReferences(input: {
	readonly carrierUuid: Uuid;
	readonly ast: Predicate | ValueExpression;
	readonly subpath?: readonly LookupReferencePathSegment[];
	readonly location: LookupReferenceValidationLocation;
}): ExtractedLookupReference[] {
	const references: ExtractedLookupReference[] = [];

	const walk = (
		node: unknown,
		path: readonly LookupReferencePathSegment[],
	): void => {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (let index = 0; index < node.length; index++) {
				walk(node[index], [...path, index]);
			}
			return;
		}

		const record = node as Readonly<Record<string, unknown>>;
		if (record.kind === "table-column") {
			const term = record as unknown as {
				readonly tableId: LookupTableId;
				readonly columnId: LookupColumnId;
			};
			references.push({
				carrierUuid: input.carrierUuid,
				subpath: [...path, "columnId"],
				tableId: term.tableId,
				columnId: term.columnId,
				location: input.location,
			});
			return;
		}

		if (record.kind === "table-lookup") {
			const expression = record as unknown as {
				readonly tableId: LookupTableId;
				readonly resultColumnId: LookupColumnId;
			};
			references.push({
				carrierUuid: input.carrierUuid,
				subpath: [...path, "resultColumnId"],
				tableId: expression.tableId,
				columnId: expression.resultColumnId,
				location: input.location,
			});
		}

		for (const [key, value] of Object.entries(record)) {
			if (
				key === "kind" ||
				key === "tableId" ||
				key === "columnId" ||
				key === "resultColumnId"
			) {
				continue;
			}
			walk(value, [...path, key]);
		}
	};

	walk(input.ast, input.subpath ?? []);
	return references;
}

function byUuid<T extends { readonly uuid: Uuid }>(left: T, right: T): number {
	return left.uuid.localeCompare(right.uuid);
}

function sortedModules(doc: BlueprintDoc): Module[] {
	return Object.values(doc.modules).sort(byUuid);
}

function sortedForms(doc: BlueprintDoc): Form[] {
	return Object.values(doc.forms).sort(byUuid);
}

function sortedFields(doc: BlueprintDoc): Field[] {
	return Object.values(doc.fields).sort(byUuid);
}

function moduleLocation(module: Module): LookupReferenceValidationLocation {
	return {
		scope: "module",
		moduleUuid: module.uuid,
		moduleName: module.name,
	};
}

function owningModule(doc: BlueprintDoc, formUuid: Uuid): Module | undefined {
	for (const moduleUuid of Object.keys(doc.formOrder).sort()) {
		if (!doc.formOrder[moduleUuid]?.includes(formUuid)) continue;
		return doc.modules[moduleUuid];
	}
	return undefined;
}

function formLocation(
	doc: BlueprintDoc,
	form: Form,
): LookupReferenceValidationLocation {
	const module = owningModule(doc, form.uuid);
	return {
		scope: "form",
		...(module !== undefined && {
			moduleUuid: module.uuid,
			moduleName: module.name,
		}),
		formUuid: form.uuid,
		formName: form.name,
	};
}

function parentByField(doc: BlueprintDoc): ReadonlyMap<Uuid, Uuid> {
	const parents = new Map<Uuid, Uuid>();
	for (const parentUuid of Object.keys(doc.fieldOrder).sort()) {
		for (const childUuid of doc.fieldOrder[parentUuid] ?? []) {
			if (!parents.has(childUuid)) parents.set(childUuid, parentUuid as Uuid);
		}
	}
	return parents;
}

function owningForm(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	parents: ReadonlyMap<Uuid, Uuid>,
): Form | undefined {
	const visited = new Set<Uuid>();
	let current = fieldUuid;
	while (!visited.has(current)) {
		visited.add(current);
		const parent = parents.get(current);
		if (parent === undefined) return undefined;
		const form = doc.forms[parent];
		if (form !== undefined) return form;
		current = parent;
	}
	return undefined;
}

function fieldLocation(
	doc: BlueprintDoc,
	field: Field,
	parents: ReadonlyMap<Uuid, Uuid>,
): LookupReferenceValidationLocation {
	const form = owningForm(doc, field.uuid, parents);
	const module = form === undefined ? undefined : owningModule(doc, form.uuid);
	return {
		scope: "field",
		...(module !== undefined && {
			moduleUuid: module.uuid,
			moduleName: module.name,
		}),
		...(form !== undefined && {
			formUuid: form.uuid,
			formName: form.name,
		}),
		fieldUuid: field.uuid,
		fieldId: field.id,
		field: "optionsSource",
	};
}

function extractLookupOptionsSources(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	const references: ExtractedLookupReference[] = [];
	const parents = parentByField(doc);

	for (const field of sortedFields(doc)) {
		if (field.kind !== "single_select" && field.kind !== "multi_select") {
			continue;
		}
		const source = field.optionsSource;
		if (source === undefined) continue;
		const location = fieldLocation(doc, field, parents);
		references.push(
			{
				carrierUuid: field.uuid,
				subpath: ["valueColumnId"],
				tableId: source.tableId,
				columnId: source.valueColumnId,
				location,
			},
			{
				carrierUuid: field.uuid,
				subpath: ["labelColumnId"],
				tableId: source.tableId,
				columnId: source.labelColumnId,
				location,
			},
		);
		if (source.filter !== undefined) {
			references.push(
				...extractAstLookupReferences({
					carrierUuid: field.uuid,
					ast: source.filter,
					subpath: ["filter"],
					location,
				}),
			);
		}
	}

	return references;
}

function extractModuleDisplayConditions(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedModules(doc).flatMap((module) =>
		module.displayCondition === undefined
			? []
			: extractAstLookupReferences({
					carrierUuid: module.uuid,
					ast: module.displayCondition,
					location: moduleLocation(module),
				}),
	);
}

function extractFormDisplayConditions(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedForms(doc).flatMap((form) =>
		form.displayCondition === undefined
			? []
			: extractAstLookupReferences({
					carrierUuid: form.uuid,
					ast: form.displayCondition,
					location: formLocation(doc, form),
				}),
	);
}

function extractCalculatedColumnExpressions(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedModules(doc).flatMap((module) =>
		(module.caseListConfig?.columns ?? []).flatMap((column) =>
			column.kind !== "calculated"
				? []
				: extractAstLookupReferences({
						carrierUuid: column.uuid,
						ast: column.expression,
						location: moduleLocation(module),
					}),
		),
	);
}

function extractCaseListFilters(doc: BlueprintDoc): ExtractedLookupReference[] {
	return sortedModules(doc).flatMap((module) => {
		const filter = module.caseListConfig?.filter;
		return filter === undefined
			? []
			: extractAstLookupReferences({
					carrierUuid: module.uuid,
					ast: filter,
					location: moduleLocation(module),
				});
	});
}

function extractSearchInputDefaults(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedModules(doc).flatMap((module) =>
		(module.caseListConfig?.searchInputs ?? []).flatMap((input) =>
			input.default === undefined
				? []
				: extractAstLookupReferences({
						carrierUuid: input.uuid,
						ast: input.default,
						location: moduleLocation(module),
					}),
		),
	);
}

function extractSearchInputPredicates(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedModules(doc).flatMap((module) =>
		(module.caseListConfig?.searchInputs ?? []).flatMap((input) =>
			input.kind !== "advanced"
				? []
				: extractAstLookupReferences({
						carrierUuid: input.uuid,
						ast: input.predicate,
						location: moduleLocation(module),
					}),
		),
	);
}

function extractSearchButtonDisplayConditions(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedModules(doc).flatMap((module) => {
		const condition = module.caseSearchConfig?.searchButtonDisplayCondition;
		return condition === undefined
			? []
			: extractAstLookupReferences({
					carrierUuid: module.uuid,
					ast: condition,
					location: moduleLocation(module),
				});
	});
}

function extractExcludedOwnerIds(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedModules(doc).flatMap((module) => {
		const expression = module.caseSearchConfig?.excludedOwnerIds;
		return expression === undefined
			? []
			: extractAstLookupReferences({
					carrierUuid: module.uuid,
					ast: expression,
					location: moduleLocation(module),
				});
	});
}

function extractCaseOperationTargetExpressions(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedForms(doc).flatMap((form) =>
		(form.caseOperations ?? []).flatMap((operation) =>
			operation.target.kind !== "expression"
				? []
				: extractAstLookupReferences({
						carrierUuid: operation.uuid,
						ast: operation.target.expr,
						location: formLocation(doc, form),
					}),
		),
	);
}

function extractCaseOperationConditions(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedForms(doc).flatMap((form) =>
		(form.caseOperations ?? []).flatMap((operation) =>
			operation.condition === undefined
				? []
				: extractAstLookupReferences({
						carrierUuid: operation.uuid,
						ast: operation.condition,
						location: formLocation(doc, form),
					}),
		),
	);
}

function extractCaseOperationNames(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedForms(doc).flatMap((form) =>
		(form.caseOperations ?? []).flatMap((operation) =>
			operation.name === undefined
				? []
				: extractAstLookupReferences({
						carrierUuid: operation.uuid,
						ast: operation.name,
						location: formLocation(doc, form),
					}),
		),
	);
}

function extractCaseOperationOwners(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedForms(doc).flatMap((form) =>
		(form.caseOperations ?? []).flatMap((operation) =>
			operation.owner === undefined
				? []
				: extractAstLookupReferences({
						carrierUuid: operation.uuid,
						ast: operation.owner,
						location: formLocation(doc, form),
					}),
		),
	);
}

function extractCaseOperationRenames(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedForms(doc).flatMap((form) =>
		(form.caseOperations ?? []).flatMap((operation) =>
			operation.rename === undefined
				? []
				: extractAstLookupReferences({
						carrierUuid: operation.uuid,
						ast: operation.rename,
						location: formLocation(doc, form),
					}),
		),
	);
}

function extractCaseOperationWriteValues(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedForms(doc).flatMap((form) =>
		(form.caseOperations ?? []).flatMap((operation) =>
			(operation.writes ?? []).flatMap((write) =>
				extractAstLookupReferences({
					carrierUuid: operation.uuid,
					ast: write.value,
					subpath: ["property", write.property],
					location: formLocation(doc, form),
				}),
			),
		),
	);
}

function extractCaseOperationWriteConditions(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedForms(doc).flatMap((form) =>
		(form.caseOperations ?? []).flatMap((operation) =>
			(operation.writes ?? []).flatMap((write) =>
				write.condition === undefined
					? []
					: extractAstLookupReferences({
							carrierUuid: operation.uuid,
							ast: write.condition,
							subpath: ["property", write.property],
							location: formLocation(doc, form),
						}),
			),
		),
	);
}

function extractCaseOperationLinkTargetExpressions(
	doc: BlueprintDoc,
): ExtractedLookupReference[] {
	return sortedForms(doc).flatMap((form) =>
		(form.caseOperations ?? []).flatMap((operation) =>
			(operation.links ?? []).flatMap((link) =>
				link.target?.kind !== "expression"
					? []
					: extractAstLookupReferences({
							carrierUuid: operation.uuid,
							ast: link.target.expr,
							subpath: ["identifier", link.identifier],
							location: formLocation(doc, form),
						}),
			),
		),
	);
}

function productionExtractor(
	registrySlot: string,
	extract: LookupReferenceExtractor["extract"],
): LookupReferenceExtractor {
	return Object.freeze({ registrySlot, extract });
}

/**
 * S05a production registry. Each entry names one immutable domain slot; array
 * members without their own UUID (operation writes/links) retain the owning
 * operation UUID and use their validator-enforced unique property/identifier
 * as a semantic member anchor below the slot.
 */
export const PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS: LookupReferenceExtractorRegistry =
	Object.freeze([
		productionExtractor("lookup_options_source", extractLookupOptionsSources),
		productionExtractor(
			"module_display_condition",
			extractModuleDisplayConditions,
		),
		productionExtractor("form_display_condition", extractFormDisplayConditions),
		productionExtractor(
			"case_list_column_expression",
			extractCalculatedColumnExpressions,
		),
		productionExtractor("case_list_filter", extractCaseListFilters),
		productionExtractor("search_input_default", extractSearchInputDefaults),
		productionExtractor("search_input_predicate", extractSearchInputPredicates),
		productionExtractor(
			"search_button_display_condition",
			extractSearchButtonDisplayConditions,
		),
		productionExtractor("excluded_owner_ids", extractExcludedOwnerIds),
		productionExtractor(
			"case_operation_target_expression",
			extractCaseOperationTargetExpressions,
		),
		productionExtractor(
			"case_operation_condition",
			extractCaseOperationConditions,
		),
		productionExtractor("case_operation_name", extractCaseOperationNames),
		productionExtractor("case_operation_owner", extractCaseOperationOwners),
		productionExtractor("case_operation_rename", extractCaseOperationRenames),
		productionExtractor(
			"case_operation_write_value",
			extractCaseOperationWriteValues,
		),
		productionExtractor(
			"case_operation_write_condition",
			extractCaseOperationWriteConditions,
		),
		productionExtractor(
			"case_operation_link_target_expression",
			extractCaseOperationLinkTargetExpressions,
		),
	]);

const LOOKUP_DATA_TYPE_ORDER: Readonly<Record<LookupDataType, number>> = {
	text: 0,
	int: 1,
	decimal: 2,
	date: 3,
	time: 4,
	datetime: 5,
};

function normalizeAcceptedColumnTypes(
	types: readonly LookupDataType[] | undefined,
): readonly LookupDataType[] | undefined {
	if (types === undefined) return undefined;
	const normalized = [...new Set(types)].sort(
		(a, b) => LOOKUP_DATA_TYPE_ORDER[a] - LOOKUP_DATA_TYPE_ORDER[b],
	);
	return Object.freeze(normalized);
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareOccurrences(
	a: LookupReferenceOccurrence,
	b: LookupReferenceOccurrence,
): number {
	return (
		compareStrings(a.registrySlot, b.registrySlot) ||
		compareStrings(a.carrierUuid, b.carrierUuid) ||
		compareStrings(a.subpath, b.subpath) ||
		compareStrings(a.tableId, b.tableId) ||
		compareStrings(a.columnId ?? "", b.columnId ?? "")
	);
}

/** Extract deterministic occurrences through an explicit immutable registry. */
export function extractLookupReferenceOccurrences(
	doc: BlueprintDoc,
	registry: LookupReferenceExtractorRegistry,
): readonly LookupReferenceOccurrence[] {
	const seenSlots = new Set<string>();
	const occurrences: LookupReferenceOccurrence[] = [];

	for (const extractor of registry) {
		if (extractor.registrySlot.length === 0) {
			throw new Error("Lookup reference registry slots must not be empty.");
		}
		if (seenSlots.has(extractor.registrySlot)) {
			throw new Error(
				`Duplicate lookup reference registry slot: ${extractor.registrySlot}`,
			);
		}
		seenSlots.add(extractor.registrySlot);

		for (const extracted of extractor.extract(doc)) {
			if (
				extracted.acceptedColumnTypes !== undefined &&
				extracted.columnId === undefined
			) {
				throw new Error(
					`Lookup reference extractor ${extractor.registrySlot} declared accepted column types without a column target.`,
				);
			}
			if (extracted.acceptedColumnTypes?.length === 0) {
				throw new Error(
					`Lookup reference extractor ${extractor.registrySlot} supplied an empty accepted column type set; omit it to accept every type.`,
				);
			}
			occurrences.push({
				carrierUuid: extracted.carrierUuid,
				registrySlot: extractor.registrySlot,
				subpath: canonicalLookupReferenceSubpath(extracted.subpath),
				tableId: extracted.tableId,
				...(extracted.columnId !== undefined && {
					columnId: extracted.columnId,
				}),
				...(extracted.acceptedColumnTypes !== undefined && {
					acceptedColumnTypes: normalizeAcceptedColumnTypes(
						extracted.acceptedColumnTypes,
					),
				}),
				location: extracted.location,
			});
		}
	}

	return Object.freeze(occurrences.sort(compareOccurrences));
}

export interface LookupColumnReferenceTarget {
	readonly tableId: LookupTableId;
	readonly columnId: LookupColumnId;
}

/** Exact normalized app-to-resource edge set. */
export interface LookupReferenceTargetSet {
	readonly tableIds: readonly LookupTableId[];
	readonly columnTargets: readonly LookupColumnReferenceTarget[];
}

const EMPTY_LOOKUP_TABLE_IDS: readonly LookupTableId[] = Object.freeze([]);
const EMPTY_LOOKUP_COLUMN_TARGETS: readonly LookupColumnReferenceTarget[] =
	Object.freeze([]);

export const EMPTY_LOOKUP_REFERENCE_TARGETS: LookupReferenceTargetSet =
	Object.freeze({
		tableIds: EMPTY_LOOKUP_TABLE_IDS,
		columnTargets: EMPTY_LOOKUP_COLUMN_TARGETS,
	});

export interface LookupReferenceTargetSetInput {
	readonly tableIds?: Iterable<LookupTableId>;
	readonly columnTargets?: Iterable<LookupColumnReferenceTarget>;
}

/**
 * Sort and deduplicate exact targets. A column target always contributes its
 * parent table target, matching the database FK/materialization contract.
 */
export function normalizeLookupReferenceTargetSet(
	input: LookupReferenceTargetSetInput,
): LookupReferenceTargetSet {
	const tableIds = new Set(input.tableIds ?? []);
	const columnsByKey = new Map<string, LookupColumnReferenceTarget>();

	for (const target of input.columnTargets ?? []) {
		tableIds.add(target.tableId);
		columnsByKey.set(`${target.tableId}\0${target.columnId}`, {
			tableId: target.tableId,
			columnId: target.columnId,
		});
	}

	if (tableIds.size === 0 && columnsByKey.size === 0) {
		return EMPTY_LOOKUP_REFERENCE_TARGETS;
	}

	const normalizedTableIds = Object.freeze([...tableIds].sort(compareStrings));
	const normalizedColumnTargets = Object.freeze(
		[...columnsByKey.values()].sort(
			(a, b) =>
				compareStrings(a.tableId, b.tableId) ||
				compareStrings(a.columnId, b.columnId),
		),
	);

	return Object.freeze({
		tableIds: normalizedTableIds,
		columnTargets: normalizedColumnTargets,
	});
}

/** Project structural occurrences to the exact persisted target sets. */
export function lookupReferenceTargetsFromOccurrences(
	occurrences: readonly LookupReferenceOccurrence[],
): LookupReferenceTargetSet {
	return normalizeLookupReferenceTargetSet({
		tableIds: occurrences.map((occurrence) => occurrence.tableId),
		columnTargets: occurrences.flatMap((occurrence) =>
			occurrence.columnId === undefined
				? []
				: [
						{
							tableId: occurrence.tableId,
							columnId: occurrence.columnId,
						},
					],
		),
	});
}

/**
 * Extract the complete normalized target set for one doc. Production callers
 * omit the registry and therefore use the immutable production registry;
 * synthetic tests/races may pass an explicit registry.
 */
export function extractLookupReferenceTargets(
	doc: BlueprintDoc,
	registry: LookupReferenceExtractorRegistry = PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
): LookupReferenceTargetSet {
	return lookupReferenceTargetsFromOccurrences(
		extractLookupReferenceOccurrences(doc, registry),
	);
}

/** Normalized set union used by seeded races and future carrier partitions. */
export function unionLookupReferenceTargetSets(
	...sets: readonly LookupReferenceTargetSet[]
): LookupReferenceTargetSet {
	return normalizeLookupReferenceTargetSet({
		tableIds: sets.flatMap((set) => [...set.tableIds]),
		columnTargets: sets.flatMap((set) => [...set.columnTargets]),
	});
}
