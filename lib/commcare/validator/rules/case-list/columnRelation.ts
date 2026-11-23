import { columnCaseScopes } from "@/lib/domain/expression/detailRowScope";
/** A native detail reads its saved index names from the local or Search
 * roster. The menu needs a case, HQ must keep the path in the field editor,
 * and the default parent step carries no per-column type annotation. A field
 * of a Details tab over child cases walks from that child type. */

import {
	type BlueprintDoc,
	type Column,
	type ColumnVia,
	columnFieldText,
	effectiveCaseSearchConfig,
	hqStoresColumnAsExpression,
	type Module,
	type Uuid,
} from "@/lib/domain";
import {
	columnPropertyCaseType,
	namedWorkerColumnProperty,
} from "@/lib/domain/columnRelation";
import { hqColumnFieldText, isHqDetailField } from "../../../suite/wire";
import { type ValidationError, validationError } from "../../errors";

type RelationReason =
	| "worker-info"
	| "worker-walk"
	| "owner-field"
	| "unresolved"
	| "parent-type"
	| "worker"
	| "index-name"
	| "search";

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
		if (column.kind === "calculated") continue;
		const binding = column.readFrom
			? namedWorkerColumnProperty(
					column.field,
					Object.values(doc.userProperties ?? {}),
				)
			: undefined;
		const own =
			binding?.uuid !== column.workerPropertyUuid
				? "worker-info"
				: column.showOwner && column.field !== "owner_id"
					? "owner-field"
					: column.readFrom && column.via
						? "worker-walk"
						: undefined;
		if (own !== undefined) {
			errors.push(relationError(mod, moduleUuid, index, column, own));
			continue;
		}
		if (column.via === undefined) continue;
		const origins = columnCaseScopes(doc, mod, column);
		const reasons = new Set(
			(origins.length > 0 ? origins : [undefined]).map((origin) =>
				relationReason(
					column,
					column.via as ColumnVia,
					origin,
					doc,
					effectiveCaseSearchConfig(mod) !== undefined,
				),
			),
		);
		for (const reason of reasons)
			if (reason !== undefined)
				errors.push(relationError(mod, moduleUuid, index, column, reason));
	}
	return errors;
}

function relationReason(
	column: Exclude<Column, { kind: "calculated" }>,
	via: ColumnVia,
	origin: string | undefined,
	doc: BlueprintDoc,
	offersSearch: boolean,
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
	// stored case index determines the reached row, including in Search
	// for a column HQ keeps as a property field.
	if (
		origin === undefined ||
		!doc.caseTypes?.some((one) => one.name === origin)
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
	// HQ stores a link, an interval and a plain column showing option labels
	// as an expression it copies verbatim into the Search results detail,
	// where its walk still starts in the local case database: a related case
	// the worker doesn't hold reads blank for every case Search finds. A
	// property field is re-rooted at the results roster and reads correctly.
	if (offersSearch) {
		const reached = columnPropertyCaseType(column, origin, doc.caseTypes ?? []);
		const property = doc.caseTypes
			?.find((type) => type.name === reached)
			?.properties.find((one) => one.name === column.field);
		if (hqStoresColumnAsExpression(column, property)) return "search";
	}
	return undefined;
}

const REASON_SENTENCE: Record<RelationReason, (column: string) => string> = {
	"worker-info": (column) =>
		`"${column}" needs its worker information to match the selected field. Choose that information again.`,
	"worker-walk": (column) =>
		`"${column}" reads the worker’s record. Choose a worker property, or choose a related case instead.`,
	"owner-field": (column) =>
		`"${column}" shows the owner’s name. Choose the owner ID for its information, or show the saved value instead.`,
	unresolved: (column) =>
		`"${column}" reads its value through a link from a case type this app doesn't have: either the menu's own case type, or a case type a step of the link names. You can choose the case above again, or show information of this case itself.`,
	"parent-type": (column) =>
		`"${column}" reads through a parent link that names its case type, but the parent's case type comes from this case type's own parent, and CommCare HQ keeps no type on the column. You can leave the type off the parent step.`,
	worker: (column) =>
		`"${column}" reads through a link called user, but CommCare HQ reads a column starting with user as the worker's own information, not a case above this one. You can rename the link, or show the worker's information another way.`,
	search: (column) =>
		`"${column}" shows a related case's value as a link, a time since or an option label, and this case list offers Search. CommCare HQ reads such a value from the cases on the worker's device, so it would show blank for the cases Search finds. You can show the related value's saved text instead.`,
	"index-name": (column) =>
		`"${column}" reads through a link CommCare HQ can't keep on a case list column: each link name there starts with a letter and holds only letters, numbers, underscores and hyphens, with no dots. You can read it through a link named that way, or use a calculated value that reads the related case.`,
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
