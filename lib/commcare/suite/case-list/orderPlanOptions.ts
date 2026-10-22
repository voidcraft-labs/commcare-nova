// lib/commcare/suite/case-list/orderPlanOptions.ts
//
// The options every reader of the case list order plan builds it with
// (`lib/domain/caseListOrder.ts::caseListOrderPlan`). The plan lives in the
// domain, which imports nothing from `lib/commcare`, so the two things it
// cannot compute come from here: a calculated column's resolved type, and the
// text HQ JSON writes as an expression column's `field`. One helper builds
// both for every reader (HQ JSON, the local suite, the validator and
// Preview), so no two readers can build the plan differently.

import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { identityLookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	ATTRIBUTE_BACKED_COLUMN_PROPERTIES,
	type BlueprintDoc,
	type CaseListOrderOptions,
	type CaseListOrderPlan,
	type Column,
	caseListOrderPlan,
	casePropertyShowsOptionLabels,
	effectiveCaseSearchConfig,
	effectiveCaseTypes,
	type Module,
} from "@/lib/domain";
import { checkExpression, scalarDataType } from "@/lib/domain/expression";
import {
	type ModuleExpressionContexts,
	moduleExpressionContexts,
} from "../../expressionContext";
import { w } from "../../xpath/wire/builders";
import { toWire } from "../../xpath/wire/fromExpression";
import { serializeWire } from "../../xpath/wire/serialize";
import type { WireExpr } from "../../xpath/wire/tree";
import { classifyRelatedCaseSearchExpression } from "../case-search/relatedCaseProjection";
import { casePropertyPath } from "../wire";
import {
	intervalColumnDisplayXpath,
	linkColumnDisplayXpath,
	plainSelectDisplayXpath,
} from "./columns";

/**
 * HQ's `XPathEnum` builder discovers a `translatable-enum` column's variables
 * by substring before it prefixes them with `$k`
 * (`suite_xml/xml_models.py::XPathEnum.build`). Fixed-width decimal indices
 * make every index prefix-free, so key 1 can never corrupt key 10.
 */
export function hqEnumPlaceholder(index: number): string {
	return `nova_text_${index.toString(10).padStart(10, "0")}`;
}

/** Whether the column reads an attribute-backed property (finding 57). */
export function columnReadsCaseAttribute(column: Column): boolean {
	return (
		column.kind !== "calculated" &&
		(ATTRIBUTE_BACKED_COLUMN_PROPERTIES as ReadonlySet<string>).has(
			column.field,
		)
	);
}

/**
 * The text HQ JSON writes as a column's expression `field` on one screen.
 * `screen` is the detail the column is written into: on Results a column
 * hidden there that is not calculated prints its raw wire path (`@<name>`
 * for an attribute-backed one); on Details a column prints as its kind shows
 * it. A column with no expression of its own prints its raw wire path.
 *
 * `lookupNaming` is the run's naming where the caller has one; a caller with
 * no definitions snapshot prints through `identityLookupWireNaming()`, under
 * which two expressions print alike exactly when they do under any naming.
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
		return toWire(column.expression, {
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
			},
		});
	}
	const path = casePropertyPath(column.field);
	if (screen === "results" && column.visibleInList === false) return path;
	switch (column.kind) {
		case "plain": {
			const property = effectiveCaseTypes(doc)
				.find((type) => type.name === mod.caseType)
				?.properties.find((candidate) => candidate.name === column.field);
			if (property === undefined || !casePropertyShowsOptionLabels(property)) {
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
): string {
	try {
		return serializeWire(
			hqExpressionField(column, mod, doc, screen, lookupNaming, expressions),
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
 * join text itself.
 */
export function caseListOrderOptions(
	mod: Module,
	doc: BlueprintDoc,
	mediaOn: boolean,
	lookupNaming?: LookupWireNaming,
): CaseListOrderOptions {
	const expressions = moduleExpressionContexts(doc, mod.uuid, lookupNaming);
	return {
		mediaOn,
		calculatedType: (column) => {
			if (column.kind !== "calculated") return undefined;
			const outcome = checkExpression(
				column.expression,
				expressions({
					slot: "case_list_column_expression",
					member: { columnUuid: column.uuid },
				}),
			);
			return outcome.errors.length > 0
				? undefined
				: scalarDataType(outcome.type?.data);
		},
		expressionText: (column) =>
			hqExpressionFieldText(
				column,
				mod,
				doc,
				"results",
				lookupNaming,
				expressions,
			),
	};
}

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
	if (config === undefined) return { fields: [], carriers: [], authored: [] };
	const caseProperties =
		effectiveCaseTypes(doc).find((type) => type.name === mod.caseType)
			?.properties ?? [];
	return caseListOrderPlan(
		config,
		caseProperties,
		caseListOrderOptions(mod, doc, mediaOn, lookupNaming),
	);
}
