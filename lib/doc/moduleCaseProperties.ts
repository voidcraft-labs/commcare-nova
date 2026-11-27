import {
	type BlueprintDoc,
	type CaseType,
	columnPropertyBindings,
	effectiveCaseTypes,
	type Module,
	type RelationPath,
	requestedRecordTypes,
} from "@/lib/domain";
import { caseTypesWithRelations } from "@/lib/domain/appCaseRelations";
import { columnCaseScopes } from "@/lib/domain/expression/detailRowScope";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import { menuWithInheritedCaseSettings } from "@/lib/domain/listedForms";

interface MenuProperty {
	readonly slot:
		| "case_list_column_field"
		| "case_list_lookup_result_property"
		| "search_filter_property"
		| "search_input_property"
		| "search_related_property"
		| "search_request_related_property"
		| "search_order_property"
		| "search_filter_order_property";
	readonly name: string;
	readonly types: readonly string[];
	readonly throughRelation: boolean;
	rename(name: string): void;
}

/** A menu field may have a single stored spelling on several concrete types.
 * Renames, dependency edges and the ambiguity check share those same owners.
 * A reference-index pass shares the relation catalog across every carrier. */
export function* moduleCaseProperties(
	doc: BlueprintDoc,
	mod: Module,
	readRelations: () => readonly CaseType[] = () => caseTypesWithRelations(doc),
): Generator<MenuProperty> {
	const list = mod.caseListConfig;
	const lookup = list?.deviceLookup;
	if (lookup?.resultProperty !== undefined) {
		const caseType = menuWithInheritedCaseSettings(
			doc,
			mod.uuid,
			mod,
		)?.caseType;
		if (caseType !== undefined)
			yield {
				slot: "case_list_lookup_result_property",
				name: lookup.resultProperty,
				types: [caseType],
				throughRelation: false,
				rename(name) {
					lookup.resultProperty = name;
				},
			};
	}
	if (!mod.caseType) return;
	let relations: readonly CaseType[] | undefined;
	const catalog = () => {
		relations ??= readRelations();
		return relations;
	};
	const requested = requestedRecordTypes(mod.caseType, list);
	const relatedTypes = (via?: RelationPath) => [
		...new Set(
			requested.flatMap((type) => {
				const result = resolveRelationDestination(
					via,
					type,
					via === undefined || via.kind === "self" ? [] : catalog(),
				);
				return result.ok ? [result.caseType] : [];
			}),
		),
	];
	const declared = effectiveCaseTypes(doc);
	const owners = (types: readonly string[], property: string) =>
		types.filter((type) =>
			declared
				.find((item) => item.name === type)
				?.properties.some((item) => item.name === property),
		);
	for (const column of list?.columns ?? []) {
		if (column.kind === "calculated") continue;
		const types = [
			...new Set(
				columnCaseScopes(doc, mod, column).flatMap((type) =>
					column.via ? columnPropertyBindings(column, type, catalog()) : [type],
				),
			),
		];
		yield {
			slot: "case_list_column_field",
			name: column.field,
			types,
			throughRelation: column.via !== undefined,
			rename(name) {
				column.field = name;
			},
		};
	}
	for (const input of list?.searchInputs ?? []) {
		if (input.kind !== "simple") continue;
		const types = relatedTypes(input.via);
		yield {
			slot: "search_input_property",
			name: input.property,
			types: owners(types, input.property),
			throughRelation: input.via !== undefined && input.via.kind !== "self",
			rename(name) {
				if (input.matching === "project-space" && input.name === input.property)
					input.name = name;
				input.property = name;
			},
		};
	}
	const settings = mod.caseSearchConfig;
	const ordinary =
		settings && !("searchActionEnabled" in settings) ? settings : undefined;
	for (const [slot, order] of [
		["search_order_property", ordinary?.requestOrder ?? []],
		[
			"search_filter_order_property",
			(list?.searchFilters ?? []).flatMap((row) =>
				"order" in row ? row.order : [],
			),
		],
	] as const) {
		for (const term of order) {
			if (term.comparison === "discarded") continue;
			const types = owners(requested, term.property);
			yield {
				slot,
				name: term.property,
				types: types.length > 0 ? types : [mod.caseType],
				throughRelation: false,
				rename(name) {
					term.property = name;
				},
			};
		}
	}
	if (
		settings &&
		!("searchActionEnabled" in settings) &&
		settings.relatedRecordIdProperty
	) {
		const property = settings.relatedRecordIdProperty;
		yield {
			slot: "search_related_property",
			name: property,
			types: owners(requested, property),
			throughRelation: false,
			rename(name) {
				settings.relatedRecordIdProperty = name;
			},
		};
	}
	for (const filter of list?.searchFilters ?? []) {
		if ("target" in filter && filter.target.kind === "property") {
			const target = filter.target;
			const types = relatedTypes(
				target.ancestors
					? { kind: "ancestor", via: target.ancestors }
					: undefined,
			);
			yield {
				slot: "search_filter_property",
				name: target.property,
				types: owners(types, target.property),
				throughRelation: !!target.ancestors,
				rename(name) {
					target.property = name;
				},
			};
		}
		if ("kind" in filter && filter.kind === "related-record-id") {
			yield {
				slot: "search_request_related_property",
				name: filter.property,
				types: owners(requested, filter.property),
				throughRelation: false,
				rename(name) {
					filter.property = name;
				},
			};
		}
	}
}
