import type { ExpressionFacts } from "./expression/context";
import type {
	FormStructure,
	FormStructureField,
} from "./expression/formStructure";
import { isWholeChoiceValue } from "./expression/typeChecker";
import type { Expression } from "./expression/types";
import type { Uuid } from "./uuid";

/** The facts a direct count reads: a Hidden Value's inferred data type. */
export type RepeatCountFacts = Pick<ExpressionFacts, "hiddenTypes">;

/** A field `jr:count` can name as it is, with no copy: Core reads the count
 * as `IntegerData().cast(count.uncast())`, so the node must hold whole-number
 * text however it got there.
 *
 * - An `int` question holds an integer.
 * - A single select whose inline choices are each whole-number text holds
 *   one of them (the checker's count rule, `isWholeChoiceValue`).
 * - A Hidden Value calculated as an `int` holds an integer: a calculate's
 *   integral result is `IntegerData` whatever the bind
 *   (`Recalculate.java::wrapData`). One that holds only a starting value is
 *   not direct, since a setvalue casts into the bind's type
 *   (`SetValueAction`) and an integer into a decimal node reads `3.0`. */
function countsDirectly(
	field: FormStructureField,
	facts: RepeatCountFacts,
): boolean {
	switch (field.kind) {
		case "int":
			return true;
		case "single_select":
			return (
				field.choices?.kind === "inline" &&
				field.choices.options.every((option) =>
					isWholeChoiceValue(option.value),
				)
			);
		case "hidden":
			return (
				field.hiddenValueSource === "calculate" &&
				facts.hiddenTypes.get(field.uuid) === "int"
			);
		default:
			return false;
	}
}

/** The field a repeat's count names directly, or undefined where the count
 * takes the generated `nova_count_<repeat>` carrier. Only a bare read with no
 * filter and no role, spelled with a hashtag or an absolute path, of a field
 * that `countsDirectly`, is direct. A relative or `current()` read keeps the
 * carrier, because the carrier is its evaluation context. */
export function directRepeatCountReference(
	expression: Expression,
	form: FormStructure,
	facts: RepeatCountFacts,
): Uuid | undefined {
	if (expression.kind !== "term" || expression.term.kind !== "field")
		return undefined;
	const field = expression.term;
	if (
		field.role !== undefined ||
		field.filters !== undefined ||
		(field.spelling !== undefined && field.spelling !== "absolute")
	)
		return undefined;
	const target = form.fields.get(field.uuid);
	return target !== undefined && countsDirectly(target, facts)
		? field.uuid
		: undefined;
}

export interface RepeatCountCarrier {
	readonly expression: Expression;
	readonly directReference?: Uuid;
	readonly materialized: boolean;
}

export interface RepeatCountCarrierPlan {
	/** Undefined only when the owner is not a count-bound repeat. */
	forRepeat(uuid: Uuid): RepeatCountCarrier | undefined;
}

/** The complete typed form decides physical count carriers after all pending
 * expressions have bound their identities. The incoming set is immutable and
 * complete; name binding must never ask this plan about physical presence.
 * Creating the plan reads no expression, and each requested count is memoized.
 * A direct count's carrier is still materialized when another expression
 * reads its `count-result`. */
export function planRepeatCountCarriers(
	form: FormStructure,
	referencedCountResults: ReadonlySet<Uuid>,
	facts: RepeatCountFacts,
): RepeatCountCarrierPlan {
	const carriers = new Map<Uuid, RepeatCountCarrier | undefined>();
	return {
		forRepeat(uuid) {
			if (carriers.has(uuid)) return carriers.get(uuid);
			const field = form.fields.get(uuid);
			if (field?.kind !== "repeat" || field.repeatMode !== "count_bound") {
				carriers.set(uuid, undefined);
				return undefined;
			}
			const expression = form.expressionAt({
				entity: "field",
				uuid,
				slot: "repeat_count",
			});
			if (expression === undefined)
				throw new Error(
					`The count-bound repeat ${field.id} has no count expression. Resolve its required expression before planning form calculations.`,
				);
			const directReference = directRepeatCountReference(
				expression,
				form,
				facts,
			);
			const result: RepeatCountCarrier = {
				expression,
				...(directReference === undefined ? {} : { directReference }),
				materialized:
					directReference === undefined || referencedCountResults.has(uuid),
			};
			carriers.set(uuid, result);
			return result;
		},
	};
}
