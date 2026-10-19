// components/builder/shared/checkErrorPresentation.ts
//
// Builder-language presentation for predicate / expression checker
// findings. The checker keeps precise implementation detail in
// `CheckError.message` for agents, logs, and developer diagnostics. A
// person editing a condition instead sees one concise next action,
// selected from the stable error code, its reason, and the slot path.
//
// Never inspect or pattern-match `message` here. Checker prose is free
// to improve without changing the editor's UX contract.

import {
	type CheckError,
	type CheckErrorCode,
	type CheckPath,
	dayOnlyRefusalCopy,
	UNREADABLE_DATETIME_NEXT,
} from "@/lib/domain/expression";

type DiagnosticPresenter = (
	path: CheckPath,
	reason?: string,
	error?: CheckError,
) => string;

/** Return the closest named slot, skipping array indexes. */
function lastNamedSlot(path: CheckPath): string | undefined {
	for (let index = path.length - 1; index >= 0; index--) {
		const segment = path[index];
		if (typeof segment === "string") return segment;
	}
	return undefined;
}

/**
 * A path-aware fallback for an untyped boundary or a future checker
 * category. Even the fallback names the action when the path identifies
 * an editable property, value, Search field, or relationship slot.
 */
function nextActionForPath(path: CheckPath): string {
	switch (lastNamedSlot(path)) {
		case "property":
			return "Choose available case information";
		case "input":
			return "Choose an available Search field";
		case "via":
			return "Choose an available connection to another case";
		case "left":
		case "right":
		case "value":
		case "values":
		case "lower":
		case "upper":
		case "center":
		case "date":
		case "quantity":
		case "on":
		case "when":
		case "then":
		case "else":
		case "fallback":
			return "Choose a value that works here";
		case "clause":
		case "where":
		case "cond":
			return "Review this condition and update the highlighted choice";
		default:
			return "Review this setting and choose an available option";
	}
}

const PRESENT_BY_CODE: Record<CheckErrorCode, DiagnosticPresenter> = {
	"unknown-property": () => "Choose available case information",
	"unknown-search-input": () => "Choose an available Search field",
	"unknown-form-field": () => "Choose an available form answer",
	"unknown-user-property": () => "Choose available worker information",
	"unknown-operation-id": () => "Choose an earlier case operation",
	"operation-context-value": () =>
		"Choose a value available in this part of the app",
	"unknown-case-type": () =>
		"Choose information from an available kind of case",
	"unknown-lookup-table": () => "Choose an available lookup table",
	"unknown-lookup-column": () => "Choose an available lookup table column",
	"lookup-table-scope": () => "Choose a column from the lookup table used here",
	"property-scope": () => "Choose information from the related case shown here",
	"case-status-value": () => "Use open or closed for built-in case status",
	"incompatible-values": (_path, reason, error) => {
		switch (reason) {
			case "date-datetime":
				return "A date and a date and time don't line up. You can wrap the date and time in date() to compare days";
			case "datetime-ordering":
				return "A date and time can only be ordered against another date and time. You can wrap it in date() to compare days";
			case "boolean":
				return "Anything that isn't blank or zero counts as true. You can compare the two values themselves, or use the true-or-false result on its own";
			case "day-only-on-device": {
				const copy = dayOnlyRefusalCopy(error?.instant);
				return `${copy.kept}. ${copy.next.slice(0, -1)}`;
			}
			case "clock-lost":
				return "This value has kept only the day of a date and time. You can compare the date and time that first recorded it, or wrap both sides in date() to compare days";
			case "unreadable-datetime":
				return `Nova can't read this date and time. ${UNREADABLE_DATETIME_NEXT.slice(0, -1)}`;
			case "datetime-equality":
				return "A date and time never matches something that isn't one. You can compare it with another date and time, or check whether it's blank";
			default:
				return "Choose values that use compatible kinds of information";
		}
	},
	"ordered-values": () => "Use numbers or dates for this comparison",
	"time-ordering": () =>
		"A time of day can't be compared with before or after. A date can be compared this way.",
	"location-value": (path) =>
		lastNamedSlot(path) === "property"
			? "Choose location information"
			: "Choose a location or enter coordinates",
	"match-value": (path) =>
		lastNamedSlot(path) === "property"
			? "Choose other case information or a different matching method"
			: "Choose another value or matching method",
	"match-value-empty": () => "Enter a value to match",
	"multi-select-property": () =>
		"Choose multiple-choice information that allows more than one answer",
	"pattern-match-unavailable": () =>
		"Use a pattern match only in a Search field's required condition or check",
	"range-order": () => "Set the starting value before the ending value",
	"relation-origin": () => "Choose the kind of case this condition starts from",
	"relation-self": () => "Choose a related case instead of the current case",
	"relation-path": () => "Choose an available connection to another case",
	"relation-destination": () =>
		"Choose a connection that leads to an available kind of case",
	"relation-ambiguous": () => "Choose which kind of related case to use",
	"date-value": () => "Choose a date or date and time value",
	"number-value": () => "Choose a number",
	"text-or-date-value": () => "Choose text, a date, or a date and time value",
	"text-or-number-value": () => "Choose text or a number",
	"branch-values": () =>
		"Make every possible result use the same kind of information",
	"text-value": () => "Choose text",
	"expected-value": () => "Choose a value that fits this setting",
	"constraint-value": () => "Choose a value that fits this setting",
	"default-not-a-choice": () =>
		"Choose a starting value from the available choices",
	"arm-unavailable": () => "Choose a calculation available in this setting",
	"case-data-unavailable": () =>
		"Choose a value available before selecting a case",
	"form-answer-unavailable": () =>
		"Choose a form answer available in this setting",
	"search-answer-unavailable": () =>
		"Choose a Search answer available in this setting",
	"row-scope": () => "Choose information from the row being checked",
	"datum-not-supplied": () =>
		"Choose information supplied when this screen opens",
	"record-position": () => "Use position only while checking a list of records",
	"many-values": () =>
		"This needs one value. You can read one entry, or count or join them",
	"datetime-literal-precision": () =>
		"CommCare compares times to the millisecond. You can choose a time to the millisecond, second or minute",
	"format-date-pattern-not-fixed": () =>
		"This date format can't change from row to row here. You can choose a fixed format",
};

/**
 * Present one checker finding in the builder's voice. The indexed access
 * is deliberately runtime-safe because persisted or untyped input can
 * cross a version boundary with a category this build doesn't know yet.
 */
export function presentCheckErrorForEditor(error: CheckError): string {
	const presenter = (
		PRESENT_BY_CODE as Partial<Record<string, DiagnosticPresenter>>
	)[error.code];
	return (
		presenter?.(error.path, error.reason, error) ??
		nextActionForPath(error.path)
	);
}
