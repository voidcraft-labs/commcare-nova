// lib/commcare/suite/case-list/sortKeys.ts
//
// The `<sort>` blocks of the local suite's case-list short detail, read
// from the list's order plan (`lib/domain/caseListOrder.ts::caseListOrderPlan`).
// The plan decides every field's sort key and every rule; this module only
// spells them as CommCare HQ's build spells the same list:
//
//   - every field that keeps a sort key carries a `<sort>` with `type` alone
//     (`detail_screen.py::FormattedDetailColumn.sort_node`, which writes one
//     for every format with a sort expression of its own, before it tests for
//     a sort element), and the fields that carry a rule add `order`,
//     `direction` and `blanks`;
//   - a rule no field takes rides on a field appended after the stored ones,
//     as HQ's `util.py::create_temp_sort_column` appends one for a sort row
//     with no stored column.
//
// `order` is the rule's place among the sort elements HQ JSON writes, which
// is what HQ's build writes as `@order`
// (`util.py::get_sort_and_sort_only_columns`, `index + 1`).

import type { Element } from "domhandler";
import {
	el,
	type WireElementContext,
	xel,
} from "@/lib/commcare/elementBuilders";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { w } from "@/lib/commcare/xpath/wire/builders";
import { InstanceSink } from "@/lib/commcare/xpath/wire/instances";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import type {
	CaseListComparator,
	CaseListOrderPlan,
	CaseListOrderRule,
	CaseListSortKey,
	Column,
	SortDirection,
	Uuid,
} from "@/lib/domain";
import { casePropertyPath } from "../wire";

// ============================================================
// Wire-vocab translation
// ============================================================

/**
 * The plan's comparators in the suite's `<sort type>` vocabulary
 * (`suite_xml/xml_models.py::Sort`). HQ's build writes `string` for a text
 * comparison whatever the sort element's page word (`plain` and `date` both,
 * `detail_screen.py::FormattedDetailColumn.sort_node`), and the suite has no
 * other word for one.
 */
export const SORT_TYPE_WIRE_MAP: Readonly<Record<CaseListComparator, string>> =
	{
		text: "string",
		integer: "int",
		decimal: "double",
	};

/**
 * Nova's sort directions in CommCare's spelled-out words, as the canonical
 * fixture `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml`
 * carries them.
 */
export const SORT_DIRECTION_WIRE_MAP: Readonly<Record<SortDirection, string>> =
	{
		asc: "ascending",
		desc: "descending",
	};

// ============================================================
// Sort nodes from the plan
// ============================================================

/** The rule attributes of a `<sort>`; absent for a key with no rule. */
interface SortRuleAttributes {
	readonly type: CaseListComparator;
	readonly order?: number;
	readonly direction?: SortDirection;
	/** Written where HQ JSON writes the rule's element, which HQ's build
	 *  copies; HQ's default element writes none. */
	readonly blanks?: "first" | "last";
}

/**
 * One field's `<sort>`, resolved from the plan. Three arms, by what the
 * sort's text reads:
 *
 *   - `property` — an XPath with no variables: the raw wire path, or for a
 *     mapping position the chain that gives the index of the first matching
 *     entry (`'' ` when none), as HQ's `enum` and `enum-image` sort.
 *   - `calculated` — `$calculated_property` over the field's own expression
 *     (a calculated column's value, a link's markdown), as HQ's
 *     `useXpathExpression` sort.
 *   - `variables` — the field's display expression with the same
 *     `<variable>` children its template carries (a select's labels, an
 *     interval's text), as HQ's `translatable-enum` sort.
 */
export type ResolvedSortDirective = SortRuleAttributes &
	(
		| { readonly kind: "property"; readonly xpath: WireExpr }
		| { readonly kind: "calculated" }
		| { readonly kind: "variables" }
	);

/** The sort nodes of one short detail: one per field that keeps a key,
 *  keyed by column uuid, and one per carrier in plan order. */
export interface PlannedSortNodes {
	readonly byUuid: ReadonlyMap<Uuid, ResolvedSortDirective>;
	readonly carriers: readonly {
		readonly property: string;
		readonly directive: ResolvedSortDirective;
	}[];
}

/**
 * `if(selected(<path>, '<value 0>'), 0, if(selected(<path>, '<value 1>'), 1,
 * ''))`: the index of the first entry whose value the property holds, `''`
 * when none, which is the sort HQ's build gives an `enum` column
 * (`suite_xml/xml_models.py::XPathEnum.build`, closed with `''`). An ID
 * mapping and an image map share it.
 */
export function idMappingSortXpath(
	path: WireExpr,
	mapping: readonly { readonly value: string }[],
): WireExpr {
	return mapping.reduceRight<WireExpr>(
		(elseArm, entry, index) =>
			w.call("if", [
				w.call("selected", [path, w.str(entry.value)]),
				w.num(index),
				elseArm,
			]),
		w.str(""),
	);
}

function ruleAttributes(
	rule: CaseListOrderRule | undefined,
): Omit<SortRuleAttributes, "type"> {
	if (rule === undefined) return {};
	return {
		order: rule.order,
		direction: rule.direction,
		...(rule.written && { blanks: rule.blanks }),
	};
}

function keyDirective(
	key: CaseListSortKey,
	column: Column,
	attributes: SortRuleAttributes,
): ResolvedSortDirective {
	switch (key.kind) {
		case "property":
			return {
				...attributes,
				kind: "property",
				xpath: casePropertyPath(key.property),
			};
		case "mapping-position": {
			if (column.kind !== "id-mapping" && column.kind !== "image-map") {
				throw new Error(
					`A mapping-position sort key belongs to an ID mapping or an image map, and the order plan gave one to a ${column.kind} column.`,
				);
			}
			return {
				...attributes,
				kind: "property",
				xpath: idMappingSortXpath(
					casePropertyPath(column.field),
					column.mapping,
				),
			};
		}
		case "option-label":
		case "interval-text":
			return { ...attributes, kind: "variables" };
		case "link-text":
		case "calculated":
			return { ...attributes, kind: "calculated" };
	}
}

/**
 * The `<sort>` of every field that keeps a key, and of every carrier, from
 * the plan. A hidden field's key is always its raw value or its calculation:
 * the plan gives a hidden field no key of its own (rule 3), and the key of a
 * rule that lands on it is the stored value.
 */
export function planSortNodes(plan: CaseListOrderPlan): PlannedSortNodes {
	const byUuid = new Map<Uuid, ResolvedSortDirective>();
	for (const field of plan.fields) {
		if (field.key === undefined) continue;
		byUuid.set(
			field.column.uuid,
			keyDirective(field.key, field.column, {
				type: field.comparator,
				...ruleAttributes(field.rule),
			}),
		);
	}
	const carriers = plan.carriers.map((carrier) => ({
		property: carrier.property,
		directive: {
			kind: "property" as const,
			xpath: casePropertyPath(carrier.property),
			type: carrier.comparator,
			...ruleAttributes(carrier.rule),
		},
	}));
	return { byUuid, carriers };
}

// ============================================================
// Wire emission
// ============================================================

/**
 * Build a `<sort>` Element. `text` is the sort's `<xpath>`: its function and
 * the `<variable>` children it carries. Attributes follow CommCare HQ's
 * `suite_xml/xml_models.py::Sort` declaration order, `type`, `order`,
 * `direction`, `blanks`, each written only when set.
 *
 * The XPath flows raw into the `function` attribute; the serializer escapes
 * it once at render time.
 */
export function buildSortBlock(
	directive: SortRuleAttributes,
	text: { readonly xpath: WireExpr; readonly variables: readonly Element[] },
	context: WireElementContext,
): Element {
	const attributes: Record<string, string> = {
		type: SORT_TYPE_WIRE_MAP[directive.type],
	};
	if (directive.order !== undefined) attributes.order = String(directive.order);
	if (directive.direction !== undefined) {
		attributes.direction = SORT_DIRECTION_WIRE_MAP[directive.direction];
	}
	if (directive.blanks !== undefined) attributes.blanks = directive.blanks;
	return el("sort", attributes, [
		el("text", {}, [
			xel("xpath", { xpath: { function: text.xpath } }, context, [
				...text.variables,
			]),
		]),
	]);
}

/** `$calculated_property` with its one variable: the sort text of a
 *  `calculated` directive, as HQ's `useXpathExpression` sort writes it. */
export function calculatedPropertyText(
	expression: WireExpr,
	context: WireElementContext,
): {
	readonly xpath: WireExpr;
	readonly variables: readonly Element[];
} {
	return {
		xpath: w.calculatedPropertyVar(),
		variables: [
			el("variable", { name: "calculated_property" }, [
				xel("xpath", { xpath: { function: expression } }, context),
			]),
		],
	};
}

/**
 * String adapter for a `property` directive, for callers that assert against
 * the rendered XML string (the test surface).
 */
export function emitSortBlock(
	directive: Extract<ResolvedSortDirective, { kind: "property" }>,
): string {
	return serializeXml(
		buildSortBlock(
			directive,
			{ xpath: directive.xpath, variables: [] },
			{
				mode: { target: "suite" },
				instances: new InstanceSink(),
			},
		),
	);
}
