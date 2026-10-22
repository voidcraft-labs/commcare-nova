/** Typed navigation display-condition emission for suite.xml and HQ JSON. */

import { RESERVED_CASE_ATTRIBUTES } from "@/lib/commcare/casePropertyWire";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { w } from "@/lib/commcare/xpath/wire/builders";
import { toWire } from "@/lib/commcare/xpath/wire/fromExpression";
import {
	caseDbInstance,
	sessionInstance,
} from "@/lib/commcare/xpath/wire/instances";
import type { WireExpr, WirePath } from "@/lib/commcare/xpath/wire/tree";
import type { Expression, ExpressionContext } from "@/lib/domain/expression";
import { displayConditionForEmission } from "@/lib/domain/expression";
import type { DatumRef } from "@/lib/domain/expression/types";
import { casePropertyPath } from "./wire";

/** A menu or a form, as its display condition is emitted: the stored
 * condition and whether the item is off the menu. */
export interface DisplayConditionCarrier {
	readonly displayCondition?: Expression;
	readonly hiddenFromMenu?: true;
}

/** The written `false()` an item off the menu leads with. */
const OFF_THE_MENU = w.call("false", []);

/**
 * An item off the menu writes `false()` alone, or `false() and (<rest>)`
 * where it holds a condition for when it is back on the menu. The serializer
 * owns the parentheses that preserve the condition's precedence. An item on
 * the menu writes its condition as stored, or nothing.
 */
function withMenuPresence(
	carrier: DisplayConditionCarrier,
	emitRest: (rest: Expression) => WireExpr,
): WireExpr | undefined {
	const rest = displayConditionForEmission(carrier.displayCondition);
	const restText = rest === undefined ? undefined : emitRest(rest);
	if (carrier.hiddenFromMenu !== true) return restText;
	return restText === undefined ? OFF_THE_MENU : w.and(OFF_THE_MENU, restText);
}

function selectedCase(selectedCaseDatumId = "case_id"): WirePath {
	return w.instance(caseDbInstance(), [
		w.step("casedb"),
		w.step("case", [
			w.eq(
				w.context([w.attr("case_id")]),
				w.instance(sessionInstance(), [
					w.step("session"),
					w.step("data"),
					w.step(selectedCaseDatumId),
				]),
			),
		]),
	]);
}

/** Module relevancy runs before case selection, so ordinary on-device terms
 * emit directly; validation has already excluded every case-row term. */
export function emitModuleDisplayCondition(
	carrier: DisplayConditionCarrier,
	types: ExpressionContext,
	lookupNaming?: LookupWireNaming,
): WireExpr | undefined {
	return withMenuPresence(carrier, (rest) =>
		toWire(rest, {
			target: "suite",
			types,
			bindings: {
				...(lookupNaming === undefined
					? {}
					: { lookup: { naming: lookupNaming, instanceScope: "suite" } }),
			},
		}),
	);
}

/**
 * A form command in a case-first menu evaluates after `case_id` is selected,
 * but its context node is not the case row. Anchor every admitted direct-self
 * property structurally through the selected session datum. No emitted-string
 * rewriting is used: the leaf override is threaded through the typed emitter.
 */
export function emitFormDisplayConditionForSuite(
	carrier: DisplayConditionCarrier,
	types: ExpressionContext,
	lookupNaming?: LookupWireNaming,
	selectedCaseDatumId?: string,
	/** The ids the form's entry prints its datums under, which a read of the
	 * case chosen in an earlier menu names (`entryDatumIdResolver`). */
	datumId?: (ref: DatumRef) => string | undefined,
): WireExpr | undefined {
	return withMenuPresence(carrier, (rest) =>
		toWire(rest, {
			target: "suite",
			types,
			bindings: {
				...(datumId === undefined ? {} : { datumId }),
				emitSelfProperty: (property) =>
					w.append(
						selectedCase(selectedCaseDatumId),
						casePropertyPath(property.property).steps,
					),
				...(lookupNaming !== undefined && {
					lookup: { naming: lookupNaming, instanceScope: "suite" },
				}),
			},
		}),
	);
}

/**
 * HQ expands `#case/<property>` in `form_filter` to the menu's selected case
 * while regenerating suite.xml (`suite_xml/sections/menus.py::
 * MenuContributor._get_commands`), choosing the datum itself. Its parser
 * expects a name after `#case/`, so a reserved case attribute cannot be read
 * that way: `#case/@status` fails `validate_app()` with a form filter xpath
 * error and the app does not build. A read of `case_id`, `case_type`,
 * `owner_id` or `status` is therefore written expanded, through the selected
 * case's session datum, the one spelling HQ builds for an attribute; every
 * other property keeps `#case/<property>`.
 */
export function emitFormDisplayConditionForHq(
	carrier: DisplayConditionCarrier,
	types: ExpressionContext,
	lookupNaming?: LookupWireNaming,
	selectedCaseDatumId?: string,
	/** The ids the form's entry prints its datums under, after root
	 * alignment: HQ copies `form_filter` into the command as written. */
	datumId?: (ref: DatumRef) => string | undefined,
): WireExpr | undefined {
	return withMenuPresence(carrier, (rest) =>
		toWire(rest, {
			target: "hq-json",
			types,
			bindings: {
				...(datumId === undefined ? {} : { datumId }),
				emitSelfProperty: (property) =>
					RESERVED_CASE_ATTRIBUTES.has(property.property)
						? w.append(selectedCase(selectedCaseDatumId), [
								w.attr(property.property),
							])
						: w.hqCase([w.step(property.property)]),
				...(lookupNaming !== undefined && {
					lookup: { naming: lookupNaming, instanceScope: "suite" },
				}),
			},
		}),
	);
}
