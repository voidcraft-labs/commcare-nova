/** A native detail reads its saved index names from the local or Search
 * roster. The menu needs a case, HQ must keep the path in the field editor,
 * and the default parent step carries no per-column type annotation. */

import {
	type BlueprintDoc,
	type Column,
	type ColumnVia,
	columnFieldText,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { hqColumnFieldText, isHqDetailField } from "../../../suite/wire";
import { type ValidationError, validationError } from "../../errors";

type RelationReason = "unresolved" | "parent-type" | "worker" | "index-name";

export function columnRelation(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (config === undefined) return [];
	const errors: ValidationError[] = [];
	for (let index = 0; index < config.columns.length; index++) {
		const column = config.columns[index];
		if (column.kind === "calculated" || column.via === undefined) continue;
		const reason = relationReason(column, column.via, mod, doc);
		if (reason !== undefined)
			errors.push(relationError(mod, moduleUuid, index, column, reason));
	}
	return errors;
}

function relationReason(
	column: Exclude<Column, { kind: "calculated" }>,
	via: ColumnVia,
	mod: Module,
	doc: BlueprintDoc,
): RelationReason | undefined {
	if (via[0].identifier === "user") return "worker";
	if (!isHqDetailField(hqColumnFieldText(columnFieldText(column))))
		return "index-name";
	if (
		via.some(
			(step) =>
				step.identifier === "parent" && step.throughCaseType !== undefined,
		)
	)
		return "parent-type";
	// HQ builds a native case-property path without a type filter. The
	// stored case index determines the reached row, including in Search.
	if (
		mod.caseType === undefined ||
		!doc.caseTypes?.some((one) => one.name === mod.caseType)
	)
		return "unresolved";
	if (
		via.some(
			(step) =>
				step.throughCaseType !== undefined &&
				!doc.caseTypes?.some((type) => type.name === step.throughCaseType),
		)
	)
		return "unresolved";
	return undefined;
}

const REASON_SENTENCE: Record<RelationReason, (column: string) => string> = {
	unresolved: (column) =>
		`"${column}" reads its value through a link that doesn't lead to one case type: a parent step needs the case type to have a parent, and any other link needs to name the case type it reaches. You can choose the case above again, or show information of this case itself.`,
	"parent-type": (column) =>
		`"${column}" reads through a parent link that names its case type, but the parent's case type comes from this case type's own parent, and CommCare HQ keeps no type on the column. You can leave the type off the parent step.`,
	worker: (column) =>
		`"${column}" reads through a link called user, but CommCare HQ reads a column starting with user as the worker's own information, not a case above this one. You can rename the link, or show the worker's information another way.`,
	"index-name": (column) =>
		`"${column}" reads through a link whose name doesn't start with a letter, and CommCare HQ keeps a case list column's links only where each name starts with one. You can rename the link so it starts with a letter.`,
};

function relationError(
	mod: Module,
	moduleUuid: Uuid,
	index: number,
	column: Exclude<Column, { kind: "calculated" }>,
	reason: RelationReason,
): ValidationError {
	const name = column.header || columnFieldText(column);
	return validationError(
		"CASE_LIST_COLUMN_RELATION_INVALID",
		"module",
		`In the case list of "${mod.name}", ${REASON_SENTENCE[reason](name)}`,
		{ moduleUuid, moduleName: mod.name },
		{
			field: column.field,
			columnUuid: column.uuid,
			index: String(index),
			reason,
			fieldText: columnFieldText(column),
		},
	);
}
