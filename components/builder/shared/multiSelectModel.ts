import type {
	CasePropertyDataType,
	CaseType,
	UserProperty,
} from "@/lib/domain";
import type { ExpressionOfKind } from "@/lib/domain/expression";
import {
	type Choice,
	type Expression,
	type ExpressionContext,
	input,
	isExpression,
	type Literal,
	literal,
	type PropertyRef,
	type ScalarType,
	type SearchInputDecl,
	type SlotConstraint,
	sessionUserProperty,
	term,
} from "@/lib/domain/expression";
import { chosenCaseProperty } from "@/lib/domain/expression/chosenCase";
import type { ExpressionChangeAdmission } from "./editorContext";
import { resolveRelationDestination } from "./relationDestination";
export type MultiSelectPredicate = ExpressionOfKind<"multi-select-contains">;
/** One authored value of the predicate: a fixed choice, a question's choice,
 * or a value worked out when the rule runs. */
export type MultiSelectValue = MultiSelectPredicate["values"][number];
export function multiSelectProperty(
	ref: PropertyRef,
	caseTypes: readonly CaseType[],
	currentCaseType?: string,
) {
	const origin = ref.caseType ?? currentCaseType;
	if (origin === undefined) return undefined;
	const destination =
		ref.via === undefined
			? origin
			: resolveRelationDestination(ref.via, origin, caseTypes);
	return caseTypes
		.find((caseType) => caseType.name === destination)
		?.properties.find((property) => property.name === ref.property);
}

/** A value worked out when the rule runs, as opposed to a fixed choice. */
export function isRuntimeMultiSelectValue(
	value: MultiSelectValue,
): value is Expression {
	return isExpression(value);
}

/** The shapes the card edits: fixed choices and values worked out at run
 * time. A question's `choice` leaf stays a saved expression here. */
export function isEditableMultiSelectValues(
	values: readonly MultiSelectValue[],
): values is [Literal | Expression, ...(Literal | Expression)[]] {
	return (
		values.length > 0 &&
		values.every(
			(value) => value.kind === "literal" || isRuntimeMultiSelectValue(value),
		)
	);
}

/** A property change resets the fixed choices to the new property's first
 * option, since the old property's options mean nothing to it, and keeps the
 * values worked out at run time, which name choices by their value alone. */
export function replaceMultiSelectProperty(
	value: MultiSelectPredicate,
	next: PropertyRef,
	caseTypes: readonly CaseType[],
	currentCaseType?: string,
): Omit<MultiSelectPredicate, "property"> & {
	readonly property: PropertyRef;
} {
	const runtime = value.values.filter(isRuntimeMultiSelectValue);
	const [firstRuntime, ...restRuntime] = runtime;
	if (firstRuntime !== undefined)
		return { ...value, property: next, values: [firstRuntime, ...restRuntime] };
	const first = literal(
		multiSelectProperty(next, caseTypes, currentCaseType)?.options?.[0]
			?.value ?? "",
	);
	return { ...value, property: next, values: [first] };
}
export function replaceMultiSelectValues(
	value: MultiSelectPredicate,
	next: readonly (Literal | Choice | Expression)[],
): MultiSelectPredicate | undefined {
	const [first, ...rest] = next;
	if (first === undefined) return undefined;
	return { ...value, values: [first, ...rest] };
}

/** Whether a device evaluates this slot: there a value naming choices must
 * be one choice, since the device tests it as one. */
export function deviceEvaluatesSlot(context: ExpressionContext): boolean {
	return (
		context.profile.targets.has("SU") ||
		context.profile.targets.has("XF") ||
		context.runsOnDevice === true
	);
}

const ANY_CHOICE_VALUE_TYPES: ReadonlySet<ScalarType> = new Set([
	"text",
	"single_select",
	"multi_select",
]);
const SINGLE_CHOICE_VALUE_TYPES: ReadonlySet<ScalarType> = new Set([
	"single_select",
]);

/** The types a value worked out at run time may have in this slot: text or
 * a choice where only the server reads it, one choice where a device does. */
export function multiSelectValueConstraint(
	context: ExpressionContext,
): SlotConstraint {
	return {
		accepts: deviceEvaluatesSlot(context)
			? SINGLE_CHOICE_VALUE_TYPES
			: ANY_CHOICE_VALUE_TYPES,
	};
}

export type MultiSelectValueOffer =
	| {
			readonly admitted: true;
			/** The value the offer appends. */
			readonly added: Expression;
			readonly next: MultiSelectPredicate;
	  }
	| { readonly admitted: false; readonly reason: string };

export const NO_RUNTIME_CHOICE_VALUE_REASON =
	"Nothing here names a choice yet. You can add a search field, worker information, or a choice on a case chosen in an earlier menu.";

/**
 * What "Add a value from" commits: the predicate with one more value, the
 * first source in scope whose type the slot admits and whose whole rule the
 * gate admits. Sources, each ranked one choice, then text, then several
 * choices: the search's answers, a property of the case chosen in an earlier
 * menu (`ExpressionContext.supplies`), and worker information.
 * A device evaluates a value naming choices as one choice, so in a device
 * slot only a single-choice source can be offered. The person points the
 * value elsewhere through its own source menu.
 */
export function addMultiSelectValueOffer(
	value: MultiSelectPredicate,
	sources: {
		readonly context: ExpressionContext;
		readonly knownInputs: readonly SearchInputDecl[];
		readonly userProperties: readonly UserProperty[];
	},
	admit:
		| ((next: MultiSelectPredicate) => ExpressionChangeAdmission)
		| undefined,
): MultiSelectValueOffer {
	const accepts = multiSelectValueConstraint(sources.context).accepts;
	const rank: readonly CasePropertyDataType[] = [
		"single_select",
		"text",
		"multi_select",
	];
	const { facts, supplies } = sources.context;
	const chosenCaseProperties = supplies.refs.flatMap(({ ref, scalar }) => {
		if (!scalar || ref.kind !== "selected-case") return [];
		const caseType = facts.moduleCaseTypes.get(ref.module);
		const type = facts.caseTypes.find((each) => each.name === caseType);
		if (caseType === undefined || type === undefined) return [];
		return type.properties.map((property) => ({
			type: property.data_type ?? "text",
			value: chosenCaseProperty(
				ref.module,
				caseType,
				property.name,
			) as Expression,
		}));
	});
	const all = [
		...sources.knownInputs.map((candidate) => ({
			type: candidate.data_type ?? "text",
			value: term(input(candidate.uuid)) as Expression,
		})),
		...chosenCaseProperties,
		...sources.userProperties.map((property) => ({
			type: "text" as CasePropertyDataType,
			value: term(sessionUserProperty(property.uuid)) as Expression,
		})),
	];
	const candidates = rank
		.flatMap((type) => all.filter((candidate) => candidate.type === type))
		.filter((candidate) => accepts === "any" || accepts.has(candidate.type))
		.map((candidate) => candidate.value);
	let refusal: string | undefined;
	for (const candidate of candidates) {
		const next = replaceMultiSelectValues(value, [...value.values, candidate]);
		if (next === undefined) continue;
		const verdict = admit?.(next) ?? { admitted: true };
		if (verdict.admitted) return { admitted: true, added: candidate, next };
		refusal ??= verdict.reason;
	}
	return {
		admitted: false,
		reason: refusal ?? NO_RUNTIME_CHOICE_VALUE_REASON,
	};
}
