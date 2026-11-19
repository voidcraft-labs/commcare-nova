/**
 * Rule: a property column read through a relation (`via`) reaches one case
 * type CommCare HQ's build reads as Nova does.
 *
 * HQ stores the column's `field` as its indices and property joined by `/`
 * and walks each index over `casedb` with no case-type test
 * (`detail_screen.py::PropertyXpathGenerator.xpath`). So the walk must say
 * what the field cannot: every step reaches one type the catalog knows
 * (`parent` the catalog's parent type, any other index the type it names),
 * and the field's spelling must read back to the same walk. Five shapes are
 * refused (`CASE_LIST_COLUMN_RELATION_INVALID`, by `details.reason`):
 *
 *   - `unresolved`: the walk reaches no single type (a `parent` step from a
 *     type with no parent, another index naming no type or an unknown one).
 *   - `parent-type`: a `parent` step names a type. The catalog already gives
 *     the parent's type, and HQ's field holds none, so the app would read
 *     back without it.
 *   - `worker`: the first step is `user`, which HQ reads as the worker's own
 *     record rather than an index of the case.
 *   - `index-name`: the field HQ stores is outside its field grammar, which
 *     takes only words that start with a letter (`suite/wire.ts::isHqDetailField`),
 *     where an index may start with `_`. HQ's build refuses such a field in a
 *     sort element and its Case List page will not keep the column, and the
 *     field is written wherever the column is a property column, is hidden
 *     from Results, or carries a sort, so every column kind is held to it.
 *   - `search`: the list offers Search. HQ reads such a column in its
 *     results through the search's own instance, where Nova writes a column
 *     reading a related case as a calculation that carries the case type
 *     (`suite/case-search/relatedCaseProjection.ts`).
 *
 * Whether the property exists on the type the walk reaches is
 * `columnReferences`' finding.
 */

import {
	type BlueprintDoc,
	type Column,
	type ColumnVia,
	columnFieldText,
	effectiveCaseSearchConfig,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import { hqColumnFieldText, isHqDetailField } from "../../../suite/wire";
import { type ValidationError, validationError } from "../../errors";

type RelationReason =
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
	const offersSearch = effectiveCaseSearchConfig(mod) !== undefined;
	for (let index = 0; index < config.columns.length; index++) {
		const column = config.columns[index];
		if (column.kind === "calculated" || column.via === undefined) continue;
		const reason = relationReason(column, column.via, mod, doc, offersSearch);
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
	const destination = resolveRelationDestination(
		{ kind: "ancestor", via },
		mod.caseType,
		doc.caseTypes ?? [],
	);
	if (!destination.ok) return "unresolved";
	if (offersSearch) return "search";
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
	search: (column) =>
		`"${column}" shows information of the case above, but this case list offers Search, and its results show such a column only as a calculated value. You can add a calculated value that reads the case above instead.`,
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
