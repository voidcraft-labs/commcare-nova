/**
 * Step 4, `form-logic-lift` (part 09 §4, §5; part 02 §1.2 to §1.4): every
 * stored `XPathExpression` of a form-logic slot is printed by the frozen
 * pre-step printer over the raw rows and parsed by the production parser,
 * `parseFormExpression(text, scope)`, with the slot's `ExpressionSlotRef`,
 * the Project's lookup definitions, the structure as its document and no
 * `current` tree and no `authoring` scope. There is no second lifting
 * dialect: a refusal is the parser's, with its issue codes.
 *
 * Its classes, each counted on its own: (4a) `respelled`, the stored text
 * differs from the canonical print of the parsed tree; (4b) `relative`, a
 * relative or `current()` path or a repeat row; (4c) `case-query`, a
 * `casedb` query; (4d) `session-datum`, a session datum read; (4e)
 * `choice`, a choice leaf; (4f) `empty`, an empty text in an optional slot,
 * which becomes absence. An empty text in a required slot is the blocker
 * `empty-required-expression`; a leaf the frozen printer cannot resolve is
 * `old-reference-dangling`, which no admitted document holds.
 *
 * A form-logic slot that already holds an `Expression` is carried as it
 * is, so a second application changes nothing.
 */

import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import { projectFormExpression } from "@/lib/doc/expressionText";
import {
	type Expression,
	expressionSchema,
	type Term,
} from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import {
	type FrozenXPathExpression,
	projectFrozenXPath,
} from "../frozenPrinter";
import type {
	BlockerPlace,
	ExpressionsChangeClass,
	ExpressionsStep,
	StepContext,
} from "../types";
import type { SlotState, WorkingDocument } from "./working";

type LiftClass = ExpressionsChangeClass<"form-logic-lift">;

/** The step 4 classes a parsed tree falls in, beside `lifted` and `respelled`. */
export function liftClasses(expression: Expression): Set<LiftClass> {
	const classes = new Set<LiftClass>();
	const term = (leaf: Term) => {
		switch (leaf.kind) {
			case "field":
			case "form-node":
				if (leaf.spelling === "relative" || leaf.spelling === "current")
					classes.add("relative");
				break;
			case "repeat-row":
				classes.add("relative");
				break;
			case "session-datum":
				classes.add("session-datum");
				break;
			case "choice":
				classes.add("choice");
				break;
		}
	};
	walkExpression(expression, {
		visitExpression: (node) => {
			if (node.kind === "cases" && node.source === "casedb")
				classes.add("case-query");
		},
		visitTerm: term,
	});
	return classes;
}

/**
 * A pre-step stored text, `{ parts }` and nothing else. A head `concat`
 * also holds `parts`, beside its `kind`, so the key set decides.
 */
export function isStoredXPath(value: unknown): value is FrozenXPathExpression {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		!Object.hasOwn(value, "kind") &&
		Array.isArray((value as { parts?: unknown }).parts)
	);
}

/** What one lift met. */
export type LiftOutcome =
	| { readonly kind: "lifted" }
	| {
			readonly kind: "refused";
			readonly codes: readonly string[];
			readonly place: BlockerPlace;
	  }
	| { readonly kind: "blocked"; readonly place: BlockerPlace }
	| { readonly kind: "carried" };

/**
 * Print and parse one form-logic slot against the working document's
 * current structure; on success the slot holds the parsed tree.
 */
export function liftFormSlot(
	doc: WorkingDocument,
	slot: SlotState,
	ctx: StepContext,
): LiftOutcome {
	const entity = { kind: slot.owner.entity, uuid: slot.owner.uuid };
	if (!isStoredXPath(slot.stored)) {
		const parsed = expressionSchema.safeParse(slot.stored);
		if (!parsed.success) return { kind: "carried" };
		doc.lift(slot, parsed.data, "form-logic-lift", new Set());
		return { kind: "carried" };
	}
	const printed = projectFrozenXPath(slot.stored, doc.frozenContext());
	if (!printed.ok)
		return {
			kind: "blocked",
			place: {
				code: "old-reference-dangling",
				entity,
				slot: slot.ref.slot,
				findingCode: printed.unresolved.map((leaf) => leaf.kind).join(","),
				text: printed.text,
			},
		};
	if (printed.text.trim() === "") {
		if (slot.required)
			return {
				kind: "blocked",
				place: {
					code: "empty-required-expression",
					entity,
					slot: slot.ref.slot,
				},
			};
		doc.lift(slot, undefined, "form-logic-lift", new Set(["lifted", "empty"]));
		return { kind: "lifted" };
	}
	const structure = doc.structure();
	// A structure that fails the head schema is the target's own blocker.
	if (!structure.ok) return { kind: "carried" };
	const result = parseFormExpression(printed.text, {
		doc: structure.doc,
		slot: slot.ref,
		lookup: ctx.lookup,
	});
	if (!result.ok) {
		const codes = [...new Set(result.issues.map((issue) => issue.code))].sort();
		const place: BlockerPlace = {
			code: "expression-parse-refused",
			entity,
			slot: slot.ref.slot,
			findingCode: codes.join(","),
			text: `${printed.text}\n${result.issues.map((issue) => issue.message).join("\n")}`,
		};
		slot.refused = { codes, place };
		return { kind: "refused", codes, place };
	}
	const expression = result.expression;
	if (expression === undefined) {
		if (slot.required)
			return {
				kind: "blocked",
				place: {
					code: "empty-required-expression",
					entity,
					slot: slot.ref.slot,
				},
			};
		doc.lift(slot, undefined, "form-logic-lift", new Set(["lifted", "empty"]));
		return { kind: "lifted" };
	}
	const classes = liftClasses(expression);
	classes.add("lifted");
	const canonical = projectFormExpression(
		structure.doc,
		slot.ref,
		expression,
		ctx.lookup,
	);
	if (canonical.text !== printed.text) classes.add("respelled");
	doc.lift(slot, expression, "form-logic-lift", classes);
	return { kind: "lifted" };
}

export const formLogicLiftStep: ExpressionsStep = {
	id: "form-logic-lift",
	apply(doc, ctx) {
		const places: BlockerPlace[] = [];
		for (const slot of doc.slots()) {
			if (slot.ruleSet !== "form" || slot.lifted !== false) continue;
			const outcome = liftFormSlot(doc, slot, ctx);
			if (outcome.kind === "blocked") {
				slot.blocked = outcome.place.code;
				places.push(outcome.place);
			}
		}
		const count = (code: BlockerPlace["code"]) =>
			places.filter((place) => place.code === code).length;
		const blockers = (
			["empty-required-expression", "old-reference-dangling"] as const
		)
			.filter((code) => count(code) > 0)
			.map((code) => ({ code, count: count(code), findingCodes: [] }));
		return { changes: [], blockers, classes: [], places };
	},
};
