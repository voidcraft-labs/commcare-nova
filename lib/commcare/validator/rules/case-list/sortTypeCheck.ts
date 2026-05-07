/**
 * Rule: every `SortKey` on `caseListConfig.sort` references a
 * resolvable source AND declares a sort `type` compatible with the
 * source's effective case-property data type.
 *
 * Two arms drive resolution:
 *
 *   - `source.kind === "property"` — the source is a case property
 *     on the module's case type; its `data_type` (with the standard
 *     `?? "text"` fallback via `effectiveDataType`) selects the
 *     compatible `SortType` set via `applicableSortTypes(...)`.
 *
 *   - `source.kind === "calculated"` — the source is one of the
 *     module's `caseListConfig.calculatedColumns[i]`. Calculated
 *     sources have no resolvable data type at the source layer (per
 *     the spec at `lib/domain/modules.ts`'s `applicableSortTypes`
 *     comment block) — this rule only validates that the column id
 *     resolves; the per-source compatibility check is skipped because
 *     every sort type is structurally admissible against a calculated
 *     column.
 *
 * Standard CommCare list properties (`case_name`, `date_opened`, …)
 * resolve from outside the blueprint's declared `caseTypes` (CCHQ
 * provides them implicitly). The blueprint carries no `data_type`
 * declaration for them, so the per-type compatibility check has no
 * source of truth to compare against — the rule admits any declared
 * sort type for these properties and trusts the author's pick. The
 * declared sort type still routes through to wire emission; this
 * rule's role is structural reachability, not enforcement of CCHQ's
 * implicit per-property typing for the standard set.
 */

import { STANDARD_CASE_LIST_PROPERTIES } from "@/lib/commcare";
import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { applicableSortTypes } from "@/lib/domain";
import { effectiveDataType } from "@/lib/domain/casePropertyTypes";
import { type ValidationError, validationError } from "../../errors";

export function sortTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const sort = mod.caseListConfig?.sort ?? [];
	if (sort.length === 0) return [];

	const errors: ValidationError[] = [];
	const moduleCaseType = mod.caseType;
	const ct = moduleCaseType
		? doc.caseTypes?.find((c) => c.name === moduleCaseType)
		: undefined;
	const calculatedIds = new Set(
		(mod.caseListConfig?.calculatedColumns ?? []).map((c) => c.id),
	);

	for (let index = 0; index < sort.length; index++) {
		const key = sort[index];
		const source = key.source;
		const baseLoc = { moduleUuid, moduleName: mod.name };

		if (source.kind === "calculated") {
			// Calculated sources only need the column id to resolve. The
			// declared sort type is admissible regardless — the
			// calculated expression's wire emission carries its own type
			// at the runtime comparator layer.
			if (!calculatedIds.has(source.columnId)) {
				errors.push(
					validationError(
						"CASE_LIST_SORT_UNKNOWN_CALCULATED_COLUMN",
						"module",
						`Module "${mod.name}" sort key #${index + 1} references calculated column "${source.columnId}", but no calculated column with that id exists. Add a calculated column with id "${source.columnId}" or pick an existing one.`,
						baseLoc,
						{ index: String(index), columnId: source.columnId },
					),
				);
			}
			continue;
		}

		// Property-rooted sort: resolve the property against the module's
		// case type. Standard properties are admitted without a per-type
		// check (they're text-shaped at the wire layer regardless).
		const propertyName = source.property;
		if (STANDARD_CASE_LIST_PROPERTIES.has(propertyName)) continue;

		if (!ct) {
			// No case type schema in scope — can't resolve. Surface the
			// missing-property as a structural error so authors don't see
			// a silent green-light on a sort key targeting a property the
			// module's case type can't provide.
			errors.push(
				validationError(
					"CASE_LIST_SORT_UNKNOWN_PROPERTY",
					"module",
					`Module "${mod.name}" sort key #${index + 1} targets property "${propertyName}", but the module's case type ${moduleCaseType ? `("${moduleCaseType}")` : "is unset"} declares no schema. Either declare the case type's properties, or use a standard property like "case_name" / "date_opened".`,
					baseLoc,
					{ index: String(index), property: propertyName },
				),
			);
			continue;
		}

		const property = ct.properties.find((p) => p.name === propertyName);
		if (!property) {
			errors.push(
				validationError(
					"CASE_LIST_SORT_UNKNOWN_PROPERTY",
					"module",
					`Module "${mod.name}" sort key #${index + 1} references property "${propertyName}" on case type "${ct.name}", but no such property is declared. Add the property to the case type, write a field that saves to it via \`case_property_on\`, or pick a standard property.`,
					baseLoc,
					{ index: String(index), property: propertyName },
				),
			);
			continue;
		}

		const dataType = effectiveDataType(property);
		const allowed = applicableSortTypes(dataType);
		if (!allowed.includes(key.type)) {
			errors.push(
				validationError(
					"CASE_LIST_SORT_TYPE_INCOMPATIBLE",
					"module",
					`Module "${mod.name}" sort key #${index + 1} sorts "${propertyName}" (data_type "${dataType}") with sort type "${key.type}", but only ${allowed.map((t) => `"${t}"`).join(" / ")} ${allowed.length === 1 ? "is" : "are"} compatible with this property's type. Pick one of those, or change the property's data_type.`,
					baseLoc,
					{
						index: String(index),
						property: propertyName,
						declaredSortType: key.type,
						propertyDataType: dataType,
					},
				),
			);
		}
	}

	return errors;
}
