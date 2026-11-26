// lib/commcare/suite/case-list/orderPlanOptions.ts
//
// The options every reader of the case list order plan builds it with
// (`lib/domain/caseListOrder.ts::caseListOrderPlan`). The plan lives in the
// domain, which imports nothing from `lib/commcare`, so the two things it
// cannot compute come from here: a calculated column's resolved type, and the
// text HQ JSON writes as an expression column's `field`. One helper builds
// both for every reader (HQ JSON, the local suite, the validator and
// Preview), so no two readers can build the plan differently.

import type { RewriteControl } from "@/lib/commcare/emissionRewrites";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { identityLookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	type BlueprintDoc,
	type CalculatedSort,
	type CaseListOrderOptions,
	type CaseListOrderPlan,
	type CaseType,
	type Column,
	caseListOrderPlan,
	casePropertyShowsOptionLabels,
	EMPTY_CASE_LIST_ORDER_PLAN,
	EXPRESSION_ONLY_COLUMN_PROPERTIES,
	effectiveCaseSearchConfig,
	effectiveCaseTypes,
	type Module,
} from "@/lib/domain";
import { propertiesReachedByColumn } from "@/lib/domain/columnRelation";
import {
	checkExpression,
	type Expression,
	type ExpressionContext,
	type ScalarType,
	scalarDataType,
} from "@/lib/domain/expression";
import {
	type ModuleExpressionContexts,
	moduleExpressionContexts,
} from "../../expressionContext";
import { w } from "../../xpath/wire/builders";
import { toWire } from "../../xpath/wire/fromExpression";
import { serializeWire } from "../../xpath/wire/serialize";
import type { WireExpr } from "../../xpath/wire/tree";
import { classifyRelatedCaseSearchExpression } from "../case-search/relatedCaseProjection";
import { columnPropertyPath } from "../wire";
import { bindCaseTextVariables, caseTextKeyVariants } from "./calculationText";
import {
	intervalColumnDisplayXpath,
	linkColumnDisplayXpath,
	plainSelectDisplayXpath,
} from "./columns";
import { detailBindings } from "./detailBindings";

/**
 * HQ's `XPathEnum` builder discovers a `translatable-enum` column's variables
 * by substring before it prefixes them with `$k`
 * (`suite_xml/xml_models.py::XPathEnum.build`). Fixed-width decimal indices
 * make every index prefix-free, so key 1 can never corrupt key 10.
 */
export function hqEnumPlaceholder(index: number): string {
	return `nova_text_${index.toString(10).padStart(10, "0")}`;
}

/**
 * Whether HQ JSON stores a property column as the expression reading its
 * property, `@case_id`: no HQ property column can show it
 * (`EXPRESSION_ONLY_COLUMN_PROPERTIES`).
 */
export function columnStoredAsExpression(column: Column): boolean {
	return (
		column.kind !== "calculated" &&
		(EXPRESSION_ONLY_COLUMN_PROPERTIES as ReadonlySet<string>).has(column.field)
	);
}

/** The selected case, Search's supporting-case view and suite lookup names
 * are the same when HQ prints a sort calculation for its editor and when
 * the reader checks the expression it bound against the stored text. */
export function hqCalculatedSortExpression(
	sort: Pick<CalculatedSort, "uuid" | "expression">,
	mod: Module,
	doc: BlueprintDoc,
	expressions: ModuleExpressionContexts,
	naming?: LookupWireNaming,
	rewrites?: RewriteControl,
): WireExpr {
	const types = expressions({
		slot: "case_list_sort_expression",
		member: { sortUuid: sort.uuid },
	});
	if (effectiveCaseSearchConfig(mod) !== undefined) {
		const related = classifyRelatedCaseSearchExpression(sort.expression, types);
		if (related.kind === "ancestor-property") return related.hqExpression;
	}
	return toWire(sort.expression, {
		target: "hq-json",
		types,
		rewrites,
		bindings: {
			lookup: {
				naming: naming ?? identityLookupWireNaming(),
				instanceScope: "suite",
			},
			// The suite's sort field binds the same prior selections and
			// search answers (`columns.ts::lookupTermContext`).
			...detailBindings(doc, mod),
		},
	});
}

/**
 * The text HQ JSON writes as a column's expression `field` on one screen.
 * `screen` is the detail the column is written into: on Results a column
 * hidden there that is not calculated prints its raw wire path (`@case_id`
 * for one over the case's id); on Details a column prints as its kind shows
 * it. A column with no expression of its own prints its raw wire path.
 *
 * `lookupNaming` is the run's naming where the caller has one; a caller with
 * no definitions snapshot prints through `identityLookupWireNaming()`, under
 * which two expressions print alike exactly when they do under any naming.
 *
 * `rewrites` is the reader's control over the rewrites a calculated column's
 * print reaches (`emissionRewrites.ts`); an export passes none.
 */
export function hqExpressionField(
	column: Column,
	mod: Module,
	doc: BlueprintDoc,
	screen: "results" | "details",
	lookupNaming?: LookupWireNaming,
	expressions: ModuleExpressionContexts = moduleExpressionContexts(
		doc,
		mod.uuid,
		lookupNaming,
	),
	rewrites?: RewriteControl,
): WireExpr {
	if (column.kind === "calculated") {
		if (effectiveCaseSearchConfig(mod) !== undefined) {
			const related = classifyRelatedCaseSearchExpression(
				column.expression,
				expressions({
					slot: "case_list_column_expression",
					member: { columnUuid: column.uuid },
				}),
			);
			if (related.kind === "ancestor-property") return related.hqExpression;
		}
		const wire = toWire(column.expression, {
			target: "hq-json",
			types: expressions({
				slot: "case_list_column_expression",
				member: { columnUuid: column.uuid },
			}),
			bindings: {
				lookup: {
					naming: lookupNaming ?? identityLookupWireNaming(),
					instanceScope: "suite",
				},
				...detailBindings(doc, mod),
			},
			...(rewrites === undefined ? {} : { rewrites }),
		});
		return column.texts
			? bindCaseTextVariables(wire, caseTextKeyVariants(wire, column.texts))
			: wire;
	}
	const path = columnPropertyPath(column);
	if (screen === "results" && column.visibleInList === false) return path;
	switch (column.kind) {
		case "plain": {
			const property = columnProperty(column, mod, effectiveCaseTypes(doc));
			if (
				column.showChoice === "saved-value" ||
				property === undefined ||
				!casePropertyShowsOptionLabels(property)
			) {
				return path;
			}
			return plainSelectDisplayXpath(path, property, doc, (_option, index) =>
				w.hqEnumVar(index),
			);
		}
		case "interval":
			return intervalColumnDisplayXpath(column, w.hqEnumVar(0));
		case "link":
			return linkColumnDisplayXpath(path, column.linkText);
		default:
			return path;
	}
}

/**
 * The catalog entry of the property a property column shows, over the types
 * its walk reaches (`columnRelation.ts::propertiesReachedByColumn`): a lone
 * destination's own entry, or one merged over several destinations or an
 * open link, typed as text unless they agree; undefined where a lone
 * destination holds no such property.
 */
export function columnProperty(
	column: Exclude<Column, { kind: "calculated" }>,
	mod: Pick<Module, "caseType">,
	caseTypes: readonly CaseType[],
): CaseType["properties"][number] | undefined {
	return propertiesReachedByColumn(
		column,
		mod.caseType,
		caseTypes,
		column.field,
	).find((candidate) => candidate.name === column.field);
}

/** The canonical HQ print used to join an expression column to its sort rule. */
export function hqExpressionFieldText(
	column: Column,
	mod: Module,
	doc: BlueprintDoc,
	screen: "results" | "details",
	lookupNaming?: LookupWireNaming,
	expressions: ModuleExpressionContexts = moduleExpressionContexts(
		doc,
		mod.uuid,
		lookupNaming,
	),
	rewrites?: RewriteControl,
): string {
	try {
		return serializeWire(
			hqExpressionField(
				column,
				mod,
				doc,
				screen,
				lookupNaming,
				expressions,
				rewrites,
			),
			{ target: "hq-json", interpolation: "none" },
		).text;
	} catch (error) {
		// The validator reads the order plan even for a refused calculation.
		// Export supplies naming and never reaches this totality fallback.
		if (column.kind !== "calculated" || lookupNaming !== undefined) throw error;
		return unprintableExpressionText(column.expression);
	}
}

/**
 * The join text of an expression the on-device emitter refuses: the
 * expression's structure, printed with its object keys in sorted order, so
 * two such texts are equal exactly when the two expressions are equal. The
 * prefix holds a character no XPath expression holds, so it never equals a
 * printed expression.
 */
export function unprintableExpressionText(expression: unknown): string {
	return `\u0000unprintable:${canonicalJson(expression)}`;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * The options of a module's order plan. `mediaOn` is whether the export
 * carries a media manifest; the validator and Preview pass `true`, the plan of every production export. Readers 1 and 2 pass their
 * run's lookup naming, so every stored short column's `field` is the plan's
 * join text itself. `columnRewrites` is the reader's control over each
 * calculated column's print, by column, asked once per print (`hqExpressionField`);
 * an export passes none.
 */
export function caseListOrderOptions(
	mod: Module,
	doc: BlueprintDoc,
	mediaOn: boolean,
	lookupNaming?: LookupWireNaming,
	columnRewrites?: ColumnRewrites,
): CaseListOrderOptions {
	const expressions = moduleExpressionContexts(doc, mod.uuid, lookupNaming);
	const caseTypes = effectiveCaseTypes(doc);
	return {
		mediaOn,
		relatedProperties: (via) =>
			propertiesReachedByColumn({ via }, mod.caseType, caseTypes),
		sortType: (sort) =>
			orderValueType(
				sort.expression,
				expressions({
					slot: "case_list_sort_expression",
					member: { sortUuid: sort.uuid },
				}),
			),
		calculatedType: (column) =>
			column.kind === "calculated"
				? orderValueType(
						column.expression,
						expressions({
							slot: "case_list_column_expression",
							member: { columnUuid: column.uuid },
						}),
					)
				: undefined,
		expressionText: (column) =>
			hqExpressionFieldText(
				column,
				mod,
				doc,
				"results",
				lookupNaming,
				expressions,
				columnRewrites?.(column.uuid),
			),
	};
}

/**
 * The type an order value orders by. A leaf a declared platform lacks types
 * as it does on any other, so a document whose declaration is still to be
 * settled (a reading's) orders by the type no declaration narrows, the one
 * it orders by once the declaration that admits the leaf is chosen.
 */
function orderValueType(
	expression: Expression,
	context: ExpressionContext,
): ScalarType | undefined {
	const outcome = checkExpression(expression, context);
	const platformOnly =
		outcome.errors.length > 0 &&
		outcome.errors.every(
			(error) =>
				error.code === "arm-unavailable" &&
				error.reason === "platform-unavailable",
		);
	const typed = platformOnly
		? checkExpression(expression, { ...context, platforms: [] })
		: outcome;
	return typed.errors.length > 0 ? undefined : scalarDataType(typed.type?.data);
}

/** The reader's control over one calculated column's print, by the column's UUID, asked once
 *  per print; undefined where the column prints as an export prints it. */
export type ColumnRewrites = (columnUuid: string) => RewriteControl | undefined;

/**
 * The plan of one module's list, over the module's effective case type
 * catalog (`effectiveCaseTypes`), with `caseListOrderOptions`. A module with
 * no list has the plan of an empty one.
 */
export function moduleCaseListOrderPlan(
	mod: Module,
	doc: BlueprintDoc,
	mediaOn: boolean,
	lookupNaming?: LookupWireNaming,
): CaseListOrderPlan {
	const config = mod.caseListConfig;
	if (config === undefined) return EMPTY_CASE_LIST_ORDER_PLAN;
	const caseProperties =
		effectiveCaseTypes(doc).find((type) => type.name === mod.caseType)
			?.properties ?? [];
	return caseListOrderPlan(
		config,
		caseProperties,
		caseListOrderOptions(mod, doc, mediaOn, lookupNaming),
	);
}
