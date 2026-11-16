import type { Uuid } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression/builders";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { instantOperand } from "@/lib/domain/expression/instantOperand";
import type { Expression } from "@/lib/domain/expression/types";
import {
	storedDatetimeWire,
	type WireBuildContext,
} from "../xpath/wire/fromExpression";
import { storedDatetimeValue } from "../xpath/wire/instant";
import type { WireExpr } from "../xpath/wire/tree";
import type { FormPath } from "./formPath";
import type { GeneratedNodePlan } from "./generatedNodes";

/** HQ generates untyped case-update binds. Reading a date-valued question into
 * one wraps it as DateData and loses the clock. A sibling text value preserves
 * the full instant on both HQ-regenerated and directly emitted submissions.
 * Its name is the form's plan of generated nodes' (`generatedNodes.ts`). */
export function datetimeCaseValuePath(
	plan: GeneratedNodePlan,
	fieldUuid: Uuid,
	path: FormPath,
): FormPath {
	const last = path.segments().at(-1);
	if (last?.kind !== "element")
		throw new Error("A datetime answer must have an element path.");
	return path.parent().child(plan.datetime(fieldUuid));
}

/**
 * The text a date and time takes on a case: its moment as CommCare HQ stores
 * it, UTC with six fraction digits and `Z`
 * (`corehq/form_processor/utils/xform.py::adjust_datetimes`, printed by
 * `dimagi/utils/parsing.py::json_format_datetime`). Written on an untyped
 * node: every Save to Case leaf that writes a date-and-time property
 * (`caseOps.ts`) and, through `questionDatetimeCaseValue`, a question's
 * sibling text value (`builder.ts`), which classifies its question as a
 * field read. HQ's form builder writes a Save to Case
 * row's bind with no `type`, so a typed leaf would lose its clock on the
 * first save. The phone, CommCare HQ and every other phone then hold one
 * text, and a list ordered by the property orders by the moment. Each leaf
 * prints by what a device holds (`xpath/wire/instant.ts::storedDatetimeValue`),
 * classified in the write's own slot: stored text as itself, so a copy is
 * exact.
 *
 * `clock` names the node that reads a typed leaf holding `now()` once
 * (`generatedNodes.ts`, purpose `instant`); a question read needs none.
 */
export function datetimeCaseValue(
	expression: Expression,
	ctx: WireBuildContext,
	clock?: (leaf: Expression) => WireExpr | undefined,
): WireExpr {
	return storedDatetimeWire(expression, ctx, clock);
}

/** A question's answer as the text a case holds for a date and time:
 * `datetimeCaseValue` of the question read as a field (`types`, a slot of
 * the question's own form), printed at its node `path`. A date-and-time
 * question, and a Hidden Value Core holds as a typed `Date` (a starting value
 * cast under `xsd:dateTime`, or a calculate that gives a `Date`), is a typed
 * leaf; a Hidden Value whose calculate gives text, such as a copy of a
 * case's stored value, holds that text (`Recalculate.wrapData` keeps a
 * string as it is) and is written as itself, so a copy is exact. */
export function questionDatetimeCaseValue(
	fieldUuid: Uuid,
	path: FormPath,
	types: ExpressionContext,
): WireExpr {
	const node = path.toWire();
	const read: Expression = term(formField(fieldUuid));
	return storedDatetimeValue(instantOperand(read, types), {
		value: (expression) => {
			if (expression !== read)
				throw new Error(
					"A question's date-and-time sibling reads only its question.",
				);
			return node;
		},
		condition: () => {
			throw new Error("A question read has no condition.");
		},
		switchTests: () => {
			throw new Error("A question read has no switch.");
		},
	});
}
