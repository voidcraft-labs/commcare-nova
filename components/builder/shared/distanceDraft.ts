import type { CasePropertyDataType } from "@/lib/domain";
import {
	DISTANCE_UNITS,
	type DistanceUnit,
	distanceValidationIssue,
	double,
	type Expression,
	input,
	literal,
	type ScalarType,
	type SearchInputDecl,
	type SlotConstraint,
	term,
} from "@/lib/domain/expression";
import type { ExpressionChangeAdmission } from "./editorContext";

/** HQ's nine distance units (`es/queries.py::DISTANCE_UNITS`), in the menu's
 * order, each with the words a person reads. */
export const DISTANCE_UNIT_LABELS: Record<DistanceUnit, string> = {
	miles: "miles",
	yards: "yards",
	feet: "feet",
	inch: "inches",
	kilometers: "kilometers",
	meters: "meters",
	centimeters: "centimeters",
	millimeters: "millimeters",
	nauticalmiles: "nautical miles",
};

export const DISTANCE_UNIT_CHOICES: readonly DistanceUnit[] = DISTANCE_UNITS;

export function isDistanceUnit(value: unknown): value is DistanceUnit {
	return (
		typeof value === "string" &&
		(DISTANCE_UNITS as readonly string[]).includes(value)
	);
}

/** A distance worked out from a value: a number (`distance-not-numeric`). */
export const DISTANCE_VALUE_CONSTRAINT: SlotConstraint = {
	accepts: new Set<ScalarType>(["int", "decimal"]),
};

/** A unit worked out from a value: text or one choice naming a unit
 * (`distance-unit-type`). */
export const DISTANCE_UNIT_VALUE_CONSTRAINT: SlotConstraint = {
	accepts: new Set<ScalarType>(["text", "single_select"]),
};

/** The fixed values a card returns to when a person stops using a value. */
export const FIXED_DISTANCE_FALLBACK = 1;
export const FIXED_UNIT_FALLBACK: DistanceUnit = "miles";

function firstInputOf(
	inputs: readonly SearchInputDecl[],
	types: ReadonlySet<CasePropertyDataType>,
): SearchInputDecl | undefined {
	return inputs.find((candidate) => types.has(candidate.data_type ?? "text"));
}

/** The value "Use a value" starts the distance with: a number search answer
 * when the search has one, else a text answer read as a number (a search's
 * typed answers are text), else the current fixed distance as a value the
 * person can then point elsewhere. */
export function distanceValueSeed(
	inputs: readonly SearchInputDecl[],
	currentDistance: number | Expression,
): Expression {
	const number = firstInputOf(inputs, new Set(["int", "decimal"]));
	if (number !== undefined) return term(input(number.uuid));
	const text = firstInputOf(inputs, new Set(["text"]));
	if (text !== undefined) return double(term(input(text.uuid)));
	return term(
		literal(
			typeof currentDistance === "number"
				? currentDistance
				: FIXED_DISTANCE_FALLBACK,
		),
	);
}

/** The value "Use a value" starts the unit with: a text or single-choice
 * search answer when the search has one, else the current unit as text. */
export function unitValueSeed(
	inputs: readonly SearchInputDecl[],
	currentUnit: DistanceUnit | Expression,
): Expression {
	const answer = firstInputOf(inputs, new Set(["text", "single_select"]));
	if (answer !== undefined) return term(input(answer.uuid));
	return term(
		literal(
			typeof currentUnit === "string" ? currentUnit : FIXED_UNIT_FALLBACK,
		),
	);
}

/** Parse a typed distance. `unit` is the fixed unit, or undefined when a
 * value supplies the unit, so only the radius itself can be checked. */
export function positiveDistance(
	draft: string,
	unit: DistanceUnit | undefined,
): { value: number; error?: undefined } | { value?: undefined; error: string } {
	if (draft.trim() === "") {
		return { error: "Enter a distance greater than 0" };
	}
	const parsed = Number(draft);
	// Without a fixed unit only the radius itself is checked: a factor of one
	// never overflows a finite number.
	const issue = distanceValidationIssue(parsed, unit ?? "meters");
	switch (issue) {
		case "not-positive-finite":
			return { error: "Enter a distance greater than 0" };
		case "meters-overflow":
			return {
				error: `Enter a smaller distance in ${DISTANCE_UNIT_LABELS[unit ?? "meters"]}`,
			};
		case undefined:
			return { value: parsed };
		default: {
			const _exhaustive: never = issue;
			return _exhaustive;
		}
	}
}

type WithinDistance = Extract<Expression, { kind: "within-distance" }>;

export interface DistanceSourceChoice {
	/** The predicate the choice commits. */
	readonly next: WithinDistance;
	readonly admission: ExpressionChangeAdmission;
}

/**
 * The two source switches the card offers for the radius and for the unit:
 * "Use a value" from a fixed one, and back to a fixed one from a value. Each
 * is the exact predicate the click commits, with the whole-rule verdict for
 * it, so the card offers a switch only where the gate admits its result.
 */
export function distanceSourceChoices(
	value: WithinDistance,
	inputs: readonly SearchInputDecl[],
	admit: ((next: WithinDistance) => ExpressionChangeAdmission) | undefined,
): {
	readonly distance: DistanceSourceChoice;
	readonly unit: DistanceSourceChoice;
} {
	const verdict = (next: WithinDistance): DistanceSourceChoice => ({
		next,
		admission: admit?.(next) ?? { admitted: true },
	});
	return {
		distance: verdict({
			...value,
			distance:
				typeof value.distance === "number"
					? distanceValueSeed(inputs, value.distance)
					: FIXED_DISTANCE_FALLBACK,
		}),
		unit: verdict({
			...value,
			unit:
				typeof value.unit === "string"
					? unitValueSeed(inputs, value.unit)
					: FIXED_UNIT_FALLBACK,
		}),
	};
}
