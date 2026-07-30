/**
 * Schema-derived inventory of lookup-carrier authoring slots.
 *
 * Lookup references run in the preview but have no wire spelling yet, so the
 * export boundary refuses any document that carries one
 * (`LOOKUP_CARRIER_EXPORT_NOT_ACTIVE`). This module is what that refusal reads:
 * every slot returned here becomes one finding, so a slot missed here is a
 * reference that reaches the wire.
 *
 * The walk covers detached entities as well as reachable ones — an unparented
 * field still persists, and export must not depend on tree reachability.
 *
 * A carrier's fingerprint spans the complete containing slot/root rather than
 * the table/column leaf, so two carriers naming the same ids are still distinct
 * when they evaluate differently — changing a `table-column` term's comparison
 * operator or peer literal changes the lookup's meaning while both stable ids
 * stay put. A select-source fingerprint covers the canonical
 * `optionsSource` value itself.
 */

import type {
	BlueprintDoc,
	CaseOperation,
	Field,
	Form,
	Module,
	Uuid,
} from "@/lib/domain";
import {
	asUuid,
	isOwnerOnlyCaseSearchConfig,
	searchInputDefault,
} from "@/lib/domain";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate/types";
import {
	walkExpressionNodes,
	walkExpressionTerms,
	walkPredicateExpressionNodes,
	walkTerms,
} from "@/lib/domain/predicate/walk";
import { canonicalLookupReferenceSubpath } from "./lookupReferences";

export type LookupCarrierOwnerKind =
	| "module"
	| "form"
	| "field"
	| "column"
	| "search-input"
	| "case-operation";

/** Nova-owned provenance for one complete authored carrier slot. */
export interface LookupCarrier {
	readonly ownerUuid: Uuid;
	readonly ownerKind: LookupCarrierOwnerKind;
	readonly slot: string;
	/** Stable logical member path below a registry slot; empty at its root. */
	readonly subpath: string;
	readonly fingerprint: string;
	readonly location: {
		readonly scope: "module" | "form" | "field";
		readonly moduleUuid?: Uuid;
		readonly moduleName?: string;
		readonly formUuid?: Uuid;
		readonly formName?: string;
		readonly fieldUuid?: Uuid;
		readonly fieldId?: string;
		readonly field?: string;
	};
}

/**
 * Canonical, lossless JSON spelling for a schema-shaped carrier payload.
 *
 * Object keys sort recursively, object `undefined` values are omitted, and an
 * array `undefined` value has JSON's `null` spelling. Carrier schemas contain
 * only JSON values, so retaining the complete canonical string as the
 * fingerprint avoids a permissive hash collision in the commit gate.
 */
export function canonicalLookupCarrierFingerprint(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
		case "boolean":
			return JSON.stringify(value);
		case "number":
			return JSON.stringify(value);
		case "undefined":
			return "null";
		case "object":
			if (Array.isArray(value)) {
				return `[${value
					.map((entry) => canonicalLookupCarrierFingerprint(entry))
					.join(",")}]`;
			}
			return `{${Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(
					([key, entry]) =>
						`${JSON.stringify(key)}:${canonicalLookupCarrierFingerprint(entry)}`,
				)
				.join(",")}}`;
		default:
			throw new Error("Lookup carrier payloads must be JSON-shaped values.");
	}
}

function predicateContainsLookupCarrier(predicate: Predicate): boolean {
	let found = false;
	walkTerms(predicate, (term) => {
		if (term.kind === "table-column") found = true;
	});
	if (found) return true;
	walkPredicateExpressionNodes(predicate, (expression) => {
		if (expression.kind === "table-lookup") found = true;
	});
	return found;
}

function expressionContainsLookupCarrier(expression: ValueExpression): boolean {
	let found = false;
	walkExpressionTerms(expression, (term) => {
		if (term.kind === "table-column") found = true;
	});
	if (found) return true;
	walkExpressionNodes(expression, (node) => {
		if (node.kind === "table-lookup") found = true;
	});
	return found;
}

type CarrierLocation = LookupCarrier["location"];

function compareUuid(
	left: { readonly uuid: Uuid },
	right: { readonly uuid: Uuid },
): number {
	return left.uuid < right.uuid ? -1 : left.uuid > right.uuid ? 1 : 0;
}

function sortedModules(doc: BlueprintDoc): Module[] {
	return Object.values(doc.modules).sort(compareUuid);
}

function sortedForms(doc: BlueprintDoc): Form[] {
	return Object.values(doc.forms).sort(compareUuid);
}

function sortedFields(doc: BlueprintDoc): Field[] {
	return Object.values(doc.fields).sort(compareUuid);
}

function owningModule(doc: BlueprintDoc, formUuid: Uuid): Module | undefined {
	for (const moduleUuid of Object.keys(doc.formOrder).sort()) {
		if (doc.formOrder[moduleUuid]?.includes(formUuid)) {
			return doc.modules[moduleUuid];
		}
	}
	return undefined;
}

function formLocation(doc: BlueprintDoc, form: Form): CarrierLocation {
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
		for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
			if (!parents.has(fieldUuid)) {
				parents.set(fieldUuid, asUuid(parentUuid));
			}
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
): CarrierLocation {
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

function addCarrier(
	carriers: LookupCarrier[],
	args: {
		readonly ownerUuid: Uuid;
		readonly ownerKind: LookupCarrierOwnerKind;
		readonly slot: string;
		readonly subpath?: string;
		readonly payload: unknown;
		readonly location: CarrierLocation;
	},
): void {
	carriers.push({
		ownerUuid: args.ownerUuid,
		ownerKind: args.ownerKind,
		slot: args.slot,
		subpath: args.subpath ?? "",
		fingerprint: canonicalLookupCarrierFingerprint(args.payload),
		location: args.location,
	});
}

function addPredicateSlot(
	carriers: LookupCarrier[],
	args: {
		readonly ownerUuid: Uuid;
		readonly ownerKind: LookupCarrierOwnerKind;
		readonly slot: string;
		readonly subpath?: string;
		readonly predicate: Predicate | undefined;
		readonly location: CarrierLocation;
	},
): void {
	if (
		args.predicate === undefined ||
		!predicateContainsLookupCarrier(args.predicate)
	) {
		return;
	}
	addCarrier(carriers, {
		...args,
		payload: args.predicate,
	});
}

function addExpressionSlot(
	carriers: LookupCarrier[],
	args: {
		readonly ownerUuid: Uuid;
		readonly ownerKind: LookupCarrierOwnerKind;
		readonly slot: string;
		readonly subpath?: string;
		readonly expression: ValueExpression | undefined;
		readonly location: CarrierLocation;
	},
): void {
	if (
		args.expression === undefined ||
		!expressionContainsLookupCarrier(args.expression)
	) {
		return;
	}
	addCarrier(carriers, {
		...args,
		payload: args.expression,
	});
}

/**
 * The single inventory walk for every carrier a case operation may own.
 *
 * Keeping this as a focused helper lets the edit planner inspect the operation
 * already in hand without rescanning every module, field, and unrelated form.
 * The full document collector calls the same helper, so the fail-closed edit
 * boundary and export validation cannot drift to different slot lists.
 */
function addCaseOperationCarriers(
	carriers: LookupCarrier[],
	operation: CaseOperation,
	location: CarrierLocation,
): void {
	const operationArgs = {
		ownerUuid: operation.uuid,
		ownerKind: "case-operation" as const,
		location,
	};
	addPredicateSlot(carriers, {
		...operationArgs,
		slot: "case_operation_condition",
		predicate: operation.condition,
	});
	addExpressionSlot(carriers, {
		...operationArgs,
		slot: "case_operation_name",
		expression: operation.name,
	});
	addExpressionSlot(carriers, {
		...operationArgs,
		slot: "case_operation_owner",
		expression: operation.owner,
	});
	addExpressionSlot(carriers, {
		...operationArgs,
		slot: "case_operation_rename",
		expression: operation.rename,
	});
	if (operation.target.kind === "expression") {
		addExpressionSlot(carriers, {
			...operationArgs,
			slot: "case_operation_target_expression",
			expression: operation.target.expr,
		});
	}
	for (const write of operation.writes ?? []) {
		addExpressionSlot(carriers, {
			...operationArgs,
			slot: "case_operation_write_value",
			subpath: canonicalLookupReferenceSubpath(["property", write.property]),
			expression: write.value,
		});
		addPredicateSlot(carriers, {
			...operationArgs,
			slot: "case_operation_write_condition",
			subpath: canonicalLookupReferenceSubpath(["property", write.property]),
			predicate: write.condition,
		});
	}
	for (const link of operation.links ?? []) {
		if (link?.target?.kind !== "expression") continue;
		addExpressionSlot(carriers, {
			...operationArgs,
			slot: "case_operation_link_target_expression",
			subpath: canonicalLookupReferenceSubpath(["identifier", link.identifier]),
			expression: link.target.expr,
		});
	}
}

/**
 * Return one deterministic entry per authored slot/root that contains any
 * lookup carrier.
 *
 * Sub-entities with their own stable identity (columns, Search inputs, case
 * operations) own their slots directly. Operation write/link arrays have no
 * element UUID, so their authored property/identifier key is the canonical
 * logical subpath. An unrelated sibling reorder therefore cannot rename a
 * historical carrier.
 */
export function collectLookupCarriers(
	doc: BlueprintDoc,
): readonly LookupCarrier[] {
	const carriers: LookupCarrier[] = [];

	for (const module of sortedModules(doc)) {
		const moduleUuid = module.uuid;
		const moduleLocation: CarrierLocation = {
			scope: "module",
			moduleUuid,
			moduleName: module.name,
		};

		addPredicateSlot(carriers, {
			ownerUuid: moduleUuid,
			ownerKind: "module",
			slot: "module_display_condition",
			predicate: module.displayCondition,
			location: {
				...moduleLocation,
				field: "displayCondition",
			},
		});
		addPredicateSlot(carriers, {
			ownerUuid: moduleUuid,
			ownerKind: "module",
			slot: "case_list_filter",
			predicate: module.caseListConfig?.filter,
			location: {
				...moduleLocation,
				field: "caseListConfig.filter",
			},
		});

		for (const column of module.caseListConfig?.columns ?? []) {
			if (column.kind !== "calculated") continue;
			addExpressionSlot(carriers, {
				ownerUuid: column.uuid,
				ownerKind: "column",
				slot: "case_list_column_expression",
				expression: column.expression,
				location: {
					...moduleLocation,
					field: "caseListConfig.columns.expression",
				},
			});
		}

		for (const input of module.caseListConfig?.searchInputs ?? []) {
			addExpressionSlot(carriers, {
				ownerUuid: input.uuid,
				ownerKind: "search-input",
				slot: "search_input_default",
				expression: searchInputDefault(input),
				location: {
					...moduleLocation,
					field: "caseListConfig.searchInputs.default",
				},
			});
			if (input.kind === "advanced") {
				addPredicateSlot(carriers, {
					ownerUuid: input.uuid,
					ownerKind: "search-input",
					slot: "search_input_predicate",
					predicate: input.predicate,
					location: {
						...moduleLocation,
						field: "caseListConfig.searchInputs.predicate",
					},
				});
			}
		}

		addPredicateSlot(carriers, {
			ownerUuid: moduleUuid,
			ownerKind: "module",
			slot: "search_button_display_condition",
			predicate:
				module.caseSearchConfig === undefined ||
				isOwnerOnlyCaseSearchConfig(module.caseSearchConfig)
					? undefined
					: module.caseSearchConfig.searchButtonDisplayCondition,
			location: {
				...moduleLocation,
				field: "caseSearchConfig.searchButtonDisplayCondition",
			},
		});
		addExpressionSlot(carriers, {
			ownerUuid: moduleUuid,
			ownerKind: "module",
			slot: "excluded_owner_ids",
			expression: module.caseSearchConfig?.excludedOwnerIds,
			location: {
				...moduleLocation,
				field: "caseSearchConfig.excludedOwnerIds",
			},
		});
	}

	for (const form of sortedForms(doc)) {
		const location = formLocation(doc, form);

		addPredicateSlot(carriers, {
			ownerUuid: form.uuid,
			ownerKind: "form",
			slot: "form_display_condition",
			predicate: form.displayCondition,
			location: {
				...location,
				field: "displayCondition",
			},
		});

		for (const operation of form.caseOperations ?? []) {
			addCaseOperationCarriers(carriers, operation, location);
		}
	}

	const fieldParents = parentByField(doc);
	for (const field of sortedFields(doc)) {
		if (
			(field.kind !== "single_select" && field.kind !== "multi_select") ||
			field.optionsSource.kind !== "lookup"
		) {
			continue;
		}
		addCarrier(carriers, {
			ownerUuid: field.uuid,
			ownerKind: "field",
			slot: "lookup_options_source",
			payload: field.optionsSource,
			location: fieldLocation(doc, field, fieldParents),
		});
	}

	return carriers;
}
