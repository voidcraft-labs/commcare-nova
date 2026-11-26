/**
 * The order a form's load-time values run in. Core runs one event's
 * actions in the order the model holds them
 * (`ActionController.java::triggerActionsFromEvent`), and Nova writes
 * setvalues in data-tree order (`builder.ts::inDataTreeOrder`), so a form whose
 * setvalues stand in another order reads with its values run in Nova's order.
 * That matters exactly where one value reads a node another sets: such a pair,
 * of one event, in another relative order in the two, is a finding.
 */

import type { Element } from "domhandler";
import type { PendingExpression, PendingRegistry } from "../pendingExpressions";
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
export function effectiveLoadOrder(
	form: ReadXForm,
	registry?: PendingRegistry,
): readonly LoadStep[] {
	const expressions = expressionsBySetvalue(form);
	const registered = registry?.list();
	const steps: LoadStep[] = [];
	for (const setvalue of form.setvalues) {
		if (setvalue.event !== "xforms-ready" && setvalue.event !== "jr-insert")
			continue;
		if (setvalue.target === undefined) continue;
		const read = expressions.get(setvalue.element);
		const uuid = read?.field.uuid;
		const index = registry?.firstAt(setvalue.element, "value");
		const pending: PendingExpression | undefined =
			read === undefined || uuid === undefined
				? index === undefined
					? undefined
					: registered?.[index]
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
 *  document, where `reader` reads `read.target`, in the order of the pairs in `order` (the
 *  earlier step first), the later step's read before the earlier's. Each step's reads are
 *  asked once and looked up among the steps that set what they name, so the work is the reads,
 *  never every pair of steps. */
export function loadOrderConflicts(
	order: readonly LoadStep[],
	emitted: readonly LoadStep[],
	reads: (step: LoadStep) => ReadonlySet<string>,
): readonly { readonly reader: LoadStep; readonly read: LoadStep }[] {
	const position = new Map<LoadStep, number>();
	for (const [index, step] of emitted.entries()) position.set(step, index);
	const setting = new Map<string, number[]>();
	for (const [index, step] of order.entries()) {
		const at = setting.get(step.target);
		if (at === undefined) setting.set(step.target, [index]);
		else at.push(index);
	}
	const found: {
		readonly key: readonly [number, number, number];
		readonly conflict: { reader: LoadStep; read: LoadStep };
	}[] = [];
	for (const [index, reader] of order.entries()) {
		const at = position.get(reader);
		if (at === undefined) continue;
		for (const target of reads(reader))
			for (const other of setting.get(target) ?? []) {
				if (other === index) continue;
				const read = order[other] as LoadStep;
				if (read.event !== reader.event) continue;
				const atRead = position.get(read);
				if (atRead === undefined) continue;
				// The pair in `order`'s order: the earlier step, then the later.
				const [first, second] = other < index ? [read, reader] : [reader, read];
				const firstAt = position.get(first) as number;
				const secondAt = position.get(second) as number;
				if (firstAt < secondAt) continue;
				found.push({
					key: other < index ? [other, index, 0] : [index, other, 1],
					conflict: { reader, read },
				});
			}
	}
	found.sort(
		(a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2],
	);
	return found.map((one) => one.conflict);
}
