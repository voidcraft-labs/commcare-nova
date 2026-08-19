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
	casePropertyIsAttachmentSlot,
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
		// Checked before the type requirement, and for every kind rather
		// than only the demanding ones: a property whose writers all save
		// an attachment has no scalar value at any type, so `plain` — the
		// escape hatch the mismatch message recommends — is just as empty
		// here as `date` is. Unknown stays permissive everywhere else in
		// this file because the wire is stringly; this is the one case
		// where the document positively says there is nothing to read.
		if (casePropertyIsAttachmentSlot(doc, mod.caseType, col.field)) {
			errors.push(buildAttachmentSlotError(mod, moduleUuid, index, col));
			continue;
		}
		const requirement = columnKindPropertyRequirement(col.kind);
		if (requirement === null) continue; // universal kinds accept everything
		// Raw `data_type` off the effective view, NOT
		// `effectiveDataType(...)` — absent must stay absent (unknown
		// is permissive here), and an unresolvable property is
		// `columnReferences`' finding, not a second one here.
		const resolvedType = properties.find(
			(p) => p.name === col.field,
		)?.data_type;
		if (resolvedType === undefined) continue;
		if (columnKindAcceptsPropertyType(col.kind, resolvedType)) continue;
		errors.push(
			buildMismatchError(
				mod,
				moduleUuid,
				index,
				col,
				resolvedType,
				requirement,
			),
		);
	}
	return errors;
}

function buildMismatchError(
	mod: Module,
	moduleUuid: Uuid,
	index: number,
	col: Exclude<Column, { kind: "calculated" }>,
	resolvedType: CasePropertyDataType,
	requirement: keyof typeof REQUIREMENT_PHRASE,
): ValidationError {
	const phrase = REQUIREMENT_PHRASE[requirement];
	const columnName = col.header || col.field;
	return validationError(
		"CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH",
		"module",
		`The "${columnName}" column (column #${index + 1}) on the case list of module "${mod.name}" formats the case property "${col.field}" as ${phrase}, but that property's type is "${resolvedType}". Either point the column at ${phrase}, change the column's kind to one that renders "${resolvedType}" values (plain always works), or change the type of the fields that write "${col.field}".`,
		{ moduleUuid, moduleName: mod.name },
		{
			field: col.field,
			columnUuid: col.uuid,
			index: String(index),
			columnKind: col.kind,
			resolvedType,
		},
	);
}

function buildAttachmentSlotError(
	mod: Module,
	moduleUuid: Uuid,
	index: number,
	col: Exclude<Column, { kind: "calculated" }>,
): ValidationError {
	const columnName = col.header || col.field;
	return validationError(
		"CASE_LIST_COLUMN_OVER_ATTACHMENT_SLOT",
		"module",
		`The "${columnName}" column (column #${index + 1}) on the case list of module "${mod.name}" shows the case property "${col.field}", but every question saving that property saves its file as a case attachment, so the property itself holds no value and the column would be empty on every case. Either point the column at a property that holds a value, or change those questions to save a link to the file instead, which a link column can open.`,
		{ moduleUuid, moduleName: mod.name },
		{
			field: col.field,
			columnUuid: col.uuid,
			index: String(index),
			columnKind: col.kind,
		},
	);
}
