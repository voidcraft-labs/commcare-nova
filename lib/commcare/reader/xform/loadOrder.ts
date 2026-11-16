/**
 * The order a form's load-time values run in (11.3). Core runs one event's
 * actions in the order the model holds them
 * (`ActionController.java::triggerActionsFromEvent`), and Nova writes
 * setvalues in data-tree order (`builder.ts::inDataTreeOrder`), so a form whose
 * setvalues stand in another order reads with its values run in Nova's order.
 * That matters exactly where one value reads a node another sets: such a pair,
 * of one event, in another relative order in the two, is a finding.
 */

import type { Element } from "domhandler";
import type { PendingExpression } from "../pendingExpressions";
import type { DraftExpression, DraftField, ReadXForm } from "./index";

export interface LoadStep {
	readonly event: "xforms-ready" | "jr-insert";
	/** The data path set, an attribute as its last step `@name`. */
	readonly target: string;
	readonly pending?: PendingExpression;
}

/** Every field of a form, in document order. */
function fieldsOf(form: ReadXForm): DraftField[] {
	const order: DraftField[] = [];
	const walk = (parent: DraftField | null) => {
		for (const field of form.childrenOf(parent)) {
			order.push(field);
			walk(field);
		}
	};
	walk(null);
	return order;
}

/** The draft expression each setvalue's `value` was registered as, with its field. */
function expressionsBySetvalue(
	form: ReadXForm,
): Map<
	Element,
	{ readonly field: DraftField; readonly expression: DraftExpression }
> {
	const bySetvalue = new Map<
		Element,
		{ readonly field: DraftField; readonly expression: DraftExpression }
	>();
	for (const field of fieldsOf(form))
		for (const expression of field.expressions) {
			const at = expression.at;
			if (
				"element" in at &&
				at.attribute === "value" &&
				expression.event !== undefined
			)
				bySetvalue.set(at.element, { field, expression });
		}
	return bySetvalue;
}

/** A's order of the form's own setvalues: the source's, in document order. */
export function effectiveLoadOrder(form: ReadXForm): readonly LoadStep[] {
	const expressions = expressionsBySetvalue(form);
	const steps: LoadStep[] = [];
	for (const setvalue of form.setvalues) {
		if (setvalue.event !== "xforms-ready" && setvalue.event !== "jr-insert")
			continue;
		if (setvalue.target === undefined) continue;
		const read = expressions.get(setvalue.element);
		const uuid = read?.field.uuid;
		const pending: PendingExpression | undefined =
			read === undefined || uuid === undefined
				? undefined
				: {
						ref: {
							entity: "field",
							uuid,
							slot: read.expression.slot,
						} as PendingExpression["ref"],
						text: read.expression.text,
						mode: read.expression.mode,
						place: read.field.place,
						key: read.expression.key,
					};
		steps.push({
			event: setvalue.event,
			target: setvalue.target.join("/"),
			...(pending === undefined ? {} : { pending }),
		});
	}
	return steps;
}

/** Each pair of one event whose relative order differs between A and Nova's emission of the
 *  document, where `reader` reads `read.target`. */
export function loadOrderConflicts(
	order: readonly LoadStep[],
	emitted: readonly LoadStep[],
	reads: (step: LoadStep) => ReadonlySet<string>,
): readonly { readonly reader: LoadStep; readonly read: LoadStep }[] {
	const position = new Map<LoadStep, number>();
	for (const [index, step] of emitted.entries()) position.set(step, index);
	const conflicts: { reader: LoadStep; read: LoadStep }[] = [];
	for (let i = 0; i < order.length; i++)
		for (let j = i + 1; j < order.length; j++) {
			const before = order[i] as LoadStep;
			const after = order[j] as LoadStep;
			if (before.event !== after.event) continue;
			const at = position.get(before);
			const atAfter = position.get(after);
			if (at === undefined || atAfter === undefined || at < atAfter) continue;
			if (reads(after).has(before.target))
				conflicts.push({ reader: after, read: before });
			if (reads(before).has(after.target))
				conflicts.push({ reader: before, read: after });
		}
	return conflicts;
}
