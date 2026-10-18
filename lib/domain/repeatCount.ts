import type {
	FormStructure,
	FormStructureField,
} from "./expression/formStructure";
import type { Expression } from "./expression/types";
import type { Uuid } from "./uuid";

/** Only a bare question reference can be a direct count. Hidden values and
 * other expressions need an integer calculation carrier. Relative/current
 * references retain that carrier because it is their evaluation context. */
export function directRepeatCountReference(
	expression: Expression,
	fields: ReadonlyMap<Uuid, Pick<FormStructureField, "kind">>,
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
	const target = fields.get(field.uuid);
	return target === undefined || target.kind === "hidden"
		? undefined
		: field.uuid;
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
 * Creating the plan reads no expression, and each requested count is memoized. */
export function planRepeatCountCarriers(
	form: FormStructure,
	referencedCountResults: ReadonlySet<Uuid>,
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
				form.fields,
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
