// lib/domain/columnRelation.ts
//
// The case a property column reads. A column with no `via` shows a property
// of the list's own case; a column with one shows a property of the case its
// indices reach, whose type the catalog gives the walk exactly as it gives a
// `prop` read's (`expression/relationDestination.ts`): `parent` reaches the
// catalog's parent type and every other index the type its step names.

import type { CaseProperty, CaseType } from "./blueprint";
import type { CasePropertyDataType } from "./casePropertyTypes";
import { CaseRelationCatalog } from "./caseRelations";
import { humanizeId } from "./idSlug";
import type { PropertyColumn } from "./modules";
import { proseText } from "./prose";
import {
	isStandardCaseListProperty,
	STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
} from "./standardCaseProperties";

export function reachedPropertyType(
	column: Pick<PropertyColumn, "via" | "field">,
	origin: string,
	types: readonly CaseType[],
): CasePropertyDataType {
	const scope = columnPropertyScope(column, origin, types);
	return commonReachedPropertyType(
		column.field,
		scope.open,
		scope.types.map(
			(name) =>
				types
					.find((type) => type.name === name)
					?.properties.find((property) => property.name === column.field)
					?.data_type,
		),
	);
}

export function commonReachedPropertyType(
	name: string,
	open: boolean,
	opinions: readonly (CasePropertyDataType | undefined)[],
): CasePropertyDataType {
	if (isStandardCaseListProperty(name))
		return STANDARD_CASE_LIST_PROPERTY_DATA_TYPES[name];
	const type = opinions[0];
	return !open && type !== undefined && opinions.every((one) => one === type)
		? type
		: "text";
}

export function columnPropertyScope(
	column: Pick<PropertyColumn, "via">,
	listCaseType: string | undefined,
	caseTypes: readonly CaseType[],
) {
	if (listCaseType === undefined) return { types: [], open: false };
	if (column.via === undefined) return { types: [listCaseType], open: false };
	return new CaseRelationCatalog(caseTypes).reached(listCaseType, column.via);
}

/** An open native index is also a dependency of each declared case type that
 * holds the named property. A read can reach a row from outside the catalog. */
export function columnPropertyBindings(
	column: Pick<PropertyColumn, "via" | "field">,
	listCaseType: string,
	caseTypes: readonly CaseType[],
): readonly string[] {
	const scope = columnPropertyScope(column, listCaseType, caseTypes);
	if (!scope.open) return scope.types;
	return [
		...new Set([
			...scope.types,
			...caseTypes
				.filter((type) =>
					type.properties.some((property) => property.name === column.field),
				)
				.map((type) => type.name),
		]),
	].sort();
}

export function columnPropertyCaseType(
	column: Pick<PropertyColumn, "via">,
	listCaseType: string | undefined,
	caseTypes: readonly CaseType[],
): string | undefined {
	const scope = columnPropertyScope(column, listCaseType, caseTypes);
	return !scope.open && scope.types.length === 1 ? scope.types[0] : undefined;
}

/** Every closed destination must use the same projected name. Keeping an
 * unknown destination's current spelling preserves what an older case reads. */
export function reachedPropertyRename(
	column: Pick<PropertyColumn, "via" | "field">,
	origin: string,
	types: readonly CaseType[],
	resolve: (caseType: string, property: string) => string | undefined,
): { conflict: boolean; name: string } {
	const scope = columnPropertyScope(column, origin, types);
	const bindings = scope.open
		? columnPropertyBindings(column, origin, types)
		: scope.types;
	const names = new Set(
		bindings.map((type) => resolve(type, column.field) ?? column.field),
	);
	if (scope.open || names.size === 0) names.add(column.field);
	return {
		conflict: names.size > 1,
		name: names.size === 1 ? [...names][0] : column.field,
	};
}

/** A unique reached type supplies its actual property definitions. Several
 * types can agree on a value type while having different choice labels. An
 * open link can read an older property absent from every known definition. */
export function propertiesReachedByColumn(
	column: Pick<PropertyColumn, "via">,
	origin: string | undefined,
	types: readonly CaseType[],
	currentField?: string,
): readonly CaseProperty[] {
	if (origin === undefined) return [];
	const scope = columnPropertyScope(column, origin, types);
	if (!scope.open && scope.types.length === 1)
		return types.find((type) => type.name === scope.types[0])?.properties ?? [];
	const options = new Map<string, CaseProperty[]>();
	for (const type of types) {
		if (!scope.open && !scope.types.includes(type.name)) continue;
		for (const property of type.properties) {
			const group = options.get(property.name) ?? [];
			group.push(property);
			options.set(property.name, group);
		}
	}
	if (currentField && !options.has(currentField)) options.set(currentField, []);
	return [...options].map(([name, group]) => {
		const label =
			group.length > 0 &&
			group.every(
				(property) =>
					JSON.stringify(property.label) === JSON.stringify(group[0].label),
			)
				? group[0].label
				: proseText(humanizeId(name));
		return {
			name,
			label,
			data_type: commonReachedPropertyType(
				name,
				scope.open || group.length < scope.types.length,
				group.map((property) => property.data_type),
			),
		};
	});
}
