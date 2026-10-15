/**
 * The predicate self-step spelling HQ's form builder accepts.
 *
 * Vellum marks any expression that holds a relative path of exactly one
 * `self` step as a reference to the question itself
 * (`Vellum/src/logic.js::LogicExpression.analyze` sets `referencesSelf`),
 * and only a validation condition may do that. So a bare `.` inside a
 * predicate, such as `count(/data/items/item/choice[. = 'yes'])`, draws
 * "not allowed to reference the question itself" on every save of a
 * Calculate or Display Condition, although the dot names the predicate's
 * candidate node and not the question. `./.` is a path of two `self` steps,
 * which Vellum does not flag, and Core reads it as the same node `.` names.
 */

import type { SyntaxNode } from "@lezer/common";
import { parser } from "./parser";

/**
 * Rewrite each one-step `.` path that stands inside a predicate to `./.`,
 * reading structure through the Lezer grammar. A `.` that is one step of a
 * longer path (`./x`, `x/.`) and a `.` outside every predicate are left as
 * written. Applied to every expression Nova writes into a `calculate`,
 * `relevant`, `required`, a setvalue's `value` and a Save to Case field, and
 * never to a `constraint`, where `.` is the answer and Vellum allows it.
 * Idempotent: a `./.` holds no one-step `.` path.
 */
export function spellPredicateSelf(source: string): string {
	if (!source.includes(".")) return source;
	const edits: number[] = [];
	parser.parse(source).iterate({
		enter(cursor) {
			if (cursor.name !== "SelfStep") return;
			const node = cursor.node;
			const parent = node.parent;
			if (parent?.name === "Child" || parent?.name === "Descendant") return;
			if (insidePredicate(node)) edits.push(node.from);
		},
	});
	let out = source;
	for (const from of edits.sort((a, b) => b - a)) {
		out = `${out.slice(0, from)}./.${out.slice(from + 1)}`;
	}
	return out;
}

/** Whether `node` lies in the bracketed part of some `Filtered` ancestor. */
function insidePredicate(node: SyntaxNode): boolean {
	let child = node;
	for (let parent = node.parent; parent; parent = parent.parent) {
		if (
			parent.name === "Filtered" &&
			child.from >= (parent.firstChild?.to ?? 0)
		)
			return true;
		child = parent;
	}
	return false;
}
