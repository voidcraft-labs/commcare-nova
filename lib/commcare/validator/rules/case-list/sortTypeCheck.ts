/**
 * Rule: every `SortKey` on `caseListConfig.sort` references a
 * resolvable source AND declares a sort `type` compatible with the
 * source's effective case-property data type.
 *
 * Two arms drive resolution:
 *
 *   - `source.kind === "property"` — the source is a case property
 *     on the module's case type. Resolution follows the rule set's
 *     shared model (see `./shared.ts`'s `resolvePropertyDataType`):
 *     declared schema → CommCare standard → writer-derived. The
 *     resolved type drives `applicableSortTypes(...)`.
 *
 *   - `source.kind === "calculated"` — the source is one of the
 *     module's `caseListConfig.calculatedColumns[i]`. Calculated
 *     sources have no resolvable data type at the source layer (per
 *     the spec at `lib/domain/modules.ts`'s `applicableSortTypes`
 *     comment block) — this rule only validates that the column id
 *     resolves; the per-source compatibility check is skipped because
 *     every sort type is structurally admissible against a calculated
 *     column.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { applicableSortTypes } from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";
import { resolvePropertyDataType } from "./shared";

export function sortTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const sort = mod.caseListConfig?.sort ?? [];
	if (sort.length === 0) return [];

	const errors: ValidationError[] = [];
	const moduleCaseType = mod.caseType;
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

		// Property-rooted sort: resolve through the rule set's shared
		// 3-arm model — backed by the cached augmented case-type list,
		// so per-pass cost is one walk regardless of sort key count.
		// `undefined` means the property exists nowhere.
		const propertyName = source.property;
		if (!moduleCaseType) {
			errors.push(unknownPropertyError(mod, baseLoc, index, propertyName));
			continue;
		}

		const dataType = resolvePropertyDataType(doc, moduleCaseType, propertyName);
		if (dataType === undefined) {
			errors.push(unknownPropertyError(mod, baseLoc, index, propertyName));
			continue;
		}

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

function unknownPropertyError(
	mod: Module,
	baseLoc: { moduleUuid: Uuid; moduleName: string },
	index: number,
	propertyName: string,
): ValidationError {
	return validationError(
		"CASE_LIST_SORT_UNKNOWN_PROPERTY",
		"module",
		`Module "${mod.name}" sort key #${index + 1} references property "${propertyName}"${
			mod.caseType ? ` on case type "${mod.caseType}"` : ""
		}, but no such property is declared on the case type, written to by any field via \`case_property_on\`, or part of the standard set ("case_name", "date_opened", …). Add the property to the case type's \`properties[]\`, or pick one that exists.`,
		baseLoc,
		{ index: String(index), property: propertyName },
	);
}
