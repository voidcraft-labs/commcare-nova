/**
 * Step 3, `record-expressions` (part 09 §5; part 01 §1.4): every stored
 * `Predicate` / `ValueExpression` is an `Expression` with its bytes
 * unchanged, because every step 3 widening admits every stored value. Two
 * rewrites keep a record's meaning under the new union:
 *
 * (a) `arith` `div` over two `int` operands, which a record slot ran as
 *     integer division, becomes `quotient`. The operands are typed over the
 *     structure, which holds no expression, so a Hidden Value and a property
 *     only its Hidden writers type read as unknown and the verdict is
 *     today's. Meaning and emitted bytes are unchanged, so no line is
 *     written.
 * (b) A string literal opposite a static select's `field` in `eq`, `neq`,
 *     `in.values` or `switch.cases[].when` whose value is one option's (a
 *     multi-select's space-joined options) becomes `choice { field,
 *     options }`, as the record dialect's binder does
 *     (`lib/agent/authoring/bindings.ts::AuthoringScope.choice`); a literal
 *     that names no option stays a literal. The app's members are told once,
 *     with step 4's choices (`expressions-follow-choices`).
 *
 * A record slot that already holds a head `Expression` with neither shape
 * is carried as it is, so a second application changes nothing.
 */

import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { ExpressionNode } from "@/lib/domain/expression/children";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { mapExpressionAst } from "@/lib/domain/expression/mapAst";
import { scalarDataType, typeOf } from "@/lib/domain/expression/typeChecker";
import {
	type Choice,
	type Expression,
	expressionSchema,
	type Literal,
	type Term,
} from "@/lib/domain/expression/types";
import type { Uuid } from "@/lib/domain/uuid";
import type { ExpressionsChangeClass, ExpressionsStep } from "../types";
import { walkWithContext } from "./shared";

/**
 * The record binder of a literal opposite a field: the field's inline
 * options, one per space-separated value of a multi-select, else the
 * literal itself.
 */
export function recordChoiceFor(
	doc: Pick<BlueprintDoc, "fields">,
	field: Uuid,
	value: Literal,
): Literal | Choice {
	if (typeof value.value !== "string") return value;
	const saved = Object.hasOwn(doc.fields, field)
		? doc.fields[field]
		: undefined;
	if (saved === undefined || !("optionsSource" in saved)) return value;
	const source = saved.optionsSource;
	if (source?.kind !== "inline") return value;
	const values =
		saved.kind === "multi_select"
			? value.value.split(/\s+/u).filter(Boolean)
			: [value.value];
	const options = values.map(
		(selected) =>
			source.options.find((option) => option.value === selected)?.uuid,
	);
	if (
		options.length === 0 ||
		!options.every((uuid): uuid is Uuid => uuid !== undefined)
	)
		return value;
	return { kind: "choice", field, options: options as [Uuid, ...Uuid[]] };
}

/** The field a record operand reads directly, if it is a plain field leaf. */
function fieldOperand(operand: Expression | undefined): Uuid | undefined {
	return operand?.kind === "term" &&
		operand.term.kind === "field" &&
		operand.term.role === undefined
		? operand.term.uuid
		: undefined;
}

/** A literal term an operand or a direct leaf holds. */
function literalTerm(node: Expression | Term | undefined): Literal | undefined {
	if (node === undefined) return undefined;
	const term = node.kind === "term" ? (node as { term: Term }).term : node;
	return term.kind === "literal" ? (term as Literal) : undefined;
}

function isInt(operand: Expression, ctx: ExpressionContext): boolean {
	return scalarDataType(typeOf(operand, ctx)?.data) === "int";
}

/** One record value's rewrites, and which of the two it met. */
export function rewriteRecordExpression(
	expression: Expression,
	ctx: ExpressionContext,
	doc: Pick<BlueprintDoc, "fields">,
): {
	readonly value: Expression;
	readonly quotient: number;
	readonly choice: number;
} {
	const nodes = new Map<ExpressionNode, ExpressionNode>();
	let quotient = 0;
	let choice = 0;
	/* `holder` is the operand wrapper (`{ kind: "term" }`) of a comparison
	 * side, or the direct leaf of `in.values` and `switch.cases[].when`. */
	const bind = (
		leaf: Literal | undefined,
		field: Uuid | undefined,
		holder: ExpressionNode,
	) => {
		if (leaf === undefined || field === undefined) return;
		const bound = recordChoiceFor(doc, field, leaf);
		if (bound === leaf) return;
		nodes.set(
			holder,
			holder.kind === "literal" ? bound : { kind: "term", term: bound },
		);
		choice += 1;
	};
	walkWithContext(expression, ctx, (node, nodeCtx) => {
		switch (node.kind) {
			case "arith":
				if (
					node.op === "div" &&
					isInt(node.left, nodeCtx) &&
					isInt(node.right, nodeCtx)
				) {
					nodes.set(node, { ...node, op: "quotient" });
					quotient += 1;
				}
				break;
			case "eq":
			case "neq":
				bind(literalTerm(node.right), fieldOperand(node.left), node.right);
				bind(literalTerm(node.left), fieldOperand(node.right), node.left);
				break;
			case "in": {
				const field = fieldOperand(node.left);
				for (const value of node.values)
					if (value.kind === "literal") bind(value, field, value);
				break;
			}
			case "switch": {
				const field = fieldOperand(node.on);
				for (const entry of node.cases)
					if (entry.when.kind === "literal")
						bind(entry.when, field, entry.when);
				break;
			}
		}
	});
	if (nodes.size === 0) return { value: expression, quotient, choice };
	const apply = (node: Expression): Expression =>
		mapExpressionAst(node, {
			mapExpression: (candidate) => {
				const replacement = nodes.get(candidate);
				if (replacement === undefined) return undefined;
				// A quotient's operands may hold rewrites of their own.
				return candidate.kind === "arith" && replacement.kind === "arith"
					? {
							...replacement,
							left: apply(candidate.left),
							right: apply(candidate.right),
						}
					: (replacement as Expression);
			},
			mapTerm: (term) => nodes.get(term) as Term | undefined,
		});
	return { value: apply(expression), quotient, choice };
}

export const recordExpressionsStep: ExpressionsStep = {
	id: "record-expressions",
	apply(doc) {
		const structure = doc.structure();
		for (const slot of doc.slots()) {
			if (slot.ruleSet !== "record" || slot.lifted !== false) continue;
			const parsed = expressionSchema.safeParse(slot.stored);
			const ctx = doc.structureContext(slot);
			// A stored value the head union does not hold is the target's
			// own blocker; a structure that fails the head schema is too.
			if (!parsed.success || ctx === undefined || !structure.ok) continue;
			const { value, quotient, choice } = rewriteRecordExpression(
				parsed.data,
				ctx,
				structure.doc,
			);
			const classes = new Set<ExpressionsChangeClass<"record-expressions">>([
				"structural",
			]);
			if (quotient > 0) classes.add("quotient");
			if (choice > 0) classes.add("choice");
			doc.lift(
				slot,
				value,
				"record-expressions",
				classes,
				value !== parsed.data,
			);
		}
		return { changes: [], blockers: [], classes: [], places: [] };
	},
};
