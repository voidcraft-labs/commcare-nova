import { isValid, parseISO } from "date-fns";
import {
	type SearchInputDef,
	simpleSearchInputHasCoherentRangeWidget,
} from "@/lib/domain";

/** Wire-form calendar date accepted by CommCare's daterange encoding. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const DATE_RANGE_PAIR_REQUIRED_MESSAGE =
	"Choose both a start date and an end date";
export const DATE_RANGE_ORDER_MESSAGE =
	"Choose an end date on or after the start date";
export const DATE_RANGE_INVALID_MESSAGE = "Choose valid start and end dates";
export const DATE_RANGE_CONFIGURATION_MESSAGE =
	"This search field's date settings don't match. Return to edit and choose Date range with Between dates";

export type SearchInputValuesLike = ReadonlyMap<string, string>;

/**
 * Errors that must block a search submission before Preview or CommCare runs.
 *
 * CommCare serializes a daterange as one indivisible
 * `__range__<start>__<end>` answer. Core and HQ reject any shape without both
 * dates, so Nova may preserve a partial pair as an editable draft but must not
 * execute it. The independent Nova pickers can also create a reversed range;
 * catching that here gives the worker a useful correction instead of an empty
 * result whose cause is invisible.
 */
export function dateRangeInputErrors(
	searchInputs: readonly SearchInputDef[],
	values: SearchInputValuesLike,
): ReadonlyMap<string, string> {
	const errors = new Map<string, string>();
	for (const input of searchInputs) {
		if (
			input.kind === "simple" &&
			!simpleSearchInputHasCoherentRangeWidget(input)
		) {
			errors.set(input.name, DATE_RANGE_CONFIGURATION_MESSAGE);
			continue;
		}
		if (input.type !== "date-range") continue;
		const lower = values.get(`${input.name}:from`)?.trim() ?? "";
		const upper = values.get(`${input.name}:to`)?.trim() ?? "";
		if (lower === "" && upper === "") continue;
		if (lower === "" || upper === "") {
			errors.set(input.name, DATE_RANGE_PAIR_REQUIRED_MESSAGE);
			continue;
		}
		if (!isValidCalendarDate(lower) || !isValidCalendarDate(upper)) {
			errors.set(input.name, DATE_RANGE_INVALID_MESSAGE);
			continue;
		}
		// ISO calendar dates sort chronologically by code point.
		if (lower > upper) errors.set(input.name, DATE_RANGE_ORDER_MESSAGE);
	}
	return errors;
}

export function isValidCalendarDate(value: string): boolean {
	return ISO_DATE_PATTERN.test(value) && isValid(parseISO(value));
}

/** Typed boundary for server-side callers that bypass the form. */
export class SearchInputValuesError extends Error {
	readonly errors: ReadonlyMap<string, string>;

	constructor(errors: ReadonlyMap<string, string>) {
		const first = errors.values().next().value;
		super(
			typeof first === "string"
				? first
				: "Correct the search values and try again",
		);
		this.name = "SearchInputValuesError";
		this.errors = errors;
	}
}
