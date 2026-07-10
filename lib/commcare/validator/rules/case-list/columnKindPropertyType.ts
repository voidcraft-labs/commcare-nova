/**
 * Rule: a column kind with a property-type requirement (`date` /
 * `interval` need a date-typed property; `phone` needs a text-shaped
 * one) only renders a property whose EFFECTIVE type satisfies it.
 *
 * The verdict is the shared domain predicate
 * (`lib/domain/columnApplicability.ts::columnKindAcceptsPropertyType`)
 * over the shared effective view — the same pair the builder's
 * kind-replace menu, inline hints, and workspace tab dots consume —
 * so the gate can never approve a column the workspace displays as
 * broken, and the workspace can never flag one the gate accepted.
 *
 * **Unknown passes.** The effective view leaves `data_type` absent
 * when neither a declaration nor the writing fields pin a type, and
 * an unknown type is "no opinion", never an error — CommCare's wire
 * is stringly, so a mistyped display column renders poorly rather
 * than crashing, and refusing to manufacture findings out of missing
 * metadata is what keeps SA-authored apps clean by construction.
 * Unresolvable properties are likewise skipped — existence is
 * `columnReferences`' finding, not a second one here.
 */

import {
	type BlueprintDoc,
	type CasePropertyDataType,
	type Column,
	type ColumnKind,
	columnKindAcceptsPropertyType,
	columnKindPropertyRequirement,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";
import { validationContextFor } from "./shared";

/** Human phrasing per requirement family, for the error sentence. */
const REQUIREMENT_PHRASE: Record<"date-typed" | "text-shaped", string> = {
	"date-typed": "a date or datetime property",
	"text-shaped": "a text-shaped property",
};

export function columnKindPropertyType(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (!config || !mod.caseType) return [];

	const { augmentedCaseTypes } = validationContextFor(doc);
	const properties = augmentedCaseTypes.find(
		(ct) => ct.name === mod.caseType,
	)?.properties;
	if (properties === undefined) return [];

	const errors: ValidationError[] = [];
	for (let index = 0; index < config.columns.length; index++) {
		const col = config.columns[index];
		if (col.kind === "calculated") continue;
		// Raw `data_type` off the effective view, NOT
		// `effectiveDataType(...)` — absent must stay absent (unknown
		// is permissive here), and an unresolvable property is
		// `columnReferences`' finding.
		const property = properties.find((p) => p.name === col.field);
		if (property === undefined) continue;
		if (columnKindAcceptsPropertyType(col.kind, property.data_type)) continue;
		errors.push(
			buildMismatchError(mod, moduleUuid, index, col, property.data_type),
		);
	}
	return errors;
}

function buildMismatchError(
	mod: Module,
	moduleUuid: Uuid,
	index: number,
	col: Exclude<Column, { kind: "calculated" }>,
	resolvedType: CasePropertyDataType | undefined,
): ValidationError {
	const requirement = columnKindPropertyRequirement(col.kind as ColumnKind);
	const phrase =
		requirement === null
			? "a compatible property" // unreachable — universal kinds always accept
			: REQUIREMENT_PHRASE[requirement];
	return validationError(
		"CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH",
		"module",
		`Column "${col.header}" (column #${index + 1}) on the case list of module "${mod.name}" is a ${col.kind} column reading the case property "${col.field}", but that property's type is "${resolvedType}" and a ${col.kind} column needs ${phrase}. Either point the column at ${phrase}, change the column's kind to one that renders "${resolvedType}" values (plain always works), or change the type of the fields that write "${col.field}".`,
		{ moduleUuid, moduleName: mod.name },
		{
			field: col.field,
			columnUuid: col.uuid,
			index: String(index),
			columnKind: col.kind,
			resolvedType: resolvedType ?? "",
		},
	);
}
