import { literal, matchAll, term } from "@/lib/domain/expression/builders";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import type { HqPlace } from "@/lib/publish/hqFindings";
import type { HqInterpolation } from "../hqJson/xpath";
import type { ClaimSite } from "./accounting";
import type { ExpressionClaim } from "./expressions";

/** How an expression's text is printed and compared: the XForm attribute it
 *  was read from, or an HQ JSON slot under the interpolation HQ's build
 *  applies to it. */
export type ReadMode =
	/** `constraint`: the attribute is a validation condition, where the printer writes a
	 *  predicate's own node as `.` and elsewhere as `./.` (`xpath/wire/CLAUDE.md`, "Printing"). */
	| { readonly target: "xform"; readonly constraint: boolean }
	| {
			readonly target: "hq-json";
			readonly interpolation: HqInterpolation;
	  };

/** One expression a structure reader found, registered for the expression
 *  stage, which binds every registration against the finished structure. */
export interface PendingExpression {
	/** The slot the expression belongs to, which exists in the document. */
	readonly ref: SlotContextRef;
	/** HQ's text, as the source holds it. */
	readonly text: string;
	readonly mode: ReadMode;
	readonly place: HqPlace;
	/** The surface key the claim is logged under: `xform:model/bind@relevant`, `schema:Detail.filter`. */
	readonly key: string;
}

/** What a slot that must hold a tree holds until the expression stage fills
 *  it: `match-all` for a condition, the empty string for a value. */
export function pendingPlaceholder(
	expectation: "condition" | "value",
): Expression {
	return expectation === "condition" ? matchAll() : term(literal(""));
}

/** A default's event: when the form sets it. */
export type DefaultEvent = "xforms-ready" | "jr-insert";

/** What the expression stage answered for one registration. */
export interface PendingOutcome {
	readonly expression: Expression | undefined;
	readonly claim: ExpressionClaim | undefined;
}

/**
 * Every expression a structure stage registered, with what the record does not
 * hold: the node it was read from, a default's event, and what the expression
 * stage answered for it. Stages read a registration's result through it and no
 * other way.
 */
export interface PendingRegistry {
	/** Register one expression with the node it was read from. Returns the registration's index. */
	register(
		expression: PendingExpression,
		at: ClaimSite,
		options?: { readonly event?: DefaultEvent },
	): number;
	/** Every registration, in registration order: what `readExpressions` takes. */
	list(): readonly PendingExpression[];
	/** The node the registration at `index` was read from, and its event where it is a default. */
	site(index: number): {
		readonly at: ClaimSite;
		readonly event?: DefaultEvent;
	};
	/** What the expression stage answered for the registration at `index`. */
	outcome(index: number): PendingOutcome;
}

/** The registry a reading holds, with the one write the expression stage makes. */
export interface AnsweredPendingRegistry extends PendingRegistry {
	/**
	 * Records the expression stage's answer: per registration, the tree it held
	 * (`bound[i]`) and the slot's own claim, the one whose `source` is `i` and
	 * whose `key` is the registration's own. Answering again replaces the answer.
	 */
	answer(
		bound: readonly (Expression | undefined)[],
		claims: readonly ExpressionClaim[],
	): void;
}

const NOTHING_BOUND: PendingOutcome = Object.freeze({
	expression: undefined,
	claim: undefined,
});

export function pendingRegistry(): AnsweredPendingRegistry {
	const expressions: PendingExpression[] = [];
	const sites: { readonly at: ClaimSite; readonly event?: DefaultEvent }[] = [];
	let outcomes: readonly PendingOutcome[] = [];
	const inRange = (index: number) => {
		if (!Number.isInteger(index) || index < 0 || index >= expressions.length)
			throw new RangeError(
				`No expression is registered at ${index}; the registry holds ${expressions.length}. Read a registration by the index register returned for it.`,
			);
	};
	return {
		register(expression, at, options) {
			expressions.push(expression);
			sites.push(
				options?.event === undefined ? { at } : { at, event: options.event },
			);
			return expressions.length - 1;
		},
		list: () => expressions,
		site(index) {
			inRange(index);
			return sites[index] as (typeof sites)[number];
		},
		outcome(index) {
			inRange(index);
			return outcomes[index] ?? NOTHING_BOUND;
		},
		answer(bound, claims) {
			const own = new Map<number, ExpressionClaim>();
			for (const claim of claims) {
				const registration = expressions[claim.source];
				if (
					registration !== undefined &&
					claim.key === registration.key &&
					!own.has(claim.source)
				)
					own.set(claim.source, claim);
			}
			outcomes = expressions.map((_, index) => {
				const expression = bound[index];
				const claim = own.get(index);
				return expression === undefined && claim === undefined
					? NOTHING_BOUND
					: { expression, claim };
			});
		},
	};
}
