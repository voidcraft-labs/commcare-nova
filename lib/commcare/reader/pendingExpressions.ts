import { literal, matchAll, term } from "@/lib/domain/expression/builders";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import type { HqPlace } from "@/lib/publish/hqFindings";
import type { HqInterpolation } from "../hqJson/xpath";
import type { ClaimSite } from "./accounting";
import type { ExpressionClaim } from "./expressions";
import type { PrintLevel } from "./expressions/printLevel";

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
	/** The expression stage's refusal of this registration waits for the stage that registered
	 *  it, which applies it at its settle or names there what else keeps the slot out
	 *  (`provisional.ts::settleDeferredRefusal`): a Search field's check whose message no longer
	 *  tells whether Nova's runtime guard is joined to the rule. */
	readonly deferRefusal?: true;
	/** The text is one Nova's emitter writes, which the reader recognized as its own and no slot
	 *  holds (a Save to Case block's generated binds and setvalues): the expression stage binds
	 *  nothing of it and claims each use its syntax makes, at the node it was read from, under the
	 *  slot `ref` names for the form it stands in. */
	readonly usesOnly?: true;
	/** A translated output has its own value and the same checking site as the source. */
	readonly translatedOutput?: true;
	/** HQ's build names a fixture where it interpolates the text, so `$fixture_value` is one of the
	 *  patterns it replaces there: a form's display condition in a menu whose lookup table
	 *  selection is active (`menus.py`, `fixture_xpath`). */
	readonly fixtureValue?: true;
	/** The text HQ's build interpolates (`xpath.py::interpolate_xpath`) at the node the claims are
	 *  recorded at, where the registration's text is only a part of it: the whole stored filter a
	 *  list filter's operand or an owner clause stands in, a Search field's whole validation
	 *  condition beside the rule read apart from Nova's guard. Its shorthand is what the slot uses,
	 *  and a hashtag in it, which Core's lexer refuses, leaves the slot no grammar of its own.
	 *  `null` where that node is no slot HQ interpolates (an owner clause whose claims land on the
	 *  menu's `case_details`), so the text's shorthand is no use there. */
	readonly slotText?: string | null;
	/** Physical screens at which the worker evaluates this column. */
	readonly suiteDetails?: readonly string[];
	/** The menu contributions or entries actually evaluating this slot. */
	readonly suiteNavigation?: readonly string[];
	/** Direct declarations on the observed navigation scopes that evaluate this slot. */
	readonly navigationSources?: ReadonlyMap<string, string | null>;
	/** Additional declarations supplied by other inputs of the same physical entry. */
	readonly suiteSources?: ReadonlyMap<string, string>;
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
	/** Every claim the expression stage made of the registration, the slot's own among them: the
	 *  uses its text makes as well as its key's. */
	readonly claims: readonly ExpressionClaim[];
	/** The level the tree was held at, where it is not exact (`expressions/printLevel.ts`): a stage
	 *  that prints the slot again prints it through `levelControl` of it. */
	readonly level?: PrintLevel;
}

/**
 * Whether the expression stage handed the registration's slot to project data (a read of a table
 * the catalog lacks): the slot holds no tree of the source's, so its own print is project data's
 * one finding at the table, never a difference of what prints it.
 */
export function handedOff(outcome: PendingOutcome): boolean {
	const claim = outcome.claim;
	return (claim?.handOff ?? claim?.refusal?.handOff) !== undefined;
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
	/**
	 * The index of each registration of one entity's slots (`ref.entity` and `ref.uuid`), in
	 * registration order: what a settle of one menu, form or field reads of its own slots.
	 */
	of(entity: SlotContextRef["entity"], uuid: string): readonly number[];
	/** The index of the first registration read from `attribute` of `element`, where one was. */
	firstAt(element: object, attribute: string): number | undefined;
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
	 * whose `key` is the registration's own, and, by registration, the level a tree held other
	 * than exact was held at. A slot refused under an entry that names the key of a use the
	 * text makes and not the slot's own key is still refused: its own claim stands under the
	 * slot's allowing entry and carries the refusal (`ExpressionClaim.refusal`), and no tree is
	 * bound. Answering again replaces the answer.
	 */
	answer(
		bound: readonly (Expression | undefined)[],
		claims: readonly ExpressionClaim[],
		levels?: ReadonlyMap<number, PrintLevel>,
	): void;
}

const NOTHING_BOUND: PendingOutcome = Object.freeze({
	expression: undefined,
	claim: undefined,
	claims: [],
});

export function pendingRegistry(): AnsweredPendingRegistry {
	const expressions: PendingExpression[] = [];
	const sites: { readonly at: ClaimSite; readonly event?: DefaultEvent }[] = [];
	let outcomes: readonly PendingOutcome[] = [];
	const byEntity = new Map<string, number[]>();
	const entityKey = (entity: string, uuid: string) => `${entity}/${uuid}`;
	const byAttribute = new WeakMap<object, Map<string, number>>();
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
			const index = expressions.length - 1;
			const key = entityKey(expression.ref.entity, expression.ref.uuid);
			const indices = byEntity.get(key);
			if (indices === undefined) byEntity.set(key, [index]);
			else indices.push(index);
			if ("element" in at && at.attribute !== undefined) {
				const attributes =
					byAttribute.get(at.element) ?? new Map<string, number>();
				if (!attributes.has(at.attribute)) attributes.set(at.attribute, index);
				byAttribute.set(at.element, attributes);
			}
			return index;
		},
		list: () => expressions,
		of: (entity, uuid) => byEntity.get(entityKey(entity, uuid)) ?? [],
		firstAt: (element, attribute) => byAttribute.get(element)?.get(attribute),
		site(index) {
			inRange(index);
			return sites[index] as (typeof sites)[number];
		},
		outcome(index) {
			inRange(index);
			return outcomes[index] ?? NOTHING_BOUND;
		},
		answer(bound, claims, levels) {
			const own = new Map<number, ExpressionClaim>();
			const every = new Map<number, ExpressionClaim[]>();
			for (const claim of claims) {
				const all = every.get(claim.source);
				if (all === undefined) every.set(claim.source, [claim]);
				else all.push(claim);
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
				const level = expression === undefined ? undefined : levels?.get(index);
				return expression === undefined && claim === undefined
					? NOTHING_BOUND
					: {
							expression,
							claim,
							claims: every.get(index) ?? [],
							...(level === undefined ? {} : { level }),
						};
			});
		},
	};
}
