import { type BlueprintDoc, isContainer, type Uuid } from "@/lib/domain";
import {
	type Expression,
	type FormFieldRef,
	isRelationPath,
} from "@/lib/domain/expression/types";
import {
	type ExpressionNode,
	expressionChildren,
} from "@/lib/domain/expression/walk";
import type { WireExpr } from "../xpath/wire/tree";
import type { FormPath } from "./formPath";

interface Calculation {
	readonly name: string;
	readonly path: FormPath;
	readonly expression: Expression;
}

/** Core substitutes a validation candidate at the predicate's current node too.
 * Count a different question's filtered answers outside that candidate context.
 * Only explicit scalar-field collections with context-independent predicates
 * qualify. The proposed answer and relative/current reads stay in validation.
 * The identities remain unchanged; only wire emission substitutes count nodes.
 */
export function planConstraintCollections(
	expression: Expression,
	fieldUuid: Uuid,
	doc: BlueprintDoc,
	path: FormPath,
	nameFor: (ordinal: number) => string,
): {
	expression: Expression;
	calculations: readonly Calculation[];
	overrides: ReadonlyMap<Expression, WireExpr>;
} {
	const calculations: Calculation[] = [];
	const overrides = new Map<Expression, WireExpr>();
	const byStructure = new Map<string, Calculation>();
	const visit = (node: ExpressionNode, insideFilter: boolean): void => {
		if (
			!insideFilter &&
			node.kind === "count" &&
			!isRelationPath(node.via) &&
			node.via.kind === "term" &&
			node.via.term.kind === "field" &&
			independentCollection(node.via.term, fieldUuid, doc)
		) {
			const key = JSON.stringify(node);
			let calculation = byStructure.get(key);
			if (calculation === undefined) {
				const name = nameFor(calculations.length);
				calculation = {
					name,
					path: path.parent().child(name),
					expression: node,
				};
				calculations.push(calculation);
				byStructure.set(key, calculation);
			}
			overrides.set(node, calculation.path.toWire());
			return;
		}
		for (const child of expressionChildren(node)) {
			if (child.kind === "relation") continue;
			const filter =
				child.role.kind === "form-step-filter" ||
				((child.role.kind === "operand" || child.role.kind === "item") &&
					child.role.slot === "where");
			visit(child.value, insideFilter || filter);
		}
	};
	visit(expression, false);
	return { expression, calculations, overrides };
}

function independentCollection(
	field: FormFieldRef,
	validated: Uuid,
	doc: BlueprintDoc,
): boolean {
	const target = doc.fields[field.uuid];
	return (
		field.uuid !== validated &&
		target !== undefined &&
		!isContainer(target) &&
		field.role === undefined &&
		(field.spelling === undefined || field.spelling === "absolute") &&
		field.filters?.every(
			(filter) =>
				filter.step.kind === "field" &&
				filter.step.uuid === field.uuid &&
				filter.step.role === undefined &&
				filter.where.every((where) =>
					safePredicateTree(where, validated, field.uuid),
				),
		) === true
	);
}

/** The old bounded correction allows arithmetic/comparisons, literal values,
 * explicit references and a predicate's own scalar field. Calls and implicit
 * outer/current context may depend on the validation candidate and never move. */
function safePredicateTree(
	node: ExpressionNode,
	validated: Uuid,
	candidate: Uuid,
): boolean {
	switch (node.kind) {
		case "literal":
		case "form-case":
		case "input":
			return true;
		case "session-user":
		case "session-user-property":
			return node.source === "worker-record";
		case "field": {
			if (node.uuid === validated || node.role !== undefined) return false;
			if (node.spelling === "current") return false;
			if (node.spelling === "relative")
				return node.uuid === candidate && node.filters === undefined;
			return (
				node.filters?.every(
					(filter) =>
						filter.step.kind === "field" &&
						filter.step.uuid === node.uuid &&
						filter.step.role === undefined &&
						filter.where.every((where) =>
							safePredicateTree(where, validated, node.uuid),
						),
				) ?? true
			);
		}
		case "term":
		case "eq":
		case "neq":
		case "lt":
		case "lte":
		case "gt":
		case "gte":
		case "arith":
		case "negate":
		case "and":
		case "or":
			return expressionChildren(node).every(
				(child) =>
					child.kind !== "relation" &&
					safePredicateTree(child.value, validated, candidate),
			);
		default:
			return false;
	}
}
