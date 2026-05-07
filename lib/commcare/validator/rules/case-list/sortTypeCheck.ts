/**
 * Rule: every `SortKey` on `caseListConfig.sort` references a
 * resolvable source AND declares a sort `type` compatible with the
 * source's effective case-property data type.
 *
 * Two arms drive resolution:
 *
 *   - `source.kind === "property"` — the source is a case property
 *     on the module's case type. Resolution follows the rule set's
 *     shared model (see `./shared.ts`): a property exists if it's
 *     declared on `ct.properties[]` OR a form field writes to it via
 *     `case_property_on === ct.name`, OR it's one of CommCare's
 *     standard list properties. The declared type drives
 *     `applicableSortTypes(...)`; writer-derived properties default
 *     to `text` per `effectiveDataType`'s `?? "text"` convention;
 *     standard properties consult the
 *     `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES` table for their
 *     implicit typing.
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

import {
	STANDARD_CASE_LIST_PROPERTIES,
	STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
} from "@/lib/commcare";
import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { applicableSortTypes } from "@/lib/domain";
import { effectiveDataType } from "@/lib/domain/casePropertyTypes";
import { type ValidationError, validationError } from "../../errors";
import { collectCaseProperties } from "../../index";

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
	// Writer-derived property names: every property that some field
	// saves to via `case_property_on === moduleCaseType`. Used as the
	// secondary admission set when `ct.properties[]` doesn't declare
	// the property — sort keys against a writer-only property resolve
	// without firing UNKNOWN_PROPERTY. Their data type defaults to
	// `text` (no declared schema → `effectiveDataType`'s fallback).
	const writerProps = collectCaseProperties(doc, moduleCaseType) ?? new Set();

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

		// Property-rooted sort: resolve the property through the rule
		// set's shared resolution model — declared schema, writer-
		// derived, or standard — and pick the data type accordingly.
		const propertyName = source.property;

		// Standard properties: implicit data type from the CommCare
		// standard table. The check still runs against
		// `applicableSortTypes(...)` because some standard properties
		// are date-typed (`date_opened`, `last_modified`) — picking a
		// `plain` sort against `date_opened` is fine; `date` against
		// `case_name` is structurally rejected.
		if (STANDARD_CASE_LIST_PROPERTIES.has(propertyName)) {
			const dataType =
				STANDARD_CASE_LIST_PROPERTY_DATA_TYPES[propertyName] ?? "text";
			const allowed = applicableSortTypes(dataType);
			if (!allowed.includes(key.type)) {
				errors.push(
					validationError(
						"CASE_LIST_SORT_TYPE_INCOMPATIBLE",
						"module",
						`Module "${mod.name}" sort key #${index + 1} sorts standard property "${propertyName}" (data_type "${dataType}") with sort type "${key.type}", but only ${allowed.map((t) => `"${t}"`).join(" / ")} ${allowed.length === 1 ? "is" : "are"} compatible with this property's type.`,
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
			continue;
		}

		// Declared property on the case type's `properties[]` schema.
		const property = ct?.properties.find((p) => p.name === propertyName);
		if (property) {
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
			continue;
		}

		// Writer-derived property: some field writes to it via
		// `case_property_on`, but the case type's schema doesn't
		// declare a `data_type`. Default to `text` (matching
		// `effectiveDataType`'s convention). Only `plain` sort is
		// structurally admissible against text per
		// `applicableSortTypes`.
		if (writerProps.has(propertyName)) {
			const allowed = applicableSortTypes("text");
			if (!allowed.includes(key.type)) {
				errors.push(
					validationError(
						"CASE_LIST_SORT_TYPE_INCOMPATIBLE",
						"module",
						`Module "${mod.name}" sort key #${index + 1} sorts "${propertyName}" with sort type "${key.type}", but the case type's schema declares no data_type for this property — it defaults to "text", which is only compatible with ${allowed.map((t) => `"${t}"`).join(" / ")}. Either declare the property's data_type on the case type, or pick a "plain" sort.`,
						baseLoc,
						{
							index: String(index),
							property: propertyName,
							declaredSortType: key.type,
							propertyDataType: "text",
						},
					),
				);
			}
			continue;
		}

		// Property is unresolvable — neither declared, writer-derived,
		// nor standard. Surface the missing-property as a structural
		// error.
		errors.push(
			validationError(
				"CASE_LIST_SORT_UNKNOWN_PROPERTY",
				"module",
				`Module "${mod.name}" sort key #${index + 1} references property "${propertyName}"${
					moduleCaseType ? ` on case type "${moduleCaseType}"` : ""
				}, but no such property is declared on the case type, written to by any field via \`case_property_on\`, or part of the standard set ("case_name", "date_opened", …). Add the property to the case type's \`properties[]\`, or pick one that exists.`,
				baseLoc,
				{ index: String(index), property: propertyName },
			),
		);
	}

	return errors;
}
